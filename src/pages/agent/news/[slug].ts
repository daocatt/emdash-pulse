import type { APIRoute } from "astro";
import { getEmDashEntry, decodeSlug } from "emdash";
import { agentGuard } from "../../../utils/agent-route";
import { serializeArticleDetail, jsonResponse } from "../../../utils/agent";

/** GET /agent/news/{slug} —— 单篇详情（Portable Text + 纯文本 + markdown + 图片）。 */
export const GET: APIRoute = async ({ request, url, params }) => {
	const guard = await agentGuard(request, url);
	if ("response" in guard) return guard.response;

	const slug = decodeSlug(params.slug);
	if (!slug) {
		return jsonResponse({ error: "NOT_FOUND" }, { status: 404, maxAge: 0 });
	}

	const { entry, error } = await getEmDashEntry("articles", slug);
	if (error) {
		return jsonResponse({ error: "QUERY_FAILED", message: error.message }, { status: 500, maxAge: 0 });
	}
	if (!entry) {
		return jsonResponse({ error: "NOT_FOUND", slug }, { status: 404, maxAge: 0 });
	}

	return jsonResponse({ ...guard.meta, article: serializeArticleDetail(entry, guard.siteUrl) }, { maxAge: 300 });
};
