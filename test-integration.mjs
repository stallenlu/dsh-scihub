/**
 * Offline integration checks for the dsh-scihub host plugin. A local HTTP
 * server stands in for the Sci-Hub mirrors, so nothing here needs the network:
 *
 *   node test-integration.mjs
 *
 * Covers tool registration, every naming path, idempotent re-runs, collision
 * suffixes, batch numbering, and the two concurrency/robustness fixes:
 * the AbortSignal listener leak and the atomic (no-overwrite) PDF write.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, Config } from './lib/host.mjs';
import { httpGet } from './lib/http.mjs';

const TITLE = 'Molecular structure of nucleic acids: A structure for deoxyribose nucleic acid';
const TITLE_IN_NAME = 'Molecular structure of nucleic acids A structure for deoxyribose nucleic acid';
const PDF_A = Buffer.from('%PDF-1.4 paper-A ' + 'x'.repeat(40));
const PDF_B = Buffer.from('%PDF-1.4 paper-B ' + 'y'.repeat(40));

const EMBED = '<embed type="application/pdf" src="/pdf/p.pdf?doi=PLACEHOLDER_DOI" id="pdf">';
function fullHtml(title, author, date, journal) {
	return `<html><head>
<meta name="citation_title" content="${title}">
<meta name="citation_author" content="${author}">
<meta name="citation_date" content="${date}">
<meta name="citation_journal_title" content="${journal}">
<title>Sci-Hub | ${title} | 10.1038/nature12373</title>
</head><body>${EMBED}</body></html>`;
}
const papers = {
	'10.1038/nature12373': { html: fullHtml(TITLE, 'Watson, J. D.', '1953/04/25', 'Nature'), pdf: PDF_A },
	'10.1038/nature99999': { html: fullHtml(TITLE, 'Watson, J. D.', '1953/04/25', 'Nature'), pdf: PDF_B },
	'10.1016/j.cell.2020.01.001': { html: '<html><head></head><body>no meta' + EMBED + '</body></html>', pdf: Buffer.from('%PDF-1.4 nometa ' + 'z'.repeat(30)) },
};

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	if (url.pathname.startsWith('/pdf/')) {
		const doi = url.searchParams.get('doi');
		const paper = doi ? papers[doi] : undefined;
		res.writeHead(200, { 'content-type': 'application/pdf' });
		res.end(paper ? paper.pdf : PDF_A);
		return;
	}
	const doi = url.pathname.replace(/^\//, '');
	const paper = papers[doi];
	if (!paper) { res.writeHead(404); res.end('not found'); return; }
	const html = paper.html.replace(/PLACEHOLDER_DOI/g, encodeURIComponent(doi));
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const mirror = `http://127.0.0.1:${server.address().port}`;

function harness(template, dir) {
	const registered = {};
	const ctx = {
		tools: { register(d) { registered[d.name] = d; } },
		get(name) { return name === 'workingDirectory' ? { defaultDirectory: dir } : undefined; },
	};
	apply(ctx, { mirrors: [mirror], mirrorFile: '', fileNameTemplate: template });
	return registered;
}

// ── 1) Config validation ────────────────────────────────────────────────────
assert.ok(Config['~standard'].validate({}).value, 'default config validates');
assert.equal(Config['~standard'].validate({}).value.fileNameTemplate, '{firstAuthor} ({year}) {title}');
assert.ok(Config['~standard'].validate({ fileNameTemplate: 123 }).issues, 'non-string template rejected');
assert.deepEqual(
	Config['~standard'].validate({ mirrorFile: 'x.json' }).value,
	{ mirrors: [], mirrorFile: 'x.json', fileNameTemplate: '{firstAuthor} ({year}) {title}', libgenMirrors: [], proxy: '' },
	'validate() still fills defaults (reuses resolveConfig)'
);

// ── 2) AbortSignal: no listener accumulation across many httpGet calls ───────
{
	const ac = new AbortController();
	for (let i = 0; i < 15; i += 1) await httpGet(`${mirror}/10.1038/nature12373`, { signal: ac.signal });
	assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'native signal must clean up its own listener');
	const pre = new AbortController();
	pre.abort();
	await assert.rejects(() => httpGet(`${mirror}/10.1038/nature12373`, { signal: pre.signal }), /abort/i);
}

// ── 3) single-download naming / idempotency / collisions ─────────────────────
const tmp = await mkdtemp(join(tmpdir(), 'scihub-it-'));
const outDir = join(tmp, 'scihub');
const listDir = async () => (await readdir(outDir)).sort();
let reg = harness('{firstAuthor} ({year}) {title}', tmp);
let r = await reg.scihub_pdf.execute({ doi: '10.1038/nature12373' }, {});
assert.equal(r.ok, true, JSON.stringify(r));
assert.equal(r.title, TITLE);
assert.ok(r.path.endsWith(`Watson (1953) ${TITLE_IN_NAME}.pdf`), r.path);
assert.equal((await readFile(r.path)).equals(PDF_A), true);
assert.deepEqual(await listDir(), [`Watson (1953) ${TITLE_IN_NAME}.pdf`]);

// identical bytes re-run → reused, no "(2)"
let r2 = await reg.scihub_pdf.execute({ doi: '10.1038/nature12373' }, {});
assert.equal(r2.ok, true);
assert.ok(r2.path.endsWith(`Watson (1953) ${TITLE_IN_NAME}.pdf`), r2.path);
assert.deepEqual(await listDir(), [`Watson (1953) ${TITLE_IN_NAME}.pdf`]);

// same human name, different bytes → "(2)", both survive
let r3 = await reg.scihub_pdf.execute({ doi: '10.1038/nature99999' }, {});
assert.equal(r3.ok, true);
assert.ok(r3.path.endsWith(`Watson (1953) ${TITLE_IN_NAME} (2).pdf`), r3.path);
assert.equal((await readFile(r3.path)).equals(PDF_B), true);
assert.equal((await listDir()).length, 2, 'both human-named PDFs coexist');

// no metadata → legacy DOI-based name (0.4.0 backward compat)
let r4 = await reg.scihub_pdf.execute({ doi: '10.1016/j.cell.2020.01.001' }, {});
assert.equal(r4.ok, true, JSON.stringify(r4));
assert.ok(r4.path.endsWith('10.1016_j.cell.2020.01.001.pdf'), r4.path);
assert.equal(r4.title, undefined, 'no title when page has none');

// empty template forces legacy naming even with full metadata
reg = harness('', tmp);
let r5 = await reg.scihub_pdf.execute({ doi: '10.1038/nature12373' }, {});
assert.ok(r5.path.endsWith('10.1038_nature12373.pdf'), r5.path);
assert.deepEqual(await listDir(), [
	'10.1016_j.cell.2020.01.001.pdf',
	'10.1038_nature12373.pdf',
	`Watson (1953) ${TITLE_IN_NAME}.pdf`,
	`Watson (1953) ${TITLE_IN_NAME} (2).pdf`,
].sort(), 'legacy + human names coexist');

// ── 4) concurrent downloads must never overwrite each other ──────────────────
{
	const concTmp = await mkdtemp(join(tmpdir(), 'scihub-it-concurrent-'));
	const creg = harness('{firstAuthor} ({year}) {title}', concTmp);
	const [a, b] = await Promise.all([
		creg.scihub_pdf.execute({ doi: '10.1038/nature12373' }, {}),
		creg.scihub_pdf.execute({ doi: '10.1038/nature99999' }, {}),
	]);
	assert.equal(a.ok && b.ok, true, 'both concurrent downloads succeed');
	assert.notEqual(a.path, b.path, 'concurrent writes land on distinct paths');
	assert.equal((await readFile(a.path)).equals(PDF_A), true, 'A kept its own bytes');
	assert.equal((await readFile(b.path)).equals(PDF_B), true, 'B kept its own bytes');
	assert.equal((await readdir(join(concTmp, 'scihub'))).length, 2, 'no file was overwritten');
	await rm(concTmp, { recursive: true, force: true });
}

// ── 5) batch {n} numbering + counts ──────────────────────────────────────────
{
	const batchTmp = await mkdtemp(join(tmpdir(), 'scihub-it-batch-'));
	const breg = harness('{n} {firstAuthor} - {title}', batchTmp);
	let result = await breg.scihub_batch.execute({ dois: ['10.1038/nature12373', '10.1038/nature99999'] }, {});
	assert.deepEqual(result.counts, { total: 2, downloaded: 2, failed: 0 });
	assert.ok(result.results[0].path.endsWith(`01 Watson - ${TITLE_IN_NAME}.pdf`), result.results[0].path);
	assert.ok(result.results[1].path.endsWith(`02 Watson - ${TITLE_IN_NAME}.pdf`), result.results[1].path);
	assert.equal(result.results[0].title, TITLE);
	assert.ok(result.outDir.endsWith('scihub'));
	await rm(batchTmp, { recursive: true, force: true });
}

// ── 6) direct .pdf URL also goes through the naming template ─────────────────
{
	const urlTmp = await mkdtemp(join(tmpdir(), 'scihub-it-url-'));
	const ureg = harness('{journal} {year} {title}', urlTmp);
	let u = await ureg.scihub_pdf.execute({ url: `${mirror}/pdf/Deep%20Learning%20Paper.pdf` }, {});
	assert.equal(u.ok, true, JSON.stringify(u));
	assert.ok(u.path.endsWith('Deep Learning Paper.pdf'), u.path);
	await rm(urlTmp, { recursive: true, force: true });
}

// ── 7) a very long CJK title still yields a filesystem-safe name ─────────────
{
	const cjkTmp = await mkdtemp(join(tmpdir(), 'scihub-it-cjk-'));
	const creg = harness('{title}', cjkTmp);
	let c = await creg.scihub_pdf.execute({ url: `${mirror}/pdf/${encodeURIComponent('中'.repeat(300))}.pdf` }, {});
	assert.equal(c.ok, true, JSON.stringify(c));
	const base = c.path.split(/[\\/]/).pop();
	assert.ok(Buffer.byteLength(base, 'utf8') <= 255, `file name must fit a 255-byte component: ${Buffer.byteLength(base, 'utf8')}`);
	await rm(cjkTmp, { recursive: true, force: true });
}

server.close();
await rm(tmp, { recursive: true, force: true });
console.log('test-integration: ALL PASS');
