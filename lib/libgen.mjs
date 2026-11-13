/**
 * Library Genesis (libgen.li family) search + download.
 *
 * Protocol, distilled from the Apache-2.0 `libgen-cli` reference implementation
 * (github.com/halfurness/libgen-cli, libgen/{mirrors,api,download,const}.go):
 *
 *   - search  : GET index.php?req=<keywords>&res=25|50|100 on any mirror.
 *               A browser User-Agent is mandatory — without one the mirrors
 *               answer every path with the nginx placeholder page under HTTP
 *               200, which would silently look like "no results". `httpGet`
 *               already sends one.
 *   - results : a <tr>/<td> table carrying every field we need, including the
 *               MD5 (in `ads.php?md5=...` links). No json.php round-trips.
 *   - download: GET ads.php?md5=<md5> → the page embeds a per-page-signed
 *               `get.php?md5=<md5>&key=<rotating token>`. That key is only
 *               valid on the mirror that issued it, so the link must be
 *               resolved back against the SAME host. The download itself must
 *               carry `Referer: <ads.php URL>` or the host cuts the connection
 *               part-way through.
 *
 * No dependencies: `node:` builtins plus this package's own helpers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	assertSafeDerivedUrl, errorMessage, httpGet, isChallenge, isPdf,
	PAGE_TIMEOUT_MS, PDF_TIMEOUT_MS, truncationReason,
} from './http.mjs';
import { decodeEntities } from './naming.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LIBGEN_MIRROR_FILE = join(HERE, 'libgen-mirrors.json');

/** Used only when libgen-mirrors.json is missing or broken. */
const FALLBACK_LIBGEN_MIRRORS = [
	'https://libgen.li',
	'https://libgen.la',
	'https://libgen.bz',
	'https://libgen.gl',
	'https://libgen.vg',
];

/** Mirror that answered last — tried first so a dead mirror costs one round. */
let lastGoodMirror;

/**
 * Mirror list, re-read on every call so editing libgen-mirrors.json (or the
 * `libgenMirrors` config override) takes effect without a DSH restart.
 * @param {{libgenMirrors?: string[]}} [config]
 * @returns {string[]}
 */
