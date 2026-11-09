/**
 * dsh-scihub — fetch a paper's PDF from Sci-Hub by DOI or article URL
 * (host-only Cordis plugin).
 *
 * Registers two model tools:
 *   - `scihub_pdf`  — one DOI or URL → one PDF.
 *   - `scihub_batch` — a list of DOIs → many PDFs, one summary.
 *
 * Input resolution for `scihub_pdf` (exactly one of `doi` / `url`):
 *   doi  — bare DOI or a doi.org link → fetched through the mirrors.
 *   url  — the DOI is read out of the URL (`.../doi/10.1038/nature12373`) or,
 *          for a page with no DOI in it, out of the page markup
 *          (`citation_doi` meta tag, else the first DOI on the page) → fetched
 *          through the mirrors. A `.pdf` link is downloaded as-is first; if the
 *          server refuses the bytes (paywall / cookie gate) and the link also
 *          names a DOI, the mirror walk takes over.
 *
 * The mirror list is data, not code: `lib/mirrors.json` holds it and is
 * re-read on every call, so `node update-mirrors.mjs` refreshes it in place
 * and the next download uses the new list — no DSH restart. A bundle patch
 * can override the list outright (`config.mirrors`) or point at another file
 * (`config.mirrorFile`).
 *
 * Mirror survival is a snapshot, not a fact: probed 2026-10-29 against 24
 * candidate domains, each verified to actually return a `%PDF` download:
 *   - live: sci-hub.usualwant.com, sci-hub.ee, sci-hub.in, sci-hub.ren — all
 *     serve `<embed id="pdf" src="https://sci.bban.top/pdf/<doi>.pdf#view=FitH">`.
 *   - sci-hub.jp (the original request) answers every path with a 610-byte
 *     ad-only shell: parked, not a mirror any more, so it is not in the list.
 *   - dead or walled: see the comment in update-mirrors.mjs.
 * The mirror that last succeeded is tried first, so a list entry that dies
 * costs nothing after the first failure.
 * Some mirrors occasionally answer with a Cloudflare Turnstile "Verification"
 * page; that is reported as status `challenge`, not silently as "not found".
 *
 * Note: Sci-Hub is a shadow library. Availability and legality vary by
 * jurisdiction, so the tools report what they actually got and never invent a
 * successful download.
 *
 * Constraints: ESM `.mjs`, no dependencies, no `@deepseek-ai/*` imports, plain
 * JavaScript. Only `node:` builtins are used.
 */

import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { config, resolveConfig } from './config.mjs';
import {
	contentType,
	errorMessage,
	findPdfUrl,
	httpGet,
	isChallenge,
	isPdf,
	PAGE_TIMEOUT_MS,
	PDF_TIMEOUT_MS,
} from './http.mjs';
import { buildPdfFileName, DEFAULT_FILE_NAME_TEMPLATE, parseCitation } from './naming.mjs';
import { orderMirrors, rememberMirror, resolveMirrors } from './mirrors.mjs';

export const name = 'scihub';
export const inject = ['tools'];

const STATUS_DOWNLOADED = 'downloaded';
const STATUS_NOT_FOUND = 'not_found';
const STATUS_CHALLENGE = 'challenge';
const STATUS_ERROR = 'error';
const STATUS_PARTIAL = 'partial';
const STATUS_FAILED = 'failed';

const MAX_BATCH = 50;

const CONFIG_DEFAULTS = {
	/** Explicit mirror list; when set it wins over the JSON file. */
	mirrors: [],
	/** Path to a JSON file holding { "mirrors": [...] }. */
	mirrorFile: '',
	/**
	 * Human-friendly PDF name template. Placeholders: {title} {year}
	 * {firstAuthor} {author} {authors} {journal} {doi} {stem} {n}
	 * {index} {total}. {n} is the zero-padded batch position. Set it to
	 * an empty string to restore the old DOI-based names.
	 */
	fileNameTemplate: DEFAULT_FILE_NAME_TEMPLATE,
};

/**
 * Standard Schema config. Cordis reads `Config['~standard'].validate(...)`;
 * this package cannot import `@deepseek-ai/schemastery` (it lives outside the
 * profile's node_modules tree), so the helper is hand-rolled in config.mjs.
 */
export const Config = config(CONFIG_DEFAULTS, (value) => {
	const issues = [];
	if (!Array.isArray(value.mirrors)) {
		issues.push('`mirrors` must be an array of mirror URLs.');
	} else if (value.mirrors.some((entry) => typeof entry !== 'string')) {
		issues.push('`mirrors` must contain only strings.');
	}
	if (typeof value.mirrorFile !== 'string') {
		issues.push('`mirrorFile` must be a string path.');
	}
	if (typeof value.fileNameTemplate !== 'string') {
		issues.push('`fileNameTemplate` must be a string.');
	}
	return issues;
});

