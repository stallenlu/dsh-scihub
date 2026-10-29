/**
 * One minimal end-to-end check: register the tool through a fake Cordis
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

import { apply, inject } from './lib/host.mjs';

assert.deepEqual(inject, ['tools'], 'plugin must inject the tools service');

// ── fake Cordis context ─────────────────────────────────────────────────────

const dir = await mkdtemp(join(tmpdir(), 'dsh-scihub-'));
let definition;
apply({
	tools: {
		register(def) {
			definition = def;
			return () => {};
		},
	},
	get(service) {
		return service === 'workingDirectory' ? { ensure: async () => dir } : undefined;
	},
});

assert.equal(definition.name, 'scihub_pdf');
assert.ok(definition.parameters.properties.doi, 'doi parameter exists');
assert.ok(definition.parameters.properties.url, 'url parameter exists');
assert.equal(definition.parameters.required, undefined, 'doi/url are an either/or pair');

const run = (args) => definition.execute(args, { agent: { id: 'smoke' } });

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

	// 6) The saved files are all real PDFs in the resolved output directory:
	//    one named after the DOI, one after the direct link's basename.
	const saved = (await readdir(join(dir, 'scihub'))).sort();
	assert.deepEqual(saved, ['10.1038_nature12373.pdf', 'nature12373.pdf'].sort(), `unexpected files: ${saved.join(', ')}`);
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
	console.log('\nOK');
} finally {
	await rm(dir, { recursive: true, force: true });
}