export function resolveLibgenMirrors(config = {}) {
	const fromConfig = Array.isArray(config.libgenMirrors) ? config.libgenMirrors.filter(Boolean) : [];
	let list = fromConfig;
	if (!list.length) {
		try {
			const parsed = JSON.parse(readFileSync(DEFAULT_LIBGEN_MIRROR_FILE, 'utf8'));
			list = Array.isArray(parsed) ? parsed : parsed.mirrors;
		} catch {
			// missing / broken file → built-in fallback
		}
	}
	if (!Array.isArray(list) || !list.length) list = FALLBACK_LIBGEN_MIRRORS;

	const seen = new Set();
	const out = [];
	for (const entry of list) {
		const url = String(entry).trim().replace(/\/+$/, '');
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	if (lastGoodMirror && out.includes(lastGoodMirror)) {
		return [lastGoodMirror, ...out.filter((m) => m !== lastGoodMirror)];
	}
	return out;
}

/** Strip markup, decode entities, collapse whitespace. */
function cleanText(html) {
	return decodeEntities(
		String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
	).replace(/\s+/g, ' ').trim();
}

function headerIndex(headers, ...needles) {
	return headers.findIndex((h) => needles.some((n) => h.includes(n)));
}

/**
 * Parse the index.php results table. Exported so the parser can be tested
 * against fixtures without touching the network.
 *
 * Column order differs between mirrors, so prefer a <th> header row when one
 * exists and fall back to the libgen.li default otherwise.
 * @returns {Array<{md5,title,author,publisher,year,language,pages,size,extension}>}
 */
export function parseSearchResults(html) {
	const rows = [...String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
	let columns = null;
	const results = [];

	for (const [, row] of rows) {
		const headers = [...row.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
			.map((m) => cleanText(m[1]).toLowerCase());
		if (headers.length >= 5) {
			const mapped = {
				title: headerIndex(headers, 'title'),
				author: headerIndex(headers, 'author'),
				publisher: headerIndex(headers, 'publisher'),
				year: headerIndex(headers, 'year'),
				language: headerIndex(headers, 'language'),
				pages: headerIndex(headers, 'pages'),
				size: headerIndex(headers, 'size'),
				extension: headerIndex(headers, 'extension', 'format', 'type'),
				mirrors: headerIndex(headers, 'mirror', 'link'),
			};
			if (mapped.title >= 0) columns = mapped;
			continue;
		}

		const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
		if (cells.length < 5) continue;
		const col = columns || {
			title: 0, author: 1, publisher: 2, year: 3, language: 4,
			pages: 5, size: 6, extension: 7, mirrors: 8,
		};
		const cell = (key) => cleanText(cells[col[key]] ?? '');

		const ads = /ads\.php\?md5=([a-f0-9]{32})/i.exec(row);
		const any = /(?<![a-f0-9])([a-f0-9]{32})(?![a-f0-9])/i.exec(row);
		const md5 = (ads ? ads[1] : any ? any[1] : '').toLowerCase();
		if (!md5) continue; // header / layout row, or no file behind it

		const year = /(\d{4})/.exec(cell('year'));
		results.push({
			md5,
			title: cell('title'),
			author: cell('author'),
			publisher: cell('publisher'),
			year: year ? year[1] : '',
			language: cell('language'),
			pages: cell('pages'),
			size: cell('size'),
			extension: cell('extension').toLowerCase().replace(/[^a-z0-9]/g, ''),
		});
	}
	return results;
}

function classify(reasons) {
	if (reasons.some((r) => r.startsWith('captcha'))) return 'challenge';
	if (reasons.some((r) => r.startsWith('no result rows') || r.startsWith('no get.php'))) return 'not_found';
	return 'error';
}

/**
 * Search LibGen, trying each mirror in order until one returns a real table.
 * @returns {Promise<{ok:boolean,status:string,query:string,mirror:string,count:number,results:Array,attempts:Array,message?:string}>}
 */
export async function libgenSearch(query, options = {}) {
	const { mirrors = resolveLibgenMirrors(), limit = 25, signal } = options;
	const res = limit <= 25 ? 25 : limit <= 50 ? 50 : 100;
	const attempts = [];

	for (const mirror of mirrors) {
		const url = new URL(`${mirror}/index.php`);
		url.searchParams.set('req', query);
		url.searchParams.set('res', String(res));
		let page;
		try {
			page = await httpGet(url.href, {
				accept: 'text/html,application/xhtml+xml,*/*',
				timeoutMs: PAGE_TIMEOUT_MS,
				signal,
			});
		} catch (error) {
			attempts.push({ mirror, reason: `network: ${errorMessage(error)}` });
			continue;
		}
		if (page.status >= 400) {
			attempts.push({ mirror, reason: `HTTP ${page.status}` });
			continue;
		}
		const html = page.body.toString('utf8');
		if (isChallenge(html)) {
			attempts.push({ mirror, reason: 'captcha / verification page' });
			continue;
		}
		const parsed = parseSearchResults(html);
		if (!parsed.length) {
			attempts.push({
				mirror,
				reason: /<t[rd][\s>]/i.test(html)
					? 'no result rows (no matches)'
					: 'empty / placeholder page',
			});
			continue;
		}
		lastGoodMirror = mirror;
		return {
			ok: true,
			status: 'ok',
			query,
			mirror,
			count: Math.min(parsed.length, limit),
			results: parsed.slice(0, limit),
			attempts,
		};
	}

	const status = classify(attempts.map((a) => a.reason));
	return {
		ok: false,
		status,
		query,
		mirror: '',
		count: 0,
		results: [],
		attempts,
		message: status === 'not_found'
			? '镜像上没有匹配的条目（也可能是镜像返回了占位页）。'
			: status === 'challenge'
				? '至少一个镜像返回人机验证页面，无法确认是否有匹配条目。'
				: '所有镜像都失败了，原因见下。',
	};
}

/**
 * Resolve an MD5 to file bytes via ads.php → get.php on one mirror.
 * The caller owns naming and writing; this only does HTTP and validation.
 * @returns {Promise<{ok:boolean,status:string,md5:string,mirror:string,downloadUrl?:string,body?:Buffer,headers?:object,attempts:Array,message?:string}>}
 */
export async function libgenDownload(md5, options = {}) {
	const { mirrors = resolveLibgenMirrors(), signal } = options;
	const attempts = [];

	for (const mirror of mirrors) {
		const adsUrl = new URL(`${mirror}/ads.php`);
		adsUrl.searchParams.set('md5', md5);
		let page;
		try {
			page = await httpGet(adsUrl.href, {
				accept: 'text/html,*/*',
				timeoutMs: PAGE_TIMEOUT_MS,
				signal,
			});
		} catch (error) {
			attempts.push({ mirror, reason: `network: ${errorMessage(error)}` });
			continue;
		}
		if (page.status >= 400) {
			attempts.push({ mirror, reason: `HTTP ${page.status}` });
			continue;
		}
		const html = page.body.toString('utf8');
		if (isChallenge(html)) {
			attempts.push({ mirror, reason: 'captcha / verification page' });
			continue;
		}
		const link = /get\.php\?md5=[a-f0-9]{32}&key=[A-Za-z0-9]+/i
			.exec(html.replace(/&amp;/g, '&'));
		if (!link) {
			attempts.push({ mirror, reason: 'no get.php download link' });
			continue;
		}

		let downloadUrl;
		try {
			downloadUrl = new URL(link[0], adsUrl.href);
			// The key is signed per mirror view; following it to another host
			// would 404, and would also be an SSRF pivot out of this host.
			if (downloadUrl.host !== adsUrl.host) throw new Error('download link left the mirror host');
			assertSafeDerivedUrl(downloadUrl, adsUrl.host);
		} catch (error) {
			attempts.push({ mirror, reason: `bad download link: ${errorMessage(error)}` });
			continue;
		}

		let file;
		try {
			file = await httpGet(downloadUrl.href, {
				referer: adsUrl.href,
				accept: '*/*',
				timeoutMs: PDF_TIMEOUT_MS,
				signal,
			});
		} catch (error) {
			attempts.push({ mirror, reason: `download: ${errorMessage(error)}` });
			continue;
		}
		if (file.status >= 400) {
			attempts.push({ mirror, reason: `download HTTP ${file.status}` });
			continue;
		}
		const body = file.body;
		if (!body.length) {
			attempts.push({ mirror, reason: 'empty response' });
			continue;
		}
		if (/^\s*<(?:!doctype|html|body)/i.test(body.subarray(0, 512).toString('latin1'))) {
			attempts.push({ mirror, reason: 'HTML instead of a file' });
			continue;
		}
		const truncated = truncationReason(file);
		if (truncated) {
			attempts.push({ mirror, reason: truncated });
			continue;
		}

		lastGoodMirror = mirror;
		return {
			ok: true,
			status: 'downloaded',
			md5,
			mirror,
			downloadUrl: downloadUrl.href,
			body,
			headers: file.headers,
			attempts,
		};
	}

	const status = classify(attempts.map((a) => a.reason));
	return {
		ok: false,
		status,
		md5,
		mirror: '',
		attempts,
		message: status === 'not_found'
			? '镜像上没有这个文件（或落地页没有给出下载链接）。'
			: status === 'challenge'
				? '至少一个镜像返回人机验证页面，无法下载。'
				: '所有镜像都失败了，原因见下。',
	};
}

/**
 * Pick a safe extension for a downloaded file. LibGen serves pdf/epub/djvu/...
 * so we must not hard-code `.pdf`: trust the caller's hint (straight from the
 * search hit) first, then Content-Disposition, then sniff a PDF, else `.bin`.
 */
export function downloadExtension(headers = {}, hint = '', body = Buffer.alloc(0)) {
	const clean = String(hint || '').trim().toLowerCase();
	if (/^[a-z0-9]{1,8}$/.test(clean)) return clean;
	const raw = headers['content-disposition'];
	const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i
		.exec(String(Array.isArray(raw) ? raw[0] : raw || ''));
	if (named) {
		const ext = /\.([a-z0-9]{1,8})$/i.exec(named[1].trim());
		if (ext) return ext[1].toLowerCase();
	}
	if (isPdf(body)) return 'pdf';
	return 'bin';
}
