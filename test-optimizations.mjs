/**
 * Offline regression checks for the 0.5.2 speed / robustness work.
 *
 *   node test-optimizations.mjs
 *
 * Pure checks for the two shared helpers, then a pair of programmable local
 * mirrors to prove: bounded-parallel batch keeps the input order, a mirror
 * that is unreachable is probed at most once per worker (not once per paper),
 * and generic Cloudflare wording is reported as `challenge` rather than
 * `not_found`.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from './lib/host.mjs';
import { isChallenge, truncationReason } from './lib/http.mjs';
import { libgenSearch } from './lib/libgen.mjs';

const EMBED = '<embed type="application/pdf" src="/pdf/p.pdf" id="pdf">';
const PDF = Buffer.from('%PDF-1.4 optimized ' + 'x'.repeat(48));

/** A mirror whose article pages can be delayed, fail, or serve arbitrary HTML. */
function startMirror({ delay = 0, status = 200, html = null } = {}) {
	const hits = { page: 0, pdf: 0 };
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		const reply = () => {
			if (url.pathname.startsWith('/pdf/')) {
				hits.pdf += 1;
				res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(PDF.length) });
				res.end(PDF);
				return;
			}
			hits.page += 1;
			if (status >= 400) { res.writeHead(status); res.end('mirror unavailable'); return; }
			if (url.pathname.startsWith('/index.php')) {
				res.writeHead(200, { 'content-type': 'text/html' });
				res.end(html || '<html><body>no rows</body></html>');
				return;
			}
			const doi = url.pathname.replace(/^\//, '');
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(`<html><head><meta name="citation_title" content="Paper ${doi}"><meta name="citation_author" content="Doe, J."><meta name="citation_date" content="2020"></head><body>${EMBED}</body></html>`);
		};
		if (delay) setTimeout(reply, delay);
		else reply();
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({
			server,
			hits,
			base: `http://127.0.0.1:${server.address().port}`,
		}));
	});
}

function harness(mirrors, dir, template) {
	const registered = {};
	const ctx = {
		tools: { register(d) { registered[d.name] = d; } },
		get(name) { return name === 'workingDirectory' ? { defaultDirectory: dir } : undefined; },
	};
	apply(ctx, { mirrors, mirrorFile: '', fileNameTemplate: template });
	return registered;
}

// ── 1) the two shared helpers ────────────────────────────────────────────────
for (const phrase of [
	'<title>Just a moment...</title>',
	'Attention Required! | Cloudflare',
	'cf-browser-verification',
	'cf_chl_opt',
	'Please wait while we verify your browser',
	'Enable JavaScript and cookies to continue',
	'Verify you are human',
	'checking your browser before we continue', // old Sci-Hub wording still matches
]) {
	assert.equal(isChallenge(phrase), true, `challenge wording must be detected: ${phrase}`);
}
assert.equal(isChallenge('<html><body>10 results found</body></html>'), false, 'a normal page is not a challenge');

const short = Buffer.from('%PDF-1.4 short');
assert.equal(
	truncationReason({ headers: { 'content-length': '999' }, body: short }),
	`truncated: got ${short.length} of 999 bytes`
);
assert.equal(truncationReason({ headers: { 'content-length': String(short.length) }, body: short }), null);
assert.equal(truncationReason({ headers: {}, body: short }), null, 'chunked responses have no declared length');
assert.equal(truncationReason({ headers: { 'content-length': '0' }, body: short }), null);

// ── 2) bounded-parallel batch keeps input order and is actually parallel ─────
const tmpA = await mkdtemp(join(tmpdir(), 'scihub-opt-parallel-'));
const slow = await startMirror({ delay: 100 });
try {
	const reg = harness([slow.base], tmpA, '{n} {title}');
	const dois = Array.from({ length: 8 }, (_, i) => `10.1000/paper${i}`);
	const started = Date.now();
	const batch = await reg.scihub_batch.execute({ dois }, {});
	const elapsed = Date.now() - started;
	assert.equal(batch.counts.total, 8, JSON.stringify(batch.counts));
	assert.equal(batch.counts.downloaded, 8, JSON.stringify(batch.counts));
	assert.deepEqual(batch.results.map((r) => r.doi), dois, 'results stay in input order despite parallel workers');
	const names = (await readdir(join(tmpA, 'scihub'))).sort();
	assert.equal(names.length, 8, `expected 8 files, got ${names.join(', ')}`);
	for (let i = 0; i < 8; i += 1) {
		assert.ok(names[i].startsWith(String(i + 1).padStart(2, '0')), `file ${i} must carry its batch position: ${names[i]}`);
	}
	// Serial would be 8 papers x 2 requests x 100 ms = 1600 ms; four workers
	// should finish around 400 ms. A loose bound keeps this stable on slow CI.
	assert.ok(elapsed < 1100, `batch must be bounded-parallel, took ${elapsed} ms`);
} finally {
	slow.server.close();
	await rm(tmpA, { recursive: true, force: true });
}

// ── 3) an unreachable mirror is skipped after the first (racing) round ───────
// Four workers race on their first paper, so up to four of them can probe the
// dead mirror before any marks it. Every paper after that skips it. The point
// is that 10 papers do NOT cause 10 dead probes - only the worker count does.
const tmpB = await mkdtemp(join(tmpdir(), 'scihub-opt-dead-'));
const dead = await startMirror({ status: 500 });
const live = await startMirror();
try {
	const reg = harness([dead.base, live.base], tmpB, '{n} {title}');
	const dois = Array.from({ length: 10 }, (_, i) => `10.2000/p${i}`);
	const batch = await reg.scihub_batch.execute({ dois }, {});
	assert.equal(batch.counts.downloaded, 10, JSON.stringify(batch.counts));
	assert.ok(dead.hits.page <= 4, `dead mirror must be probed at most once per worker, got ${dead.hits.page}`);
	assert.ok(dead.hits.page < 10, `dead mirror must not be probed once per paper, got ${dead.hits.page}`);
	assert.equal(live.hits.page, 10, 'the live mirror is still tried for every paper');
} finally {
	dead.server.close();
	live.server.close();
	await rm(tmpB, { recursive: true, force: true });
}

// ── 4) generic Cloudflare wording on a LibGen search is a challenge ──────────
const challenged = await startMirror({ html: '<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>' });
try {
	const search = await libgenSearch('deep learning', { mirrors: [challenged.base] });
	assert.equal(search.ok, false);
	assert.equal(search.status, 'challenge', `expected challenge, got ${search.status}: ${JSON.stringify(search.attempts)}`);
} finally {
	challenged.server.close();
}

console.log('test-optimizations: ALL PASS');
