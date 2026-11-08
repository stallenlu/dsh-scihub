/**
 * Human-friendly, *consistent* PDF file naming for dsh-scihub.
 *
 * The old behaviour named every file after its DOI (`10.1038_nature12373.pdf`).
 * Sci-Hub article pages carry citation metadata (Highwire / Google Scholar
 * meta tags, a `#citation` block, or at the very least a
 * `Sci-Hub | <title> | <doi>` <title>), so we read what is actually there,
 * fill a template, sanitise the result for the filesystem, and let savePdf()
 * de-duplicate collisions. Anything we cannot learn degrades gracefully to the
 * old DOI-based name — we never invent authors or a year.
 *
 * No dependencies: plain JavaScript, `node:` builtins only.
 */
import { pageTitle } from './http.mjs';

/** Default convention: `Watson (1953) Molecular structure of nucleic acids.pdf`. */
export const DEFAULT_FILE_NAME_TEMPLATE = '{firstAuthor} ({year}) {title}';

/** Keep individual file names well inside the 255-byte/char filesystem limits. */
export const MAX_NAME_CHARS = 120;

// Windows-illegal characters plus control characters. Everything else — CJK,
// accented letters, spaces, brackets — is kept, because humans read those.
const ILLEGAL_RE = /[\\/:*?"<>|\x00-\x1f\x7f]/g;
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function safeCodePoint(n) {
	if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
	try {
		return String.fromCodePoint(n);
	} catch {
		return '';
	}
}

function decodeEntities(text) {
	return String(text)
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
		.replace(/&(amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip);/gi, (match, name) => {
			const map = {
				amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
				nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
			};
			return map[name.toLowerCase()] ?? match;
		});
}

/** All `<meta>` tags as { name, content } pairs, in either attribute order. */
function metaTags(html) {
	const tags = [];
	const re = /<meta\b([^>]*)>/gi;
	let match;
	while ((match = re.exec(html))) {
		const attrs = match[1];
		const nameMatch = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(attrs);
		const contentMatch = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(attrs);
		if (nameMatch && contentMatch) {
			tags.push({
				name: nameMatch[1].toLowerCase(),
				content: decodeEntities(contentMatch[1]).trim(),
			});
		}
	}
	return tags;
}

function firstMeta(tags, names) {
	for (const wanted of names) {
		const hit = tags.find((tag) => tag.name === wanted);
		if (hit && hit.content) return hit.content;
	}
	return '';
}

function allMeta(tags, names) {
	return tags.filter((tag) => names.includes(tag.name) && tag.content).map((tag) => tag.content);
}

function yearOf(text) {
	const match = /\b(1[6-9]\d{2}|20\d{2}|21\d{2})\b/.exec(String(text || ''));
	return match ? match[1] : '';
}

function collectAuthors(tags) {
	const singles = allMeta(tags, ['citation_author', 'dc.creator', 'author']);
	const lists = allMeta(tags, ['citation_authors', 'dc.contributor']);
	const out = [];
	for (const value of singles) {
		const name = value.trim();
		if (name) out.push(name);
	}
	for (const value of lists) {
		for (const part of value.split(/;\s*/)) {
			const name = part.trim();
			if (name) out.push(name);
		}
	}
	return [...new Set(out)];
}

/** "Doe, John" → "Doe"; "John Doe" → "Doe". */
function surnameOf(name) {
	const clean = String(name || '').replace(/\s+/g, ' ').trim();
	if (!clean) return '';
	if (clean.includes(',')) return clean.split(',')[0].trim();
	const tokens = clean.split(' ').filter(Boolean);
	return tokens[tokens.length - 1] || clean;
}

/** Sci-Hub also renders a plain-text citation inside `<div id="citation">`. */
function citationBlock(html) {
	const match = /<div[^>]+id=["']citation["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
	if (!match) return '';
	return decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Recover whatever citation metadata the page gives us. All fields are best
 * effort: an absent field is an empty string / empty array, never a guess.
 */
export function parseCitation(html, doi) {
	const source = String(html || '');
	const tags = metaTags(source);
	const block = citationBlock(source);

	let title = firstMeta(tags, ['citation_title', 'dc.title', 'og:title', 'twitter:title']);
	if (!title) title = pageTitle(source) || '';
	title = title.replace(/\s+/g, ' ').trim();

	const authors = collectAuthors(tags);
	const firstAuthor = authors.length ? surnameOf(authors[0]) : '';

	let year = '';
	for (const key of [
		'citation_date', 'citation_publication_date', 'citation_online_date',
		'citation_year', 'dc.date', 'article:published_time',
	]) {
		const value = firstMeta(tags, [key]);
		if (value) {
			year = yearOf(value);
			if (year) break;
		}
	}
	if (!year && block) year = yearOf(block);

	const journal = firstMeta(tags, [
		'citation_journal_title', 'citation_conference_title',
		'citation_journal_abbrev', 'dc.source',
	]);

	return { title, year, authors, firstAuthor, journal, doi: doi || '' };
}

/** Substitute placeholders, then tidy the holes that missing values leave. */
function resolveTemplate(template, vars) {
	let out = String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
		const value = vars[key];
		if (value === undefined || value === null) return '';
		return Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value);
	});
	out = out
		.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
		.replace(/\s*[-_·|](?:\s*[-_·|])+\s*/g, ' - ')
		.replace(/\s{2,}/g, ' ')
		.replace(/^[\s\-_.·|,;]+|[\s\-_.·|,;]+$/g, '')
		.trim();
	return out;
}

