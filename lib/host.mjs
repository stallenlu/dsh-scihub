/**
 * dsh-scihub — fetch a paper's PDF from Sci-Hub by DOI or article URL
 * (host-only Cordis plugin).
 *
 * Registers the `scihub_pdf` model tool. Given a DOI or a URL it walks a small
 * mirror list, reads the article page, extracts the PDF URL the page embeds,
 * downloads the PDF, checks the `%PDF` magic and writes it to
 * `<workspace>/scihub/<name>.pdf`.
 *
 * Input resolution (exactly one of `doi` / `url`):
 *   doi  — bare DOI or a doi.org link → fetched through the mirrors.
 *   url  — the DOI is read out of the URL (`.../doi/10.1038/nature12373`) or,
 *          for a page with no DOI in it, out of the page markup
 *          (`citation_doi` meta tag, else the first DOI on the page) → fetched
 *          through the mirrors. A `.pdf` link is downloaded as-is first; if the
 *          server refuses the bytes (paywall / cookie gate) and the link also
 *          names a DOI, the mirror walk takes over.
 *
 * Probed against the live mirrors on 2026-10-29 (24 candidate domains, each
 * verified to actually return a `%PDF` download):
 *   - live: sci-hub.usualwant.com, sci-hub.ee, sci-hub.in, sci-hub.ren — all
 *     serve `<embed id="pdf" src="https://sci.bban.top/pdf/<doi>.pdf#view=FitH">`.
 *   - sci-hub.jp (the original request) answers every path with a 610-byte
 *     ad-only shell: parked, not a mirror any more, so it is not in the list.
 *   - dead or walled: see the MIRRORS comment below.
 * The mirror that last succeeded is tried first, so a list entry that dies
 * costs nothing after the first failure. Re-run `node probe-mirrors.mjs` when
 * downloads start failing.
 * Some mirrors occasionally answer with a Cloudflare Turnstile "Verification"
 * page; that is reported as status `challenge`, not silently as "not found".
 *
 * Note: Sci-Hub is a shadow library. Availability and legality vary by
 * jurisdiction, so the tool reports what it actually got and never invents a
 * successful download.
 *
 * Constraints: ESM `.mjs`, no dependencies, no `@deepseek-ai/*` imports, plain
 * JavaScript. Only `node:` builtins are used.
 */

import http from 'node:http';
import https from 'node:https';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'scihub';
export const inject = ['tools'];

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/**
 * Mirrors that answered with a downloadable PDF when probed on 2026-10-29,
 * fastest first. Everything else in the wild is dead or walled:
 *   africa/jp-style parked shells — sci-hub.jp, sci-hub.ist
 *   no DNS                      — .se .ink .io .work .tech .3800808.xyz .nsm.plus
 *   DDoS-Guard / 403            — .st .box .mksa.top; 503 — .wf
 *   Cloudflare "are you a robot" — .ru
 *   HTTP 404/501/timeout        — .tf .cat .pub .help .li .tw
 * Re-probe when downloads start failing; `node probe-mirrors.mjs` does it.
 */
const MIRRORS = [
	'https://sci-hub.usualwant.com',
	'https://sci-hub.ee',
	'https://sci-hub.in',
	'https://sci-hub.ren',
];
const PAGE_TIMEOUT_MS = 20000;
const PDF_TIMEOUT_MS = 120000;
const MAX_BYTES = 150 * 1024 * 1024;
const STATUS_DOWNLOADED = 'downloaded';
const STATUS_NOT_FOUND = 'not_found';
const STATUS_CHALLENGE = 'challenge';
const STATUS_ERROR = 'error';

/** The mirror that last worked goes first, so a dead list entry costs nothing. */
let lastGoodMirror;

function orderedMirrors() {
	if (!lastGoodMirror || !MIRRORS.includes(lastGoodMirror)) return MIRRORS;
	return [lastGoodMirror, ...MIRRORS.filter((mirror) => mirror !== lastGoodMirror)];
}

const DESCRIPTION =
	'Download a paper PDF and save it under `scihub/` in the session workspace. Pass `doi` (bare DOI or doi.org link) to fetch the paper through Sci-Hub mirrors, or `url` to give an article link or a direct PDF link: a URL that carries a DOI is fetched through the mirrors, a `.pdf` link is downloaded directly, and any other article page has its `citation_doi` meta tag (or first DOI on the page) resolved first. ' +
	'Returns `status`: downloaded | not_found (no mirror has it) | challenge (a mirror demands a Cloudflare captcha — a plain HTTP client cannot pass it, so retry later or fetch manually) | error (network/HTTP/not-a-PDF), with `attempts` naming what each mirror did. ' +
	'Use when the user gives a DOI or a paper URL and wants the PDF, or asks to download a paywalled article. ' +
	'Sci-Hub is a shadow library: availability and legality vary by jurisdiction, so report the returned status rather than assuming the paper was retrieved.';

