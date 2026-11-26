/**
 * Z-Library EAPI foundation: session, envelope parsing and status.
 *
 * Protocol notes (from the heartleo/zlib reference and the design spec):
 *  - login is POST /eapi/user/login with form email/password; the answer carries
 *    user.id + remix_userkey (legacy name remix_user_key is accepted too).
 *  - every later request carries remix-userid/remix-userkey as headers AND as
 *    same-named cookies; `source: android` is mandatory (else Access denied).
 *  - every endpoint returns {"success":0|1,"error":...}; parse the envelope even
 *    on non-2xx and keep the server's raw error text.
 *  - HTTP 400 + Invalid credentials / Please login means the session expired —
 *    a distinct, classified failure, not a generic error.
 *
 * Credential rules (HARD): only process.env is read; never logged, never
 * returned by zlibStatus or any tool result. The session object returned by
 * getSession is an in-process value consumed only by eapiRequest. No cookies on
 * disk, no timer refresh, zero third-party deps, Node built-ins only.
 */
import { createHash } from 'node:crypto';
import { httpGet, USER_AGENT } from './http.mjs';

// ── canonical status vocabulary (exact names; imported by T3/T5) ──────────────
export const STATUS_NOT_CONFIGURED = 'not_configured';
export const STATUS_SESSION_EXPIRED = 'session_expired';
export const STATUS_DOMAIN_UNREACHABLE = 'domain_unreachable';
export const STATUS_QUOTA_EXHAUSTED = 'quota_exhausted';
export const STATUS_OK = 'ok';
export const STATUS_ERROR = 'error';

export const STATUS = {
	OK: STATUS_OK,
	ERROR: STATUS_ERROR,
	NOT_CONFIGURED: STATUS_NOT_CONFIGURED,
	SESSION_EXPIRED: STATUS_SESSION_EXPIRED,
	DOMAIN_UNREACHABLE: STATUS_DOMAIN_UNREACHABLE,
	QUOTA_EXHAUSTED: STATUS_QUOTA_EXHAUSTED,
};

const LOGIN_PATH = '/eapi/user/login';
const PROFILE_PATH = '/eapi/user/profile';
const REQUEST_TIMEOUT_MS = 60000;
const EXPIRED_ERROR_RE = /^(?:invalid credentials|please login)$/i;

/** An error carrying a classified `status` so callers never fold it into `error`. */
export class ZlibError extends Error {
	constructor(message, status = STATUS_ERROR) {
		super(message);
		this.name = 'ZlibError';
		this.status = status;
	}
}

// Module-level, lazy, in-memory session. Keyed by the raw credential inputs so
// changing env (common in the offline tests) never reuses a stale session.
let cachedSession = null;

function normalizeDomain(value) {
	let domain = String(value || '').trim();
	if (!domain) return '';
	if (!/^https?:\/\//i.test(domain)) domain = `https://${domain}`;
	try {
		return new URL(domain).origin;
	} catch {
		return '';
	}
}

function encodeForm(form) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(form || {})) {
		if (Array.isArray(value)) {
			for (const item of value) params.append(key, item === undefined || item === null ? '' : String(item));
		} else if (value !== undefined && value !== null) {
			params.set(key, String(value));
		}
	}
	return params.toString();
}

/** Parse the inline cookie string ONLY; a file path is never accepted. */
function parseInlineCookie(cookie) {
	let userid = '';
	let userkey = '';
	for (const part of String(cookie).split(';')) {
		const at = part.indexOf('=');
		if (at < 0) continue;
		const key = part.slice(0, at).trim();
		const value = part.slice(at + 1).trim();
		if (key === 'remix_userid') userid = value;
		else if (key === 'remix_userkey' || key === 'remix_user_key') userkey = value;
	}
	if (!userid || !userkey) {
		throw new ZlibError(
			'ZLIB_COOKIE 格式无效：只接受内联串 remix_userid=...; remix_userkey=...（不接受 cookie 文件路径）。',
			STATUS_NOT_CONFIGURED
		);
	}
	return { userid, userkey };
}

/**
 * POST /eapi/user/login, then read user.id + remix_userkey (legacy alias OK).
 * The password is sent in the form body only; it never enters a message here.
 */
