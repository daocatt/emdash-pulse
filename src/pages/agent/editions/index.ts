import type { APIRoute } from "astro";
import { getEmDashCollection } from "emdash";
import { agentGuard } from "../../../utils/agent-route";
import { serializeEdition, jsonResponse } from "../../../utils/agent";

/** GET /agent/editions?limit=20 —— 期号列表。 */
export const GET: APIRoute = async ({ request, url }) => {
	const guard = await agentGuard(request, url);
	if ("response" in guard) return guard.response;

	const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 20));
	const { entries, error } = await getEmDashCollection("editions", {
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
			items: entries.map((entry) => serializeEdition(entry, guard.siteUrl)),
		},
		{ maxAge: 600 },
	);
};