// ── tool descriptions ───────────────────────────────────────────────────────

const DESCRIPTION =
	'Download a paper PDF and save it under `scihub/` in the session workspace. Pass `doi` (bare DOI or doi.org link) to fetch the paper through Sci-Hub mirrors, or `url` to give an article link or a direct PDF link: a URL that carries a DOI is fetched through the mirrors, a `.pdf` link is downloaded directly, and any other article page has its `citation_doi` meta tag (or first DOI on the page) resolved first. ' +
	'Returns `status`: downloaded | not_found (no mirror has it) | challenge (a mirror demands a Cloudflare captcha — a plain HTTP client cannot pass it, so retry later or fetch manually) | error (network/HTTP/not-a-PDF), with `attempts` naming what each mirror did. ' +
	'Use when the user gives a DOI or a paper URL and wants the PDF, or asks to download a paywalled article. ' +
	'Saved PDFs are named from the citation metadata of the article (for example Watson (1953) Molecular structure of nucleic acids.pdf) using the configurable `fileNameTemplate`; set it to an empty string for the old DOI-based names. ' +
	'Sci-Hub is a shadow library: availability and legality vary by jurisdiction, so report the returned status rather than assuming the paper was retrieved.';

const BATCH_DESCRIPTION =
	'Download many paper PDFs in one call and save them under `scihub/` in the session workspace. Pass `dois` — a list of bare DOIs (up to 50) — and each one is resolved through the Sci-Hub mirrors exactly like `scihub_pdf` does, one after another. ' +
	'Returns `status`: downloaded (every DOI landed) | partial (some landed, some did not) | failed (none landed), plus `counts` and a `results` entry per DOI carrying that DOI\'s own status, saved path and mirror attempts. ' +
	'Use when the user hands over several DOIs at once, e.g. "把这 20 篇都下载了". For a single paper prefer `scihub_pdf`. ' +
	'Files are named from citation metadata via the configurable `fileNameTemplate` (use {n} for the batch position); set it to an empty string for the old DOI-based names. ' +
	'Sci-Hub is a shadow library: availability and legality vary by jurisdiction, so report the returned status rather than assuming the papers were retrieved.';

// ── result schemas (the enforced JSON Schema subset) ─────────────────────────

const ATTEMPTS_SCHEMA = {
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
};

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
		attempts: ATTEMPTS_SCHEMA,
		message: { type: 'string', description: 'Human-readable summary when nothing was downloaded.' },
	},
	required: ['ok', 'status'],
};

const BATCH_RESULT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		ok: { type: 'boolean', description: 'True only when every DOI produced a PDF.' },
		status: {
			type: 'string',
			enum: [STATUS_DOWNLOADED, STATUS_PARTIAL, STATUS_FAILED],
			description: 'downloaded (all landed) | partial (some landed) | failed (none landed).',
		},
		counts: {
			type: 'object',
			additionalProperties: false,
			description: 'How many DOIs were asked for, landed and failed.',
			properties: {
				total: { type: 'integer' },
				downloaded: { type: 'integer' },
				failed: { type: 'integer' },
			},
			required: ['total', 'downloaded', 'failed'],
		},
		outDir: { type: 'string', description: 'Directory the PDFs were written to.' },
		results: {
			type: 'array',
			description: 'One entry per requested DOI, in the requested order.',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					doi: { type: 'string' },
					ok: { type: 'boolean' },
					status: {
						type: 'string',
						enum: [STATUS_DOWNLOADED, STATUS_NOT_FOUND, STATUS_CHALLENGE, STATUS_ERROR],
					},
					title: { type: 'string' },
					path: { type: 'string' },
					bytes: { type: 'integer' },
					mirror: { type: 'string' },
					pdfUrl: { type: 'string' },
					attempts: ATTEMPTS_SCHEMA,
					message: { type: 'string' },
				},
				required: ['doi', 'ok', 'status'],
			},
		},
	},
	required: ['ok', 'status', 'counts', 'results'],
};

// ── plugin entry ────────────────────────────────────────────────────────────

