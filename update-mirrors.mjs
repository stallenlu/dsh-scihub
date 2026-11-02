#!/usr/bin/env node
/**
 * One-key mirror refresh.
 *
 *   node update-mirrors.mjs            # probe all candidates, rewrite lib/mirrors.json
 *   node update-mirrors.mjs --doi 10.1038/nature12373
 *
 * A candidate counts as live only when a PDF actually downloads and starts
 * with the %PDF- magic — a page that merely renders is not enough.
 * Live mirrors are written to lib/mirrors.json, fastest first. The plugin
 * re-reads that file on every call, so the new list takes effect at once.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPdfUrl, httpGet, isPdf, PAGE_TIMEOUT_MS, PDF_TIMEOUT_MS } from './lib/http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIRROR_FILE = join(HERE, 'lib', 'mirrors.json');

/**
 * Candidates probed on 2026-10-29. Dead ones and how they died:
 *   no DNS        : .se .ink .io .work .tech .3800808.xyz .nsm.plus
 *   DDoS-Guard 403: .st .box .mksa.top
 *   Cloudflare bot: .ru
 *   HTTP 503      : .wf
 *   parked shell  : .jp .ist (ad page, no PDF)
 *   timeout/reset : .tf .cat .pub .help .li .tw
 */
const CANDIDATES = [
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

const args = process.argv.slice(2);
const doiArg = args.indexOf('--doi');
const DOI = doiArg >= 0 ? args[doiArg + 1] : '10.1038/nature12373';
const CONCURRENCY = 4;

async function probe(mirror) {
	const started = Date.now();
	try {
		const page = await httpGet(`${mirror}/${DOI}`, {
			accept: 'text/html,application/xhtml+xml,*/*',
			timeoutMs: PAGE_TIMEOUT_MS,
		});
		if (page.status >= 400) {
			return { mirror, ok: false, reason: `HTTP ${page.status}`, ms: Date.now() - started };
		}
		const pdfUrl = findPdfUrl(page.body.toString('utf8'), page.url);
		if (!pdfUrl) {
			return { mirror, ok: false, reason: 'no PDF link', ms: Date.now() - started };
		}
		const pdf = await httpGet(pdfUrl, {
			referer: page.url,
			accept: 'application/pdf,*/*',
			timeoutMs: PDF_TIMEOUT_MS,
		});
		if (!isPdf(pdf.body)) {
			return { mirror, ok: false, reason: `not a PDF (${pdf.status})`, ms: Date.now() - started };
		}
		return {
			mirror,
			ok: true,
			bytes: pdf.body.length,
			ms: Date.now() - started,
			pdfUrl,
		};
	} catch (error) {
		return { mirror, ok: false, reason: error.message || String(error), ms: Date.now() - started };
	}
}

async function main() {
	console.log(`probing ${CANDIDATES.length} candidates with DOI ${DOI}\n`);
	const results = [];
	let cursor = 0;
	const workers = Array.from({ length: Math.min(CONCURRENCY, CANDIDATES.length) }, async () => {
		while (cursor < CANDIDATES.length) {
			const index = cursor++;
			results[index] = await probe(CANDIDATES[index]);
		}
	});
	await Promise.all(workers);

	for (const result of results) {
		console.log(
			result.ok
				? `OK   ${String(result.ms).padStart(6)} ms  ${result.mirror}  (${result.bytes} bytes)`
				: `--   ${String(result.ms).padStart(6)} ms  ${result.mirror}  ${result.reason}`
		);
	}

	const live = results
		.filter((result) => result.ok)
		.sort((a, b) => a.ms - b.ms)
		.map((result) => result.mirror);

	if (!live.length) {
		console.error('\nno live mirror found — keeping the current list');
		process.exitCode = 1;
		return;
	}

	let previous = [];
	try {
		const parsed = JSON.parse(readFileSync(MIRROR_FILE, 'utf8'));
		previous = Array.isArray(parsed) ? parsed : parsed.mirrors || [];
	} catch {
		// no previous file
	}

	const payload = { updatedAt: new Date().toISOString().slice(0, 10), mirrors: live };
	writeFileSync(MIRROR_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

	console.log(`\n${MIRROR_FILE}`);
	console.log(`  before: ${previous.join(', ') || '(none)'}`);
	console.log(`  after : ${live.join(', ')}`);
	const added = live.filter((mirror) => !previous.includes(mirror));
	const dropped = previous.filter((mirror) => !live.includes(mirror));
	if (added.length) console.log(`  added  : ${added.join(', ')}`);
	if (dropped.length) console.log(`  dropped: ${dropped.join(', ')}`);
	console.log('\nthe plugin re-reads this file per call — no DSH restart needed.');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
