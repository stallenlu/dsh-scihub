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
	STATUS_NOT_CONFIGURED,
	STATUS_SESSION_EXPIRED,
	STATUS_DOMAIN_UNREACHABLE,
	STATUS_QUOTA_EXHAUSTED,
	STATUS_ERROR,
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
async function startFakeEapi({ expired = false, exhausted = false } = {}) {
	const state = { expired, exhausted, logins: 0, requests: [] };
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

console.log('test-zlib: ALL PASS');
