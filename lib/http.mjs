/**
 * Shared HTTP + article-page parsing for dsh-scihub.
 *
 * `node:https` instead of `fetch` on purpose: the Sci-Hub PDF CDN
 * (sci.bban.top) answers `fetch()` with an abort/timeout, while a plain
 * node:https request returns the PDF. Keep it that way.
 *
 * No dependencies — `node:` builtins only.
 */
import http from 'node:http';
import https from 'node:https';

export const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
export const PAGE_TIMEOUT_MS = 20000;
export const PDF_TIMEOUT_MS = 120000;
export const MAX_BYTES = 150 * 1024 * 1024;

/**
 * GET a URL following redirects. No `accept-encoding` is sent, so the response
 * is always identity-encoded and needs no decompression. `signal` is handed to
 * the native request (Node >= 15), which removes its own abort listener when
 * the request settles — a hand-rolled addEventListener would pile one up per
 * call and trip MaxListenersExceededWarning on a 50-item batch.
 */
export function httpGet(url, options = {}, redirectsLeft = 5) {
	const { referer, accept = '*/*', timeoutMs = PAGE_TIMEOUT_MS, signal } = options;
	return new Promise((resolvePromise, reject) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			reject(new Error(`invalid URL: ${url}`));
			return;
		}
		const client = parsed.protocol === 'http:' ? http : https;
		const request = client.get(
			parsed,
			{
				headers: {
					'user-agent': USER_AGENT,
					accept,
					'accept-language': 'en-US,en;q=0.9',
					...(referer ? { referer } : {}),
				},
				timeout: timeoutMs,
				signal,
			},
			(response) => {
				const status = response.statusCode || 0;
				const location = response.headers.location;
				if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
					response.resume();
					const next = new URL(location, parsed).href;
					resolvePromise(httpGet(next, options, redirectsLeft - 1));
					return;
				}
				const chunks = [];
				let total = 0;
				response.on('data', (chunk) => {
					total += chunk.length;
					if (total > MAX_BYTES) {
						request.destroy(new Error(`response exceeds ${MAX_BYTES} bytes`));
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () =>
					resolvePromise({ status, headers: response.headers, body: Buffer.concat(chunks), url: parsed.href })
				);
				response.on('error', reject);
			}
		);
		request.on('timeout', () => request.destroy(new Error(`timeout after ${timeoutMs} ms`)));
		request.on('error', reject);
	});
}

export function isPdf(buf) {
	return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function contentType(response) {
	const type = response.headers['content-type'];
	return Array.isArray(type) ? type[0] : type || 'unknown type';
}

export function errorMessage(error) {
	if (!error) return 'unknown error';
	if (error.code) return `${error.code} ${error.message}`;
	return error.message || String(error);
}

/**
 * The PDF URL an article page embeds. Sci-Hub emits
 *   <embed type="application/pdf" src="https://sci.bban.top/pdf/<doi>.pdf#view=FitH" id="pdf">
 * and a save button with a JSON-escaped copy of the same URL (`\\/`).
 */
export function findPdfUrl(html, pageUrl) {
	const patterns = [
		/<embed[^>]+src\s*=\s*["']([^"']+)["']/i,
		/<iframe[^>]+src\s*=\s*["']([^"']+\.pdf[^"']*)["']/i,
		/location\.href\s*=\s*['"]([^'"]+\.pdf[^'"]*)['"]/i,
		/["'](https?:\/\/[^"']+\.pdf[^"']*)["']/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(html);
		if (!match) continue;
		const cleaned = match[1].replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/#.*$/, '').trim();
		if (!cleaned || cleaned.startsWith('data:')) continue;
		try {
			return new URL(cleaned, pageUrl).href;
		} catch {
			// try the next pattern
		}
	}
	return null;
}

export function isChallenge(html) {
	return /challenges\.cloudflare\.com\/turnstile|are you (a )?robot|ddos-guard|checking your browser|verification - sci-hub/i.test(
		html
	);
}

/** "Sci-Hub | <title> | <doi>" → "<title>". */
export function pageTitle(html) {
	const match = /<title>([^<]*)<\/title>/i.exec(html);
	if (!match) return undefined;
	const title = match[1].replace(/\s+/g, ' ').trim();
	const parts = title.split('|').map((s) => s.trim());
	if (parts.length >= 2) {
		const inner = parts.slice(1, parts.length > 2 ? -1 : undefined).join(' | ').trim();
		if (inner && !/^10\.\d{4,9}\//.test(inner)) return inner;
		return undefined;
	}
	return title || undefined;
}
