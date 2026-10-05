import type { APIRoute } from "astro";
import { getEmDashCollection } from "emdash";
import type { WhereValue } from "emdash";
import { agentGuard } from "../../utils/agent-route";
import { serializeArticleSummary, jsonResponse } from "../../utils/agent";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * GET /agent/news
 *
 * 查询参数：
 *   section  版块 slug（taxonomy）
 *   tag      标签 slug（taxonomy）
 *   edition  期号 slug（taxonomy）
 *   type     稿件类型（standard/photo/live/video）
 *   since    起始时间（ISO，含）
 *   until    结束时间（ISO，不含）
 *   order    desc（默认）| asc
 *   limit    1–100（默认 20）
 *   cursor   keyset 游标（上一页的 next_cursor）
 *   offset   offset 分页（与 cursor 互斥）
 */
export const GET: APIRoute = async ({ request, url }) => {
	const guard = await agentGuard(request, url);
	if ("response" in guard) return guard.response;

	const params = url.searchParams;
	const where: Record<string, WhereValue> = {};
	for (const key of ["section", "tag", "edition", "type"] as const) {
		const value = params.get(key);
		if (value) where[key === "type" ? "article_type" : key] = value;
	}
	const since = params.get("since");
	const until = params.get("until");
	if (since || until) {
		where.published_at = {
			...(since ? { gte: new Date(since).toISOString() } : {}),
			...(until ? { lt: new Date(until).toISOString() } : {}),
		};
	}

	const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(params.get("limit") ?? "", 10) || DEFAULT_LIMIT));
	const order: "asc" | "desc" = params.get("order") === "asc" ? "asc" : "desc";
	const cursor = params.get("cursor") ?? undefined;
	const offsetRaw = Number.parseInt(params.get("offset") ?? "", 10);

	const base = {
		orderBy: { published_at: order },
		limit,
		...(Object.keys(where).length > 0 ? { where } : {}),
	};
	// cursor 与 offset 互斥（EmDash 的类型与运行时都如此要求）
	const filter = cursor
		? { ...base, cursor }
		: Number.isInteger(offsetRaw) && offsetRaw > 0
			? { ...base, offset: offsetRaw }
			: base;

	const { entries, nextCursor, hasMore, error } = await getEmDashCollection("articles", filter);
	if (error) {
		return jsonResponse({ error: "QUERY_FAILED", message: error.message }, { status: 500, maxAge: 0 });
	}

	return jsonResponse(
		{
			...guard.meta,
			count: entries.length,
			has_more: Boolean(hasMore),
			next_cursor: nextCursor ?? null,
			items: entries.map((entry) => serializeArticleSummary(entry, guard.siteUrl)),
		},
		{ maxAge: 300 },
	);
};
