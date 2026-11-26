/**
 * Offline Z-Library EAPI tests. A local fake EAPI server exercises login,
 * auth headers/cookies, envelope parsing, quota and session expiry — no real
 * network, no third-party deps, no credential values in the test output.
 *
 * Run: node test-zlib.mjs
 *
 * NOTE: this file is shared. Later tasks (T3/T4/T5) APPEND their own assertion
 * blocks below; never rewrite or remove the blocks above them. Helpers declared
 * here (FAKE_*, ENV_KEYS, temporaryEnv, startFakeEapi, captureConsole,
 * assertNoCredentialLeak) are intentionally top-level for reuse.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveZlibFile } from './lib/host.mjs';
import {
	getSession,
	zlibDownload,
	eapiRequest,
	zlibStatus,
	zlibSearch,
	zlibGetBook,
	zlibProfile,
	zlibSaved,
	zlibHistory,
	zlibDeleteHistory,
	zlibCheckDomains,
	STATUS_NOT_CONFIGURED,
	STATUS_SESSION_EXPIRED,
	STATUS_DOMAIN_UNREACHABLE,
	STATUS_QUOTA_EXHAUSTED,
	STATUS_ERROR,
	STATUS_OK,
} from './lib/zlib-api.mjs';

// Test-only fake credentials. They are never printed, echoed or written to disk.
const FAKE_EMAIL = 'zlib-tester@example.test';
const FAKE_PASSWORD = 'fake-pass-Zlib-Test-8472';
const FAKE_USERID = '424242';
const FAKE_USERKEY = 'fake-userkey-zlib-token-5513';
const FAKE_QUOTA = { limit: 10, used: 3 };
const WRONG_PASSWORD = 'wrong-pass-Zlib-Test-9921';

const ENV_KEYS = ['ZLIB_EMAIL', 'ZLIB_PASSWORD', 'ZLIB_COOKIE', 'ZLIB_DOMAIN'];
const SECRETS = [FAKE_EMAIL, FAKE_PASSWORD, WRONG_PASSWORD, FAKE_USERKEY];

/** Save/restore the ZLIB_* env keys around an async assertion block. */
async function temporaryEnv(values, fn) {
	const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
	for (const [k, v] of Object.entries(values)) {
		if (!ENV_KEYS.includes(k)) throw new Error(`temporaryEnv: unexpected key ${k}`);
		process.env[k] = v;
	}
	try {
		return await fn();
	} finally {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

/** Start a fake EAPI server. `state.expired`/`state.exhausted` can be flipped mid-test. */
async function startFakeEapi({ expired = false, exhausted = false, rootMode = 'ok', cdnMode = 'pdf' } = {}) {
	const state = { expired, exhausted, rootMode, cdnMode, logins: 0, requests: [], deleted: [], cdnHits: [] };
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const bodyText = Buffer.concat(chunks).toString('utf8');
			state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: bodyText });
			const send = (code, obj) => {
				res.writeHead(code, { 'content-type': 'application/json' });
				res.end(JSON.stringify(obj));
			};
			const path = String(req.url || '').split('?')[0];
			if (path === '/eapi/user/login') {
				state.logins += 1;
				const params = new URLSearchParams(bodyText);
				if (params.get('email') === FAKE_EMAIL && params.get('password') === FAKE_PASSWORD) {
					// Legacy alias is accepted by the client; send the modern name here.
					return send(200, { success: 1, user: { id: FAKE_USERID }, remix_userkey: FAKE_USERKEY });
				}
				return send(400, { success: 0, error: 'Invalid credentials' });
			}
			if (path === '/eapi/user/profile') {
				const h = req.headers;
				const cookie = String(h.cookie || '');
				const hasAuth =
					h.source === 'android' &&
					h['remix-userid'] === FAKE_USERID &&
					h['remix-userkey'] === FAKE_USERKEY &&
					cookie.includes(`remix_userid=${FAKE_USERID}`) &&
					cookie.includes(`remix_userkey=${FAKE_USERKEY}`);
				if (!hasAuth) return send(403, { success: 0, error: 'Access denied' });
				if (state.expired) return send(400, { success: 0, error: 'Invalid credentials' });
				if (state.exhausted) return send(200, { success: 1, quota: { limit: 5, used: 5 } });
				return send(200, { success: 1, quota: { ...FAKE_QUOTA } });
			}
			// ── T3 routes (additive; T2 login/profile/expiry behavior untouched) ──
			const h = req.headers;
			const cookie = String(h.cookie || '');
			const hasAuth =
				h.source === 'android' &&
				h['remix-userid'] === FAKE_USERID &&
				h['remix-userkey'] === FAKE_USERKEY &&
				cookie.includes(`remix_userid=${FAKE_USERID}`) &&
				cookie.includes(`remix_userkey=${FAKE_USERKEY}`);

			if (path === '/eapi/book/search' && req.method === 'POST') {
				if (!hasAuth) return send(403, { success: 0, error: 'Access denied' });
				const params = new URLSearchParams(bodyText);
				const echoed = {};
				for (const key of new Set(params.keys())) {
					echoed[key] = key.endsWith('[]') ? params.getAll(key) : params.get(key);
				}
				return send(200, { success: 1, books: [{ id: '1', hash: 'abc', title: 'Fake Book' }], echoed });
			}
			const detailMatch = /^\/eapi\/book\/([^/]+)\/([^/]+)$/.exec(path);
			if (detailMatch && req.method === 'GET') {
				if (!hasAuth) return send(403, { success: 0, error: 'Access denied' });
				return send(200, { success: 1, book: { id: detailMatch[1], hash: detailMatch[2], title: 'Fake Book' } });
			}
			if (path === '/eapi/user/book/saved' && req.method === 'GET') {
				if (!hasAuth) return send(403, { success: 0, error: 'Access denied' });
				const page = new URL(req.url, 'http://x').searchParams.get('page');
				return send(200, { success: 1, books: [{ id: '42', title: 'Saved One' }], echoed: { page } });
			}
			if (path === '/eapi/user/book/downloaded' && req.method === 'GET') {
				if (!hasAuth) return send(403, { success: 0, error: 'Access denied' });
				const page = new URL(req.url, 'http://x').searchParams.get('page');
				return send(200, { success: 1, books: [{ id: '43', title: 'Downloaded One' }], echoed: { page } });
			}
			const deleteMatch = /^\/eapi\/user\/book\/([^/]+)\/delete$/.exec(path);
			if (deleteMatch && req.method === 'GET') {
				if (!hasAuth) return send(403, { success: 0, error: 'Access denied' });
				state.deleted.push(deleteMatch[1]);
				return send(200, { success: 1, deleted: deleteMatch[1] });
			}
			// ── T4 routes (additive; T2/T3 behavior untouched) ──
			const origin = `http://${req.headers.host}`;
			const fileMatch = /^\/eapi\/book\/([^/]+)\/([^/]+)\/file$/.exec(path);
			if (fileMatch && req.method === 'GET') {
				if (!hasAuth) return send(403, { success: 0, error: 'Access denied' });
				const [, id, hash] = fileMatch;
				return send(200, {
					success: 1,
					url: `${origin}/cdn/${id}/${hash}`,
					book: { id, hash, title: 'Zlib Test Book', author: 'Ada Lovelace', year: '2020' },
				});
			}
			const cdnMatch = /^\/cdn\/([^/]+)\/([^/]+)$/.exec(path);
			if (cdnMatch && req.method === 'GET') {
				state.cdnHits.push({ url: req.url, headers: { ...req.headers } });
				if (cdnMode === 'html') {
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
					return res.end('<html><head><title>Just a moment...</title></head><body>Checking your browser before we continue</body></html>');
				}
				if (cdnMode === 'truncated') {
					const short = Buffer.from('%PDF-1.4 partial-body', 'latin1');
					res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(short.length + 100) });
					res.write(short);
					return res.socket.destroy();
				}
				if (cdnMode === 'epub') {
					const epub = Buffer.from('PK\x03\x04 zlib-epub ' + 'e'.repeat(40), 'latin1');
					res.writeHead(200, { 'content-type': 'application/epub+zip' });
					return res.end(epub);
				}
				const pdf = Buffer.from('%PDF-1.4 zlib-test ' + 'y'.repeat(48), 'latin1');
				res.writeHead(200, { 'content-type': 'application/pdf' });
				return res.end(pdf);
			}
			// Domain probe target for zlibCheckDomains: lightweight HTML, no creds.
			if (path === '/') {
				if (rootMode === 'fail') {
					res.writeHead(500, { 'content-type': 'text/html' });
					return res.end('<html><body>server error</body></html>');
				}
				if (rootMode === 'challenge') {
					res.writeHead(200, { 'content-type': 'text/html' });
					return res.end('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
				}
				res.writeHead(200, { 'content-type': 'text/html' });
				return res.end('<html><body>Z-Library</body></html>');
			}
			if (path === '/eapi/test/fail') {
				return send(418, { success: 0, error: '原始错误 Raw Error' });
			}
			return send(404, { success: 0, error: 'not found' });
		});
	});
	const listening = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
	return {
		server,
		state,
		base: `http://127.0.0.1:${await listening}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/** Capture console output so credential-leak assertions see the real output. */
async function captureConsole(fn) {
	const methods = ['log', 'warn', 'error', 'info', 'debug'];
	const original = Object.fromEntries(methods.map((m) => [m, console[m]]));
	const lines = [];
	for (const m of methods) console[m] = (...args) => lines.push(args.map((x) => String(x)).join(' '));
	try {
		return { result: await fn(), lines };
	} finally {
		for (const m of methods) console[m] = original[m];
	}
}

/** Fail if any captured output text contains a fake credential value. */
function assertNoCredentialLeak(lines) {
	const text = lines.join('\n');
	for (const secret of SECRETS) {
		assert.ok(!text.includes(secret), 'test output leaked a credential value');
	}
}

/** Fail if a returned object/string contains a fake credential value. */
function assertNoCredentialsIn(value) {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	for (const secret of SECRETS) {
		assert.ok(!text.includes(secret), 'returned value leaked a credential value');
	}
}

// ── T2.1: no credentials -> not_configured, no login attempted ────────────────
await temporaryEnv({}, async () => {
	const { result, lines } = await captureConsole(async () => {
		const status = await zlibStatus();
		assert.equal(status.ok, false, 'no creds: ok is false');
		assert.equal(status.status, STATUS_NOT_CONFIGURED, 'no creds: not_configured');
		assert.equal(status.loggedIn, false, 'no creds: not logged in');
		assert.equal(status.quota, null, 'no creds: quota is null');
		assert.match(status.message, /未配置/, 'no creds: Chinese guidance message');
		return status;
	});
	assertNoCredentialLeak(lines);
	assertNoCredentialsIn(result);
});

// ── T2.2: bad credentials -> classified failure, never not_configured ─────────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: WRONG_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const status = await zlibStatus();
					assert.equal(status.ok, false, 'bad creds: ok is false');
					assert.equal(status.loggedIn, false, 'bad creds: not logged in');
					assert.equal(status.status, STATUS_ERROR, 'bad creds: classified error (not session_expired)');
					assert.notEqual(status.status, STATUS_NOT_CONFIGURED, 'bad creds are configured');
					assert.notEqual(status.status, STATUS_SESSION_EXPIRED, 'bad login is NOT session expiry');
					assert.match(status.message, /登录|失败/, 'bad creds: Chinese login-failure message');
					return status;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
				assert.equal(fx.state.logins, 1, 'bad creds: login was attempted once');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T2.3: valid login -> loggedIn + quota; auth headers and cookies present ───
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const status = await zlibStatus();
					assert.equal(status.ok, true, 'valid login: ok is true');
					assert.equal(status.loggedIn, true, 'valid login: loggedIn is true');
					assert.equal(status.status, 'ok', 'valid login: status ok');
					assert.equal(status.domain, fx.base, 'valid login: domain reported');
					assert.deepEqual(status.quota, FAKE_QUOTA, 'valid login: quota parsed from profile');
					return status;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);

				const login = fx.state.requests.find((r) => r.url === '/eapi/user/login');
				assert.ok(login, 'login request was sent');
				assert.equal(login.method, 'POST', 'login uses POST');
				assert.equal(new URLSearchParams(login.body).get('email'), FAKE_EMAIL, 'login form has email');
				assert.equal(new URLSearchParams(login.body).get('password'), FAKE_PASSWORD, 'login form has password');
				assert.equal(login.headers['content-length'], String(Buffer.byteLength(login.body)), 'explicit content-length');

				const profile = fx.state.requests.find((r) => r.url === '/eapi/user/profile');
				assert.ok(profile, 'profile request was sent');
				assert.equal(profile.method, 'GET', 'profile uses GET');
				assert.equal(profile.headers['remix-userid'], FAKE_USERID, 'remix-userid header sent');
				assert.equal(profile.headers['remix-userkey'], FAKE_USERKEY, 'remix-userkey header sent');
				assert.equal(profile.headers.source, 'android', 'source: android header sent');
				assert.match(profile.headers.cookie, /remix_userid=/, 'remix_userid cookie sent');
				assert.match(profile.headers.cookie, /remix_userkey=/, 'remix_userkey cookie sent');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T2.4: cookie-only credentials skip login and authenticate ─────────────────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{
				ZLIB_COOKIE: `remix_userid=${FAKE_USERID}; remix_userkey=${FAKE_USERKEY}`,
				ZLIB_DOMAIN: fx.base,
			},
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const status = await zlibStatus();
					assert.equal(status.ok, true, 'cookie creds: ok is true');
					assert.equal(status.loggedIn, true, 'cookie creds: loggedIn is true');
					return status;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
				assert.equal(fx.state.logins, 0, 'cookie creds: no password login attempted');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T2.5: non-2xx envelope is parsed and raw error text preserved ─────────────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				await getSession();
				const { result, lines } = await captureConsole(async () => {
					const res = await eapiRequest('GET', '/eapi/test/fail');
					assert.equal(res.httpStatus, 418, 'non-2xx status preserved');
					assert.equal(res.ok, false, 'non-2xx envelope: ok is false');
					assert.equal(res.error, '原始错误 Raw Error', 'server error text preserved verbatim');
					assert.match(res.raw, /原始错误 Raw Error/, 'raw body preserved');
					assert.equal(res.data.success, 0, 'envelope parsed on non-2xx');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T2.6: HTTP 400 Invalid credentials -> session_expired (not generic) ───────
{
	const fx = await startFakeEapi({ expired: true });
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const status = await zlibStatus();
					assert.equal(status.ok, false, 'expired: ok is false');
					assert.equal(status.status, STATUS_SESSION_EXPIRED, 'expired: session_expired');
					assert.equal(status.loggedIn, false, 'expired: not logged in');
					assert.match(status.message, /登录态|失效/, 'expired: Chinese guidance message');
					await assert.rejects(
						() => eapiRequest('GET', '/eapi/user/profile'),
						(err) => err.status === STATUS_SESSION_EXPIRED,
						'eapiRequest throws classified session_expired'
					);
					return status;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T2.7: profile quota used>=limit -> quota_exhausted ────────────────────────
{
	const fx = await startFakeEapi({ exhausted: true });
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const status = await zlibStatus();
					assert.equal(status.ok, true, 'exhausted profile: ok is true (logged in)');
					assert.equal(status.loggedIn, true, 'exhausted profile: still logged in');
					assert.equal(status.status, STATUS_QUOTA_EXHAUSTED, 'exhausted profile: quota_exhausted');
					assert.deepEqual(status.quota, { limit: 5, used: 5 }, 'exhausted profile: quota parsed');
					assert.match(status.message, /配额/, 'exhausted profile: Chinese quota message');
					return status;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T2.8: unreachable domain -> domain_unreachable ─────────────────────────────
{
	// Port 1 is reserved and has no listener -> ECONNREFUSED (transport failure).
	await temporaryEnv(
		{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: 'http://127.0.0.1:1' },
		async () => {
			const { result, lines } = await captureConsole(async () => {
				const status = await zlibStatus();
				assert.equal(status.ok, false, 'unreachable: ok is false');
				assert.equal(status.status, STATUS_DOMAIN_UNREACHABLE, 'unreachable: domain_unreachable');
				assert.equal(status.loggedIn, false, 'unreachable: not logged in');
				assert.match(status.message, /请求失败|失败/, 'unreachable: Chinese failure message');
				return status;
			});
			assertNoCredentialLeak(lines);
			assertNoCredentialsIn(result);
		}
	);
}

// ── T2.9: new STATUS constants are exported with exact canonical values ───────
assert.equal(STATUS_NOT_CONFIGURED, 'not_configured');
assert.equal(STATUS_SESSION_EXPIRED, 'session_expired');
assert.equal(STATUS_DOMAIN_UNREACHABLE, 'domain_unreachable');
assert.equal(STATUS_QUOTA_EXHAUSTED, 'quota_exhausted');

// ═════════════════════════ T3: read-class API tests ══════════════════════════
// Every block below was appended after the T2 blocks above; nothing earlier is
// rewritten. The shared helpers (temporaryEnv / startFakeEapi / captureConsole /
// assertNoCredentialLeak / assertNoCredentialsIn) are reused as-is.

// ── T3.1: zlibSearch maps all params to POST form; arrays stay arrays ─────────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibSearch({
						query: 'domain driven design',
						page: 2,
						limit: 25,
						yearFrom: 2018,
						yearTo: 2024,
						languages: ['en', 'zh'],
						extensions: ['pdf', 'epub'],
						order: 'date',
					});
					assert.equal(res.ok, true, 'search: ok true');
					assert.equal(res.status, STATUS_OK, 'search: status ok');
					assert.equal(res.data.success, 1, 'search: envelope returned as data');
					assert.deepEqual(res.data.books, [{ id: '1', hash: 'abc', title: 'Fake Book' }], 'search: books forwarded');
					assert.match(res.message, /搜索|找到|结果/, 'search: Chinese message');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);

				const call = fx.state.requests.find((r) => r.url === '/eapi/book/search');
				assert.ok(call, 'search: request sent');
				assert.equal(call.method, 'POST', 'search: uses POST');
				const p = new URLSearchParams(call.body);
				assert.equal(p.get('message'), 'domain driven design', 'search: query -> message');
				assert.equal(p.get('page'), '2', 'search: page form param');
				assert.equal(p.get('limit'), '25', 'search: limit form param');
				assert.equal(p.get('yearFrom'), '2018', 'search: yearFrom form param');
				assert.equal(p.get('yearTo'), '2024', 'search: yearTo form param');
				assert.deepEqual(p.getAll('languages[]'), ['en', 'zh'], 'search: languages -> languages[] array');
				assert.deepEqual(p.getAll('extensions[]'), ['pdf', 'epub'], 'search: extensions -> extensions[] array');
				assert.equal(p.get('order'), 'date', 'search: order form param');
				assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8', 'search: form content-type');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T3.2: zlibGetBook maps id/hash to GET /eapi/book/{id}/{hash} ──────────────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibGetBook({ id: '12345', hash: 'deadbeef' });
					assert.equal(res.ok, true, 'getBook: ok true');
					assert.equal(res.status, STATUS_OK, 'getBook: status ok');
					assert.deepEqual(res.data.book, { id: '12345', hash: 'deadbeef', title: 'Fake Book' }, 'getBook: book data forwarded');
					assert.match(res.message, /书籍|详情|获取/, 'getBook: Chinese message');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);

				const call = fx.state.requests.find((r) => r.url === '/eapi/book/12345/deadbeef');
				assert.ok(call, 'getBook: correct path /eapi/book/{id}/{hash}');
				assert.equal(call.method, 'GET', 'getBook: uses GET');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T3.3: zlibProfile maps to GET /eapi/user/profile ──────────────────────────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibProfile();
					assert.equal(res.ok, true, 'profile: ok true');
					assert.equal(res.status, STATUS_OK, 'profile: status ok');
					assert.deepEqual(res.data.quota, FAKE_QUOTA, 'profile: quota data forwarded');
					assert.match(res.message, /配额|账户|资料|成功/, 'profile: Chinese message');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);

				const call = fx.state.requests.find((r) => r.url === '/eapi/user/profile');
				assert.ok(call, 'profile: request sent');
				assert.equal(call.method, 'GET', 'profile: uses GET');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T3.4: zlibSaved maps page -> GET /eapi/user/book/saved?page= ──────────────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibSaved({ page: 3 });
					assert.equal(res.ok, true, 'saved: ok true');
					assert.equal(res.status, STATUS_OK, 'saved: status ok');
					assert.deepEqual(res.data.books, [{ id: '42', title: 'Saved One' }], 'saved: books data forwarded');
					assert.match(res.message, /收藏|成功/, 'saved: Chinese message');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);

				const call = fx.state.requests.find((r) => r.url.startsWith('/eapi/user/book/saved?'));
				assert.ok(call, 'saved: request sent');
				assert.equal(call.method, 'GET', 'saved: uses GET');
				assert.equal(new URL(call.url, 'http://x').searchParams.get('page'), '3', 'saved: page query param');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T3.5: zlibHistory maps page -> GET /eapi/user/book/downloaded?page= ───────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibHistory({ page: 4 });
					assert.equal(res.ok, true, 'history: ok true');
					assert.equal(res.status, STATUS_OK, 'history: status ok');
					assert.deepEqual(res.data.books, [{ id: '43', title: 'Downloaded One' }], 'history: books data forwarded');
					assert.match(res.message, /历史|下载|成功/, 'history: Chinese message');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);

				const call = fx.state.requests.find((r) => r.url.startsWith('/eapi/user/book/downloaded?'));
				assert.ok(call, 'history: request sent');
				assert.equal(call.method, 'GET', 'history: uses GET');
				assert.equal(new URL(call.url, 'http://x').searchParams.get('page'), '4', 'history: page query param');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T3.6: zlibDeleteHistory maps id -> GET /eapi/user/book/{id}/delete, mutates state ──
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibDeleteHistory({ id: '777' });
					assert.equal(res.ok, true, 'deleteHistory: ok true');
					assert.equal(res.status, STATUS_OK, 'deleteHistory: status ok');
					assert.equal(res.data.deleted, '777', 'deleteHistory: server echoes deleted id');
					assert.match(res.message, /删除|成功/, 'deleteHistory: Chinese message');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);

				const call = fx.state.requests.find((r) => r.url === '/eapi/user/book/777/delete');
				assert.ok(call, 'deleteHistory: correct path /eapi/user/book/{id}/delete');
				assert.equal(call.method, 'GET', 'deleteHistory: uses GET');
				assert.deepEqual(fx.state.deleted, ['777'], 'deleteHistory: fake server state mutated');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T3.7: zlibCheckDomains: reachability + challenge wall, no credentials ─────
{
	const fxOk = await startFakeEapi({ rootMode: 'ok' });
	const fxChallenge = await startFakeEapi({ rootMode: 'challenge' });
	try {
		await temporaryEnv({ ZLIB_DOMAIN: `${fxOk.base},${fxChallenge.base}` }, async () => {
			const { result, lines } = await captureConsole(async () => {
				const res = await zlibCheckDomains();
				assert.equal(res.ok, true, 'checkDomains: ok true when a clean domain responds');
				assert.equal(res.status, STATUS_OK, 'checkDomains: status ok');
				assert.ok(Array.isArray(res.data.domains), 'checkDomains: per-domain results array');
				assert.equal(res.data.domains.length, 2, 'checkDomains: both domains probed');
				const okEntry = res.data.domains.find((d) => d.domain === fxOk.base);
				const chEntry = res.data.domains.find((d) => d.domain === fxChallenge.base);
				assert.equal(okEntry.reachable, true, 'checkDomains: healthy domain reachable');
				assert.equal(okEntry.challenge, false, 'checkDomains: healthy domain no challenge');
				assert.equal(chEntry.reachable, true, 'checkDomains: challenge domain still reachable');
				assert.equal(chEntry.challenge, true, 'checkDomains: challenge wall detected via isChallenge');
				assert.match(res.message, /域名|可达/, 'checkDomains: Chinese message');
				return res;
			});
			assertNoCredentialLeak(lines);
			assertNoCredentialsIn(result);
			assert.equal(fxOk.state.logins, 0, 'checkDomains: no password login');
			assert.equal(fxChallenge.state.logins, 0, 'checkDomains: no password login on any domain');
			assert.ok(
				fxOk.state.requests.every((r) => r.url === '/'),
				'checkDomains: probe only hits root path (lightweight, no EAPI)'
			);
		});
	} finally {
		await fxOk.close();
		await fxChallenge.close();
	}
}

// ── T3.8: zlibCheckDomains reports unreachable domains; no creds required ────
{
	await temporaryEnv({ ZLIB_DOMAIN: 'http://127.0.0.1:1' }, async () => {
		const { result, lines } = await captureConsole(async () => {
			const res = await zlibCheckDomains();
			assert.equal(res.ok, false, 'checkDomains: ok false when no domain reachable');
			assert.equal(res.status, STATUS_DOMAIN_UNREACHABLE, 'checkDomains: domain_unreachable');
			assert.equal(res.data.domains[0].reachable, false, 'checkDomains: unreachable flagged per domain');
			assert.equal(res.data.domains[0].challenge, false, 'checkDomains: unreachable has no challenge flag');
			assert.match(res.message, /域名|不可达|失败/, 'checkDomains: Chinese failure message');
			return res;
		});
		assertNoCredentialLeak(lines);
		assertNoCredentialsIn(result);
	});
}

// ── T3.9: uniform return shape on classified error (session_expired) ─────────
{
	const fx = await startFakeEapi({ expired: true });
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibProfile();
					assert.equal(res.ok, false, 'expired profile: ok false');
					assert.equal(res.status, STATUS_SESSION_EXPIRED, 'expired profile: session_expired, not thrown');
					assert.equal(res.data, null, 'expired profile: data null');
					assert.match(res.message, /登录态|失效/, 'expired profile: Chinese guidance');
					for (const key of ['ok', 'status', 'data', 'message']) {
						assert.ok(Object.hasOwn(res, key), `uniform return has key ${key}`);
					}
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
			}
		);
	} finally {
		await fx.close();
	}
}

// ═════════════════════════ T4: zlibDownload + saveZlibFile tests ═══════════════
// Appended after the T2/T3 blocks above; those blocks remain untouched.

// ── T4.1: /file → CDN GET strips remix headers + cookies, sets Referer ─────────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibDownload({ id: '123', hash: 'abc', meta: { title: 'Zlib Test Book', author: 'Ada Lovelace', year: '2020' } });
					assert.equal(res.ok, true, 'download: ok true');
					assert.equal(res.status, STATUS_OK, 'download: status ok');
					assert.equal(res.httpStatus, 200, 'download: CDN HTTP status forwarded');
					assert.ok(Buffer.isBuffer(res.body), 'download: body is a Buffer');
					assert.match(res.body.toString('latin1'), /^%PDF-/, 'download: PDF magic body returned');
					assert.ok(res.headers && typeof res.headers === 'object', 'download: headers returned');
					assert.match(res.message, /下载|成功|文件/, 'download: Chinese message');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);

				const fileCall = fx.state.requests.find((r) => r.url === '/eapi/book/123/abc/file');
				assert.ok(fileCall, 'download: /file endpoint called');
				assert.equal(fileCall.method, 'GET', 'download: /file uses GET');
				assert.equal(fileCall.headers['remix-userid'], FAKE_USERID, 'download: /file carries auth header');

				assert.equal(fx.state.cdnHits.length, 1, 'download: exactly one CDN hit');
				const cdn = fx.state.cdnHits[0];
				assert.equal(cdn.headers['remix-userid'], undefined, 'download: CDN has no remix-userid header');
				assert.equal(cdn.headers['remix-userkey'], undefined, 'download: CDN has no remix-userkey header');
				assert.equal(cdn.headers.cookie, undefined, 'download: CDN has no cookie header');
				assert.match(cdn.headers.referer, /eapi\/book\/123\/abc\/file$/, 'download: CDN Referer is the book file page');
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T4.2: fileNameHint uses buildFileNameStem with default template ───────────
{
	const fx = await startFakeEapi();
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibDownload({
						id: '123', hash: 'abc',
						meta: { title: 'Clean Code', author: 'Robert C. Martin', year: '2008' },
					});
					assert.equal(res.ok, true, 'naming: download ok');
					assert.equal(res.fileNameHint, 'Martin (2008) Clean Code.pdf', 'naming: default template applied');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T4.3: non-PDF format accepted by magic; HTML/challenge rejected ───────────
{
	const fxEpub = await startFakeEapi({ cdnMode: 'epub' });
	const fxHtml = await startFakeEapi({ cdnMode: 'html' });
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fxEpub.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibDownload({ id: '222', hash: 'def', meta: { title: 'EPUB Book' } });
					assert.equal(res.ok, true, 'epub: ok true');
					assert.match(res.fileNameHint, /\.epub$/, 'epub: extension preserved from magic');
					assert.match(res.body.toString('latin1'), /^PK/, 'epub: EPUB body returned');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
			}
		);
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fxHtml.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibDownload({ id: '333', hash: 'ghi', meta: { title: 'Blocked' } });
					assert.equal(res.ok, false, 'html: ok false');
					assert.equal(res.status, STATUS_ERROR, 'html: status error');
					assert.equal(res.body, null, 'html: no body returned');
					assert.match(res.message, /验证|HTML|网页|文件|失败/, 'html: Chinese rejection message');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
			}
		);
	} finally {
		await fxEpub.close();
		await fxHtml.close();
	}
}

// ── T4.4: truncated CDN response rejected ────────────────────────────────────
{
	const fx = await startFakeEapi({ cdnMode: 'truncated' });
	try {
		await temporaryEnv(
			{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fx.base },
			async () => {
				const { result, lines } = await captureConsole(async () => {
					const res = await zlibDownload({ id: '444', hash: 'jkl', meta: { title: 'Truncated' } });
					assert.equal(res.ok, false, 'truncated: ok false');
					assert.equal(res.status, STATUS_ERROR, 'truncated: status error');
					assert.equal(res.body, null, 'truncated: no bytes returned');
					assert.match(res.message, /截断|失败|下载/, 'truncated: Chinese rejection message');
					return res;
				});
				assertNoCredentialLeak(lines);
				assertNoCredentialsIn(result);
			}
		);
	} finally {
		await fx.close();
	}
}

// ── T4.5: saveZlibFile writes under zlib/, idempotent, no overwrite ───────────
{
	const dir = await mkdtemp(join(tmpdir(), 'zlib-save-'));
	try {
		const bodyA = Buffer.from('%PDF-1.4 zlib-A ' + 'a'.repeat(48), 'latin1');
		const bodyB = Buffer.from('%PDF-1.4 zlib-B ' + 'b'.repeat(48), 'latin1');
		const first = await saveZlibFile(dir, 'Test Book.pdf', bodyA);
		assert.equal(first.ok, true, 'save: ok true');
		assert.equal(first.status, 'downloaded', 'save: status downloaded');
		assert.match(first.path.replaceAll('\\', '/'), /\/zlib\/Test Book\.pdf$/, 'save: written under zlib/');
		assert.deepEqual(await readFile(first.path), bodyA, 'save: bytes written');

		const again = await saveZlibFile(dir, 'Test Book.pdf', bodyA);
		assert.equal(again.path, first.path, 'save: identical re-run is idempotent');

		const diff = await saveZlibFile(dir, 'Test Book.pdf', bodyB);
		assert.match(diff.path.replaceAll('\\', '/'), /\/zlib\/Test Book \(2\)\.pdf$/, 'save: different bytes get (2) suffix');
		assert.deepEqual(await readFile(diff.path), bodyB, 'save: original bytes preserved');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ═════════════════════════ T5: host tool wiring (schemas / renders) ══════════
// Appended after the T2/T3/T4 blocks above; nothing earlier is rewritten.
// Dynamic import keeps the original import line at the top of the file intact.
{
	const { apply, STATUS_LABELS = {} } = await import('./lib/host.mjs');

	const ZLIB_TOOL_NAMES = [
		'zlib_status', 'zlib_search', 'zlib_get_book', 'zlib_download',
		'zlib_profile', 'zlib_saved', 'zlib_history', 'zlib_check_domains',
		'zlib_delete_history',
	];
	const FORBIDDEN_SCHEMA_KEYS = ['email', 'password', 'cookie', 'userkey', 'userid'];
	const NEW_LABEL_STATUSES = ['not_configured', 'session_expired', 'domain_unreachable', 'quota_exhausted'];

	/** Recursive key scan: a credential-shaped property must not hide anywhere. */
	function schemaKeys(node, out = new Set()) {
		if (Array.isArray(node)) {
			for (const value of node) schemaKeys(value, out);
		} else if (node && typeof node === 'object') {
			for (const [key, value] of Object.entries(node)) {
				out.add(key.toLowerCase());
				schemaKeys(value, out);
			}
		}
		return out;
	}

	function rendered(tool, value) {
		const parts = tool.output.render({}, value);
		assert.ok(Array.isArray(parts) && parts[0] && typeof parts[0].text === 'string', 'render returns text');
		return parts[0].text;
	}

	function assertHuman(text, label) {
		assert.match(text, /[\u4e00-\u9fff]/, `${label}: render must be Chinese`);
		assert.ok(!text.includes('"success"'), `${label}: no raw envelope`);
		assert.ok(!text.includes('"data"'), `${label}: no raw data dump`);
		assertNoCredentialsIn(text);
	}

	const tmpT5 = await mkdtemp(join(tmpdir(), 'zlib-t5-'));
	try {
		// T5.2 — mock ctx (test-integration.mjs:61 blueprint): all nine tools register.
		const registered = {};
		const ctx = {
			tools: { register(def) { registered[def.name] = def; } },
			get(name) { return name === 'workingDirectory' ? { defaultDirectory: tmpT5 } : undefined; },
		};
		apply(ctx, {});

		// T5.2 — mock ctx: all nine tools register (RED before implementation).
		for (const name of ZLIB_TOOL_NAMES) assert.ok(registered[name], `tool ${name} registered by apply()`);

		// T5.1 — four new STATUS_LABELS with distinct, actionable Chinese guidance.
		for (const status of NEW_LABEL_STATUSES) {
			assert.equal(typeof STATUS_LABELS[status], 'string', `STATUS_LABELS.${status} exists`);
			assert.match(STATUS_LABELS[status], /[\u4e00-\u9fff]/, `STATUS_LABELS.${status} is Chinese`);
		}
		assert.equal(new Set(NEW_LABEL_STATUSES.map((s) => STATUS_LABELS[s])).size, 4, 'four distinct labels');
		assert.match(STATUS_LABELS.not_configured, /环境变量/, 'not_configured guidance: configure env');
		assert.match(STATUS_LABELS.session_expired, /重新/, 'session_expired guidance: log in again');
		assert.match(STATUS_LABELS.domain_unreachable, /域名/, 'domain_unreachable guidance: check domain');
		assert.match(STATUS_LABELS.quota_exhausted, /配额/, 'quota_exhausted guidance: quota');

		for (const name of ZLIB_TOOL_NAMES) {
			const tool = registered[name];
			assert.ok(tool.output && tool.output.schema && typeof tool.output.schema === 'object', `${name}: output.schema`);
			assert.equal(typeof tool.output.render, 'function', `${name}: render`);
			assert.equal(typeof tool.timeoutMs, 'number', `${name}: timeoutMs`);
			assert.equal(typeof tool.isConcurrencySafe, 'function', `${name}: isConcurrencySafe`);
			assert.equal(typeof tool.presentCall, 'function', `${name}: presentCall`);
			assert.equal(typeof tool.execute, 'function', `${name}: execute`);

			// T5.3 — recursive credential-free schema assertion (parameters + output).
			for (const [which, schema] of [['parameters', tool.parameters], ['output.schema', tool.output.schema]]) {
				const keys = schemaKeys(schema);
				for (const forbidden of FORBIDDEN_SCHEMA_KEYS) {
					assert.ok(!keys.has(forbidden), `${name}.${which} must not expose \`${forbidden}\``);
				}
			}
		}

		// T5.4 — synthetic renders for all four new failure classifications.
		for (const status of NEW_LABEL_STATUSES) {
			const text = rendered(registered.zlib_status, { ok: false, status, message: '测试说明' });
			assertHuman(text, `status render ${status}`);
			assert.ok(text.includes(STATUS_LABELS[status]), `${status}: render shows its own label`);
		}

		// T5.5 — happy path for every tool against the local fake EAPI.
		const fakeOk = await startFakeEapi();
		try {
			await temporaryEnv(
				{ ZLIB_EMAIL: FAKE_EMAIL, ZLIB_PASSWORD: FAKE_PASSWORD, ZLIB_DOMAIN: fakeOk.base },
				async () => {
					const cases = [
						['zlib_status', {}],
						['zlib_search', { query: 'Fake', limit: 5 }],
						['zlib_get_book', { id: '1', hash: 'abc' }],
						['zlib_download', { id: '1', hash: 'abc', title: 'Zlib Test Book', author: 'Ada Lovelace', year: '2020' }],
						['zlib_profile', {}],
						['zlib_saved', { page: 1 }],
						['zlib_history', { page: 1 }],
						['zlib_check_domains', {}],
						['zlib_delete_history', { id: '7' }],
					];
					for (const [name, args] of cases) {
						const tool = registered[name];
						const result = await tool.execute(args, {});
						assert.equal(result.ok, true, `${name}: happy path ok (${result.message})`);
						const text = rendered(tool, result);
						assertHuman(text, `${name} happy render`);
					}
					const dl = await registered.zlib_download.execute(
						{ id: '1', hash: 'abc', title: 'Another Book', author: 'Grace Hopper', year: '2021' },
						{}
					);
					assert.equal(dl.ok, true, 'download writes to disk');
					assert.match(dl.path.replaceAll(/[\\/]/g, '/'), /\/zlib\//, 'download saved under zlib/');
					assert.ok(dl.bytes > 0, 'download reports bytes');
				}
			);
		} finally {
			await fakeOk.close();
		}

		// T5.6 — failure classification for every credentialed tool: no env ⇒
		// not_configured, human render, no credential text.
		await temporaryEnv({}, async () => {
			for (const name of ZLIB_TOOL_NAMES.filter((n) => n !== 'zlib_check_domains')) {
				const tool = registered[name];
				const args = name === 'zlib_get_book' || name === 'zlib_download'
					? { id: '1', hash: 'abc' }
					: name === 'zlib_delete_history' ? { id: '7' } : {};
				const result = await tool.execute(args, {});
				assert.equal(result.ok, false, `${name}: failure without env`);
				assert.equal(result.status, 'not_configured', `${name}: classified not_configured`);
				const text = rendered(tool, result);
				assertHuman(text, `${name} failure render`);
				assert.ok(text.includes(STATUS_LABELS.not_configured), `${name}: shows not_configured label`);
			}
		});

		// T5.7 — domain_unreachable classification through the real check_domains path.
		const fakeFail = await startFakeEapi({ rootMode: 'fail' });
		try {
			await temporaryEnv({ ZLIB_DOMAIN: fakeFail.base }, async () => {
				const result = await registered.zlib_check_domains.execute({}, {});
				assert.equal(result.ok, false, 'check_domains: unreachable');
				assert.equal(result.status, 'domain_unreachable', 'check_domains: classified');
				const text = rendered(registered.zlib_check_domains, result);
				assertHuman(text, 'check_domains failure render');
				assert.ok(text.includes(STATUS_LABELS.domain_unreachable), 'shows domain_unreachable label');
			});
		} finally {
			await fakeFail.close();
		}
	} finally {
		await rm(tmpT5, { recursive: true, force: true });
	}
}

