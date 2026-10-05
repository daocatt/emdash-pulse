import type { APIRoute } from "astro";
import { getEmDashCollection } from "emdash";
import { monthRange, weekRange, isoWeeksInYear } from "../../utils/date-range";

/**
 * Phase 0 Spike：验证按月 / 按周的范围查询。
 *
 * 用法：
 *   /spike/date-range.json                     列出全部（含 publishedAt）
 *   /spike/date-range.json?year=2026&month=10  按月
 *   /spike/date-range.json?year=2026&week=40   按周
 */
export const GET: APIRoute = async ({ url }) => {
	const yearParam = url.searchParams.get("year");
	const monthParam = url.searchParams.get("month");
	const weekParam = url.searchParams.get("week");

	let range: { gte: string; lt: string } | null = null;
	let label = "all";
	if (yearParam && monthParam) {
		range = monthRange(Number(yearParam), Number(monthParam));
		label = `${yearParam}-${String(monthParam).padStart(2, "0")}`;
	} else if (yearParam && weekParam) {
		range = weekRange(Number(yearParam), Number(weekParam));
		label = `${yearParam}-W${String(weekParam).padStart(2, "0")}`;
	}

	const { entries, error } = await getEmDashCollection("articles", {
		...(range ? { where: { published_at: range } } : {}),
		orderBy: { published_at: "desc" },
		limit: 100,
	});

	return new Response(
		JSON.stringify(
			{
				label,
				range,
				isoWeeksInYear2026: isoWeeksInYear(2026),
				error: error ? String(error) : null,
				count: entries.length,
				items: entries.map((e) => ({
					slug: e.id,
					title: e.data.title,
					publishedAt: e.data.publishedAt,
					review_status: (e.data as Record<string, unknown>).review_status ?? null,
				})),
			},
			null,
			2,
		),
		{ headers: { "content-type": "application/json; charset=utf-8" } },
	);
};
