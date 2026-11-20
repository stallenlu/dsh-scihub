#!/usr/bin/env node
/**
 * 一键重测镜像（CLI 入口）。
 *
 *   node update-mirrors.mjs
 *   node update-mirrors.mjs --doi 10.1038/nature12373
 *
 * 真正的探测逻辑在 lib/mirrors.mjs 的 refreshMirrors()，插件工具
 * scihub_refresh_mirrors 也调用同一个函数——两处共用，不复制代码。
 * 一个镜像只有真下到以 %PDF- 开头的 PDF 才算活着。可用镜像按速度排序
 * 写回 lib/mirrors.json；插件每次调用都重读该文件，立即生效、无需重启。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refreshMirrors } from './lib/mirrors.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIRROR_FILE = join(HERE, 'lib', 'mirrors.json');

const args = process.argv.slice(2);
const doiArg = args.indexOf('--doi');
const DOI = doiArg >= 0 ? args[doiArg + 1] : '10.1038/nature12373';

const result = await refreshMirrors({ doi: DOI, file: MIRROR_FILE });
for (const r of result.results) {
	console.log(
		r.ok
			? `OK   ${String(r.ms).padStart(6)} ms  ${r.mirror}  (${r.bytes} bytes)`
			: `--   ${String(r.ms).padStart(6)} ms  ${r.mirror}  ${r.reason}`
	);
}
console.log(`\n${result.message}`);
console.log(`  文件: ${MIRROR_FILE}`);
if (result.ok) {
	const added = result.after.filter((m) => !result.before.includes(m));
	const dropped = result.before.filter((m) => !result.after.includes(m));
	if (added.length) console.log(`  新增: ${added.join(', ')}`);
	if (dropped.length) console.log(`  移除: ${dropped.join(', ')}`);
}
if (!result.ok) process.exitCode = 1;