// ═════════════════════════ T6: docs / attribution / version / packaging ═══════
// Appended after the T2/T3/T4/T5 blocks above; nothing earlier is rewritten.
{
	const readText = (p) => readFile(new URL(p, import.meta.url), 'utf8');
	const readme = await readText('./README.md');
	const en = JSON.parse(await readText('./locale/en.json'));
	const zh = JSON.parse(await readText('./locale/zh.json'));
	const pkg = JSON.parse(await readText('./package.json'));

	// T6.1 — five mandatory attribution/disclaimer elements, verbatim.
	for (const needle of ['heartleo/zlib', 'MIT', '非官方', '版权', '免责']) {
		assert.ok(readme.includes(needle), `README must contain attribution element: ${needle}`);
	}
	assert.ok(readme.includes('https://github.com/heartleo/zlib'), 'README links the upstream project');

	// T6.2 — bilingual locale descriptions cover the zlib tools (names only).
	for (const [lang, loc] of [['en', en], ['zh', zh]]) {
		assert.ok(loc.meta && typeof loc.meta.description === 'string', `${lang}.meta.description exists`);
		assert.ok(loc.meta.description.includes('zlib_status'), `${lang}.meta.description lists zlib_status`);
		assert.match(loc.meta.title, /Z-Library/, `${lang}.meta.title mentions Z-Library`);
	}

	// T6.3 — packaging manifest: 0.6.1, both new tests, lib/, keyword, description.
	assert.equal(pkg.version, '0.6.1', 'package.json version is 0.6.1');
	for (const path of ['test-zlib.mjs', 'test-http-methods.mjs', 'lib']) {
		assert.ok(Array.isArray(pkg.files) && pkg.files.includes(path), `package.json files includes ${path}`);
	}
	assert.ok(pkg.keywords.includes('zlib'), 'package.json keywords includes zlib');
	assert.match(pkg.description, /Z-Library/, 'package.json description mentions Z-Library');

	// T6.4 — README self-test list includes the two new suites.
	for (const cmd of ['node test-http-methods.mjs', 'node test-zlib.mjs']) {
		assert.ok(readme.includes(cmd), `README self-test lists ${cmd}`);
	}

	// T6.5 — README documents env variable NAMES and all nine tools + failure states.
	for (const name of ['ZLIB_EMAIL', 'ZLIB_PASSWORD', 'ZLIB_COOKIE', 'ZLIB_DOMAIN']) {
		assert.ok(readme.includes(name), `README documents env var name ${name}`);
	}
	for (const tool of [
		'zlib_status', 'zlib_search', 'zlib_get_book', 'zlib_download', 'zlib_profile',
		'zlib_saved', 'zlib_history', 'zlib_check_domains', 'zlib_delete_history',
	]) {
		assert.ok(readme.includes(tool), `README documents tool ${tool}`);
	}
	for (const status of ['not_configured', 'session_expired', 'domain_unreachable', 'quota_exhausted']) {
		assert.ok(readme.includes(status), `README documents failure status ${status}`);
	}
}

console.log('test-zlib: ALL PASS');