// ── result schema (the enforced JSON Schema subset) ─────────────────────────

const RESULT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		ok: { type: 'boolean', description: 'True only when a PDF was written to disk.' },
		status: {
			type: 'string',
			enum: [STATUS_DOWNLOADED, STATUS_NOT_FOUND, STATUS_CHALLENGE, STATUS_ERROR],
			description:
				'downloaded | not_found (mirrors had no copy) | challenge (a mirror demanded a captcha) | error (network/HTTP/not-a-PDF).',
		},
		input: { type: 'string', description: 'The `doi` or `url` argument as given.' },
		doi: { type: 'string', description: 'DOI used for the lookup, when one was resolved.' },
		title: { type: 'string', description: 'Article title as the Sci-Hub page reports it.' },
		path: { type: 'string', description: 'Absolute path of the saved PDF.' },
		bytes: { type: 'integer', description: 'Size of the saved PDF.' },
		mirror: { type: 'string', description: 'The mirror that produced the PDF (absent when a URL was downloaded directly).' },
		pdfUrl: { type: 'string', description: 'The PDF URL that was downloaded.' },
		attempts: {
			type: 'array',
			description: 'Per-mirror outcome, in the order they were tried.',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					mirror: { type: 'string' },
					reason: { type: 'string' },
				},
				required: ['mirror', 'reason'],
			},
		},
		message: { type: 'string', description: 'Human-readable summary when nothing was downloaded.' },
	},
	required: ['ok', 'status'],
};

// ── plugin entry ────────────────────────────────────────────────────────────

export function apply(ctx) {
	ctx.tools.register({
		name: 'scihub_pdf',
		description: DESCRIPTION,
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				doi: {
					type: 'string',
					description:
						'DOI of the article, bare (`10.1038/nature12373`) or as a URL (`https://doi.org/10.1038/nature12373`). Use this or `url`, not both.',
				},
				url: {
					type: 'string',
					description:
						'Article page URL (`https://www.nature.com/articles/s41586-020-2649-2`), a publisher DOI link (`https://link.springer.com/article/10.1007/...`), or a direct PDF link (`https://host/paper.pdf`). A URL with no DOI in it costs one extra page fetch to find one. Use this or `doi`, not both.',
				},
			},
		},
		output: {
			schema: RESULT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
		},
		timeoutMs: 180000,
		isConcurrencySafe: () => true,
		presentCall: (args) => ({
			card: 'generic',
			title: `Sci-Hub · ${firstString(args, 'doi') || firstString(args, 'url') || '…'}`,
			kind: 'fetch',
			rawInput: args,
		}),
		async execute(args, exec) {
			const doiArg = firstString(args, 'doi');
			const urlArg = firstString(args, 'url');
			if (doiArg && urlArg) throw new Error('Provide `doi` or `url`, not both.');
			if (!doiArg && !urlArg) {
				throw new Error('Provide `doi` (e.g. 10.1038/nature12373) or `url` (an article link or a direct PDF link).');
			}

			const input = doiArg || urlArg;
			const signal = exec && exec.signal;
			const outDir = await resolveOutDir(ctx, exec);

			let doi;
			if (doiArg) {
				doi = normalizeDoi(doiArg);
			} else {
				const target = parseHttpUrl(urlArg);
				doi = extractDoi(decodeSafe(target.pathname + target.search));
				// A `.pdf` link is downloaded as-is. Paywalled publisher PDF
				// endpoints answer with HTML or 403, so carry on to the mirrors
				// when the link also names a DOI.
				if (/\.pdf$/i.test(target.pathname)) {
					const direct = await downloadPdf(target, outDir, signal, input, doi);
					if (direct.ok || !doi) return direct;
				}
				// An article page with no DOI in its URL: read one out of the markup.
				if (!doi) doi = await doiFromPage(target.href, signal);
			}

			return fetchFromMirrors(doi, outDir, signal, input);
		},
	});
}

// ── download paths ──────────────────────────────────────────────────────────

