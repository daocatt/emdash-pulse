import type { APIRoute } from "astro";
import { getEmDashCollection } from "emdash";
import { agentGuard } from "../../../utils/agent-route";
import { serializeArticleSummary, jsonResponse } from "../../../utils/agent";

/** GET /agent/news/latest?limit=10 —— 最新报道。 */
export const GET: APIRoute = async ({ request, url }) => {
	const guard = await agentGuard(request, url);
	if ("response" in guard) return guard.response;

	const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 10));
	const { entries, error } = await getEmDashCollection("articles", {
		orderBy: { published_at: "desc" },
		limit,
	});
	if (error) {
		return jsonResponse({ error: "QUERY_FAILED", message: error.message }, { status: 500, maxAge: 0 });
	}

	return jsonResponse(
		{
			...guard.meta,
			count: entries.length,
			items: entries.map((entry) => serializeArticleSummary(entry, guard.siteUrl)),
		},
		{ maxAge: 120 },
	);
};
