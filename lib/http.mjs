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
import tls from 'node:tls';

export const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
export const PAGE_TIMEOUT_MS = 20000;
export const PDF_TIMEOUT_MS = 120000;
export const MAX_BYTES = 150 * 1024 * 1024;

/**
 * Proxy configured in the plugin settings. `httpGet` has ~10 call sites, so
 * rather than threading one more option through every signature the resolved
 * config is set once at apply() time. Direct library/script callers get the
 * standard environment variables instead.
 */
let configuredProxy = '';
export function setProxy(value) {
	configuredProxy = String(value || '');
}

/**
 * Whether a hostname is a literal loopback / private / link-local address.
 * DNS names that resolve into the private range are out of scope here — the
 * direct targets of an SSRF pivot (cloud metadata, the DSH local API, LAN
 * hosts) are all addressed by literal IP in practice.
 */
export function isPrivateHost(hostname) {
	const h = String(hostname || '').toLowerCase().replaceAll('[', '').replaceAll(']', '');
	if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
	const p = h.split('.');
	if (p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x))) {
		const a = Number(p[0]);
		const b = Number(p[1]);
		if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && (b === 168 || b === 0)) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
		if (a === 203 && b === 0) return true;
		return false;
	}
	if (h === '::1' || h === '::') return true;
	for (const pre of ['fc', 'fd', 'fe8', 'fe9', 'fea', 'feb', '::ffff:127.', '::ffff:10.', '::ffff:192.168.', '::ffff:169.254.']) {
		if (h.startsWith(pre)) return true;
	}
	return false;
}

/**
 * Guard a URL that came out of untrusted remote content: a redirect target or a
 * PDF link scraped from an article page. It must be http(s), and it may not
 * pivot into the local network on a *different* host than the one that produced
 * it. Pointing back at the same host is fine (the offline tests' loopback mirror
 * serves both the page and the PDF), as is any public host (Sci-Hub pages
 * legitimately embed PDFs from a CDN on another domain).
 */
export function assertSafeDerivedUrl(candidate, sourceHost) {
	const url = typeof candidate === 'string' ? new URL(candidate) : candidate;
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`refusing non-http(s) URL derived from a remote response: ${url.protocol}`);
	}
	if (isPrivateHost(url.hostname) && url.host.toLowerCase() !== String(sourceHost || '').toLowerCase()) {
		throw new Error(`refusing to follow a remote response into the local network: ${url.host}`);
	}
	return url.href;
}

// ── proxy ────────────────────────────────────────────────────────────────────

function envProxy(target) {
	const specific = target.protocol === 'https:'
		? process.env.HTTPS_PROXY || process.env.https_proxy
		: process.env.HTTP_PROXY || process.env.http_proxy;
	return specific || process.env.ALL_PROXY || process.env.all_proxy || '';
}

function noProxyMatches(host) {
	const raw = process.env.NO_PROXY || process.env.no_proxy || '';
	const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
	return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((entry) => {
		const e = entry.replace(/^\./, '').replace(/:\d+$/, '');
		return e === '*' || h === e || h.endsWith(`.${e}`);
	});
}

/**
 * Pick the proxy for this request, or null for a direct connection.
 * An explicitly configured proxy (plugin config or `options.proxy`) wins; a
 * proxy taken from the environment never intercepts literal local/private
 * targets, which keeps the offline loopback mirrors working on machines that
 * happen to have HTTP_PROXY set.
 */
export function resolveProxyUrl(target, explicit = '') {
	const configured = String(explicit || '');
	const raw = configured || (!isPrivateHost(target.hostname) ? envProxy(target) : '');
	if (!raw || noProxyMatches(target.host)) return null;
	try {
		const proxy = new URL(raw.includes('://') ? raw : `http://${raw}`);
		if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') return null;
		return proxy;
	} catch {
		return null;
	}
}

/**
 * A `createConnection` for the http/https client that first opens a CONNECT
 * tunnel through the proxy. For https targets the tunnelled socket is wrapped
 * in TLS here; `agent: false` makes the client use it as-is (it would otherwise
 * try a second handshake / its own socket pool).
 */
function tunnelConnection(proxy, target, timeoutMs, signal) {
	const port = target.port || (target.protocol === 'https:' ? 443 : 80);
	const authority = `${target.hostname}:${port}`;
	const client = proxy.protocol === 'https:' ? https : http;
	return (_options, callback) => {
		const headers = { Host: authority };
		if (proxy.username) {
			const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
			headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
		}
		const req = client.request({
			hostname: proxy.hostname,
			port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
			method: 'CONNECT',
			path: authority,
			headers,
			agent: false,
			signal,
		});
		req.once('connect', (res, socket, head) => {
			// The CONNECT request is over; its timeout must not kill a long PDF
			// download that shares this socket from here on.
			req.setTimeout(0);
			socket.setTimeout(0);
			if (res.statusCode !== 200) {
				socket.destroy();
				callback(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
				return;
			}
			if (head && head.length) socket.unshift(head);
			if (target.protocol === 'https:') {
				const secure = tls.connect({ socket, servername: target.hostname }, () => callback(null, secure));
				secure.once('error', callback);
			} else {
				callback(null, socket);
			}
		});
		req.once('error', callback);
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`proxy CONNECT timeout after ${timeoutMs} ms`)));
		req.end();
	};
}

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
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			reject(new Error(`unsupported URL scheme: ${parsed.protocol}`));
			return;
		}
		const client = parsed.protocol === 'http:' ? http : https;
		const proxy = resolveProxyUrl(parsed, options.proxy !== undefined ? options.proxy : configuredProxy);
		// `agent: false` would make Node build a *plain* one-off Agent that throws
		// away our createConnection, so hand it a real Agent with the tunnel
		// installed explicitly. No proxy → no agent option → normal global agent.
		let agent;
		if (proxy) {
			agent = new client.Agent({ keepAlive: false });
			agent.createConnection = tunnelConnection(proxy, parsed, timeoutMs, signal);
		}
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
				...(agent ? { agent } : {}),
			},
			(response) => {
				const status = response.statusCode || 0;
				const location = response.headers.location;
				if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
					response.resume();
					let next;
					try {
						next = assertSafeDerivedUrl(new URL(location, parsed), parsed.host);
					} catch (error) {
						reject(error);
						return;
					}
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
		if (agent) request.on('close', () => agent.destroy());
	});
}

export function isPdf(buf) {
	return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * A response that declares more bytes than it delivered was cut short. A PDF
 * with a valid `%PDF-` header can still be truncated, so every download path
 * must check this before saving — otherwise half a file looks like a success.
 */
export function truncationReason(response) {
	const declared = Number(response.headers && response.headers['content-length']);
	if (Number.isFinite(declared) && declared > 0 && response.body.length < declared) {
		return `truncated: got ${response.body.length} of ${declared} bytes`;
	}
	return null;
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
			const resolved = new URL(cleaned, pageUrl);
			return assertSafeDerivedUrl(resolved, new URL(pageUrl).host);
		} catch {
			// try the next pattern
		}
	}
	return null;
}

export function isChallenge(html) {
	// The last five phrases are generic Cloudflare / DDoS-Guard interstitial
	// wording. Without them a LibGen "Just a moment..." page is misreported as
	// "no result rows" (not_found) instead of "we were challenged".
	return /challenges\.cloudflare\.com\/turnstile|are you (a )?robot|ddos-guard|checking your browser|verification - sci-hub|just a moment|attention required|cf-browser-verification|cf_chl_|enable javascript (and )?cookies|verify you are human|please wait while we (verify|check)/i.test(
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
