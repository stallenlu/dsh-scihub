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
import {
	getSession,
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
async function startFakeEapi({ expired = false, exhausted = false, rootMode = 'ok' } = {}) {
	const state = { expired, exhausted, rootMode, logins: 0, requests: [], deleted: [] };
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

console.log('test-zlib: ALL PASS');
