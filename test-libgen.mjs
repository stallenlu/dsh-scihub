/**
 * Offline tests for the LibGen half of dsh-scihub. A local HTTP server stands
 * in for the libgen.li mirrors, so nothing here needs the real network:
 *
 *   node test-libgen.mjs
 *
 * Covers the results-table parser (with and without <th> headers, entity
 * decoding, MD5 extraction), extension detection, search status classification,
 * mirror failover, the full registered-tool search -> download flow, the
 * browser Referer requirement, idempotent re-runs, and the never-overwrite
 * atomic write.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from './lib/host.mjs';
import {
	downloadExtension,
	libgenSearch,
	parseSearchResults,
} from './lib/libgen.mjs';

const MD5_A = 'a'.repeat(32);
const MD5_B = 'b'.repeat(32);
const MD5_HTML = 'e'.repeat(32);
const FILE_A = Buffer.from('%PDF-1.4 libgen-A ' + 'x'.repeat(48));
const FILE_EPUB = Buffer.from('PK\x03\x04 libgen-epub ' + 'z'.repeat(48));

const TABLE_WITH_HEADERS = `<html><body><table>
<tr><th>Title</th><th>Author</th><th>Publisher</th><th>Year</th><th>Language</th><th>Pages</th><th>Size</th><th>Extension</th><th>Mirrors</th></tr>
<tr><td><a href="edition.php?id=1">Alpha &alpha; &amp; Omega</a></td><td>Ian Goodfellow</td><td>MIT Press</td><td>2016</td><td>English</td><td>800</td><td>12 MB</td><td>pdf</td><td><a href="ads.php?md5=${MD5_A}">[1]</a></td></tr>
<tr><td>Deep Learning</td><td>Ian Goodfellow</td><td>MIT Press</td><td>2016</td><td>English</td><td>800</td><td>9 MB</td><td>epub</td><td><a href="ads.php?md5=${MD5_B}">[2]</a></td></tr>
</table></body></html>`;

const TABLE_NO_HEADERS = `<table>
<tr><td>Deep Learning</td><td>Ian Goodfellow</td><td>MIT Press</td><td>2016</td><td>English</td><td>800</td><td>9 MB</td><td>epub</td><td><a href="ads.php?md5=${MD5_B}">mirror</a></td></tr>
<tr><td>layout</td><td>only</td><td>4</td><td>cells</td></tr>
</table>`;

const referers = [];
const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	const send = (status, body, headers = {}) => {
		res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
		res.end(body);
	};

	if (url.pathname === '/index.php') {
		const q = url.searchParams.get('req') || '';
		if (q === 'Deep Learning') return send(200, TABLE_WITH_HEADERS);
		if (q === 'nonexistent') return send(200, '<table><tr><td>No files found</td></tr></table>');
		if (q === 'challenge') return send(200, '<html>checking your browser before we continue</html>');
		return send(200, '<html><body>placeholder</body></html>');
	}

	if (url.pathname === '/ads.php') {
		const md5 = url.searchParams.get('md5') || '';
		if (md5 === MD5_A) return send(200, `<a href="get.php?md5=${MD5_A}&amp;key=KEYA9">download</a>`);
		if (md5 === MD5_B) return send(200, `<a href="get.php?md5=${MD5_B}&amp;key=KEYB9">download</a>`);
		if (md5 === MD5_HTML) return send(200, `<a href="get.php?md5=${MD5_HTML}&amp;key=KEYH9">download</a>`);
		return send(200, '<html><body>no download link on this page</body></html>');
	}

	if (url.pathname === '/get.php') {
		referers.push(req.headers.referer || '');
		const md5 = url.searchParams.get('md5') || '';
		if (md5 === MD5_A) {
			return send(200, FILE_A, { 'content-type': 'application/pdf' });
		}
		if (md5 === MD5_B) {
			return send(200, FILE_EPUB, {
				'content-type': 'application/epub+zip',
				'content-disposition': 'attachment; filename="Deep Learning.epub"',
			});
		}
		if (md5 === MD5_HTML) return send(200, '<html><body>blocked</body></html>');
		return send(404, 'not found');
	}

	return send(404, 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const mirror = `http://127.0.0.1:${server.address().port}`;

function libgenHarness(dir) {
	const registered = {};
	const ctx = {
		tools: { register(d) { registered[d.name] = d; } },
		get(name) { return name === 'workingDirectory' ? { defaultDirectory: dir } : undefined; },
	};
	apply(ctx, { libgenMirrors: [mirror], fileNameTemplate: '{firstAuthor} ({year}) {title}' });
	return registered;
}

try {
	// ── 1) parseSearchResults: <th> header mapping + entity decoding ───────────
	{
		const rows = parseSearchResults(TABLE_WITH_HEADERS);
		assert.equal(rows.length, 2, 'two data rows parsed');
		assert.equal(rows[0].md5, MD5_A);
		assert.equal(rows[0].title, 'Alpha α & Omega', 'named + numeric HTML entities decoded');
		assert.equal(rows[0].author, 'Ian Goodfellow');
		assert.equal(rows[0].publisher, 'MIT Press');
		assert.equal(rows[0].year, '2016', 'year pulled from the Year column');
		assert.equal(rows[0].language, 'English');
		assert.equal(rows[0].pages, '800');
		assert.equal(rows[0].size, '12 MB');
		assert.equal(rows[0].extension, 'pdf');
		assert.equal(rows[1].md5, MD5_B);
		assert.equal(rows[1].title, 'Deep Learning');
		assert.equal(rows[1].extension, 'epub');
	}

	// ── 2) parseSearchResults: default column order, short/layout rows skipped ─
	{
		const rows = parseSearchResults(TABLE_NO_HEADERS);
		assert.equal(rows.length, 1, 'row with <5 cells is skipped');
		assert.equal(rows[0].md5, MD5_B);
		assert.equal(rows[0].title, 'Deep Learning');
		assert.equal(rows[0].extension, 'epub');
		assert.equal(parseSearchResults('').length, 0, 'no rows in empty page');
	}

	// ── 3) downloadExtension: hint > Content-Disposition > PDF sniff > bin ─────
	{
		assert.equal(downloadExtension({}, 'EPUB', Buffer.alloc(0)), 'epub', 'hint wins (case-insensitive)');
		assert.equal(
			downloadExtension({ 'content-disposition': 'attachment; filename="book.DJVU"' }, '', Buffer.alloc(0)),
			'djvu', 'Content-Disposition filename extension is used',
		);
		assert.equal(downloadExtension({}, '', FILE_A), 'pdf', 'PDF magic bytes sniffed');
		assert.equal(downloadExtension({}, '', FILE_EPUB), 'bin', 'unknown bytes fall back to .bin');
		assert.equal(downloadExtension({}, '../etc', Buffer.alloc(0)), 'bin', 'unsafe hint is rejected');
	}

	// ── 4) libgenSearch status classification + mirror failover ───────────────
	{
		const ok = await libgenSearch('Deep Learning', { mirrors: [mirror] });
		assert.equal(ok.ok, true);
		assert.equal(ok.status, 'ok');
		assert.equal(ok.count, 2);
		assert.equal(ok.mirror, mirror);

		const nf = await libgenSearch('nonexistent', { mirrors: [mirror] });
		assert.equal(nf.ok, false);
		assert.equal(nf.status, 'not_found', 'empty table -> not_found, not error');

		const ch = await libgenSearch('challenge', { mirrors: [mirror] });
		assert.equal(ch.status, 'challenge', 'verification page -> challenge');

		const failover = await libgenSearch('Deep Learning', { mirrors: ['http://127.0.0.1:1', mirror] });
		assert.equal(failover.ok, true, 'dead first mirror is skipped');
		assert.equal(failover.attempts.length, 1);
		assert.ok(failover.attempts[0].reason.startsWith('network'), 'dead mirror recorded as network failure');
	}

	// ── 5) registered tools: search -> download, real extension, Referer ───────
	const dir = await mkdtemp(join(tmpdir(), 'dsh-libgen-'));
	try {
		const tools = libgenHarness(dir);
		assert.ok(tools.libgen_search && tools.libgen_download, 'both LibGen tools registered');
		assert.ok(tools.scihub_pdf && tools.scihub_batch, 'Sci-Hub tools still registered');

		const search = await tools.libgen_search.execute({ query: 'Deep Learning' }, {});
		assert.equal(search.status, 'ok');
		assert.equal(search.count, 2);
		const hitA = search.results.find((r) => r.md5 === MD5_A);
		assert.ok(hitA);

		// MD5_A: no hint, PDF body -> extension sniffed as pdf.
		const dlA = await tools.libgen_download.execute(
			{ md5: MD5_A, title: hitA.title, author: hitA.author, year: hitA.year }, {},
		);
		assert.equal(dlA.ok, true);
		assert.equal(dlA.status, 'downloaded');
		assert.equal(dlA.extension, 'pdf', 'extension sniffed from PDF body');
		assert.ok(dlA.path.endsWith('.pdf'));
		assert.ok(dlA.path.includes('libgen'), 'file lands in <workspace>/libgen/');
		assert.ok((await readFile(dlA.path)).equals(FILE_A), 'saved bytes match the mirror response');

		assert.ok(
			referers.some((r) => r.includes(`/ads.php?md5=${MD5_A}`)),
			'file request carried the ads.php page as Referer',
		);

		// Re-running is idempotent: same bytes reuse the same path, no "(2)".
		const dlA2 = await tools.libgen_download.execute(
			{ md5: MD5_A, title: hitA.title, author: hitA.author, year: hitA.year }, {},
		);
		assert.equal(dlA2.path, dlA.path, 'identical re-run reuses the file');

		// MD5_B: hint 'epub' keeps the real LibGen format (not a hard-coded .pdf).
		const dlB = await tools.libgen_download.execute(
			{ md5: MD5_B, extension: 'epub', title: 'Deep Learning', author: 'Ian Goodfellow', year: '2016' }, {},
		);
		assert.equal(dlB.ok, true);
		assert.equal(dlB.extension, 'epub');
		assert.ok(dlB.path.endsWith('.epub'));
		assert.ok((await readFile(dlB.path)).equals(FILE_EPUB));

		// Failed downloads are reported honestly, never written to disk.
		const missing = await tools.libgen_download.execute({ md5: 'd'.repeat(32), extension: 'pdf' }, {});
		assert.equal(missing.ok, false);
		assert.equal(missing.status, 'not_found', 'ads page without get.php -> not_found');

		const html = await tools.libgen_download.execute({ md5: MD5_HTML, extension: 'pdf' }, {});
		assert.equal(html.ok, false);
		assert.ok(
			html.attempts.some((a) => a.reason.includes('HTML instead of a file')),
			'HTML body is rejected instead of being saved as a file',
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}

	// ── 6) atomic write never overwrites a different existing file ─────────────
	const dir2 = await mkdtemp(join(tmpdir(), 'dsh-libgen-collision-'));
	try {
		const tools = libgenHarness(dir2);
		await mkdir(join(dir2, 'libgen'), { recursive: true });
		const taken = join(dir2, 'libgen', 'Goodfellow (2016) Deep Learning.epub');
		await writeFile(taken, Buffer.from('some other book, different bytes'));
		const dl = await tools.libgen_download.execute(
			{ md5: MD5_B, extension: 'epub', title: 'Deep Learning', author: 'Ian Goodfellow', year: '2016' }, {},
		);
		assert.ok(dl.ok);
		assert.ok(dl.path.endsWith(' (2).epub'), 'collision gets a (2) suffix, existing file untouched');
		assert.ok((await readFile(taken)).equals(Buffer.from('some other book, different bytes')), 'pre-existing file survived');
	} finally {
		await rm(dir2, { recursive: true, force: true });
	}

	console.log('test-libgen: ALL PASS');
} finally {
	server.close();
}
