/**
 * metasource — read-only online book-metadata lookup (v0.6.1 Task 3).
 *
 * Two sources, queried independently: Open Library and Google Books. A failed
 * source is ignored so the other source's candidates survive. Every string
 * that comes back from a remote response is treated as DATA: it is converted
 * with String(...) only, never evaluated or executed.
 *
 * Node built-ins only. No credentials, no API key, no child_process.
 */
import { httpGet } from './http.mjs';

export const METASOURCE_SOURCES = ['openlibrary', 'googlebooks'];

const DEFAULT_OPEN_LIBRARY_BASE = 'https://openlibrary.org';
const DEFAULT_GOOGLE_BOOKS_BASE = 'https://www.googleapis.com/books/v1';
const RESULT_LIMIT = 5;

/** Trim the book text to a plain string. Never evaluate remote content. */
function text(value) {
  return value === undefined || value === null ? undefined : String(value);
}

/** A repeated field (authors) becomes an array of plain strings. */
function textList(value) {
  if (value === undefined || value === null) return undefined;
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

function baseUrl(value, fallback) {
  return String(value || fallback).replace(/\/+$/, '');
}

/** GET a JSON endpoint. Throws on network/HTTP/parse failure so a failed
 * source is isolated by the caller's allSettled, not mixed into an empty
 * success. */
async function getJson(url) {
  const response = await httpGet(url);
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response ? response.status : 'no response'} for ${url}`);
  }
  return JSON.parse(response.body.toString('utf8'));
}

/* --------------------------------- sources --------------------------------- */

async function queryOpenLibrary({ title, author, isbn, base }) {
  const params = new URLSearchParams();
  if (title) params.set('title', String(title));
  if (author) params.set('author', String(author));
  if (isbn) params.set('isbn', String(isbn));
  params.set('limit', String(RESULT_LIMIT));

  const json = await getJson(`${base}/search.json?${params}`);
  const docs = json && Array.isArray(json.docs) ? json.docs : [];
  return docs.map((doc) => {
    const source = doc && typeof doc === 'object' ? doc : {};
    const fields = {};
    const t = text(source.title);
    if (t !== undefined) fields.title = t;
    const authors = textList(source.author_name);
    if (authors !== undefined) fields.authors = authors;
    const isbnList = Array.isArray(source.isbn) ? source.isbn : [source.isbn];
    const isbn0 = text(isbnList[0]);
    if (isbn0 !== undefined) fields.isbn = isbn0;
    const date = text(source.first_publish_year);
    if (date !== undefined) fields.date = date;
    return { source: 'openlibrary', fields, raw: source };
  });
}

async function queryGoogleBooks({ title, author, isbn, base }) {
  const qParts = [];
  if (title) qParts.push(String(title));
  if (author) qParts.push(String(author));
  if (isbn) qParts.push(String(isbn));
  const params = new URLSearchParams({ q: qParts.join(' '), maxResults: String(RESULT_LIMIT) });

  const json = await getJson(`${base}/volumes?${params}`);
  const items = json && Array.isArray(json.items) ? json.items : [];
  return items.map((item) => {
    const wrapper = item && typeof item === 'object' ? item : {};
    const info = wrapper.volumeInfo && typeof wrapper.volumeInfo === 'object' ? wrapper.volumeInfo : {};
    const fields = {};
    const t = text(info.title);
    if (t !== undefined) fields.title = t;
    const authors = textList(info.authors);
    if (authors !== undefined) fields.authors = authors;
    const publisher = text(info.publisher);
    if (publisher !== undefined) fields.publisher = publisher;
    const date = text(info.publishedDate);
    if (date !== undefined) fields.date = date;
    const description = text(info.description);
    if (description !== undefined) fields.description = description;
    return { source: 'googlebooks', fields, raw: info };
  });
}

/* --------------------------------- public API -------------------------------- */

/**
 * Look up book metadata across both sources.
 *
 * @param {{title?:string,author?:string,isbn?:string,
 *          limits?:{openLibraryBase?:string,googleBooksBase?:string}}} options
 * @returns {Promise<{ok:true,status:'ok',candidates:Array}|{ok:false,status:'error',message:string}>}
 */
export async function lookupMetadata({ title, author, isbn, limits = {} } = {}) {
  const openLibraryBase = baseUrl(limits.openLibraryBase, DEFAULT_OPEN_LIBRARY_BASE);
  const googleBooksBase = baseUrl(limits.googleBooksBase, DEFAULT_GOOGLE_BOOKS_BASE);

  const results = await Promise.allSettled([
    queryOpenLibrary({ title, author, isbn, base: openLibraryBase }),
    queryGoogleBooks({ title, author, isbn, base: googleBooksBase }),
  ]);

  const candidates = [];
  const failures = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      candidates.push(...result.value);
    } else {
      failures.push(`${METASOURCE_SOURCES[index]}: ${result.reason && result.reason.message ? result.reason.message : String(result.reason)}`);
    }
  });

  if (failures.length === METASOURCE_SOURCES.length) {
    return { ok: false, status: 'error', message: `all metadata sources failed (${failures.join('; ')})` };
  }
  return { ok: true, status: 'ok', candidates };
}
