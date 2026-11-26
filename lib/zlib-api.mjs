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
import {
	assertSafeDerivedUrl, errorMessage as httpErrorMessage, httpGet, isChallenge,
	isPdf, PDF_TIMEOUT_MS, truncationReason, USER_AGENT,
} from './http.mjs';
import { buildFileNameStem } from './naming.mjs';

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

// ── T3: read-class EAPI tools ────────────────────────────────────────────────
// Every function below returns the same {ok, status, data, message} shape.
// Classified ZlibErrors (session_expired / not_configured / domain_unreachable)
// are returned, never thrown, so the host layer can render them uniformly.

/** Run an EAPI call, turning any classified error into the uniform shape. */
async function withZlibErrors(fn) {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof ZlibError) {
			return { ok: false, status: error.status, data: null, message: error.message };
		}
		return {
			ok: false,
			status: STATUS_ERROR,
			data: null,
			message: `Z-Library 请求失败：${error?.message || '未知错误'}`,
		};
	}
}

/** Map an eapiRequest result to the uniform read result; keep the envelope. */
function readResult(response, successMessage, failurePrefix) {
	if (response.ok) {
		return { ok: true, status: STATUS_OK, data: response.data ?? null, message: successMessage };
	}
	return {
		ok: false,
		status: STATUS_ERROR,
		data: response.data ?? null,
		message: `${failurePrefix}：${response.error || '未知错误'}。`,
	};
}

/** POST /eapi/book/search. Array options map to the official `[]` form keys. */
export async function zlibSearch({ query, page, limit, yearFrom, yearTo, languages, extensions, order } = {}) {
	return withZlibErrors(async () => {
		const form = {
			message: query,
			page,
			limit,
			yearFrom,
			yearTo,
			'languages[]': Array.isArray(languages) ? languages : languages ? [languages] : undefined,
			'extensions[]': Array.isArray(extensions) ? extensions : extensions ? [extensions] : undefined,
			order,
		};
		const response = await eapiRequest('POST', '/eapi/book/search', { form });
		const books = response.data?.books;
		const found = Array.isArray(books) ? `找到 ${books.length} 条结果` : '已返回结果';
		return readResult(response, `搜索完成，${found}。`, '搜索失败');
	});
}

/** GET /eapi/book/{id}/{hash}. */
export async function zlibGetBook({ id, hash } = {}) {
	return withZlibErrors(async () => {
		const response = await eapiRequest('GET', `/eapi/book/${encodeURIComponent(String(id ?? ''))}/${encodeURIComponent(String(hash ?? ''))}`);
		return readResult(response, '已获取书籍详情。', '获取书籍详情失败');
	});
}

/** GET /eapi/user/profile (account quota + limits). */
export async function zlibProfile() {
	return withZlibErrors(async () => {
		const response = await eapiRequest('GET', PROFILE_PATH);
		return readResult(response, '已获取账户信息与配额。', '获取账户信息失败');
	});
}

/** GET /eapi/user/book/saved?page=. */
export async function zlibSaved({ page } = {}) {
	return withZlibErrors(async () => {
		const response = await eapiRequest('GET', '/eapi/user/book/saved', { query: { page } });
		return readResult(response, '已获取收藏列表。', '获取收藏列表失败');
	});
}

/** GET /eapi/user/book/downloaded?page=. */
export async function zlibHistory({ page } = {}) {
	return withZlibErrors(async () => {
		const response = await eapiRequest('GET', '/eapi/user/book/downloaded', { query: { page } });
		return readResult(response, '已获取下载历史。', '获取下载历史失败');
	});
}

/** GET /eapi/user/book/{id}/delete — removes one entry from the download history. */
export async function zlibDeleteHistory({ id } = {}) {
	return withZlibErrors(async () => {
		const response = await eapiRequest('GET', `/eapi/user/book/${encodeURIComponent(String(id ?? ''))}/delete`);
		return readResult(response, '已从下载历史中删除该记录。', '删除下载历史失败');
	});
}

// Candidate mirrors only — a live probe decides reachability; these are not a
// promise that any given domain works. ZLIB_DOMAIN (comma-separated) overrides.
const DEFAULT_ZLIB_DOMAINS = [
	'https://z-library.sk',
	'https://zlib.fx',
	'https://singlelogin.re',
];

/**
 * Lightweight reachability / challenge-wall probe. No credentials are used or
 * sent: this hits only the root path of each candidate domain.
 */
