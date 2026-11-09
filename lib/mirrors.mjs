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
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
