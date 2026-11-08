/**
 * Offline, deterministic checks for the human-friendly PDF naming in
 * lib/naming.mjs. No network, no Sci-Hub, no fixtures on disk:
 *
 *   node test-naming.mjs
 *
 * Unlike test-smoke.mjs (which walks the real mirrors), this only exercises
 * citation parsing, template substitution, sanitisation and the legacy-name
 * fallback, so it is safe to run in CI or right after a fresh clone.
 */
import assert from 'node:assert/strict';
import {
	DEFAULT_FILE_NAME_TEMPLATE, MAX_NAME_CHARS,
	parseCitation, sanitizeFileName, buildPdfFileName,
} from './lib/naming.mjs';

const TITLE = 'Molecular structure of nucleic acids: A structure for deoxyribose nucleic acid';
const TITLE_IN_NAME = 'Molecular structure of nucleic acids A structure for deoxyribose nucleic acid';
const fullHtml = `<html><head>
<meta name="citation_title" content="${TITLE}">
<meta name="citation_author" content="Watson, J. D.">
<meta name="citation_author" content="Crick, F. H. C.">
<meta name="citation_date" content="1953/04/25">
<meta name="citation_journal_title" content="Nature">
<meta name="citation_doi" content="10.1038/nature12373">
<title>Sci-Hub | Molecular structure of nucleic acids | 10.1038/nature12373</title>
</head><body></body></html>`;

// 1) Full citation metadata is recovered from Highwire meta tags.
const c = parseCitation(fullHtml, '10.1038/nature12373');
assert.equal(c.title, TITLE);
assert.equal(c.year, '1953');
assert.deepEqual(c.authors, ['Watson, J. D.', 'Crick, F. H. C.']);
assert.equal(c.firstAuthor, 'Watson');
assert.equal(c.journal, 'Nature');
assert.equal(c.doi, '10.1038/nature12373');

// 2) Default template yields a human-readable, consistent name.
const cfg = { fileNameTemplate: DEFAULT_FILE_NAME_TEMPLATE };
assert.equal(buildPdfFileName(cfg, { ...c, inputStem: c.doi }), `Watson (1953) ${TITLE_IN_NAME}.pdf`);

// 3) No metadata at all → legacy DOI-based name (backwards compatible).
const empty = parseCitation('<html><head></head></html>', '10.1016/j.cell.2020.01.001');
assert.equal(empty.title, '');
assert.equal(empty.year, '');
assert.equal(empty.firstAuthor, '');
assert.equal(buildPdfFileName(cfg, { ...empty, inputStem: empty.doi }), '10.1016_j.cell.2020.01.001.pdf');

// 4) <title> fallback when no citation_title meta is present.
const titleOnly = parseCitation('<title>Sci-Hub | Attention Is All You Need | 10.48550/arXiv.1706.03762</title>', '10.48550/arXiv.1706.03762');
assert.equal(titleOnly.title, 'Attention Is All You Need');

// 5) An empty template explicitly restores the old naming, even with full metadata.
const legacy = { fileNameTemplate: '' };
assert.equal(buildPdfFileName(legacy, { ...c, inputStem: c.doi }), '10.1038_nature12373.pdf');
assert.equal(buildPdfFileName(legacy, { doi: '10.1038/nature12373', inputStem: '10.1038/nature12373' }), '10.1038_nature12373.pdf');

// 6) Batch placeholders {n} {index} {total}, plus {journal}/{year}/{firstAuthor}.
const short = { title: 'Deep Residual Learning', firstAuthor: 'He', year: '2016', journal: 'CVPR' };
const tmpl = { fileNameTemplate: '{n} {firstAuthor} - {title} ({journal} {year})' };
assert.equal(buildPdfFileName(tmpl, { ...short, index: 3, total: 20, inputStem: 'x' }),
	'03 He - Deep Residual Learning (CVPR 2016).pdf');
const tmpl2 = { fileNameTemplate: '{index}of{total} {doi}' };
assert.equal(buildPdfFileName(tmpl2, { doi: '10.1038/nature12373', index: 7, total: 9, inputStem: 'x' }),
	'7of9 10.1038 nature12373.pdf');

// 7) Missing fields leave no empty brackets / dangling separators.
const sparse = { ...c, year: '', firstAuthor: '', journal: '' };
assert.equal(buildPdfFileName(cfg, { ...sparse, inputStem: c.doi }), `${TITLE_IN_NAME}.pdf`);

// 8) sanitizeFileName: illegal chars, Windows device names, Unicode, length cap.
assert.equal(sanitizeFileName('  a/b:c*d?e"f<g>h|i  '), 'a b c d e f g h i');
assert.equal(sanitizeFileName('CON'), '_CON');
assert.equal(sanitizeFileName('COM1.pdf'), '_COM1.pdf');
assert.equal(sanitizeFileName(''), 'article');
assert.equal(sanitizeFileName('中文 论文 café'), '中文 论文 café');
assert.ok(Array.from(sanitizeFileName('x'.repeat(300))).length <= MAX_NAME_CHARS);

// 9) HTML entities are decoded for the file name.
assert.equal(buildPdfFileName({ fileNameTemplate: '{title}' }, { title: 'A &amp; B &#x2013; C' }), 'A & B – C.pdf');

console.log('test-naming: ALL PASS');