/** Walk the mirrors: article page → embedded PDF link → download. */
async function fetchFromMirrors(doi, outDir, signal, input) {
	const attempts = [];
	for (const mirror of orderedMirrors()) {
		const pageUrl = `${mirror}/${doi}`;
		let page;
		try {
			page = await httpGet(pageUrl, {
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
		const pdfUrl = findPdfUrl(html, page.url);
		if (!pdfUrl) {
			attempts.push({
				mirror,
				reason: isChallenge(html) ? 'captcha / verification page' : 'no PDF link (article not found)',
			});
			continue;
		}

		let pdf;
		try {
			pdf = await httpGet(pdfUrl, {
				referer: pageUrl,
				accept: 'application/pdf,*/*',
				timeoutMs: PDF_TIMEOUT_MS,
				signal,
			});
		} catch (error) {
			attempts.push({ mirror, reason: `PDF download: ${errorMessage(error)}` });
			continue;
		}
		if (!isPdf(pdf.body)) {
			attempts.push({ mirror, reason: notPdfReason(pdf) });
			continue;
		}

		const result = await savePdf(outDir, safeFileName(doi), pdf.body);
		lastGoodMirror = mirror;
		result.doi = doi;
		result.mirror = mirror;
		result.pdfUrl = pdfUrl;
		const title = pageTitle(html);
		if (title) result.title = title;
		return withInput(result, input);
	}
	return withInput(failedResult(doi, attempts), input);
}

/** Download a URL the user gave directly (no mirror, no DOI lookup). */
async function downloadPdf(target, outDir, signal, input, doi) {
	let pdf;
	try {
		pdf = await httpGet(target.href, { accept: 'application/pdf,*/*', timeoutMs: PDF_TIMEOUT_MS, signal });
	} catch (error) {
		return withInput(
			{ ok: false, status: STATUS_ERROR, message: `下载失败: ${errorMessage(error)}`, pdfUrl: target.href },
			input
		);
	}
	if (!isPdf(pdf.body)) {
		return withInput(
			{
				ok: false,
				status: STATUS_ERROR,
				message: `该 URL 返回的不是 PDF — ${notPdfReason(pdf)}。如果这是文章页而不是 PDF 链接,请把页面 URL 交给 url,或直接传 DOI。`,
				pdfUrl: target.href,
			},
			input
		);
	}
	const stem = decodeSafe(target.pathname.split('/').pop() || '').replace(/\.pdf$/i, '');
	const result = await savePdf(outDir, safeFileName(stem), pdf.body);
	result.pdfUrl = target.href;
	if (doi) result.doi = doi;
	return withInput(result, input);
}

async function savePdf(outDir, fileName, body) {
	const dir = join(outDir, 'scihub');
	await mkdir(dir, { recursive: true });
	const path = join(dir, fileName);
	await writeFile(path, body);
	return { ok: true, status: STATUS_DOWNLOADED, path, bytes: body.length };
}

function withInput(result, input) {
	return result.input === input ? result : { ...result, input };
}

// ── result rendering (model-facing text) ────────────────────────────────────

function renderResult(value) {
	if (value.ok) {
		const head = value.doi ? `已下载 ${value.doi}` : '已下载';
		const title = value.title ? `\n标题: ${value.title}` : '';
		const origin = value.mirror ? `\n来源: ${value.mirror}\nPDF: ${value.pdfUrl}` : `\n来源: ${value.pdfUrl}`;
		return `${head}${title}\n保存: ${value.path} (${formatBytes(value.bytes)})${origin}`;
	}
	const target = value.doi || value.input || value.pdfUrl || '';
	const lines = [`未能下载 ${target} — ${STATUS_LABELS[value.status] || value.status}`];
	lines.push(value.message);
	if (value.attempts && value.attempts.length > 0) {
		lines.push('');
		lines.push('镜像尝试:');
		for (const a of value.attempts) lines.push(`- ${a.mirror}: ${a.reason}`);
	}
	if (value.status === STATUS_CHALLENGE) {
		lines.push('');
		lines.push('某个镜像要求人机验证(Cloudflare Turnstile)。纯 HTTP 客户端过不去——稍后重试,或在浏览器里打开镜像手动下载。');
	}
	return lines.join('\n');
}

const STATUS_LABELS = {
	[STATUS_NOT_FOUND]: '镜像上没有这篇文章',
	[STATUS_CHALLENGE]: '镜像要求人机验证',
	[STATUS_ERROR]: '网络/HTTP/内容错误',
};

function formatBytes(n) {
	if (typeof n !== 'number') return '?';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── failure classification ──────────────────────────────────────────────────

/**
 * Nothing was downloaded. `challenge` outranks `not_found`: a captcha means we
 * never learned whether the article exists, and reporting "not found" would be
 * a false claim about the paper.
 */
function failedResult(doi, attempts) {
	const reasons = attempts.map((a) => a.reason);
	let status = STATUS_ERROR;
	if (reasons.some((r) => r.startsWith('captcha'))) status = STATUS_CHALLENGE;
	else if (reasons.length > 0 && reasons.every((r) => r.startsWith('no PDF link') || r.startsWith('HTTP 404')))
		status = STATUS_NOT_FOUND;
	const message =
		status === STATUS_NOT_FOUND
			? '所有镜像都返回"没有这篇文章"(或空页面)。'
			: status === STATUS_CHALLENGE
				? '至少一个镜像返回人机验证页面,无法确认文章是否存在。'
				: '所有镜像都失败了,原因见下。';
	return { ok: false, status, doi, message, attempts };
}

function notPdfReason(response) {
	return `not a PDF (HTTP ${response.status}, ${contentType(response)}), ${response.body.length} bytes`;
}

// ── input: DOI, URLs, paths ─────────────────────────────────────────────────

const DOI_RE = /^10\.\d{4,9}\/\S+$/;
/** A DOI inside free text or a URL. Stops at URL/query delimiters. */
const DOI_IN_TEXT_RE = /10\.\d{4,9}\/[^\s"'<>#?&]+/;

function firstString(args, key) {
	const value = args && typeof args[key] === 'string' ? args[key].trim() : '';
	return value || '';
}

/** Accept a bare DOI or a doi.org URL; reject anything that is not a DOI. */
function normalizeDoi(input) {
	const raw = typeof input === 'string' ? input.trim() : '';
	if (!raw) throw new Error('Missing `doi`. Pass a DOI such as 10.1038/nature12373.');
	const doi = raw
		.replace(/^doi:\s*/i, '')
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
		.replace(/\.pdf$/i, '')
		.trim();
	if (!DOI_RE.test(doi)) {
		throw new Error(`Not a DOI: ${raw}. Expected the form 10.<registrant>/<suffix>, e.g. 10.1038/nature12373.`);
	}
	return doi;
}

function parseHttpUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Not a URL: ${raw}. Pass an http(s) link or use \`doi\` for a bare DOI.`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Only http(s) URLs are supported, got ${url.protocol}`);
	}
	return url;
}

/** First DOI in a string, without a trailing sentence/URL punctuation. */
function extractDoi(text) {
	const match = DOI_IN_TEXT_RE.exec(String(text || ''));
	if (!match) return undefined;
	try {
		// Speculative: a DOI-shaped fragment that fails validation is not a DOI.
		return normalizeDoi(match[0].replace(/[.,;:)\]]+$/, ''));
	} catch {
		return undefined;
	}
}

/** No DOI in the URL: read the article page's citation metadata instead. */
async function doiFromPage(url, signal) {
	let page;
	try {
		page = await httpGet(url, { accept: 'text/html,*/*', timeoutMs: PAGE_TIMEOUT_MS, signal });
	} catch (error) {
		throw new Error(`URL 里没有 DOI,抓取页面也失败(${errorMessage(error)})。请直接传 DOI。`);
	}
	if (page.status >= 400) {
		throw new Error(`URL 里没有 DOI,页面又返回 HTTP ${page.status}。请直接传 DOI。`);
	}
	const html = page.body.toString('utf8');
	for (const pattern of CITATION_DOI_PATTERNS) {
		const match = pattern.exec(html);
		if (match) return normalizeDoi(match[1]);
	}
	const fallback = extractDoi(html);
	if (fallback) return fallback;
	throw new Error('URL 和页面里都没找到 DOI。请直接传 DOI(`doi` 参数)。');
}

const CITATION_DOI_PATTERNS = [
	/<meta[^>]+name=["']citation_doi["'][^>]*content=["']([^"']+)["']/i,
	/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']citation_doi["']/i,
	/<meta[^>]+name=["'](?:dc\.identifier|DC\.Identifier|DOI)["'][^>]*content=["']([^"']+)["']/i,
	/doi\.org\/(10\.\d{4,9}\/[^\s"'<>]+)/i,
];

function decodeSafe(text) {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** `<workspace>/scihub/<stem>.pdf` — DOI slashes and odd characters flattened. */
function safeFileName(stem) {
	const cleaned = String(stem || '')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._]+|[._]+$/g, '')
		.slice(0, 150);
	return `${cleaned || 'article'}.pdf`;
}

/** The session workspace, when the working-directory service is available. */
async function resolveOutDir(ctx, exec) {
	let service;
	try {
		service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
	} catch {
		service = undefined;
	}
	if (service) {
		if (exec && exec.agent) {
			try {
				const dir = await service.ensure(exec.agent, exec.signal);
				if (typeof dir === 'string' && dir) return dir;
			} catch {
				// fall through to the default directory
			}
		}
		// No agent to resolve (or ensure failed): use the configured default
		// rather than the Host process directory.
		if (typeof service.defaultDirectory === 'string' && service.defaultDirectory) return service.defaultDirectory;
	}
	return process.cwd();
}

// ── article page parsing ────────────────────────────────────────────────────

/**
 * The PDF URL an article page embeds. Sci-Hub emits
 *   <embed type="application/pdf" src="https://sci.bban.top/pdf/<doi>.pdf#view=FitH" id="pdf">
 * and a save button with a JSON-escaped copy of the same URL (`\/`).
 */
function findPdfUrl(html, pageUrl) {
	const patterns = [
		/<embed[^>]+src\s*=\s*["']([^"']+)["']/i,
		/<iframe[^>]+src\s*=\s*["']([^"']+\.pdf[^"']*)["']/i,
		/location\.href\s*=\s*['"]([^'"]+\.pdf[^'"]*)['"]/i,
		/["'](https?:\/\/[^"']+\.pdf[^"']*)["']/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(html);
		if (!match) continue;
		const cleaned = match[1].replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/#.*$/, '').trim();
		if (!cleaned || cleaned.startsWith('data:')) continue;
		try {
			return new URL(cleaned, pageUrl).href;
		} catch {
			// try the next pattern
		}
	}
	return null;
}

function isChallenge(html) {
	return /challenges\.cloudflare\.com\/turnstile|are you (a )?robot|ddos-guard|checking your browser|verification - sci-hub/i.test(
		html
	);
}

/** "Sci-Hub | <title> | <doi>" → "<title>". */
function pageTitle(html) {
	const match = /<title>([^<]*)<\/title>/i.exec(html);
	if (!match) return undefined;
	const title = match[1].replace(/\s+/g, ' ').trim();
	const parts = title.split('|').map((s) => s.trim());
	if (parts.length >= 2) {
		const inner = parts.slice(1, parts.length > 2 ? -1 : undefined).join(' | ').trim();
		if (inner && !/^10\.\d{4,9}\//.test(inner)) return inner;
		return undefined;
	}
	return title || undefined;
}

function isPdf(buf) {
	return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

function contentType(response) {
	const type = response.headers['content-type'];
	return Array.isArray(type) ? type[0] : type || 'unknown type';
}

function errorMessage(error) {
	if (!error) return 'unknown error';
	if (error.code) return `${error.code} ${error.message}`;
	return error.message || String(error);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * GET a URL following redirects. No `accept-encoding` is sent, so the response
 * is always identity-encoded and needs no decompression.
 */
function httpGet(url, options = {}, redirectsLeft = 5) {
	const { referer, accept = '*/*', timeoutMs = PAGE_TIMEOUT_MS, signal } = options;
	return new Promise((resolvePromise, reject) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			reject(new Error(`invalid URL: ${url}`));
			return;
		}
		const client = parsed.protocol === 'http:' ? http : https;
		const request = client.get(
			parsed,
			{
				headers: {
					'user-agent': USER_AGENT,
					accept,
					'accept-language': 'en-US,en;q=0.9',
					...(referer ? { referer } : {}),
				},
				timeout: timeoutMs,
			},
			(response) => {
				const status = response.statusCode || 0;
				const location = response.headers.location;
				if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
					response.resume();
					const next = new URL(location, parsed).href;
					resolvePromise(httpGet(next, options, redirectsLeft - 1));
					return;
				}
				const chunks = [];
				let total = 0;
				response.on('data', (chunk) => {
					total += chunk.length;
					if (total > MAX_BYTES) {
						request.destroy(new Error(`response exceeds ${MAX_BYTES} bytes`));
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () =>
					resolvePromise({ status, headers: response.headers, body: Buffer.concat(chunks), url: parsed.href })
				);
				response.on('error', reject);
			}
		);
		request.on('timeout', () => request.destroy(new Error(`timeout after ${timeoutMs} ms`)));
		request.on('error', reject);
		if (signal) {
			if (signal.aborted) request.destroy(new Error('aborted'));
			else signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true });
		}
	});
}
