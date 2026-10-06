#!/usr/bin/env node
/**
 * 修复 @emdash-cms/plugin-audit-log 0.2.3 的 Block Kit 协议不兼容。
 *
 * 问题：插件的 `/history` 页面手写了一个 `table` block，字段名用 camelCase
 * （`blockId` / `pageActionId` / `nextCursor` / `emptyText`），而
 * `@emdash-cms/blocks@1.1.0` 的 `validateBlockResponse` 要求 snake_case
 * （`block_id` / `page_action_id` / `next_cursor` / `empty_text`）。
 * 缺 `page_action_id`（必填）会让宿主返回：
 *
 *   502 {"success":false,"error":{"code":"INVALID_BLOCK_RESPONSE", ...}}
 *
 * 后台「Audit History」页面因此整页渲染失败。`next_cursor` / `empty_text`
 * 不匹配则静默失效（翻页与空态文案）。插件自带的 `table()` builder 会做
 * 这个转换，但插件绕过了 builder 直接写字面量。
 *
 * 为什么在 node_modules 里就地改：上游最新版仍是 0.2.3（未修），npm 包只
 * 发布构建产物、不含源码，无法在上游修之前升级。`postinstall` 自动执行，
 * 幂等；上游修好后文件里会出现 `page_action_id`，脚本自动跳过。
 *
 * 验证：`node scripts/patch-audit-log.mjs --check`
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** camelCase → snake_case，按协议要求（TableBlock 见 @emdash-cms/blocks 类型定义）。 */
const RENAMES = [
	["blockId", "block_id"],
	["pageActionId", "page_action_id"],
	["nextCursor", "next_cursor"],
	["emptyText", "empty_text"],
];

function resolvePluginEntry() {
	try {
		// 插件的 sandbox 入口：package.json exports["./sandbox"] → dist/plugin.mjs
		return require.resolve("@emdash-cms/plugin-audit-log/sandbox");
	} catch {
		return null;
	}
}

function main() {
	const checkOnly = process.argv.includes("--check");
	const entry = resolvePluginEntry();

	if (!entry || !existsSync(entry)) {
		// 插件未安装（例如裁剪过的安装）：不是错误，跳过。
		console.log("[patch-audit-log] 未安装 @emdash-cms/plugin-audit-log，跳过");
		return;
	}

	const before = readFileSync(entry, "utf8");

	if (before.includes("page_action_id")) {
		console.log("[patch-audit-log] 已是 snake_case（上游已修或已打过补丁），跳过");
		return;
	}

	const missing = RENAMES.filter(([camel]) => !before.includes(camel));
	if (missing.length > 0) {
		// 字段名一个都找不到，说明插件实现变了：宁可显式失败，也不静默放过，
		// 否则 502 会在运行时才暴露。
		throw new Error(
			`[patch-audit-log] 在 ${entry} 中找不到预期字段：${missing
				.map(([camel]) => camel)
				.join(", ")}。插件实现可能已变更，请重新核对 Block Kit 字段名。`,
		);
	}

	let after = before;
	for (const [camel, snake] of RENAMES) {
		// 这些标识符在产物中各出现一次（table block 那一处），全局替换是安全的。
		after = after.replaceAll(camel, snake);
	}

	if (checkOnly) {
		console.log("[patch-audit-log] --check：需要打补丁（未写入）");
		process.exitCode = 1;
		return;
	}

	writeFileSync(entry, after);
	console.log(`[patch-audit-log] 已修补 ${entry}`);
	console.log(
		`[patch-audit-log] 字段重命名：${RENAMES.map(([c, s]) => `${c} → ${s}`).join(", ")}`,
	);
}

main();
