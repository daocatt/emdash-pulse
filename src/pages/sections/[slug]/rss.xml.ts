/**
 * 分版块 RSS：`/sections/<slug>/rss.xml`。
 *
 * 与全站 feed 共用 `@utils/feed` 的渲染，只是查询限定到该版块。
 * 路径以 `.xml` 结尾，`src/middleware.ts` 的 `HAS_EXTENSION` 会自动跳过主题
 * rewrite，所以这里拿到的就是干净路径。
 */
import type { APIRoute } from "astro";
import { decodeSlug, getEmDashCollection, getSiteSettings, getTaxonomyTermsWithCacheHint } from "emdash";
import { FEED_LIMIT, renderRssFeed, RSS_HEADERS, toFeedEntries } from "../../../utils/feed";
import { resolveSiteIdentity } from "../../../utils/site-identity";

export const GET: APIRoute = async ({ params, site, url }) => {
	const slug = decodeSlug(params.slug);
	const siteUrl = site ?? new URL(url.origin);

	const termsResult = await getTaxonomyTermsWithCacheHint("section", { includeCounts: true });
	const term = slug ? termsResult.data.find((item) => item.slug === slug) : null;
	if (!term) return new Response("Not Found", { status: 404 });

	const { siteTitle, siteTagline } = resolveSiteIdentity(await getSiteSettings());

	const { entries: articles } = await getEmDashCollection("articles", {
		where: { section: term.slug },
		orderBy: { published_at: "desc" },
		limit: FEED_LIMIT,
	});

	return new Response(
		renderRssFeed({
			siteUrl,
			siteTitle: `${siteTitle} · ${term.label}`,
			siteTagline: term.description || siteTagline,
			selfPath: `/sections/${term.slug}/rss.xml`,
			homePath: `/sections/${term.slug}`,
			entries: toFeedEntries(articles, siteUrl),
		}),
		{ headers: RSS_HEADERS },
	);
};