export function apply(ctx, rawConfig) {
	const pluginConfig = resolveConfig(rawConfig, CONFIG_DEFAULTS);

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
					const direct = await downloadPdf(target, outDir, signal, input, doi, pluginConfig);
					if (direct.ok || !doi) return direct;
				}
				// An article page with no DOI in its URL: read one out of the markup.
				if (!doi) doi = await doiFromPage(target.href, signal);
			}

			return fetchFromMirrors(doi, outDir, signal, input, pluginConfig);
		},
	});

	ctx.tools.register({
		name: 'scihub_batch',
		description: BATCH_DESCRIPTION,
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				dois: {
					type: 'array',
					description: `Bare DOIs to download, e.g. ["10.1038/nature12373", "10.1126/science.169.3946.635"]. Up to ${MAX_BATCH} entries.`,
					items: { type: 'string' },
					minItems: 1,
					maxItems: MAX_BATCH,
				},
			},
			required: ['dois'],
		},
		output: {
			schema: BATCH_RESULT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: renderBatch(value) }],
		},
		timeoutMs: 600000,
		// Batch mode already talks to the mirrors back to back; running two of
		// them at once only adds pressure.
		isConcurrencySafe: () => false,
		presentCall: (args) => ({
			card: 'generic',
			title: `Sci-Hub 批量 · ${Array.isArray(args && args.dois) ? args.dois.length : 0} 篇`,
			kind: 'fetch',
			rawInput: args,
		}),
		async execute(args, exec) {
			const raw = args && Array.isArray(args.dois) ? args.dois : [];
			if (!raw.length) throw new Error('Provide `dois` — a list of DOIs such as ["10.1038/nature12373"].');
			if (raw.length > MAX_BATCH) {
				throw new Error(`Too many DOIs: ${raw.length}. At most ${MAX_BATCH} per call.`);
			}

			const signal = exec && exec.signal;
			const outDir = await resolveOutDir(ctx, exec);
			const results = [];
			let downloaded = 0;
			const requested = raw.filter((entry) => typeof entry === 'string' && entry.trim()).length;
			let position = 0;

			for (const entry of raw) {
				const text = typeof entry === 'string' ? entry.trim() : '';
				if (!text) continue;
				position += 1;
				let result;
				try {
					const doi = normalizeDoi(text);
					result = await fetchFromMirrors(doi, outDir, signal, text, pluginConfig, { index: position, total: requested });
				} catch (error) {
					result = {
						ok: false,
						status: STATUS_ERROR,
						doi: text,
						message: errorMessage(error),
					};
				}
				if (result.ok) downloaded += 1;
				results.push({
					doi: result.doi || text,
					ok: result.ok === true,
					status: result.status,
					...(result.title ? { title: result.title } : {}),
					...(result.path ? { path: result.path } : {}),
					...(typeof result.bytes === 'number' ? { bytes: result.bytes } : {}),
					...(result.mirror ? { mirror: result.mirror } : {}),
					...(result.pdfUrl ? { pdfUrl: result.pdfUrl } : {}),
					...(result.attempts ? { attempts: result.attempts } : {}),
					...(result.message ? { message: result.message } : {}),
				});
			}

			const total = results.length;
			const failed = total - downloaded;
			const status = downloaded === 0 ? STATUS_FAILED : downloaded === total ? STATUS_DOWNLOADED : STATUS_PARTIAL;
			return {
				ok: downloaded === total,
				status,
				counts: { total, downloaded, failed },
				outDir: join(outDir, 'scihub'),
				results,
			};
		},
	});
}

// ── download paths ──────────────────────────────────────────────────────────

/** Walk the mirrors: article page → embedded PDF link → download. */
async function fetchFromMirrors(doi, outDir, signal, input, pluginConfig, position) {
	const attempts = [];
	for (const mirror of orderMirrors(resolveMirrors(pluginConfig))) {
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

		const citation = parseCitation(html, doi);
		const fileName = buildPdfFileName(pluginConfig, {
			...citation,
			inputStem: doi,
			index: position ? position.index : '',
			total: position ? position.total : '',
		});
		const result = await savePdf(outDir, fileName, pdf.body);
		rememberMirror(mirror);
		result.doi = doi;
		result.mirror = mirror;
		result.pdfUrl = pdfUrl;
		if (citation.title) result.title = citation.title;
		return withInput(result, input);
	}
	return withInput(failedResult(doi, attempts), input);
}

/** Download a URL the user gave directly (no mirror, no DOI lookup). */
async function downloadPdf(target, outDir, signal, input, doi, pluginConfig) {
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
	const fileName = buildPdfFileName(pluginConfig, {
		doi: doi || '',
		title: stem,
		inputStem: stem,
	});
	const result = await savePdf(outDir, fileName, pdf.body);
	result.pdfUrl = target.href;
	if (doi) result.doi = doi;
	return withInput(result, input);
}

