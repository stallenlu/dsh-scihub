/**
 * Offline proxy tests. Zero external network: a local HTTP server plays both
 * the CONNECT proxy and the origin, so the whole tunnel path (CONNECT -> TLS
 * or plaintext -> GET -> redirect) is exercised without DNS or a real mirror.
 *
 * Run: node test-proxy.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { getEventListeners } from 'node:events';
import { httpGet, resolveProxyUrl, setProxy } from './lib/http.mjs';

// ── 1) resolveProxyUrl: pure unit tests ───────────────────────────────────────
{
	const keys = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
	const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	const clear = () => keys.forEach((k) => delete process.env[k]);
	try {
		clear();
		assert.equal(resolveProxyUrl(new URL('https://example.com/x')), null, 'no env -> direct');

		process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
		assert.equal(resolveProxyUrl(new URL('https://example.com/x')).href, 'http://127.0.0.1:7897/', 'HTTPS_PROXY for https');
		assert.equal(resolveProxyUrl(new URL('http://example.com/x')), null, 'HTTPS_PROXY does not apply to http');

		clear();
		process.env.HTTP_PROXY = 'http://p:8080';
		assert.equal(resolveProxyUrl(new URL('http://example.com/x')).href, 'http://p:8080/', 'HTTP_PROXY for http');

		clear();
		process.env.ALL_PROXY = 'http://all:3128';
		assert.equal(resolveProxyUrl(new URL('https://example.com/x')).href, 'http://all:3128/', 'ALL_PROXY fallback');

		clear();
		process.env.ALL_PROXY = 'http://all:3128';
		process.env.NO_PROXY = 'example.com,.internal,localhost';
		assert.equal(resolveProxyUrl(new URL('https://example.com/x')), null, 'NO_PROXY exact host');
		assert.equal(resolveProxyUrl(new URL('https://sub.internal/x')), null, 'NO_PROXY suffix');
		assert.equal(resolveProxyUrl(new URL('https://other.org/x')).href, 'http://all:3128/', 'NO_PROXY non-match still proxied');

		clear();
		process.env.ALL_PROXY = 'http://all:3128';
		assert.equal(resolveProxyUrl(new URL('http://127.0.0.1:9999/x')), null, 'env proxy never intercepts loopback');
		assert.equal(resolveProxyUrl(new URL('http://192.168.1.1/x')), null, 'env proxy never intercepts RFC1918');
		assert.equal(
			resolveProxyUrl(new URL('http://127.0.0.1:9999/x'), 'http://127.0.0.1:7897').href,
			'http://127.0.0.1:7897/',
			'explicit proxy wins even for loopback targets'
		);

		clear();
		assert.equal(resolveProxyUrl(new URL('https://x/y'), 'not a url'), null, 'malformed explicit -> direct');
		assert.equal(resolveProxyUrl(new URL('https://x/y'), 'ftp://p'), null, 'non-http proxy scheme -> direct');
	} finally {
		keys.forEach((k) => {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		});
	}
}

// ── 2) fake CONNECT proxy ────────────────────────────────────────────────────
/** Each connect records the authority and answers the tunnelled GET inline. */
function startProxy(handler) {
	const connects = [];
	const seen = [];
	const server = http.createServer();
	server.on('connect', (req, socket, head) => {
		connects.push(req.url);
		socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
		const onData = (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			const end = buf.indexOf('\r\n\r\n');
			if (end < 0) return;
			const headText = buf.subarray(0, end).toString('latin1');
			seen.push(headText);
			socket.removeListener('data', onData);
			const out = handler(connects.length, headText);
			socket.end(
				`HTTP/1.1 ${out.status}\r\n` +
				(out.location ? `Location: ${out.location}\r\n` : '') +
				`Content-Type: ${out.type || 'text/plain'}\r\n` +
				`Content-Length: ${Buffer.byteLength(out.body || '')}\r\n` +
				'\r\n' + (out.body || '')
			);
		};
		socket.on('data', onData);
	});
	return { server, connects, seen };
}

function listen(server) {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// 2a) plain http target through the explicit proxy option
{
	const { server, connects, seen } = startProxy(() => ({ status: '200 OK', body: 'TUNNELED' }));
	const port = await listen(server);
	const proxy = `http://127.0.0.1:${port}`;
	try {
		const res = await httpGet('http://libgen.example/search?q=deep+learning', {
			proxy,
			accept: 'text/html',
			referer: 'http://libgen.example/',
		});
		assert.equal(res.status, 200);
		assert.equal(res.body.toString(), 'TUNNELED');
		assert.equal(connects[0], 'libgen.example:80', 'CONNECT authority is host:port');
		assert.match(seen[0], /^GET \/search\?q=deep\+learning HTTP\/1\.1/, 'GET line inside tunnel');
		assert.match(seen[0], /referer: http:\/\/libgen\.example\//i, 'referer forwarded');
		assert.match(seen[0], /user-agent: Mozilla/i, 'browser UA forwarded');
	} finally {
		await new Promise((r) => server.close(r));
	}
}

// 2b) redirect follows through a second CONNECT
{
	const { server, connects } = startProxy((n) =>
		n === 1
			? { status: '302 Found', location: 'http://libgen.example/final', body: '' }
			: { status: '200 OK', body: 'FINAL' }
	);
	const port = await listen(server);
	try {
		const res = await httpGet('http://libgen.example/start', { proxy: `http://127.0.0.1:${port}` });
		assert.equal(res.status, 200);
		assert.equal(res.body.toString(), 'FINAL');
		assert.equal(connects.length, 2, 'redirect creates a fresh tunnel');
	} finally {
		await new Promise((r) => server.close(r));
	}
}

// 2c) non-200 CONNECT is reported, not silently retried
{
	const server = http.createServer();
	server.on('connect', (_req, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
	const port = await listen(server);
	try {
		await assert.rejects(
			() => httpGet('http://libgen.example/x', { proxy: `http://127.0.0.1:${port}` }),
			/proxy CONNECT failed: HTTP 407/
		);
	} finally {
		await new Promise((r) => server.close(r));
	}
}

// 2d) setProxy() wires the plugin config into every httpGet call site
{
	const { server, connects } = startProxy(() => ({ status: '200 OK', body: 'OK' }));
	const port = await listen(server);
	try {
		setProxy(`http://127.0.0.1:${port}`);
		const res = await httpGet('http://libgen.example/via-config');
		assert.equal(res.body.toString(), 'OK');
		assert.equal(connects.length, 1, 'config proxy used with no per-call option');
	} finally {
		setProxy('');
		await new Promise((r) => server.close(r));
	}
}

// 2e) AbortSignal: listeners must not accumulate across many calls. The inner
// CONNECT request keeps one listener until Node clears it on the next tick, so
// the invariant is "never grows, and drains to zero", not "zero immediately".
{
	const { server } = startProxy(() => ({ status: '200 OK', body: 'x' }));
	const port = await listen(server);
	try {
		const ac = new AbortController();
		for (let i = 0; i < 15; i += 1) {
			await httpGet('http://libgen.example/x', { proxy: `http://127.0.0.1:${port}`, signal: ac.signal });
			assert.ok(getEventListeners(ac.signal, 'abort').length <= 1, `call ${i}: listener did not accumulate`);
		}
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'listeners drain to zero');
		await assert.rejects(
			() => httpGet('http://libgen.example/x', { proxy: `http://127.0.0.1:${port}`, signal: AbortSignal.abort() }),
			/abort/i
		);
	} finally {
		await new Promise((r) => server.close(r));
	}
}

console.log('test-proxy: ALL PASS');
