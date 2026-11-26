/**
 * TDD suite for lib/zlib-meta.mjs (v0.6.1 Task 4).
 *
 *   node test-zlib-meta.mjs          # prints ALL PASS when green
 *
 * R1 (ledger): the EPUB fixture builders are imported from test-ebookmeta.mjs.
 * That module guards its assertions behind a direct-execution check, so merely
 * importing it here does NOT re-run that suite.
 *
 * Node built-ins only. No network, no credentials, no child_process.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildEpubFixture } from './test-ebookmeta.mjs';

// Namespace import so the RED phase reports a clean "module not found" rather
// than a link error, and so a missing named export fails as an assertable value.
import * as zm from './lib/zlib-meta.mjs';

const {
  STATUS_UNSUPPORTED_FORMAT,
  STATUS_BAD_META,
  STATUS_TOKEN_EXPIRED,
  STATUS_WRITE_FAILED,
  metaRead,
  metaPreview,
  metaCommit,
  __tokens,
} = zm;

async function runSuite() {
  const dir = mkdtempSync(join(tmpdir(), 'zlib-meta-'));
  try {
    // --- STATUS contract -----------------------------------------------------
    assert.equal(STATUS_UNSUPPORTED_FORMAT, 'unsupported_format');
    assert.equal(STATUS_BAD_META, 'bad_metadata');
    assert.equal(STATUS_TOKEN_EXPIRED, 'token_expired');
    assert.equal(STATUS_WRITE_FAILED, 'write_failed');

    // 1) preview: field diff + bytes unchanged + opaque one-shot token issued.
    const previewPath = buildEpubFixture(join(dir, 'preview.epub'), {
      title: 'Original Title',
      authors: ['Fixture Author'],
      language: 'en',
    });
    const beforePreview = readFileSync(previewPath);
    const preview = await metaPreview(previewPath, { title: 'T2' });
    assert.equal(preview.ok, true, `preview failed: ${preview.message}`);
    assert.equal(preview.status, 'ok');
    assert.match(preview.token, /^[0-9a-f]{32}$/, 'token must be 16 random bytes in hex');
    const titleDiff = preview.diff.find((d) => d.field === 'title');
    assert.deepEqual(titleDiff, { field: 'title', oldValue: 'Original Title', newValue: 'T2' });
    assert.ok(readFileSync(previewPath).equals(beforePreview),
      'metaPreview must write NOTHING to disk');
    assert.ok(__tokens.has(preview.token), 'token must live in the in-memory Map');

    // 2) commit: applies the change; second commit refused (one-shot), no write.
    const committed = await metaCommit(preview.token);
    assert.equal(committed.ok, true, `commit failed: ${committed.message}`);
    assert.equal(committed.status, 'ok');
    assert.equal((await metaRead(previewPath)).fields.title, 'T2');
    const afterCommit = readFileSync(previewPath);
    const again = await metaCommit(preview.token);
    assert.equal(again.ok, false);
    assert.equal(again.status, STATUS_TOKEN_EXPIRED);
    assert.equal(__tokens.has(preview.token), false, 'token must be deleted after use');
    assert.ok(readFileSync(previewPath).equals(afterCommit),
      'a refused second commit must not touch bytes');

    // 3) expiry: a past-expires token is refused without writing.
    const expiryPath = buildEpubFixture(join(dir, 'expiry.epub'), { title: 'Expiry Book' });
    const expiryPreview = await metaPreview(expiryPath, { title: 'Should Not Apply' });
    const beforeExpiry = readFileSync(expiryPath);
    __tokens.set(expiryPreview.token, {
      ...__tokens.get(expiryPreview.token),
      expires: Date.now() - 1000,
    });
    const expired = await metaCommit(expiryPreview.token);
    assert.equal(expired.ok, false);
    assert.equal(expired.status, STATUS_TOKEN_EXPIRED);
    assert.ok(readFileSync(expiryPath).equals(beforeExpiry),
      'an expired token must not write');

    // 4) path-bound: token bound to path A, but A is renamed before commit.
    const boundPath = buildEpubFixture(join(dir, 'bound.epub'), { title: 'Bound Book' });
    const boundPreview = await metaPreview(boundPath, { title: 'Nope' });
    const beforeBound = readFileSync(boundPath);
    const movedPath = join(dir, 'bound-moved.epub');
    renameSync(boundPath, movedPath);
    const unbound = await metaCommit(boundPreview.token);
    assert.equal(unbound.ok, false);
    assert.equal(unbound.status, STATUS_WRITE_FAILED);
    assert.ok(readFileSync(movedPath).equals(beforeBound),
      'a path-bound refusal must not modify the moved file');

    // 5) content integrity: a file modified in place after preview is refused,
    //    its token burned, and the externally-modified bytes left untouched.
    const changedPath = buildEpubFixture(join(dir, 'changed.epub'), {
      title: 'Change Me',
      authors: ['Fixture Author'],
      language: 'en',
    });
    const changedPreview = await metaPreview(changedPath, { title: 'Stale Title' });
    assert.equal(changedPreview.ok, true, `preview failed: ${changedPreview.message}`);
    // External modification: append one byte after preview, bypassing every
    // plugin writer. A stale commit must not overwrite these bytes.
    const externalBytes = Buffer.concat([readFileSync(changedPath), Buffer.from([0x0a])]);
    writeFileSync(changedPath, externalBytes);
    const changed = await metaCommit(changedPreview.token);
    assert.equal(changed.ok, false, 'commit must refuse a file changed since preview');
    assert.equal(changed.status, STATUS_TOKEN_EXPIRED);
    assert.equal(__tokens.has(changedPreview.token), false,
      'a changed-file token must be burned so a fresh preview is forced');
    assert.ok(readFileSync(changedPath).equals(externalBytes),
      'a refused commit must leave the externally-modified bytes exactly as they are');

    // 6) metaRead STATUS mapping (all read-time MetaError codes).
    const textPath = join(dir, 'notes.txt');
    writeFileSync(textPath, 'not a book');
    const unsupported = await metaRead(textPath);
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.status, STATUS_UNSUPPORTED_FORMAT);

    const brokenPath = buildEpubFixture(
      join(dir, 'broken.epub'),
      { title: 'Broken' },
      { omitContainer: true },
    );
    const broken = await metaRead(brokenPath);
    assert.equal(broken.ok, false);
    assert.equal(broken.status, STATUS_BAD_META);

    const good = await metaRead(previewPath);
    assert.equal(good.ok, true);
    assert.equal(good.status, 'ok');
    assert.equal(good.fields.title, 'T2');

    // 7) zero-credential static check: no credential envs in module source.
    const sourcePath = fileURLToPath(new URL('./lib/zlib-meta.mjs', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    assert.doesNotMatch(source, /ZLIB_EMAIL|ZLIB_PASSWORD|ZLIB_COOKIE|process\.env/,
      'module source must contain no credential hooks');

    console.log('test-zlib-meta: ALL PASS');
  } finally {
    __tokens.clear();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSuite();
}
