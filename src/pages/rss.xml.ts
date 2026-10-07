import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";
import { FEED_LIMIT, renderRssFeed, RSS_HEADERS, toFeedEntries } from "../utils/feed";
import { resolveSiteIdentity } from "../utils/site-identity";

export const GET: APIRoute = async ({ site, url }) => {
	const siteUrl = site ?? new URL(url.origin);
	const { siteTitle, siteTagline } = resolveSiteIdentity(await getSiteSettings());

	const { entries: articles } = await getEmDashCollection("articles", {
		orderBy: { published_at: "desc" },
		limit: FEED_LIMIT,
	});

	return new Response(
		renderRssFeed({
			siteUrl,
			siteTitle,
			siteTagline,
			selfPath: "/rss.xml",
			homePath: "/",
			entries: toFeedEntries(articles, siteUrl),
		}),
		{ headers: RSS_HEADERS },
	);
};
