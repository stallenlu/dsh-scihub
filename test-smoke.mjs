/**
 * One minimal end-to-end check: register the tools through a fake Cordis
 * context, then drive every input mode and assert the bytes on disk.
 *
 *   node test-smoke.mjs            # uses 10.1038/nature12373
 *   node test-smoke.mjs <doi>
 *
 * The `doi` mode, the URL-carries-a-DOI mode and the direct-PDF mode hit the
 * network; the citation_doi page lookup and the not-a-PDF case use a local
 * HTTP server, so those two stay deterministic and offline.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { apply, Config, inject } from './lib/host.mjs';
import { DEFAULT_FILE_NAME_TEMPLATE } from './lib/naming.mjs';

assert.deepEqual(inject, ['tools'], 'plugin must inject the tools service');

// The Standard Schema contract Cordis reads at load time.
assert.ok(Config['~standard'], 'Config must expose ~standard');
assert.equal(Config['~standard'].vendor, 'dsh-scihub');
assert.deepEqual(Config['~standard'].validate({}).value, {
	mirrors: [], mirrorFile: '', fileNameTemplate: DEFAULT_FILE_NAME_TEMPLATE,
});

// ── fake Cordis context ─────────────────────────────────────────────────────

const dir = await mkdtemp(join(tmpdir(), 'dsh-scihub-'));
const definitions = new Map();
apply(
	{
		tools: {
			register(def) {
				definitions.set(def.name, def);
				return () => {};
			},
		},
		get(service) {
			return service === 'workingDirectory' ? { ensure: async () => dir } : undefined;
		},
	},
	// Keep the old DOI-based names so this network-dependent smoke test
	// stays deterministic; test-naming.mjs covers the new naming offline.
	{ mirrors: [], mirrorFile: '', fileNameTemplate: '' }
);

const definition = definitions.get('scihub_pdf');
const batch = definitions.get('scihub_batch');
assert.ok(definition, 'scihub_pdf must be registered');
assert.ok(batch, 'scihub_batch must be registered');
assert.ok(definition.parameters.properties.doi, 'doi parameter exists');
assert.ok(definition.parameters.properties.url, 'url parameter exists');
assert.equal(definition.parameters.required, undefined, 'doi/url are an either/or pair');
assert.ok(batch.parameters.properties.dois, 'dois parameter exists');
assert.equal(batch.parameters.required.length, 1, 'dois is required');
assert.equal(batch.parameters.properties.dois.maxItems, 50, 'batch size is capped');

const run = (args) => definition.execute(args, { agent: { id: 'smoke' } });
const runBatch = (args) => batch.execute(args, { agent: { id: 'smoke' } });

/** Assert a real PDF landed, and return it. */
async function assertDownloaded(result, label) {
	assert.equal(result.ok, true, `${label}: expected a download, got ${JSON.stringify(result)}`);
	assert.equal(result.status, 'downloaded', `${label}: status`);
	const bytes = await readFile(result.path);
	assert.equal(bytes.length, result.bytes, `${label}: byte count`);
	assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', `${label}: must start with %PDF-`);
	console.log(`  ✓ ${label} → ${result.path.split(/[\\/]/).pop()} (${result.bytes} B) via ${result.mirror || result.pdfUrl}`);
	return result;
}

const doi = process.argv[2] || '10.1038/nature12373';