/** Filesystem-safe, Unicode-friendly stem (no extension). */
export function sanitizeFileName(stem) {
	let out = decodeEntities(String(stem || ''))
		.replace(ILLEGAL_RE, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[.\s]+|[.\s]+$/g, '');
	const chars = Array.from(out);
	if (chars.length > MAX_NAME_CHARS) {
		out = chars.slice(0, MAX_NAME_CHARS).join('').replace(/[\s._-]+$/g, '');
	}
	if (!out) return 'article';
	// Windows device names (CON, NUL, COM1, ...) are not usable file names.
	if (RESERVED_RE.test(out)) return `_${out}`;
	return out;
}

/** The pre-0.4.1 naming, kept as the fallback when no metadata is available. */
function legacyStem(doi) {
	const cleaned = String(doi || '')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._]+|[._]+$/g, '')
		.slice(0, 150);
	return cleaned || 'article';
}

/**
 * Build the requested file name (always ending in `.pdf`).
 *
 * Placeholders: {title} {year} {firstAuthor} {author} {authors} {journal}
 * {doi} {stem} {n} {index} {total}. `{n}` is the zero-padded batch position,
 * `{index}` the unpadded one; both are empty for a single download.
 * An empty `fileNameTemplate` restores the legacy DOI-based names.
 */
export function buildPdfFileName(pluginConfig, context) {
	const template = pluginConfig && typeof pluginConfig.fileNameTemplate === 'string'
		? pluginConfig.fileNameTemplate
		: DEFAULT_FILE_NAME_TEMPLATE;
	const {
		doi = '', title = '', year = '', authors = [], firstAuthor = '',
		journal = '', index = '', total = '', inputStem = '',
	} = context || {};
	const n = index === '' || index === undefined || index === null
		? '' : String(index).padStart(2, '0');
	const vars = {
		title, year, authors, firstAuthor, author: firstAuthor, journal,
		doi, stem: inputStem, index, n, total,
	};
	const resolved = template ? resolveTemplate(template, vars) : '';
	let stem = resolved ? sanitizeFileName(resolved) : '';
	if (!stem) stem = legacyStem(doi || inputStem);
	if (!stem) stem = 'article';
	return `${stem}.pdf`;
}
