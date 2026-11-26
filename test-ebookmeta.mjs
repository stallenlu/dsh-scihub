/**
 * Offline, self-generating fixtures and read assertions for lib/ebookmeta.mjs.
 *
 *   node test-ebookmeta.mjs          # runs the suite and prints ALL PASS
 *
 * The fixture builders below are exported for Tasks 2/4/5 to import. Importing
 * this file does NOT run the assertions: they live behind the direct-execution
 * guard at the bottom (controller ruling R1).
 *
 * Node built-ins only. No network, no credentials, no child_process.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

import { MetaError, detectFormat, readMeta } from './lib/ebookmeta.mjs';

/* ------------------------------------------------------------------ *
 * Small, standards-shaped ZIP writer (EPUB is a ZIP container).
 * ------------------------------------------------------------------ */

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pdfEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function zipEntry(name, content, stored = false) {
  const data = Buffer.from(content, 'utf8');
  const nameBuf = Buffer.from(name, 'utf8');
  const method = stored ? 0 : 8;
  const payload = stored ? data : deflateRawSync(data);
  return { name, nameBuf, data, payload, method, crc: crc32(data) };
}

function buildZip(entries) {
  let offset = 0;
  const locals = [];
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // PK\003\004
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0x21, 12); // date: 1980-01-01
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.payload.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(entry.nameBuf.length, 26);
    header.writeUInt16LE(0, 28); // extra length
    locals.push({ entry, header, offset });
    offset += header.length + entry.nameBuf.length + entry.payload.length;
  }

  const centralStart = offset;
  const centrals = [];
  for (const { entry, offset: localOffset } of locals) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // PK\001\002
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8); // flags
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(0, 12); // time
    header.writeUInt16LE(0x21, 14); // date
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.payload.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(entry.nameBuf.length, 28);
    header.writeUInt16LE(0, 30); // extra length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number start
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(localOffset, 42);
    centrals.push({ entry, header });
    offset += header.length + entry.nameBuf.length;
  }
  const centralSize = offset - centralStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\005\006
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([
    ...locals.flatMap(({ entry, header }) => [header, entry.nameBuf, entry.payload]),
    ...centrals.flatMap(({ entry, header }) => [header, entry.nameBuf]),
    eocd,
  ]);
}

/* ------------------------------------------------------------------ *
 * Exported fixture builders — importable by later tasks.
 * ------------------------------------------------------------------ */

/**
 * Write a minimal EPUB (ZIP with a stored `mimetype`, a container and an OPF).
 * @param {string} path destination file
 * @param {{title?:string, authors?:string[], language?:string, publisher?:string,
 *          date?:string, description?:string, tags?:string[], series?:string,
 *          index?:string|number, isbn?:string}} fields metadata values
 * @param {{omitContainer?:boolean}} options test-only switches
 * @returns {string} the same path, for convenient chaining
 */
export function buildEpubFixture(path, fields = {}, options = {}) {
  mkdirSync(dirname(path), { recursive: true });

  const opfPath = 'OEBPS/content.opf';
  const creators = (fields.authors ?? ['Fixture Author'])
    .map((a) => `    <dc:creator>${xmlEscape(a)}</dc:creator>`)
    .join('\n');
  const subjects = (fields.tags ?? [])
    .map((t) => `    <dc:subject>${xmlEscape(t)}</dc:subject>`)
    .join('\n');
  const extras = [
    fields.publisher && `    <dc:publisher>${xmlEscape(fields.publisher)}</dc:publisher>`,
    fields.date && `    <dc:date>${xmlEscape(fields.date)}</dc:date>`,
    fields.description && `    <dc:description>${xmlEscape(fields.description)}</dc:description>`,
    fields.language !== undefined && `    <dc:language>${xmlEscape(fields.language)}</dc:language>`,
    fields.series && `    <meta name="calibre:series" content="${xmlEscape(fields.series)}" />`,
    fields.index !== undefined && `    <meta name="calibre:series_index" content="${xmlEscape(fields.index)}" />`,
    fields.isbn && `    <dc:identifier id="isbn" opf:scheme="ISBN">${xmlEscape(fields.isbn)}</dc:identifier>`,
  ].filter(Boolean).join('\n');

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata>
    <dc:title>${xmlEscape(fields.title ?? 'Fixture Title')}</dc:title>
${creators}
${extras}
${subjects}
  </metadata>
  <manifest />
  <spine />
</package>`;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`;

  const entries = [zipEntry('mimetype', 'application/epub+zip', true)];
  if (!options.omitContainer) entries.push(zipEntry('META-INF/container.xml', container));
  entries.push(zipEntry('OEBPS/content.opf', opf));

  writeFileSync(path, buildZip(entries));
  return path;
}

/**
 * Write a minimal PDF with an Info dictionary referenced from its trailer.
 * @param {string} path destination file
 * @param {{title?:string, authors?:string[], publisher?:string, language?:string,
 *          date?:string, tags?:string[]}} fields metadata values
 * @returns {string} the same path, for convenient chaining
 */