try {
	console.log('input modes:');

	// 1) DOI, incl. a doi.org link that must normalize to the bare DOI.
	const byDoi = await run({ doi: `https://doi.org/${doi}` });
	await assertDownloaded(byDoi, 'doi (doi.org URL)');
	assert.equal(byDoi.doi, doi, 'doi.org URL should normalize to the bare DOI');
	assert.notEqual(byDoi.mirror, 'https://sci-hub.jp', 'the parked sci-hub.jp domain must not be in the mirror list');

	// 2) URL that carries the DOI → resolved through the mirrors.
	const byDoiUrl = await run({ url: `https://sci-hub.ren/${doi}` });
	await assertDownloaded(byDoiUrl, 'url carrying a DOI');
	assert.equal(byDoiUrl.doi, doi, 'DOI should be extracted from the URL');

	// 3) Direct PDF link → downloaded as-is, no mirror walk.
	const direct = await run({ url: `https://sci.bban.top/pdf/${doi}.pdf` });
	await assertDownloaded(direct, 'direct .pdf URL');
	assert.equal(direct.mirror, undefined, 'a direct download has no mirror');
	assert.equal(direct.doi, doi, 'the DOI named by the link is still reported');

	// 4) + 5) an article page with no DOI in the URL, resolved from markup;
	//         and a .pdf URL that answers with HTML, which must fail loudly.
	const server = createServer((req, res) => {
		if (req.url === '/article/12345') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			res.end(`<!doctype html><html><head><meta name="citation_doi" content="${doi}"></head><body>x</body></html>`);
		} else {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end('<html><body>paywall</body></html>');
		}
	});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const byPage = await run({ url: `${base}/article/12345` });
		await assertDownloaded(byPage, 'article page → citation_doi');
		assert.equal(byPage.doi, doi, 'DOI should come from the page meta tag');

		const html = await run({ url: `${base}/paper.pdf` });
		assert.equal(html.ok, false, 'HTML at a .pdf URL must not be reported as a download');
		assert.equal(html.status, 'error', 'expected status error');
		assert.match(html.message, /不是 PDF/, 'message names the real problem');
		console.log('  ✓ .pdf URL answering HTML → error');
	} finally {
		server.close();
	}

	// 6) Batch mode: two real DOIs and one that does not exist.
	console.log('batch mode:');
	const secondDoi = '10.1126/science.169.3946.635';
	const batchResult = await runBatch({ dois: [doi, secondDoi, '10.9999/definitely-not-a-real-doi-xyz'] });
	assert.equal(batchResult.counts.total, 3, 'three DOIs requested');
	assert.equal(batchResult.counts.downloaded, 2, 'two DOIs should land');
	assert.equal(batchResult.counts.failed, 1, 'one DOI should fail');
	assert.equal(batchResult.status, 'partial', 'a mixed batch is partial');
	assert.equal(batchResult.ok, false, 'a mixed batch is not ok');
	assert.equal(batchResult.results.length, 3, 'one result per DOI');
	assert.equal(batchResult.results[0].status, 'downloaded', 'first DOI downloaded');
	assert.equal(batchResult.results[2].status !== 'downloaded', true, 'the bogus DOI must not be reported as downloaded');
	assert.ok(batchResult.results[0].path, 'a landed PDF reports its path');
	assert.ok(batchResult.outDir.endsWith('scihub'), 'the batch reports its output directory');
	console.log(`  ✓ ${batchResult.counts.downloaded}/${batchResult.counts.total} downloaded, status=${batchResult.status}`);

	const emptyBatch = await runBatch({ dois: [] }).then(
		() => null,
		(error) => error
	);
	assert.ok(emptyBatch && /Provide `dois`/.test(emptyBatch.message), 'an empty list is rejected');
	console.log('  ✓ empty dois list rejected');

	// 7) The saved files are all real PDFs in the resolved output directory:
	//    one named after the DOI, one after the direct link's basename.
	const saved = (await readdir(join(dir, 'scihub'))).sort();
	// 0.4.1 de-duplicates collisions with a " (2)" suffix instead of
	// overwriting, so accept that suffix when checking the expected names.
	const bases = new Set(saved.map((f) => f.replace(/ \(\d+\)(?=\.pdf$)/, '')));
	for (const want of ['10.1038_nature12373.pdf', 'nature12373.pdf', '10.1126_science.169.3946.635.pdf']) {
		assert.ok(bases.has(want), `missing expected file ${want}; got ${saved.join(', ')}`);
	}
	assert.ok(saved.every((f) => f.endsWith('.pdf')), 'every saved file is a PDF');
	console.log(`  ✓ ${saved.length} distinct files on disk: ${saved.join(', ')}`);

	console.log('input validation:');
	const rejects = [
		[{ doi, url: `https://sci-hub.ren/${doi}` }, /not both/],
		[{}, /Provide .*doi.*or .*url/],
		[{ doi: 'not-a-doi' }, /Not a DOI/],
		[{ url: 'ftp://example.com/x.pdf' }, /Only http\(s\) URLs/],
		[{ url: 'not a url' }, /Not a URL/],
	];
	for (const [args, pattern] of rejects) {
		await assert.rejects(() => run(args), pattern, `should reject ${JSON.stringify(args)}`);
		console.log(`  ✓ rejected ${JSON.stringify(args).slice(0, 60)}`);
	}

	console.log('\nrendered:\n' + definition.output.render({ doi }, byDoi)[0].text);
	console.log('\nrendered (batch):\n' + batch.output.render({}, batchResult)[0].text);
	console.log('\nOK');
} finally {
	await rm(dir, { recursive: true, force: true });
}
