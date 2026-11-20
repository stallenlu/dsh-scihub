/**
 * Mirror list resolution.
 *
 * Order of precedence:
 *   1. `config.mirrors` — an explicit list in the bundle patch (highest).
 *   2. `config.mirrorFile` — a JSON file with { mirrors: [...] }.
 *   3. `lib/mirrors.json` next to this module (the default, maintained by
 *      `node update-mirrors.mjs`).
 *
 * The file is re-read on every call, so editing it takes effect immediately —
 * no DSH restart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPdfUrl, httpGet, isChallenge, isPdf, PAGE_TIMEOUT_MS, PDF_TIMEOUT_MS } from './http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIRROR_FILE = join(HERE, 'mirrors.json');

/** Mirror that answered last — tried first so a dead mirror only costs one round. */
let lastGoodMirror;

/**
 * @param {{mirrors?: string[], mirrorFile?: string}} [config]
 * @returns {string[]}
 */
export function resolveMirrors(config = {}) {
	const fromConfig = Array.isArray(config.mirrors) ? config.mirrors.filter(Boolean) : [];
	if (fromConfig.length) return normalize(fromConfig);

	const file = config.mirrorFile
		? isAbsolute(config.mirrorFile)
			? config.mirrorFile
			: resolve(process.cwd(), config.mirrorFile)
		: DEFAULT_MIRROR_FILE;
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'));
		const list = Array.isArray(parsed) ? parsed : parsed.mirrors;
		if (Array.isArray(list) && list.length) return normalize(list);
	} catch {
		// missing or broken mirror file → fall back to the built-in list
	}
	return normalize(FALLBACK_MIRRORS);
}

/** Last known good mirror first, then the configured order. */
export function orderMirrors(mirrors) {
	if (!lastGoodMirror) return mirrors;
	const index = mirrors.indexOf(lastGoodMirror);
	if (index <= 0) return mirrors;
	return [lastGoodMirror, ...mirrors.slice(0, index), ...mirrors.slice(index + 1)];
}

export function rememberMirror(mirror) {
	if (mirror) lastGoodMirror = mirror;
}

function normalize(list) {
	const seen = new Set();
	const out = [];
	for (const entry of list) {
		const url = String(entry).trim().replace(/\/+$/, '');
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}

/**
 * Last-resort list, used only when lib/mirrors.json is missing or broken.
 * Snapshotted 2026-10-29; `node update-mirrors.mjs` refreshes the real file.
 */
const FALLBACK_MIRRORS = [
	'https://sci-hub.usualwant.com',
	'https://sci-hub.ee',
	'https://sci-hub.in',
	'https://sci-hub.ren',
];

/**
 * 候选镜像池（探测用，2026-10-29 汇总）。死镜像及死法见 update-mirrors.mjs 注释。
 * CLI 与插件工具共用这一份，避免两处列表漂移。
 */
export const MIRROR_CANDIDATES = [
	'https://sci-hub.usualwant.com',
	'https://sci-hub.ee',
	'https://sci-hub.in',
	'https://sci-hub.ren',
	'https://sci-hub.al',
	'https://sci-hub.se',
	'https://sci-hub.st',
	'https://sci-hub.ru',
	'https://sci-hub.wf',
	'https://sci-hub.box',
	'https://sci-hub.mksa.top',
	'https://sci-hub.pub',
	'https://sci-hub.help',
	'https://sci-hub.ink',
	'https://sci-hub.li',
	'https://sci-hub.tf',
	'https://sci-hub.cat',
	'https://sci-hub.ist',
	'https://sci-hub.tw',
	'https://sci-hub.io',
	'https://sci-hub.work',
	'https://sci-hub.tech',
	'https://sci-hub.3800808.xyz',
	'https://sci-hub.nsm.plus',
];

/** 探测单个镜像：必须真下到一份以 %PDF- 开头的 PDF 才算活着。 */
async function probeMirror(mirror, doi, signal) {
	const started = Date.now();
	try {
		const page = await httpGet(`${mirror}/${doi}`, {
			accept: 'text/html,application/xhtml+xml,*/*',
			timeoutMs: PAGE_TIMEOUT_MS,
			signal,
		});
		if (page.status >= 400) {
			return { mirror, ok: false, reason: `HTTP ${page.status}`, ms: Date.now() - started };
		}
		const html = page.body.toString('utf8');
		const pdfUrl = findPdfUrl(html, page.url);
		if (!pdfUrl) {
			const reason = isChallenge(html) ? 'captcha / 验证页' : 'no PDF link';
			return { mirror, ok: false, reason, ms: Date.now() - started };
		}
		const pdf = await httpGet(pdfUrl, {
			referer: page.url,
			accept: 'application/pdf,*/*',
			timeoutMs: PDF_TIMEOUT_MS,
			signal,
		});
		if (!isPdf(pdf.body)) {
			return { mirror, ok: false, reason: `not a PDF (${pdf.status})`, ms: Date.now() - started };
		}
		return { mirror, ok: true, bytes: pdf.body.length, ms: Date.now() - started, pdfUrl };
	} catch (error) {
		return { mirror, ok: false, reason: error.message || String(error), ms: Date.now() - started };
	}
}

/**
 * 重测全部候选镜像，把能真下到 PDF 的按速度排序写回镜像文件。
 * 插件每次调用都会重读该文件，因此写回立即生效、无需重启 DSH。
 * 没有任何活镜像时保留旧列表，绝不把列表清空。
 */
export async function refreshMirrors(options = {}) {
	const {
		doi = '10.1038/nature12373',
		candidates = MIRROR_CANDIDATES,
		file = DEFAULT_MIRROR_FILE,
		concurrency = 4,
		signal,
	} = options;

	let before = [];
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'));
		before = Array.isArray(parsed) ? parsed : parsed.mirrors || [];
	} catch {
		// 没有历史文件，视作空列表
	}

	const results = [];
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
		while (cursor < candidates.length) {
			const index = cursor++;
			results[index] = await probeMirror(candidates[index], doi, signal);
		}
	});
	await Promise.all(workers);

	const live = results
		.filter((result) => result && result.ok)
		.sort((a, b) => a.ms - b.ms)
		.map((result) => result.mirror);

	if (!live.length) {
		return {
			ok: false,
			status: 'no_live',
			message: '没有找到能下载 PDF 的镜像，已保留原列表。稍后再试，或检查网络/代理。',
			updatedAt: '',
			before,
			after: before,
			results,
		};
	}

	const updatedAt = new Date().toISOString().slice(0, 10);
	writeFileSync(file, `${JSON.stringify({ updatedAt, mirrors: live }, null, 2)}\n`, 'utf8');
	return {
		ok: true,
		status: 'refreshed',
		message: `已重测 ${candidates.length} 个镜像，${live.length} 个可用，已写回并立即生效（无需重启）。`,
		updatedAt,
		before,
		after: live,
		results,
	};
}
