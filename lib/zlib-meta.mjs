/**
 * zlib-meta — read / preview / commit orchestration for book metadata
 * (v0.6.1 Task 4).
 *
 * The preview step is strictly read-only: it computes a field-level diff,
 * keeps an opaque one-shot token in a module-local Map, and writes NOTHING.
 * Commit validates every failure condition before touching the file, then
 * delegates to the atomic writers in ebookmeta.mjs.
 *
 * Node built-ins only. No credentials, no environment hooks, no child_process.
 */
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';

import { readMeta, writeMeta, renameByMeta } from './ebookmeta.mjs';

export const STATUS_UNSUPPORTED_FORMAT = 'unsupported_format';
export const STATUS_BAD_META = 'bad_metadata';
export const STATUS_TOKEN_EXPIRED = 'token_expired';
export const STATUS_WRITE_FAILED = 'write_failed';

const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Module-local token store. Exported for tests only. */
export const __tokens = new Map();

/** Map any known MetaError code onto the public STATUS vocabulary. */
function mapCode(code) {
  if (code === 'unsupported_format') return STATUS_UNSUPPORTED_FORMAT;
  if (code === STATUS_BAD_META || code === 'malformed_epub' || code === 'malformed_pdf'
      || code === 'encrypted_pdf') return STATUS_BAD_META;
  if (code === STATUS_TOKEN_EXPIRED) return STATUS_TOKEN_EXPIRED;
  return STATUS_WRITE_FAILED;
}

/** Build a structured failure without ever exposing a raw stack trace. */
function fail(code, message) {
  return {
    ok: false,
    status: mapCode(code),
    message: String(message ?? 'operation failed'),
  };
}

function failureFrom(err, fallbackCode = STATUS_WRITE_FAILED) {
  const code = err && typeof err.code === 'string' ? err.code : fallbackCode;
  return fail(code, err?.message ?? String(err));
}

/** Normalise a metadata value to a plain string for the diff. */
function asString(value) {
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.map((v) => String(v)).join(', ') : String(value);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Thin wrapper over readMeta that maps its error codes onto STATUS values.
 * @param {string} path
 */
export async function metaRead(path) {
  try {
    const result = await readMeta(path);
    if (result.ok) {
      return { ok: true, status: 'ok', format: result.format, fields: result.fields };
    }
    return fail(result.code, result.message);
  } catch (err) {
    return failureFrom(err, STATUS_BAD_META);
  }
}

/**
 * Compute a field-level diff and issue an opaque, one-shot preview token.
 * This function never writes to disk.
 *
 * @param {string} path
 * @param {Record<string, unknown>} fields
 * @param {{rename?:boolean}} options
 */
export async function metaPreview(path, fields = {}, { rename = false } = {}) {
  try {
    const current = await metaRead(path);
    if (!current.ok) return current;

    const requested = fields && typeof fields === 'object' ? fields : {};
    const keys = new Set([
      ...Object.keys(current.fields ?? {}),
      ...Object.keys(requested),
    ]);
    const diff = [];
    for (const field of keys) {
      const oldValue = asString(current.fields?.[field]);
      const newValue = asString(requested[field]);
      if (oldValue !== newValue) diff.push({ field, oldValue, newValue });
    }

    const token = randomBytes(16).toString('hex');
    __tokens.set(token, {
      path,
      fields: { ...requested },
      rename: Boolean(rename),
      expires: Date.now() + TOKEN_TTL_MS,
      used: false,
    });
    return {
      ok: true,
      status: 'ok',
      token,
      diff,
      message: 'preview computed; no changes written',
    };
  } catch (err) {
    return failureFrom(err, STATUS_BAD_META);
  }
}

/**
 * Apply a previewed change. Every failure condition is checked BEFORE any
 * write: token exists, unused, unexpired, and the bound path still exists.
 * A validated token is consumed immediately, so a second commit is refused.
 *
 * @param {string} token
 */
export async function metaCommit(token) {
  const entry = __tokens.get(token);
  if (!entry || entry.used) {
    __tokens.delete(token);
    return fail(STATUS_TOKEN_EXPIRED, 'preview token is invalid or already used');
  }
  if (Date.now() >= entry.expires) {
    __tokens.delete(token);
    return fail(STATUS_TOKEN_EXPIRED, 'preview token has expired');
  }
  if (!(await pathExists(entry.path))) {
    __tokens.delete(token);
    return fail(STATUS_WRITE_FAILED, 'preview token is bound to a path that no longer exists');
  }

  // Consume the token before writing so no commit can ever be replayed,
  // including when the underlying writer throws.
  entry.used = true;
  __tokens.delete(token);

  try {
    const written = await writeMeta(entry.path, entry.fields);
    if (!written.ok) return fail(written.code, written.message);

    let finalPath = entry.path;
    if (entry.rename) {
      const renamed = await renameByMeta(entry.path, entry.fields);
      if (!renamed.ok) return fail(renamed.code, renamed.message);
      finalPath = renamed.path;
    }
    return {
      ok: true,
      status: 'ok',
      path: finalPath,
      message: 'metadata committed',
    };
  } catch (err) {
    return failureFrom(err, STATUS_WRITE_FAILED);
  }
}
