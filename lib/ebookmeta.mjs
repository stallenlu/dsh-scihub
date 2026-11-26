/**
 * ebookmeta — content-sniffed metadata reading for local EPUB/PDF files.
 *
 * Task 1 (v0.6.1) implements the read path only. Writer helpers arrive in a
 * later task; fixture builders live in test-ebookmeta.mjs, never here.
 *
 * Node built-ins only. No XML/PDF parser dependency: the EPUB OPF is read with
 * a small tag regex and the PDF Info dictionary with a bounded byte scanner.
 */
import { open, readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

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

  const infoRef = text.match(/\/Info\s+(\d+)\s+\d+\s+R/);
  const objPattern = infoRef
    ? new RegExp(`(?:^|[^\\d])${infoRef[1]}\\s+\\d+\\s+obj\\b([\\s\\S]*?)endobj`, 'g')
    : /(?:^|[^\d])\d+\s+\d+\s+obj\b([\s\S]*?)endobj/g;

  if (infoRef) {
    const m = objPattern.exec(text);
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