export function buildPdfFixture(path, fields = {}) {
  mkdirSync(dirname(path), { recursive: true });

  const parts = [];
  if (fields.title !== undefined) parts.push(`/Title (${pdfEscape(fields.title)})`);
  if (fields.authors?.length) parts.push(`/Author (${pdfEscape(fields.authors[0])})`);
  if (fields.publisher !== undefined) parts.push(`/Publisher (${pdfEscape(fields.publisher)})`);
  if (fields.language !== undefined) parts.push(`/Language (${pdfEscape(fields.language)})`);
  if (fields.date !== undefined) parts.push(`/CreationDate (${pdfEscape(fields.date)})`);
  if (fields.tags?.length) parts.push(`/Subject (${pdfEscape(fields.tags.join(', '))})`);
  parts.push('/Producer (ebookmeta fixture)');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [] /Count 0 >>',
    `<< ${parts.join(' ')} >>`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  writeFileSync(path, pdf, 'latin1');
  return path;
}

/* ------------------------------------------------------------------ *
 * Assertions — direct execution only (controller ruling R1).
 * ------------------------------------------------------------------ */

async function runSuite() {
  const dir = mkdtempSync(join(tmpdir(), 'ebookmeta-'));
  try {
    // 1) EPUB: content sniffing plus dc:* metadata extraction.
    const epubPath = buildEpubFixture(join(dir, 'book.epub'), {
      title: 'The Fixture Chronicles',
      authors: ['Ada Lovelace', 'Grace Hopper'],
      language: 'en',
    });
    assert.equal(await detectFormat(epubPath), 'epub');
    const epubResult = await readMeta(epubPath);
    assert.equal(epubResult.ok, true);
    assert.equal(epubResult.status, 'ok');
    assert.equal(epubResult.format, 'epub');
    assert.equal(epubResult.fields.title, 'The Fixture Chronicles');
    assert.deepEqual(epubResult.fields.authors, ['Ada Lovelace', 'Grace Hopper']);
    assert.equal(epubResult.fields.language, 'en');

    // 2) PDF: title from the trailer's Info dictionary.
    const pdfPath = buildPdfFixture(join(dir, 'paper.pdf'), {
      title: 'A Paper About Things',
      authors: ['Alan Turing'],
    });
    assert.equal(await detectFormat(pdfPath), 'pdf');
    const pdfResult = await readMeta(pdfPath);
    assert.equal(pdfResult.ok, true);
    assert.equal(pdfResult.status, 'ok');
    assert.equal(pdfResult.format, 'pdf');
    assert.equal(pdfResult.fields.title, 'A Paper About Things');

    // 3) Unsupported bytes: a structured error, never a raw throw.
    const txtPath = join(dir, 'notes.txt');
    writeFileSync(txtPath, 'this is not a book');
    assert.equal(await detectFormat(txtPath), null);
    const unsupported = await readMeta(txtPath);
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.status, 'error');
    assert.match(unsupported.message, /unsupported format/i);
    assert.equal(unsupported.code, 'unsupported_format');

    // 4) Broken EPUB (container.xml removed): typed error, not a crash.
    const brokenPath = buildEpubFixture(
      join(dir, 'broken.epub'),
      { title: 'Broken Book' },
      { omitContainer: true },
    );
    const broken = await readMeta(brokenPath);
    assert.equal(broken.ok, false);
    assert.equal(broken.status, 'error');
    assert.equal(broken.code, 'malformed_epub');

    // 5) Extended EPUB fields: only present keys are returned.
    const richPath = buildEpubFixture(join(dir, 'rich.epub'), {
      title: 'Rich Book',
      authors: ['Solo Author'],
      language: 'zh',
      publisher: 'Fixture Press',
      date: '2026-11-26',
      description: 'A <book> & more',
      tags: ['one', 'two'],
      series: 'Great Series',
      index: '3',
      isbn: '978-0-00-000000-0',
    });
    const rich = await readMeta(richPath);
    assert.equal(rich.ok, true);
    assert.equal(rich.fields.publisher, 'Fixture Press');
    assert.equal(rich.fields.date, '2026-11-26');
    assert.equal(rich.fields.description, 'A <book> & more');
    assert.deepEqual(rich.fields.tags, ['one', 'two']);
    assert.equal(rich.fields.series, 'Great Series');
    assert.equal(rich.fields.index, '3');
    assert.equal(rich.fields.isbn, '978-0-00-000000-0');

    // 6) PDF string literals unescape \(, \) and \\.
    const escapedPath = buildPdfFixture(join(dir, 'escaped.pdf'), {
      title: 'A (quoted) \\ title',
    });
    const escaped = await readMeta(escapedPath);
    assert.equal(escaped.ok, true);
    assert.equal(escaped.fields.title, 'A (quoted) \\ title');

    // 7) MetaError carries a stable machine-readable code.
    const metaError = new MetaError('disk full', 'write_failed');
    assert.ok(metaError instanceof Error);
    assert.equal(metaError.name, 'MetaError');
    assert.equal(metaError.code, 'write_failed');

    console.log('test-ebookmeta: ALL PASS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSuite();
}
