#!/usr/bin/env node
/**
 * 重建 PostgreSQL 搜索索引（`pulse_search`，pg_trgm）。
 *
 * EmDash 的 FTS 只支持 SQLite，迁到 PostgreSQL 后本站用自建索引做中文子串检索
 * （见 src/server/search-index.mjs 与 docs/16-vps-deployment.md）。
 *
 * 应用运行期会**懒刷新**该索引（首次同步建、之后每 5 分钟后台重建一次），所以
 * 本脚本主要用于：首次部署预热、手工排障、或外部定时任务强制刷新。
 *
 * 用法：
 *   npm run search:rebuild
 *   DATABASE_URL=postgres://… npm run search:rebuild
 *   docker compose exec pulse-app node scripts/search-rebuild.mjs
 */
import { closeSearchPool, rebuildIndex } from "../src/server/search-index.mjs";

try {
	const result = await rebuildIndex();
	if (result?.skipped) {
		console.log("已有重建在进行中（advisory lock 未获取），本次跳过。");
	} else {
		console.log(`搜索索引重建完成：${result.count} 条。`);
	}
} catch (error) {
	console.error(
		`搜索索引重建失败：${error instanceof Error ? error.message : String(error)}\n` +
			"请确认 DATABASE_URL（或 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD）指向可用的 PostgreSQL。",
	);
	process.exitCode = 1;
} finally {
	await closeSearchPool();
}
