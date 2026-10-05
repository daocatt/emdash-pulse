import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";
import { resolveSiteIdentity } from "../utils/site-identity";
import { extractPlainText } from "../utils/text";

export const GET: APIRoute = async ({ site, url }) => {
	const siteUrl = site ?? new URL(url.origin);
	const { siteTitle, siteTagline } = resolveSiteIdentity(await getSiteSettings());

	const { entries: articles } = await getEmDashCollection("articles", {
		orderBy: { published_at: "desc" },
		limit: 30,
	});

	const items = articles
		.map((article) => {
			const publishedAt = article.data.publishedAt;
			if (!publishedAt) return null;
			const link = new URL(`/articles/${article.id}`, siteUrl).href;
			const body =
				article.data.excerpt ??
				article.data.deck ??
				extractPlainText(article.data.content).slice(0, 500);
			const tags = [
				...(article.data.terms?.section ?? []),
				...(article.data.terms?.tag ?? []),
			].map((term) => term.label);

			return {
				id: link,
				url: link,
				title: article.data.title,
				summary: body,
				content_text: body,
				date_published: new Date(publishedAt).toISOString(),
				tags,
			};
		})
		.filter(Boolean);

	const feed = {
		version: "https://jsonfeed.org/version/1.1",
		title: siteTitle,
		home_page_url: siteUrl.href,
		feed_url: new URL("/feed.json", siteUrl).href,
		description: siteTagline,
		language: "zh-CN",
		items,
	};

	return new Response(JSON.stringify(feed, null, 2), {
		headers: {
			"Content-Type": "application/feed+json; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
