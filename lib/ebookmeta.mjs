/**
 * ebookmeta — content-sniffed metadata reading for local EPUB/PDF files.
 *
 * Task 1 (v0.6.1) implements the read path. Task 2 adds atomic write helpers
 * (writeMeta / renameByMeta); fixture builders live in test-ebookmeta.mjs,
 * never here.
 *
 * Node built-ins only. No XML/PDF parser dependency: the EPUB OPF is read with
 * a small tag regex and the PDF Info dictionary with a bounded byte scanner.
 */
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { sanitizeFileName } from './naming.mjs';

/** Error with a stable machine-readable code, returned (not thrown) by readMeta. */
export class MetaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MetaError';
    this.code = code;
  }
}

const MAGIC_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\003\004
const MAGIC_PDF = '%PDF-';
const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * Sniff the file by magic bytes, never by its extension.
 * @param {string} path
 * @returns {Promise<'epub'|'pdf'|null>}
 */
export async function detectFormat(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    if (b.length >= MAGIC_ZIP.length && b.subarray(0, MAGIC_ZIP.length).equals(MAGIC_ZIP)) return 'epub';
    if (b.length >= MAGIC_PDF.length && b.toString('latin1', 0, MAGIC_PDF.length) === MAGIC_PDF) return 'pdf';
    return null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/* ------------------------------ shared helpers ----------------------------- */

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code) => {
    if (code[0] === '#') {
      const lower = code[1].toLowerCase();
      const value = lower === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : whole;
    }
    return ENTITY_MAP[code.toLowerCase()] ?? whole;
  });
}

function stripTags(inner) {
  return decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]) : undefined;
}

