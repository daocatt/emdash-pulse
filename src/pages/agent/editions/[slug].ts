import type { APIRoute } from "astro";
import { getEmDashEntry, getEmDashCollection, decodeSlug } from "emdash";
import { agentGuard } from "../../../utils/agent-route";
import { serializeEdition, serializeArticleSummary, jsonResponse } from "../../../utils/agent";

/** GET /agent/editions/{slug} —— 期号及其收录文章。 */
export const GET: APIRoute = async ({ request, url, params }) => {
	const guard = await agentGuard(request, url);
	if ("response" in guard) return guard.response;

	const slug = decodeSlug(params.slug);
	if (!slug) {
		return jsonResponse({ error: "NOT_FOUND" }, { status: 404, maxAge: 0 });
	}

	const { entry: edition, error } = await getEmDashEntry("editions", slug);
	if (error) {
		return jsonResponse({ error: "QUERY_FAILED", message: error.message }, { status: 500, maxAge: 0 });
	}
	if (!edition) {
		return jsonResponse({ error: "NOT_FOUND", slug }, { status: 404, maxAge: 0 });
	}

	const { entries: articles } = await getEmDashCollection("articles", {
		where: { edition: slug },
		orderBy: { published_at: "desc" },
		limit: 100,
	});

	return jsonResponse(
		{
			...guard.meta,
			edition: serializeEdition(edition, guard.siteUrl),
			count: articles.length,
			items: articles.map((entry) => serializeArticleSummary(entry, guard.siteUrl)),
		},
		{ maxAge: 600 },
	);
};