export async function zlibCheckDomains(env = process.env) {
	const configured = String(env.ZLIB_DOMAIN || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const candidates = configured.length ? configured : DEFAULT_ZLIB_DOMAINS;
	const domains = [];
	for (const candidate of candidates) {
		const domain = normalizeDomain(candidate);
		if (!domain) {
			domains.push({ domain: candidate, reachable: false, challenge: false, error: '域名格式无效' });
			continue;
		}
		try {
			const response = await httpGet(`${domain}/`, { method: 'GET', accept: 'text/html', timeoutMs: 8000 });
			const body = response.body.toString('utf8');
			domains.push({
				domain,
				reachable: response.status > 0 && response.status < 500,
				challenge: isChallenge(body),
				httpStatus: response.status,
			});
		} catch (error) {
			domains.push({ domain, reachable: false, challenge: false, error: error?.message || '未知错误' });
		}
	}
	const reachable = domains.filter((d) => d.reachable);
	const challenged = reachable.filter((d) => d.challenge).length;
	const message = reachable.length
		? `域名探测完成：${reachable.length} 个可达${challenged ? `（其中 ${challenged} 个存在验证墙）` : ''}。`
		: '域名探测完成：没有可达的 Z-Library 域名，请设置或更换 ZLIB_DOMAIN。';
	return {
		ok: reachable.length > 0,
		status: reachable.length ? STATUS_OK : STATUS_DOMAIN_UNREACHABLE,
		data: { domains },
		message,
	};
}

// ── T4: download (bytes only — the host layer owns every disk write) ──────────

/** Pull the CDN link out of the several `/file` envelope shapes seen in the wild. */
function extractFileUrl(data, sourceHost) {
	if (typeof data === 'string') data = { url: data };
	const candidates = [
		data?.url, data?.link, data?.download, data?.downloadUrl, data?.file,
		data?.fileUrl, data?.book?.url, data?.book?.download, data?.book?.file,
	];
	for (const raw of candidates) {
		if (!raw || typeof raw !== 'string') continue;
		try {
			return assertSafeDerivedUrl(new URL(raw, `http://${sourceHost}/`), sourceHost);
		} catch {
			// try the next candidate
		}
	}
	return '';
}

/** Pick a safe extension from magic bytes (PDF/EPUB) or a server-supplied hint. */
function downloadExtension(headers, body) {
	const raw = headers && (Array.isArray(headers['content-disposition'])
		? headers['content-disposition'][0] : headers['content-disposition']);
	const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(raw || ''));
	if (named) {
		const ext = /\.([a-z0-9]{1,8})$/i.exec(named[1].trim());
		if (ext) return ext[1].toLowerCase();
	}
	if (isPdf(body)) return 'pdf';
	if (body.length >= 4 && body.subarray(0, 4).toString('latin1') === 'PK\x03\x04') return 'epub';
	const type = headers && (Array.isArray(headers['content-type']) ? headers['content-type'][0] : headers['content-type']);
	const mime = /^\s*([a-z0-9.+-]+)\//i.exec(String(type || ''));
	if (mime) {
		const subtype = String(type).split('/')[1]?.split(';')[0]?.trim().toLowerCase();
		if (/^[a-z0-9]{1,8}$/.test(subtype || '')) return subtype;
	}
	return 'bin';
}

/**
 * Resolve a book's real file link through the authed EAPI, then download the
 * bytes from the CDN with the Z-Library session stripped. No disk write — the
 * host layer turns `body`/`fileNameHint` into a file with saveZlibFile.
 */
export async function zlibDownload({ id, hash, meta, pluginConfig, env = process.env } = {}) {
	const fail = (message, status = STATUS_ERROR) => ({
		ok: false, status, body: null, headers: null, fileNameHint: '', message,
	});
	try {
		const session = await getSession(env);
		const bookId = String(id ?? '');
		const bookHash = String(hash ?? '');
		const fileUrl = `${session.domain}/eapi/book/${encodeURIComponent(bookId)}/${encodeURIComponent(bookHash)}/file`;
		const response = await eapiRequest('GET', `/eapi/book/${encodeURIComponent(bookId)}/${encodeURIComponent(bookHash)}/file`, { env, session });
		if (!response.ok) return fail(`获取文件链接失败：${response.error || '未知错误'}。`);

		const sourceHost = new URL(session.domain).host;
		const cdnUrl = extractFileUrl(response.data, sourceHost);
		if (!cdnUrl) return fail('文件链接解析失败：服务器未返回可用的下载地址。');
		const referer = fileUrl;

		// HARD: the CDN is a third party. Never forward the remix credentials,
		// their cookie aliases, or any Z-Library session state to it.
		const headers = { 'user-agent': USER_AGENT, accept: '*/*' };
		for (const key of ['remix-userid', 'remix-userkey', 'remix_userid', 'remix_userkey', 'cookie']) delete headers[key];
		let file;
		try {
			file = await httpGet(cdnUrl, { headers, referer, accept: '*/*', timeoutMs: PDF_TIMEOUT_MS });
		} catch (error) {
			return fail(`文件下载失败：${httpErrorMessage(error)}。`);
		}
		if (file.status < 200 || file.status >= 300) return fail(`文件下载失败：HTTP ${file.status}。`);
		const body = file.body;
		if (!body.length) return fail('文件下载失败：服务器返回了空内容。');
		const text = body.subarray(0, 512).toString('latin1');
		if (isChallenge(text) || /^\s*<(?:!doctype|html|body)/i.test(text)) {
			return fail('文件下载失败：服务器返回的是网页或验证页面，不是文件。');
		}
		const truncated = truncationReason(file);
		if (truncated) return fail(`文件下载失败：内容被截断（${truncated}）。`);

		const extension = downloadExtension(file.headers, body);
		const downloadUrl = cdnUrl;
		const info = meta && typeof meta === 'object'
			? meta
			: (response.data?.book || response.data || {});
		const author = String(info.author ?? info.firstAuthor ?? '');
		const authors = author ? author.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];
		const firstAuthor = authors.length ? authors[0].split(' ').filter(Boolean).pop() : '';
		const stem = buildFileNameStem(pluginConfig || {}, {
			title: String(info.title || ''),
			year: String(info.year || ''),
			authors,
			firstAuthor,
			doi: '',
			inputStem: bookId,
		});
		return {
			ok: true,
			status: STATUS_OK,
			body,
			headers: file.headers,
			httpStatus: file.status,
			downloadUrl,
			fileNameHint: `${stem}.${extension}`,
			message: '文件下载成功，尚未写入磁盘。',
		};
	} catch (error) {
		if (error instanceof ZlibError) return fail(error.message, error.status);
		return fail(`文件下载失败：${error?.message || '未知错误'}`);
	}
}
