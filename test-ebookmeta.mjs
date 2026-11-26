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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

import * as ebookmeta from './lib/ebookmeta.mjs';

const { MetaError, detectFormat, readMeta } = ebookmeta;
// Task 2 exports are intentionally resolved through the namespace so that the
// RED phase reports clean "missing feature" assertions instead of a link error.
const { writeMeta, renameByMeta } = ebookmeta;

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

/**
 * Write an encrypted-shaped PDF (a `/Encrypt` reference in its trailer),
 * used to verify that writeMeta refuses encrypted files without touching bytes.
 * @param {string} path destination file
 * @returns {string} the same path, for convenient chaining
 */
export function buildEncryptedPdfFixture(path) {
  mkdirSync(dirname(path), { recursive: true });
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [] /Count 0 >>',
    '<< /Title (Locked) >>',
    '<< /Filter /Standard /V 1 /R 2 /O () /U () /P -4 >>',
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
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R /Encrypt 4 0 R >>\n`;
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

    // --- Task 2: write path / atomicity / rename -------------------------------

    // 8) EPUB round-trip: write replaces dc:* values, file stays a valid ZIP.
    const epubWritePath = buildEpubFixture(join(dir, 'write.epub'), {
      title: 'Old Title',
      authors: ['Old Author'],
      language: 'en',
    });
    const epubWrite = await writeMeta(epubWritePath, {
      title: 'New Title',
      authors: ['A. Author'],
    });
    assert.equal(epubWrite.ok, true, `EPUB write failed: ${epubWrite.message}`);
    assert.equal(typeof epubWrite.bytes, 'number');
    assert.ok(epubWrite.bytes > 0);
    const epubAfter = await readMeta(epubWritePath);
    assert.equal(epubAfter.ok, true, `EPUB unreadable after write: ${epubAfter.message}`);
    assert.equal(epubAfter.fields.title, 'New Title');
    assert.deepEqual(epubAfter.fields.authors, ['A. Author']);
    // Untouched dc:* value survives the merge.
    assert.equal(epubAfter.fields.language, 'en');

    // 9) PDF round-trip: incremental update keeps original bytes as a prefix.
    const pdfWritePath = buildPdfFixture(join(dir, 'write.pdf'), {
      title: 'Old Paper',
      authors: ['Old Author'],
    });
    const pdfOriginal = readFileSync(pdfWritePath);
    const pdfWrite = await writeMeta(pdfWritePath, { title: 'New Paper' });
    assert.equal(pdfWrite.ok, true, `PDF write failed: ${pdfWrite.message}`);
    const pdfNew = readFileSync(pdfWritePath);
    assert.ok(pdfNew.length > pdfOriginal.length, 'incremental update must append');
    assert.ok(pdfNew.subarray(0, pdfOriginal.length).equals(pdfOriginal),
      'original PDF bytes must be a strict prefix of the updated file');
    const pdfAfter = await readMeta(pdfWritePath);
    assert.equal(pdfAfter.ok, true, `PDF unreadable after write: ${pdfAfter.message}`);
    assert.equal(pdfAfter.fields.title, 'New Paper');

    // 10) Encrypted PDF: typed error and byte-identical file.
    const encryptedPath = buildEncryptedPdfFixture(join(dir, 'locked.pdf'));
    const encryptedBefore = readFileSync(encryptedPath);
    const encryptedResult = await writeMeta(encryptedPath, { title: 'Should Not Apply' });
    assert.equal(encryptedResult.ok, false);
    assert.equal(encryptedResult.code, 'encrypted_pdf');
    assert.ok(readFileSync(encryptedPath).equals(encryptedBefore),
      'encrypted PDF must remain byte-identical');

    // 11) Unwritable directory: error, no temp leak, original bytes unchanged.
    const roDir = mkdtempSync(join(tmpdir(), 'ebookmeta-ro-'));
    try {
      const roPath = join(roDir, 'readonly.epub');
      buildEpubFixture(roPath, { title: 'Untouched' });
      const roBefore = readFileSync(roPath);
      if (process.platform !== 'win32') {
        chmodSync(roDir, 0o500);
        try {
          const roResult = await writeMeta(roPath, { title: 'Nope' });
          assert.equal(roResult.ok, false);
          assert.ok(readFileSync(roPath).equals(roBefore),
            'original bytes unchanged after failed atomic write');
          assert.deepEqual(readdirSync(roDir).filter((n) => n.endsWith('.tmp')), [],
            'no .tmp file may be left behind');
        } finally {
          chmodSync(roDir, 0o700);
        }
      } else {
        console.log('  [skip] read-only directory test on Windows (chmod not enforced)');
      }
    } finally {
      rmSync(roDir, { recursive: true, force: true });
    }

    // 12) renameByMeta success: sanitized "{title} — authors", same dir + ext.
    const renameSrc = buildEpubFixture(join(dir, 'rename-me.epub'), { title: 'Old' });
    const renamed = await renameByMeta(renameSrc, {
      title: 'A/B: Title?', authors: ['Doe, Jane'],
    });
    assert.equal(renamed.ok, true, `rename failed: ${renamed.message}`);
    assert.equal(dirname(renamed.path), dir);
    assert.match(renamed.path, /\.epub$/);
    assert.equal(renamed.path, join(dir, 'A B Title — Doe, Jane.epub'));
    assert.equal((await readMeta(renamed.path)).fields.title, 'A/B: Title?');

    // 13) renameByMeta refuses to overwrite an existing target.
    const collideSrc = buildPdfFixture(join(dir, 'collide.pdf'), { title: 'Source' });
    const collideDst = join(dir, 'Taken — Author.pdf');
    writeFileSync(collideDst, 'existing target must survive');
    const collide = await renameByMeta(collideSrc, { title: 'Taken', authors: ['Author'] });
    assert.equal(collide.ok, false);
    assert.ok(readFileSync(collideDst).toString() === 'existing target must survive');
    assert.ok(readFileSync(collideSrc).length > 0, 'source file must remain intact');

    // No temp files left in the main fixture directory either.
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [],
      'no .tmp files may remain after all writes');

    console.log('test-ebookmeta: ALL PASS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSuite();
}