function takeAll(xml, localName) {
  const re = new RegExp(`<dc:${localName}\\b[^>]*>([\\s\\S]*?)<\\/dc:${localName}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => stripTags(m[1])).filter(Boolean);
}

function first(list) {
  return list.length ? list[0] : undefined;
}

/* --------------------------------- EPUB ------------------------------------ */

function readZipEntry(buf, entry) {
  const offset = entry.localOffset;
  if (offset < 0 || offset + 30 > buf.length || buf.readUInt32LE(offset) !== LOCAL_SIG) {
    throw new MetaError('malformed epub: bad local file header', 'malformed_epub');
  }
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (end > buf.length) throw new MetaError('malformed epub: truncated ZIP entry', 'malformed_epub');
  const payload = buf.subarray(start, end);
  if (entry.method === 0) return payload;
  if (entry.method === 8) {
    try {
      return inflateRawSync(payload);
    } catch {
      throw new MetaError('malformed epub: deflate failed', 'malformed_epub');
    }
  }
  throw new MetaError(`malformed epub: unsupported ZIP method ${entry.method}`, 'malformed_epub');
}

function parseOpfMeta(xml) {
  const fields = {};
  const title = first(takeAll(xml, 'title'));
  const authors = takeAll(xml, 'creator');
  const language = first(takeAll(xml, 'language'));
  const publisher = first(takeAll(xml, 'publisher'));
  const date = first(takeAll(xml, 'date'));
  const description = first(takeAll(xml, 'description'));
  const tags = takeAll(xml, 'subject');
  if (title !== undefined) fields.title = title;
  if (authors.length) fields.authors = authors;
  if (language !== undefined) fields.language = language;
  if (publisher !== undefined) fields.publisher = publisher;
  if (date !== undefined) fields.date = date;
  if (description !== undefined) fields.description = description;
  if (tags.length) fields.tags = tags;

  for (const tag of xml.match(/<meta\b[^>]*\/?>/gi) ?? []) {
    const name = attr(tag, 'name');
    const content = attr(tag, 'content');
    if (content === undefined) continue;
    if (name === 'calibre:series') fields.series = content;
    else if (name === 'calibre:series_index') fields.index = content;
  }

  const identifiers = [...xml.matchAll(/<dc:identifier\b([^>]*)>([\s\S]*?)<\/dc:identifier>/gi)];
  for (const [, attrs, inner] of identifiers) {
    const value = stripTags(inner);
    if (!value) continue;
    const joined = `${attrs} ${inner}`;
    if (/isbn|urn:isbn/i.test(joined)) {
      fields.isbn = value.replace(/^urn:isbn:/i, '').trim();
      break;
    }
  }
  return fields;
}

async function readEpubMeta(path) {
  const buf = await readFile(path);
  if (buf.length < 22) throw new MetaError('malformed epub: too short', 'malformed_epub');

  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new MetaError('malformed epub: no ZIP end-of-central-directory record', 'malformed_epub');

  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIG) {
      throw new MetaError('malformed epub: bad central directory', 'malformed_epub');
    }
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  const container = entries.get('META-INF/container.xml');
  if (!container) throw new MetaError('malformed epub: META-INF/container.xml not found', 'malformed_epub');
  const containerXml = readZipEntry(buf, container).toString('utf8');
  const rootfile = containerXml.match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i);
  if (!rootfile) throw new MetaError('malformed epub: no rootfile full-path', 'malformed_epub');
  const opf = entries.get(rootfile[1]);
  if (!opf) throw new MetaError('malformed epub: OPF rootfile not found', 'malformed_epub');
  return parseOpfMeta(readZipEntry(buf, opf).toString('utf8'));
}

/* ---------------------------------- PDF ------------------------------------ */

function readPdfString(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { raw: text.slice(start, i + 1), end: i + 1 };
    }
    i++;
  }
  return { raw: text.slice(start), end: text.length };
}

function decodePdfString(literal) {
  let s = literal.slice(1, -1).replace(/\\\r\n|\\\n|\r\n|\r/g, '\n');
  const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
  s = s.replace(/\\([nrtbf()\\])/g, (_, ch) => escapes[ch] ?? ch);
  s = s.replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8) & 0xff));
  return s;
}

function skipPdfValue(text, i) {
  const c = text[i];
  if (c === '(') return readPdfString(text, i).end;
  if (c === '<' && text[i + 1] === '<') {
    let depth = 0;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '<' && text[i + 1] === '<') { depth++; i += 2; continue; }
      if (text[i] === '>' && text[i + 1] === '>') { depth--; i += 2; if (depth === 0) return i; continue; }
      if (text[i] === '(') { i = readPdfString(text, i).end; continue; }
      i++;
    }
    return i;
  }
  if (c === '<') { const end = text.indexOf('>', i + 1); return end < 0 ? text.length : end + 1; }
  if (c === '[') {
    let depth = 0;
    while (i < text.length) {
      if (text[i] === '(') { i = readPdfString(text, i).end; continue; }
      if (text[i] === '[') depth++;
      else if (text[i] === ']') { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return i;
  }
  while (i < text.length && !/[\s/<>()[\]{}]/.test(text[i])) i++;
  return i;
}

function parsePdfDict(text) {
  const fields = {};
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] !== '/') { i = skipPdfValue(text, i) || i + 1; continue; }
    const keyStart = ++i;
    while (i < text.length && !/[\s/<>()[\]{}]/.test(text[i])) i++;
    const key = text.slice(keyStart, i);
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '(') {
      const str = readPdfString(text, i);
      fields[key] = decodePdfString(str.raw);
      i = str.end;
    } else {
      i = skipPdfValue(text, i) || i + 1;
    }
  }
  return fields;
}

function pdfFields(dict) {
  const fields = {};
  if (dict.Title !== undefined) fields.title = dict.Title;
  if (dict.Author !== undefined) fields.authors = [dict.Author];
  if (dict.Publisher !== undefined) fields.publisher = dict.Publisher;
  if (dict.Language !== undefined) fields.language = dict.Language;
  if (dict.CreationDate !== undefined || dict.ModDate !== undefined) {
    fields.date = dict.CreationDate ?? dict.ModDate;
  }
  const subject = dict.Subject ?? dict.Keywords;
  if (subject !== undefined) {
    const tags = subject.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
    if (tags.length) fields.tags = tags;
  }
  return fields;
}

async function readPdfMeta(path) {
  const text = await readFile(path, 'latin1');
  if (/\/Encrypt\b/.test(text)) {
    throw new MetaError('encrypted pdf: metadata is not readable', 'encrypted_pdf');
  }

  // An incremental update appends a newer trailer; the active /Info reference
  // is the LAST one in the file and its object may be redefined in a later xref
  // section. Use the last reference and last object definition so an updated
  // file reads its newest metadata, while single-version PDFs read unchanged.
  const infoRefs = [...text.matchAll(/\/Info\s+(\d+)\s+\d+\s+R/g)];
  const infoRef = infoRefs.length ? infoRefs[infoRefs.length - 1] : null;
  const objPattern = infoRef
    ? new RegExp(`(?:^|[^\\d])${infoRef[1]}\\s+\\d+\\s+obj\\b([\\s\\S]*?)endobj`, 'g')
    : /(?:^|[^\d])\d+\s+\d+\s+obj\b([\s\S]*?)endobj/g;

  if (infoRef) {
    const matches = [...text.matchAll(objPattern)];
    const m = matches.length ? matches[matches.length - 1] : null;
    if (!m) throw new MetaError('malformed pdf: Info object not found', 'malformed_pdf');
    const open = m[1].indexOf('<<');
    if (open < 0) throw new MetaError('malformed pdf: Info dictionary not found', 'malformed_pdf');
    const close = skipPdfValue(m[1], open);
    return pdfFields(parsePdfDict(m[1].slice(open + 2, close - 2)));
  }

  let found;
  while ((found = objPattern.exec(text))) {
    const open = found[1].indexOf('<<');
    if (open < 0) continue;
    const dict = parsePdfDict(found[1].slice(open + 2, skipPdfValue(found[1], open) - 2));
    const fields = pdfFields(dict);
    if (Object.keys(fields).length) return fields;
  }
  return {};
}

/* -------------------------------- dispatch --------------------------------- */

/**
 * Read embedded metadata. Always resolves to a `{ok,status,...}` result —
 * a MetaError is converted into a structured error, never thrown raw.
 * @param {string} path
 */
export async function readMeta(path) {
  let format = null;
  try {
    format = await detectFormat(path);
    if (!format) throw new MetaError(`unsupported format: ${path}`, 'unsupported_format');
    const fields = format === 'epub' ? await readEpubMeta(path) : await readPdfMeta(path);
    return { ok: true, status: 'ok', format, fields };
  } catch (err) {
    const code = err instanceof MetaError
      ? err.code
      : format === 'epub' ? 'malformed_epub' : format === 'pdf' ? 'malformed_pdf' : 'unsupported_format';
    return { ok: false, status: 'error', message: err?.message ?? String(err), code };
  }
}

/* ------------------------------ write helpers ------------------------------- */

function errResult(err, fallbackCode) {
  if (err instanceof MetaError) {
    return { ok: false, status: 'error', message: err.message, code: err.code };
  }
  return {
    ok: false,
    status: 'error',
    message: err?.message ?? String(err),
    code: err?.code && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)
      ? err.code
      : fallbackCode,
  };
}

/**
 * Atomically replace `path` with `bytes` via a unique sibling temp file.
 * On any failure the temp is unlinked and the original is left untouched.
 */
async function atomicReplace(path, bytes) {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/* --------------------------------- EPUB write ------------------------------- */

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Set a `<dc:localName>` group to exactly `values`: replace existing tags in
 * order, drop surplus tags, and append any values that have no tag yet. Tags
 * outside this localName (and all non-dc markup) are left untouched.
 */
function setDcValues(xml, localName, values) {
  const re = new RegExp(`<dc:${localName}\\b([^>]*)>[\\s\\S]*?<\\/dc:${localName}>`, 'gi');
  let index = 0;
  let out = xml.replace(re, (whole, attrs) => {
    const value = values[index++];
    return value === undefined ? '' : `<dc:${localName}${attrs}>${xmlEscape(value)}</dc:${localName}>`;
  });
  const remaining = values.slice(index);
  if (remaining.length) {
    const tags = remaining.map((v) => `  <dc:${localName}>${xmlEscape(v)}</dc:${localName}>`).join('\n');
    out = out.replace(/<\/metadata>/i, `${tags}\n</metadata>`);
  }
  return out;
}

function mergeOpfMetadata(xml, fields) {
  let out = xml;
  const single = {
    title: 'title',
    language: 'language',
    publisher: 'publisher',
    date: 'date',
    description: 'description',
  };
  for (const [key, localName] of Object.entries(single)) {
    if (fields[key] === undefined) continue;
    out = setDcValues(out, localName, [String(fields[key])]);
  }
  for (const [key, localName] of [['authors', 'creator'], ['tags', 'subject']]) {
    if (fields[key] === undefined) continue;
    const values = (Array.isArray(fields[key]) ? fields[key] : [fields[key]]).map(String);
    out = setDcValues(out, localName, values);
  }
  return out;
}

/** Rebuild the ZIP from its central directory, rewriting the OPF entry. */
async function writeEpubMeta(path, fields) {
  const buf = await readFile(path);
  if (buf.length < 22) throw new MetaError('malformed epub: too short', 'malformed_epub');

  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new MetaError('malformed epub: no ZIP end-of-central-directory record', 'malformed_epub');

  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  /** @type {{name:string,nameBuf:Buffer,method:number,crc:number,compSize:number,data:Buffer,payload:Buffer}[]} */
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIG) {
      throw new MetaError('malformed epub: bad central directory', 'malformed_epub');
    }
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const nameBuf = buf.subarray(pos + 46, pos + 46 + nameLen);
    const name = nameBuf.toString('utf8');
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + nameLen + localExtraLen;
    if (start + compSize > buf.length) throw new MetaError('malformed epub: truncated ZIP entry', 'malformed_epub');
    const payload = buf.subarray(start, start + compSize);
    if (method !== 0 && method !== 8) {
      throw new MetaError(`malformed epub: unsupported ZIP method ${method}`, 'malformed_epub');
    }
    const data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload);
    if (data.length !== uncompSize) throw new MetaError('malformed epub: size mismatch', 'malformed_epub');
    entries.push({ name, nameBuf, method, crc, compSize, data, payload });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  const container = entries.find((e) => e.name === 'META-INF/container.xml');
  if (!container) throw new MetaError('malformed epub: META-INF/container.xml not found', 'malformed_epub');
  const rootfile = container.data.toString('utf8')
    .match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i);
  if (!rootfile) throw new MetaError('malformed epub: no rootfile full-path', 'malformed_epub');
  const opf = entries.find((e) => e.name === rootfile[1]);
  if (!opf) throw new MetaError('malformed epub: OPF rootfile not found', 'malformed_epub');

  opf.data = Buffer.from(mergeOpfMetadata(opf.data.toString('utf8'), fields), 'utf8');
  for (const entry of entries) {
    entry.crc = crc32(entry.data);
    entry.payload = entry.method === 0 ? entry.data : deflateRawSync(entry.data);
    entry.compSize = entry.payload.length;
  }

  let offset = 0;
  const locals = [];
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compSize, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(entry.nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push({ entry, header, offset });
    offset += 30 + entry.nameBuf.length + entry.compSize;
  }

  const centralStart = offset;
  const centrals = [];
  for (const { entry, offset: localOffset } of locals) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIG, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compSize, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(entry.nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(localOffset, 42);
    centrals.push({ entry, header });
    offset += 46 + entry.nameBuf.length;
  }
  const centralSize = offset - centralStart;

  const eocdBuf = Buffer.alloc(22);
  eocdBuf.writeUInt32LE(EOCD_SIG, 0);
  eocdBuf.writeUInt16LE(0, 4);
  eocdBuf.writeUInt16LE(0, 6);
  eocdBuf.writeUInt16LE(entries.length, 8);
  eocdBuf.writeUInt16LE(entries.length, 10);
  eocdBuf.writeUInt32LE(centralSize, 12);
  eocdBuf.writeUInt32LE(centralStart, 16);
  eocdBuf.writeUInt16LE(0, 20);

  const out = Buffer.concat([
    ...locals.flatMap(({ entry, header }) => [header, entry.nameBuf, entry.payload]),
    ...centrals.flatMap(({ entry, header }) => [header, entry.nameBuf]),
    eocdBuf,
  ]);
  await atomicReplace(path, out);
  return { ok: true, bytes: out.length };
}

/* ---------------------------------- PDF write ------------------------------- */

function pdfLiteral(s) {
  return `(${String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

/** Incremental PDF update: append a new Info object, xref subsection + trailer. */
async function writePdfMeta(path, fields) {
  const buf = await readFile(path);
  const text = buf.toString('latin1');
  if (/\/Encrypt\b/.test(text)) {
    throw new MetaError('encrypted pdf: refusing to write metadata', 'encrypted_pdf');
  }

  // Resolve the Info dictionary that readMeta would use, so the merge keeps
  // existing values for fields not supplied by the caller.
  const existing = {};
  try {
    const infoRefs = [...text.matchAll(/\/Info\s+(\d+)\s+\d+\s+R/g)];
    const infoRef = infoRefs.length ? infoRefs[infoRefs.length - 1] : null;
    const objPattern = infoRef
      ? new RegExp(`(?:^|[^\\d])${infoRef[1]}\\s+\\d+\\s+obj\\b([\\s\\S]*?)endobj`, 'g')
      : /(?:^|[^\d])\d+\s+\d+\s+obj\b([\s\S]*?)endobj/g;
    let dictBody = null;
    if (infoRef) {
      const matches = [...text.matchAll(objPattern)];
      const m = matches.length ? matches[matches.length - 1] : null;
      if (m) {
        const open = m[1].indexOf('<<');
        if (open >= 0) {
          const close = skipPdfValue(m[1], open);
          dictBody = m[1].slice(open + 2, close - 2);
        }
      }
    } else {
      let found;
      while ((found = objPattern.exec(text))) {
        const open = found[1].indexOf('<<');
        if (open >= 0) { dictBody = found[1].slice(open + 2, skipPdfValue(found[1], open) - 2); break; }
      }
    }
    if (dictBody !== null) Object.assign(existing, pdfFields(parsePdfDict(dictBody)));
  } catch {
    // A malformed Info dictionary must not block a best-effort rewrite.
  }

  const merged = { ...existing, ...fields };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }

  const pairs = [];
  if (merged.title !== undefined) pairs.push(`/Title ${pdfLiteral(merged.title)}`);
  if (merged.authors?.length) pairs.push(`/Author ${pdfLiteral(merged.authors[0])}`);
  if (merged.publisher !== undefined) pairs.push(`/Publisher ${pdfLiteral(merged.publisher)}`);
  if (merged.language !== undefined) pairs.push(`/Language ${pdfLiteral(merged.language)}`);
  if (merged.date !== undefined) pairs.push(`/CreationDate ${pdfLiteral(merged.date)}`);
  if (merged.tags?.length) pairs.push(`/Subject ${pdfLiteral(merged.tags.join(', '))}`);
  pairs.push('/Producer (ebookmeta)');

  // Parse the previous xref/trailer chain to assign fresh object numbers and
  // to keep /Prev pointing at the previous startxref.
  const rootMatch = text.match(/\/Root\s+(\d+)\s+\d+\s+R/);
  const sizeMatch = [...text.matchAll(/\/Size\s+(\d+)/g)].map((m) => Number(m[1]));
  let maxObj = 0;
  for (const m of text.matchAll(/(?:^|[^\d])(\d+)\s+\d+\s+obj\b/g)) {
    maxObj = Math.max(maxObj, Number(m[1]));
  }
  const infoNum = maxObj + 1;
  const newSize = Math.max(infoNum + 1, ...sizeMatch);
  const startxrefMatch = [...text.matchAll(/startxref\s+(\d+)/g)];
  const prevStart = startxrefMatch.length ? Number(startxrefMatch[startxrefMatch.length - 1][1]) : 0;
  const rootRef = rootMatch ? `/Root ${rootMatch[1]} 0 R ` : '';

  let append = '';
  const infoOffset = buf.length + Buffer.byteLength(append, 'latin1');
  append += `${infoNum} 0 obj\n<< ${pairs.join(' ')} >>\nendobj\n`;
  const xrefOffset = buf.length + Buffer.byteLength(append, 'latin1');
  append += `xref\n${infoNum} 1\n${String(infoOffset).padStart(10, '0')} 00000 n \n`;
  append += `trailer\n<< /Size ${newSize} ${rootRef}/Info ${infoNum} 0 R`;
  if (prevStart > 0) append += ` /Prev ${prevStart}`;
  append += ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  const out = Buffer.concat([buf, Buffer.from(append, 'latin1')]);
  await atomicReplace(path, out);
  return { ok: true, bytes: out.length };
}

/* ------------------------------- public writer API -------------------------- */

/**
 * Write (merge) metadata into an EPUB or PDF, atomically.
 * @param {string} path
 * @param {{title?:string, authors?:string[], language?:string, publisher?:string,
 *          date?:string, description?:string, tags?:string[], series?:string,
 *          index?:string|number, isbn?:string}} fields
 */
export async function writeMeta(path, fields = {}) {
  let format = null;
  try {
    format = await detectFormat(path);
    if (!format) throw new MetaError(`unsupported format: ${path}`, 'unsupported_format');
    return format === 'epub' ? await writeEpubMeta(path, fields) : await writePdfMeta(path, fields);
  } catch (err) {
    return errResult(err, format === 'epub' ? 'malformed_epub' : 'malformed_pdf');
  }
}

/**
 * Rename a book in place to a sanitized `{title} — authors` stem, keeping its
 * extension and refusing to overwrite an existing target.
 * @param {string} path
 * @param {{title?:string, authors?:string[]}} fields
 */
export async function renameByMeta(path, fields = {}) {
  try {
    const format = await detectFormat(path);
    if (!format) throw new MetaError(`unsupported format: ${path}`, 'unsupported_format');

    const authors = Array.isArray(fields.authors) ? fields.authors.join(', ') : (fields.authors ?? '');
    const stem = sanitizeFileName(`${fields.title ?? ''}${authors ? ` — ${authors}` : ''}`);
    const ext = extname(path);
    const target = join(dirname(path), `${stem}${ext}`);
    const sameTarget = target === path;
    if (!sameTarget) {
      let exists = false;
      try {
        await open(target, 'r').then((h) => h.close());
        exists = true;
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      if (exists) {
        throw new MetaError(`target already exists: ${target}`, 'target_exists');
      }
    }

    // Keep the embedded metadata in sync with the new file name. This runs
    // after the overwrite check so a refused collision leaves the source
    // byte-identical.
    if (Object.keys(fields).length) {
      const written = await writeMeta(path, fields);
      if (!written.ok) throw new MetaError(written.message, written.code ?? 'write_failed');
    }

    if (!sameTarget) await rename(path, target);
    return { ok: true, path: target };
  } catch (err) {
    return errResult(err, 'rename_failed');
  }
}
