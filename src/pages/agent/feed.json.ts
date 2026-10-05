import type { APIRoute } from "astro";
import { getEmDashCollection } from "emdash";
import { agentGuard } from "../../utils/agent-route";
import { serializeArticleSummary, jsonResponse } from "../../utils/agent";
import { extractPlainText } from "../../utils/text";

/** GET /agent/feed.json —— JSON Feed 1.1（与 /feed.json 语义一致，便于 agent 统一入口）。 */
export const GET: APIRoute = async ({ request, url }) => {
	const guard = await agentGuard(request, url);
	if ("response" in guard) return guard.response;

	const { entries } = await getEmDashCollection("articles", {
		orderBy: { published_at: "desc" },
		limit: 50,
	});

	const items = entries.map((entry) => {
		const summary = serializeArticleSummary(entry, guard.siteUrl);
		const body = entry.data.excerpt ?? entry.data.deck ?? extractPlainText(entry.data.content).slice(0, 500);
		return {
			id: summary.url,
			url: summary.url,
			title: summary.title,
			summary: body,
			content_text: body,
			date_published: summary.published_at,
			tags: [...(summary.section ? [summary.section.label] : []), ...summary.tags.map((tag) => tag.label)],
			_agent: {
				slug: summary.slug,
				article_type: summary.article_type,
				author_agent: summary.author_agent,
				api_url: new URL(`/agent/news/${summary.slug}`, guard.siteUrl).href,
			},
		};
	});

	return jsonResponse(
		{
			version: "https://jsonfeed.org/version/1.1",
			title: guard.meta.site,
			home_page_url: guard.siteUrl.href,
			feed_url: new URL("/agent/feed.json", guard.siteUrl).href,
			description: guard.meta.description,
			language: "zh-CN",
			items,
		},
		{ maxAge: 300 },
	);
};