async function login(email, password, env) {
	const response = await eapiRequest('POST', LOGIN_PATH, { form: { email, password }, auth: false, env });
	if (!response.ok) {
		// Use only the structured error from the envelope; never echo the raw
		// body (it could contain the submitted email/password on some servers).
		const detail = response.error ? `：${response.error}` : '';
		throw new ZlibError(`Z-Library 登录失败${detail}。请检查 ZLIB_EMAIL/ZLIB_PASSWORD。`, STATUS_ERROR);
	}
	const data = response.data || {};
	const userid = data.user?.id ?? data.userid ?? data.remix_userid;
	const userkey = data.remix_userkey ?? data.remix_user_key ?? data.user?.remix_userkey;
	if (!userid || !userkey) {
		throw new ZlibError('Z-Library 登录响应缺少 user.id 或 remix_userkey，无法建立会话。', STATUS_ERROR);
	}
	return { userid: String(userid), userkey: String(userkey) };
}

/**
 * Resolve the in-memory session. Email/password win over an inline cookie.
 * Returns { userid, userkey, domain } for internal use by eapiRequest; callers
 * that build tool/user output must use zlibStatus() instead.
 */
export async function getSession(env = process.env) {
	const email = String(env.ZLIB_EMAIL || '').trim();
	const password = String(env.ZLIB_PASSWORD || '');
	const cookie = String(env.ZLIB_COOKIE || '').trim();
	const domain = normalizeDomain(env.ZLIB_DOMAIN);
	// Hash the credential inputs so the raw password/cookie never lives in the
	// cache key (still enough to invalidate on any credential change).
	const key = createHash('sha256').update(JSON.stringify([domain, email, password, cookie])).digest('hex');
	if (cachedSession && cachedSession.key === key) {
		return { userid: cachedSession.userid, userkey: cachedSession.userkey, domain: cachedSession.domain };
	}

	if (!domain) {
		throw new ZlibError('未配置 ZLIB_DOMAIN：请在启动 DSH 前设置 Z-Library 域名。', STATUS_NOT_CONFIGURED);
	}
	if (email && password) {
		const { userid, userkey } = await login(email, password, env);
		cachedSession = { key, userid, userkey, domain };
		return { userid, userkey, domain };
	}
	if (cookie) {
		const { userid, userkey } = parseInlineCookie(cookie);
		cachedSession = { key, userid, userkey, domain };
		return { userid, userkey, domain };
	}
	throw new ZlibError('未配置 ZLIB_EMAIL/ZLIB_PASSWORD 或 ZLIB_COOKIE：请在启动 DSH 前设置环境变量。', STATUS_NOT_CONFIGURED);
}

/**
 * One EAPI call. `auth:false` is used only by the login call itself.
 * Returns a normalized object with the parsed envelope (`data`), the raw body,
 * the raw server `error`, and `ok`. Throws a classified ZlibError on session
 * expiry or transport failure.
 */
