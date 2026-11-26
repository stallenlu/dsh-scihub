/**
 * Offline host-wiring tests for the four zlib_meta_* tools (v0.6.1 Task 5).
 *
 *   node test-zlib-meta-tools.mjs          # prints ALL PASS when green
 *
 * R1: the EPUB fixture builder is imported from test-ebookmeta.mjs, whose
 * direct-execution guard keeps its own suite from running on import.
 *
 * Node built-ins only. No network, no credentials, no child_process.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { apply } from './lib/host.mjs';
import { buildEpubFixture } from './test-ebookmeta.mjs';

const META_TOOLS = [
	'zlib_meta_read',
	'zlib_meta_lookup',
	'zlib_meta_preview',
	'zlib_meta_commit',
];
const CREDENTIAL_KEYS = ['email', 'password', 'cookie', 'userkey', 'userid'];

function harness() {
	const registered = {};
	const ctx = {
		tools: { register(d) { registered[d.name] = d; } },
		get(name) { return name === 'workingDirectory' ? { defaultDirectory: tmpdir() } : undefined; },
	};
	apply(ctx, { mirrors: [], mirrorFile: '', fileNameTemplate: '', libgenMirrors: [], proxy: '' });
	return registered;
}

function textOf(tool, value, args = {}) {
	const parts = tool.output.render(args, value);
	assert.equal(Array.isArray(parts), true, 'render must return a parts array');
	assert.equal(typeof parts[0].text, 'string', 'render must return human text');
	return parts[0].text;
}

async function runSuite() {
	const dir = mkdtempSync(join(tmpdir(), 'zlib-meta-tools-'));
	try {
		// ── 1) registration: exactly 18 tools, four new names present ─────────
		const reg = harness();
		const names = Object.keys(reg);
		assert.equal(names.length, 18, `expected 18 tools, got ${names.length}: ${names.join(', ')}`);
		for (const name of META_TOOLS) {
			assert.ok(reg[name], `${name} must be registered`);
			assert.equal(typeof reg[name].execute, 'function', `${name} needs execute()`);
			assert.ok(reg[name].output && typeof reg[name].output.render === 'function', `${name} needs render()`);
		}

		// ── 2) zero-credential schema for EACH meta tool ──────────────────────
		for (const name of META_TOOLS) {
			const props = reg[name].parameters && reg[name].parameters.properties;
			assert.ok(props && typeof props === 'object', `${name} needs a parameter schema`);
			for (const key of CREDENTIAL_KEYS) {
				assert.equal(key in props, false, `${name} must NOT expose \`${key}\` in its schema`);
			}
		}

		// ── 3) meta_read renders the book title as human Chinese text ─────────
		const title = '工具渲染测试书名';
		const fixture = buildEpubFixture(join(dir, 'read.epub'), { title, authors: ['测试作者'] });
		const readValue = await reg.zlib_meta_read.execute({ path: fixture }, {});
		assert.equal(readValue.ok, true, `meta_read failed: ${readValue.message}`);
		const readText = textOf(reg.zlib_meta_read, readValue, { path: fixture });
		assert.ok(readText.includes(title), `render must include the title, got: ${readText}`);
		assert.doesNotMatch(readText, /\[object Object\]|"fields"\s*:/, 'render must not dump raw structures');

		// ── 4) meta_commit with a bogus token => token-expiry wording, no stack
		const bogus = 'not-a-real-token';
		const commitValue = await reg.zlib_meta_commit.execute({ token: bogus }, {});
		assert.equal(commitValue.ok, false);
		assert.equal(commitValue.status, 'token_expired');
		const commitText = textOf(reg.zlib_meta_commit, commitValue, { token: bogus });
		assert.match(commitText, /令牌|过期|失效|无效/, `expected token-expiry wording, got: ${commitText}`);
		assert.doesNotMatch(commitText, /node:|\.mjs:\d+|at\s+\S+\s+\(/, 'render must not expose a stack trace');

		// ── 5) preview + lookup renders stay human (no raw JSON / candidates) ─
		const previewValue = {
			ok: true, status: 'ok', token: 'abcdef0123456789',
			diff: [{ field: 'title', oldValue: '旧名', newValue: '新名' }],
			message: 'preview computed; no changes written',
		};
		const previewText = textOf(reg.zlib_meta_preview, previewValue, { path: fixture });
		assert.match(previewText, /书名|title/, 'preview render must describe changed fields');
		assert.doesNotMatch(previewText, /"diff"\s*:/, 'preview render must not dump raw JSON');

		const lookupValue = {
			ok: true, status: 'ok',
			candidates: [{ source: 'openlibrary', title: 'Deep Learning' }],
		};
		const lookupText = textOf(reg.zlib_meta_lookup, lookupValue, { title: 'Deep Learning' });
		assert.match(lookupText, /Deep Learning/, 'lookup render must show candidate titles');
		assert.doesNotMatch(lookupText, /"raw"\s*:|\[object Object\]/, 'lookup render must not surface raw records');

		console.log('test-zlib-meta-tools: ALL PASS');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runSuite();
}
