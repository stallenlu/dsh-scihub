/**
 * Offline httpGet method/headers/body tests. A local HTTP server echoes what
 * it received; no real network is touched.
 *
 * Run: node test-http-methods.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpGet, USER_AGENT } from './lib/http.mjs';

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const body = Buffer.concat(chunks).toString('utf8');
		if (req.url === '/echo') {
			if (req.method !== 'POST') {
				res.writeHead(405, { 'content-type': 'text/plain' });
				res.end('POST required');
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					method: req.method,
					xT: req.headers['x-t'] || null,
					ua: req.headers['user-agent'] || null,
					body,
				})
			);
			return;
		}
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end(`METHOD=${req.method}; UA=${req.headers['user-agent'] || ''}`);
	});
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

try {
	// 1) The break this catches: httpGet ignoring options.method/headers/body
	//    and issuing a GET. The server answers 405 unless it sees a real POST.
	const posted = await httpGet(`${base}/echo`, { method: 'POST', headers: { 'x-t': 'v' }, body: 'a=1' });
	assert.equal(posted.status, 200, 'POST /echo must answer 200 (RED: sent as GET)');
	assert.equal(posted.url, `${base}/echo`, 'response url is the requested URL');
	const echoed = JSON.parse(posted.body.toString('utf8'));
	assert.equal(echoed.method, 'POST', 'server must see the POST method');
	assert.equal(echoed.xT, 'v', 'custom header must be forwarded');
	assert.equal(echoed.body, 'a=1', 'string body must be written');
	assert.equal(echoed.ua, USER_AGENT, 'default UA survives the header merge');

	// 2) A Buffer body is written verbatim.
	const buffered = await httpGet(`${base}/echo`, {
		method: 'POST',
		headers: { 'x-t': 'buf' },
		body: Buffer.from('a=2'),
	});
	assert.equal(buffered.status, 200, 'Buffer POST /echo must answer 200');
	const bufferedEcho = JSON.parse(buffered.body.toString('utf8'));
	assert.equal(bufferedEcho.xT, 'buf', 'custom header forwarded on Buffer POST');
	assert.equal(bufferedEcho.body, 'a=2', 'Buffer body must be written');

	// 3) Backward compatibility: a legacy call is still a plain GET carrying
	//    the default browser UA, and the response shape is unchanged.
	const legacy = await httpGet(`${base}/legacy`);
	assert.equal(legacy.status, 200, 'legacy GET still returns 200');
	assert.equal(legacy.body.toString('utf8'), `METHOD=GET; UA=${USER_AGENT}`, 'legacy GET keeps the default UA');
	assert.equal(legacy.url, `${base}/legacy`, 'legacy response url unchanged');
} finally {
	await new Promise((resolve) => server.close(resolve));
}

console.log('test-http-methods: ALL PASS');