export async function eapiRequest(method, path, { form, query, auth = true, env = process.env, domain: domainOverride, session: sessionOverride } = {}) {
	const session = auth === false ? null : sessionOverride || (await getSession(env));
	const domain = domainOverride || session?.domain || normalizeDomain(env.ZLIB_DOMAIN);
	if (!domain) throw new ZlibError('未配置 ZLIB_DOMAIN：请在启动 DSH 前设置 Z-Library 域名。', STATUS_DOMAIN_UNREACHABLE);

	const target = new URL(String(path || '/'), `${domain}/`);
	for (const [key, value] of Object.entries(query || {})) {
		if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
	}

	const upperMethod = String(method || 'GET').toUpperCase();
	const headers = {
		'source': 'android',
		'accept': 'application/json',
		'user-agent': USER_AGENT,
	};
	if (session) {
		headers['remix-userid'] = session.userid;
		headers['remix-userkey'] = session.userkey;
		headers.cookie = `remix_userid=${session.userid}; remix_userkey=${session.userkey}`;
	}

	let body;
	if (form) {
		body = encodeForm(form);
		headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
		// Explicit length keeps form POSTs out of chunked-encoding territory.
		headers['content-length'] = String(Buffer.byteLength(body));
	}

	let response;
	try {
		response = await httpGet(target.href, {
			method: upperMethod,
			headers,
			body,
			accept: 'application/json',
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
	} catch (error) {
		throw new ZlibError(`Z-Library 请求失败：${error.message || String(error)}`, STATUS_DOMAIN_UNREACHABLE);
	}

	const raw = response.body.toString('utf8');
	let envelope = null;
	try {
		envelope = JSON.parse(raw);
	} catch {
		// Non-JSON body: keep the raw text below; envelope stays null.
	}
	const isSuccess = Boolean(envelope && envelope.success === 1 && response.status >= 200 && response.status < 300);
	// Prefer the structured envelope error; fall back to a truncated raw body
	// only for non-JSON responses (never echo a full body in an error message).
	const errorText = envelope && envelope.error !== undefined && envelope.error !== null
		? String(envelope.error)
		: isSuccess ? '' : raw.slice(0, 200);

	// A 400 Invalid credentials / Please login means EXPIRED only on an
	// already-authenticated call. On the unauthenticated login call it is a
	// plain login failure — let login() classify it as STATUS_ERROR instead.
	if (auth !== false && response.status === 400 && EXPIRED_ERROR_RE.test(errorText.trim())) {
		cachedSession = null;
		throw new ZlibError(`登录态已失效：${errorText}。请重新配置 ZLIB_EMAIL/ZLIB_PASSWORD 或 ZLIB_COOKIE。`, STATUS_SESSION_EXPIRED);
	}

	return {
		ok: isSuccess,
		success: isSuccess ? 1 : 0,
		data: envelope,
		error: errorText,
		raw,
		httpStatus: response.status,
		status: isSuccess ? STATUS_OK : STATUS_ERROR,
	};
}

/** Pull {limit, used} verbatim from the profile shapes seen in the wild. */
function extractQuota(data) {
	const quota = data?.quota ?? data?.user?.quota;
	if (!quota || typeof quota !== 'object') return null;
	const limit = quota.limit ?? quota.max ?? null;
	const used = quota.used ?? null;
	if (limit === null && used === null) return null;
	return { limit, used };
}

/**
 * Status self-check. Never returns userid/userkey/password/cookie — only the
 * domain, login state, quota and a Chinese message suitable for tool output.
 */
export async function zlibStatus(env = process.env) {
	const domain = normalizeDomain(env.ZLIB_DOMAIN);
	const base = { ok: false, status: STATUS_ERROR, domain, loggedIn: false, quota: null, message: '' };
	const email = String(env.ZLIB_EMAIL || '').trim();
	const password = String(env.ZLIB_PASSWORD || '');
	const cookie = String(env.ZLIB_COOKIE || '').trim();

	if (!email && !password && !cookie) {
		return { ...base, status: STATUS_NOT_CONFIGURED, message: '未配置 ZLIB_EMAIL/ZLIB_PASSWORD 或 ZLIB_COOKIE：请在启动 DSH 前设置环境变量。' };
	}
	if (!domain) {
		return { ...base, status: STATUS_NOT_CONFIGURED, message: '未配置 ZLIB_DOMAIN：请在启动 DSH 前设置 Z-Library 域名。' };
	}

	try {
		const session = await getSession(env);
		const profile = await eapiRequest('GET', PROFILE_PATH, { env, session });
		if (!profile.ok) {
			return { ...base, message: `登录态自检失败：${profile.error || '未知错误'}。` };
		}
		const quota = extractQuota(profile.data);
		const exhausted = quota && quota.limit !== null && quota.used !== null && Number(quota.used) >= Number(quota.limit);
		return {
			ok: true,
			status: exhausted ? STATUS_QUOTA_EXHAUSTED : STATUS_OK,
			domain,
			loggedIn: true,
			quota,
			message: exhausted ? '今日下载配额已用尽，请明天再试。' : '已登录，可正常使用。',
		};
	} catch (error) {
		const status = error?.status === STATUS_SESSION_EXPIRED || error?.status === STATUS_NOT_CONFIGURED
			? error.status
			: error?.status === STATUS_DOMAIN_UNREACHABLE ? STATUS_DOMAIN_UNREACHABLE : STATUS_ERROR;
		return { ...base, status, message: error?.message || '未知错误' };
	}
}
