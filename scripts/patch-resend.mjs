#!/usr/bin/env node
/**
 * 修复 emdash-plugin-resend 0.2.0 与 emdash 1.2.0 的插件格式不兼容。
 *
 * 问题：插件的 sandbox 入口（`dist/sandbox-entry.mjs`）用
 * `definePlugin({ hooks, routes })` **不传 `id`** 包裹定义 —— 这是旧版
 * （其 peerDependency 声明 `emdash@^0.5.0`）的写法。而 emdash 1.2.0 的
 * `definePlugin()` 是**标准/原生格式**的助手，**要求 `id` + `version`**；
 * 沙箱格式应当直接 `export default { hooks, routes }`（身份来自
 * `emdash-plugin.jsonc`）。根 `package.json` 的 `overrides` 把 resend 的
 * `emdash` 强制解析到 1.2.0（消除 peer 冲突），于是这个调用在**模块加载时**
 * 就抛错：
 *
 *   definePlugin() requires `id` (got undefined). …
 *
 * 产物里该入口是**静态导入**，抛错冒泡成**整站 500**（任意路由）。这是
 * 上线阻断级问题，且与业务代码无关（`node -e "import('emdash-plugin-resend/sandbox')"`
 * 即可独立复现）。
 *
 * 修法：去掉 `definePlugin(...)` 包装，让默认导出变成适配器期望的
 * `{ hooks, routes }`（emdash 的 `adaptSandboxEntry` 会接住它）。`import { definePlugin }`
 * 保留成未使用导入也无害，最小化改动面。
 *
 * 为什么在 node_modules 里就地改：上游只发布构建产物、不含源码，且暂无修复版本。
 * `postinstall` 自动执行，幂等；上游去掉 `definePlugin({` 调用后脚本自动跳过。
 *
 * 验证：`node scripts/patch-resend.mjs --check`
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** 触发问题的调用形态（去掉包装后变成 `= ({`，即对象字面量直出）。 */
const BAD_CALL = "definePlugin({";

function resolvePluginEntry() {
	try {
		// 插件的 sandbox 入口：package.json exports["./sandbox"] → dist/sandbox-entry.mjs
		return require.resolve("emdash-plugin-resend/sandbox");
	} catch {
		return null;
	}
}

/** `node --check` 只做语法解析（不解析 import），用来兜底补丁没把文件改坏。 */
function assertParses(file) {
	execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

function main() {
	const checkOnly = process.argv.includes("--check");
	const entry = resolvePluginEntry();

	if (!entry || !existsSync(entry)) {
		// 插件未安装（例如裁剪过的安装）：不是错误，跳过。
		console.log("[patch-resend] 未安装 emdash-plugin-resend，跳过");
		return;
	}

	const before = readFileSync(entry, "utf8");
	const count = before.split(BAD_CALL).length - 1;

	if (count === 0) {
		console.log("[patch-resend] 未发现 definePlugin({ … }) 包装（上游已修或已打过补丁），跳过");
		return;
	}

	if (checkOnly) {
		console.log(`[patch-resend] --check：需要打补丁（${count} 处，未写入）`);
		process.exitCode = 1;
		return;
	}

	// 去掉包装：`= definePlugin({ … })` → `= ({ … })`。产物里这处即默认导出。
	const after = before.replaceAll(BAD_CALL, "({");
	writeFileSync(entry, after);

	try {
		assertParses(entry);
	} catch (error) {
		// 语法坏了就回滚，避免把坏文件留在 node_modules 里（否则 500 更难定位）。
		writeFileSync(entry, before);
		throw new Error(`[patch-resend] 补丁后语法校验失败，已回滚：${error.message}`);
	}

	console.log(`[patch-resend] 已修补 ${entry}（去掉 ${count} 处 definePlugin() 包装）`);
}

main();
