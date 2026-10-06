import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";
import { DEFAULT_LOCALE } from "../i18n";
import { resolveSiteIdentity } from "../utils/site-identity";
import { extractPlainText } from "../utils/text";

const XML_ESCAPE_PATTERNS = [
	[/&/g, "&amp;"],
	[/</g, "&lt;"],
	[/>/g, "&gt;"],
	[/"/g, "&quot;"],
	[/'/g, "&apos;"],
] as const;

function escapeXml(str: string): string {
	let result = str;
	for (const [pattern, replacement] of XML_ESCAPE_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

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
			const description =
				article.data.excerpt ??
				article.data.deck ??
				extractPlainText(article.data.content).slice(0, 300);
			const categories = [
				...(article.data.terms?.section ?? []),
				...(article.data.terms?.tag ?? []),
			]
				.map((term) => `      <category>${escapeXml(term.label)}</category>`)
				.join("\n");

			return `    <item>
      <title>${escapeXml(article.data.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${new Date(publishedAt).toUTCString()}</pubDate>
      <description>${escapeXml(description)}</description>
${categories}
    </item>`;
		})
		.filter(Boolean)
		.join("\n");

	const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <description>${escapeXml(siteTagline)}</description>
    <link>${siteUrl.href}</link>
    <atom:link href="${new URL("/rss.xml", siteUrl).href}" rel="self" type="application/rss+xml"/>
    <language>${DEFAULT_LOCALE.toLowerCase()}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;

	return new Response(rss, {
		headers: {
			"Content-Type": "application/rss+xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
