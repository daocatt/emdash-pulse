/**
 * 站内搜索 JSON 端点（自建，走 `pulse_search` + pg_trgm）。
 *
 * EmDash 自带的 `/_emdash/api/search` 依赖 SQLite FTS5，在 PostgreSQL 下恒返回空；
 * 头部实时搜索与 `/search` 页都改用本端点（见 src/server/search-index.mjs）。
 *
 * 请求：`GET /api/search?q=<关键词>&limit=<1..50>`
 * 响应：`{ items: [{ collection, id, slug, title, snippet }] }`（snippet 含 `<mark>`）
 *
 * 说明：`src/middleware.ts` 的 `SKIP_PREFIXES` 含 `/api`，本端点不参与主题 rewrite。
 */
import type { APIRoute } from "astro";
import { ensureAndRefreshIndex, searchContent } from "../../server/search-index.mjs";

const MAX_LIMIT = 50;

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			// 索引最多滞后 5 分钟，短缓存足够且能挡住重复键入。
			"Cache-Control": "public, max-age=30",
		},
	});
}

export const GET: APIRoute = async ({ url }) => {
	const query = url.searchParams.get("q")?.trim() ?? "";
	const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const limit = Number.isFinite(requested)
		? Math.min(Math.max(requested, 1), MAX_LIMIT)
		: 10;

	if (!query) return json({ items: [] });

	await ensureAndRefreshIndex();
	return json({ items: await searchContent(query, limit) });
};