async function savePdf(outDir, fileName, body) {
	const dir = join(outDir, 'scihub');
	await mkdir(dir, { recursive: true });
	const path = await writeUniquePdf(dir, fileName, body);
	return { ok: true, status: STATUS_DOWNLOADED, path, bytes: body.length };
}

/**
 * Never silently overwrite a PDF already on disk. The bytes are written once to
 * a private temp file, then published with a hard link (`link`), which is an
 * atomic "create if absent" — two concurrent downloads cannot race into the
 * same name (scihub_pdf declares isConcurrencySafe), and no reader ever sees a
 * half-written .pdf at a public name. An existing file with the same bytes is
 * reused (re-running a batch is idempotent); a different one gets a (2), (3) ...
 * suffix so both papers survive.
 *
 * A hard link, not `rename`, is deliberate: on Windows a `rename` over an
 * existing target fails with EPERM when another task happens to hold that
 * target open — exactly what the collision check below does when two downloads
 * land on the same name. `link` needs no placeholder window at all.
 */
async function writeUniquePdf(dir, fileName, body) {
	const stem = fileName.replace(/\.pdf$/i, '');
	const tmp = join(dir, `.${stem}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		const th = await open(tmp, 'wx');
		try {
			await th.writeFile(body);
		} finally {
			await th.close();
		}

		for (let n = 1; n <= 999; n += 1) {
			const path = join(dir, n === 1 ? `${stem}.pdf` : `${stem} (${n}).pdf`);
			try {
				// Atomic publish: fails with EEXIST if the name is already taken, and
				// never overwrites. `path` is fully written the instant it appears.
				await link(tmp, path);
				return path;
			} catch (error) {
				if (error.code !== 'EEXIST') throw error;
				// Another download owns this name. Never overwrite: reuse it when the
				// bytes match, otherwise try the next suffix. Size check first, so a
				// different (up to 150 MB) paper is rejected without reading it whole.
				if (await sameBytes(path, body)) return path;
			}
		}
		throw new Error(`no free file name for ${stem}.pdf after 999 collisions`);
	} finally {
		// On success `path` is the surviving link; on failure/reuse our copy is
		// discarded. Best-effort: unlinking one hard link leaves the other intact.
		await unlink(tmp).catch(() => {});
	}
}

/**
 * Byte-for-byte comparison that first rejects on size and then reads in bounded
 * chunks, so an existing PDF is never slurped whole into memory (MAX_BYTES is
 * 150 MB). Bounded and side-effect free: an unreadable/vanished file is simply
 * treated as "not the same", which makes the caller take the next suffix.
 */
async function sameBytes(path, body) {
	let handle;
	try {
		handle = await open(path, 'r');
	} catch {
		return false;
	}
	try {
		if ((await handle.stat()).size !== body.length) return false;
		const chunk = Buffer.allocUnsafe(64 * 1024);
		for (let offset = 0; offset < body.length; offset += chunk.length) {
			const len = Math.min(chunk.length, body.length - offset);
			const { bytesRead } = await handle.read(chunk, 0, len, offset);
			if (bytesRead !== len) return false;
			if (!body.subarray(offset, offset + len).equals(chunk.subarray(0, len))) return false;
		}
		return true;
	} catch {
		return false;
	} finally {
		await handle.close().catch(() => {});
	}
}

function withInput(result, input) {
	return { ...result, input };
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

function renderBatch(value) {
	const { total = 0, downloaded = 0, failed = 0 } = value.counts || {};
	const lines = [`批量下载: ${downloaded}/${total} 成功, ${failed} 失败`];
	if (value.outDir) lines.push(`目录: ${value.outDir}`);
	if (value.results && value.results.length) {
		lines.push('');
		for (const item of value.results) {
			if (item.ok) {
				lines.push(
					`✓ ${item.doi} — ${formatBytes(item.bytes)}${item.path ? ` → ${item.path}` : ''}${item.mirror ? ` (${item.mirror})` : ''}`
				);
			} else {
				const reason = item.message ? ` — ${item.message}` : '';
				lines.push(`✗ ${item.doi} — ${STATUS_LABELS[item.status] || item.status}${reason}`);
			}
		}
	}
	if (failed > 0) {
		lines.push('');
		lines.push('失败项的镜像尝试见 results 里的 attempts 字段。');
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

async function resolveOutDir(ctx, exec) {
	const service = ctx.get('workingDirectory');
	if (service) {
		try {
			if (exec && exec.agent) return await service.ensure(exec.agent, exec.signal);
		} catch {
			// fall through to the default directory
		}
		if (service.defaultDirectory) return service.defaultDirectory;
	}
	return process.cwd();
}
