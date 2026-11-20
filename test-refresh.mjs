/** 镜像自愈（refreshMirrors + scihub_refresh_mirrors 工具）的离线回归测试。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from './lib/host.mjs';
import { refreshMirrors } from './lib/mirrors.mjs';

const DOI = '10.1038/nature12373';
const PDF = Buffer.from('%PDF-1.4 test-refresh\n');

/** behavior: live | captcha | nopdf */
function startMirror(behavior) {
	const server = http.createServer((req, res) => {
		if (req.url.includes('/pdf')) {
			if (behavior === 'live') {
				res.writeHead(200, { 'content-type': 'application/pdf' });
				res.end(PDF);
			} else {
				res.writeHead(404);
				res.end();
			}
			return;
		}
		if (behavior === 'live') {
			const html = `<html><body><embed src="/pdf?doi=${encodeURIComponent(DOI)}" type="application/pdf"></body></html>`;
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(html);
		} else if (behavior === 'captcha') {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end('<html><title>Just a moment...</title><body>Checking your browser</body></html>');
		} else {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end('<html><body>nothing here</body></html>');
		}
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
		});
	});
}

const tmp = await mkdtemp(join(tmpdir(), 'scihub-refresh-'));
const mirrorFile = join(tmp, 'mirrors.json');
const mirrors = [];
try {
	// ── 1. 混合候选：只保留能真下到 PDF 的，按速度排序写回 ──
	const live1 = await startMirror('live');
	const live2 = await startMirror('live');
	const captcha = await startMirror('captcha');
	const nopdf = await startMirror('nopdf');
	mirrors.push(live1, live2, captcha, nopdf);

	const original = { updatedAt: '2020-01-01', mirrors: ['https://old.example'] };
	await writeFile(mirrorFile, JSON.stringify(original), 'utf8');

	const result = await refreshMirrors({
		doi: DOI,
		candidates: [captcha.base, nopdf.base, live1.base, live2.base],
		file: mirrorFile,
		concurrency: 4,
	});
	assert.equal(result.ok, true, '有活镜像时应成功');
	assert.equal(result.status, 'refreshed');
	assert.deepEqual(result.before, original.mirrors, 'before 应是旧列表');
	assert.deepEqual(result.after.sort(), [live1.base, live2.base].sort(), '只保留两个能下 PDF 的镜像');
	assert.ok(!result.after.includes(captcha.base), '验证页镜像必须被剔除');
	assert.ok(!result.after.includes(nopdf.base), '无 PDF 链接的镜像必须被剔除');

	const written = JSON.parse(await readFile(mirrorFile, 'utf8'));
	assert.deepEqual(written.mirrors.sort(), result.after.sort(), '写回文件的应是新列表');
	assert.notEqual(written.updatedAt, original.updatedAt, 'updatedAt 应更新');

	// ── 2. 全死：保留旧列表，不清空 ──
	const stale = { updatedAt: '2020-01-01', mirrors: ['https://keep-me.example'] };
	await writeFile(mirrorFile, JSON.stringify(stale), 'utf8');
	const dead = await refreshMirrors({
		doi: DOI,
		candidates: [captcha.base, nopdf.base],
		file: mirrorFile,
		concurrency: 2,
	});
	assert.equal(dead.ok, false, '全死时应失败');
	assert.equal(dead.status, 'no_live');
	assert.deepEqual(dead.after, stale.mirrors, '全死时 after 应等于旧列表');
	const unchanged = JSON.parse(await readFile(mirrorFile, 'utf8'));
	assert.deepEqual(unchanged, stale, '全死时不能改镜像文件');

	// ── 3. 工具已注册，且 challenge 提示指向自愈工具 ──
	const registered = [];
	const ctx = {
		tools: { register: (def) => registered.push(def) },
		get: () => null,
	};
	apply(ctx, {});
	const refreshTool = registered.find((t) => t.name === 'scihub_refresh_mirrors');
	assert.ok(refreshTool, '应注册 scihub_refresh_mirrors 工具');
	assert.ok(typeof refreshTool.execute === 'function');
	const rendered = refreshTool.output.render(null, {
		ok: true,
		message: '已重测 24 个镜像，4 个可用',
		before: ['a'],
		after: ['b'],
	})[0].text;
	assert.match(rendered, /现列表: b/, 'render 应显示新列表');

	console.log('test-refresh: ALL PASS');
} finally {
	for (const m of mirrors) await new Promise((r) => m.server.close(r));
	await rm(tmp, { recursive: true, force: true });
}
