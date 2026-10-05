import type { APIRoute } from "astro";
import { getTaxonomyTermsWithCacheHint } from "emdash";
import { agentGuard } from "../../utils/agent-route";
import { jsonResponse } from "../../utils/agent";

/** GET /agent/sections —— 版块列表及计数。 */
export const GET: APIRoute = async ({ request, url }) => {
	const guard = await agentGuard(request, url);
	if ("response" in guard) return guard.response;

	const { data: terms } = await getTaxonomyTermsWithCacheHint("section", { includeCounts: true });

	return jsonResponse(
		{
			...guard.meta,
			count: terms.length,
			items: terms.map((term) => ({
				slug: term.slug,
				label: term.label,
				count: term.count ?? 0,
				url: new URL(`/sections/${term.slug}`, guard.siteUrl).href,
				api_url: new URL(`/agent/news?section=${term.slug}`, guard.siteUrl).href,
			})),
		},
		{ maxAge: 600 },
	);
};
