#!/usr/bin/env node
/**
 * 为中文内容配置全文检索分词器。
 *
 * 背景：EmDash 的 FTS 索引默认使用 `porter unicode61`（英文分词），
 * 对中文只能整段匹配（「内容审核工作流」无法用「审核」命中）。
 * `trigram` 分词器支持中文子串检索。
 *
 * EmDash 目前只在程序内暴露 `FTSManager.enableSearch(slug, { tokenize })`，
 * seed / admin / REST 均未暴露 tokenizer 配置。但 `enableSearch` 会**沿用**
 * 已存在的 `search_config.tokenize`，因此本脚本的做法是：
 *   1) 直接把 `_emdash_collections.search_config` 的 tokenize 改成 trigram；
 *   2) 重新执行 `emdash seed`，其内部的 enableSearch 会以 trigram 重建索引。
 *
 * 用法：
 *   node scripts/configure-search.mjs                 # articles + pages，trigram，并重建索引
 *   node scripts/configure-search.mjs --no-seed       # 只改配置，不重建
 *   node scripts/configure-search.mjs --tokenize=unicode61
 *   node scripts/configure-search.mjs --db=./data.db
 *
 * 注意：重建索引会短暂写入数据库，建议先停掉 dev server 再执行。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const hasFlag = (name) => args.includes(`--${name}`);

const dbPath = getArg("db", "./data.db");
const tokenize = getArg("tokenize", "trigram");
const collections = getArg("collections", "articles,pages")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

if (!existsSync(dbPath)) {
	console.error(`[search] 数据库不存在：${dbPath}`);
	process.exit(1);
}

const VALID = ["porter unicode61", "unicode61", "trigram"];
if (!VALID.includes(tokenize)) {
	console.error(`[search] 不支持的分词器：${tokenize}（可选：${VALID.join(", ")}）`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);
try {
	for (const slug of collections) {
		const row = db.prepare("SELECT search_config FROM _emdash_collections WHERE slug = ?").get(slug);
		if (!row) {
			console.warn(`[search] 跳过：未找到集合 ${slug}`);
			continue;
		}
		let config = {};
		try {
			config = row.search_config ? JSON.parse(row.search_config) : {};
		} catch {
			config = {};
		}
		config.enabled = true;
		config.tokenize = tokenize;
		db.prepare("UPDATE _emdash_collections SET search_config = ? WHERE slug = ?").run(
			JSON.stringify(config),
			slug,
		);
		console.log(`[search] ${slug}: tokenize -> ${tokenize}`);
	}
} finally {
	db.close();
}

if (hasFlag("no-seed")) {
	console.log("[search] 已更新配置（未重建索引）。请运行 `npx emdash seed` 以按新分词器重建索引。");
	process.exit(0);
}

console.log("[search] 重新执行 seed 以重建索引…");
const result = spawnSync("npx", ["emdash", "seed"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
