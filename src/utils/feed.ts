/**
 * RSS 2.0 渲染工具。
 *
 * 全站 feed（`/rss.xml`）与分版块 feed（`/sections/<slug>/rss.xml`）共用这里的
 * 条目映射与频道模板，差别只在标题、自身地址与查询条件。转义在 `./xml`。
 */
import type { ArticleEntry } from "./agent";
import { DEFAULT_LOCALE } from "../i18n";
import { extractPlainText } from "./text";
import { escapeXml } from "./xml";

/** 每条 feed 的条目上限（全站与分版块共用）。 */
export const FEED_LIMIT = 30;

export interface FeedEntry {
	title: string;
	/** 条目的绝对地址。 */
	link: string;
	/** 发布时间（EmDash 的 `published_at` 在类型里是 `Date`）。 */
	publishedAt: Date;
	description: string;
	/** 分类名（版块 / 标签的 label），按顺序输出为 `<category>`。 */
	categories: string[];
}

/**
 * 把内容条目映射成 feed 条目；没有发布时间的直接跳过。
 */
export function toFeedEntries(articles: ArticleEntry[], siteUrl: URL): FeedEntry[] {
	const entries: FeedEntry[] = [];
	for (const article of articles) {
		const publishedAt = article.data.publishedAt;
		if (!publishedAt) continue;
		entries.push({
			title: article.data.title,
			link: new URL(`/articles/${article.id}`, siteUrl).href,
			publishedAt,
			description:
				article.data.excerpt ??
				article.data.deck ??
				extractPlainText(article.data.content).slice(0, 300),
			categories: [
				...(article.data.terms?.section ?? []),
				...(article.data.terms?.tag ?? []),
			].map((term) => term.label),
		});
	}
	return entries;
}

export interface RssFeedOptions {
	/** 站点绝对地址。 */
	siteUrl: URL;
	siteTitle: string;
	siteTagline: string;
	/** 本 feed 自身路径，用于 `atom:link rel="self"`。 */
	selfPath: string;
	/** 频道对应的页面路径。 */
	homePath: string;
	entries: FeedEntry[];
}

export const RSS_HEADERS = {
	"Content-Type": "application/rss+xml; charset=utf-8",
	"Cache-Control": "public, max-age=3600",
} as const;

export function renderRssFeed({
	siteUrl,
	siteTitle,
	siteTagline,
	selfPath,
	homePath,
	entries,
}: RssFeedOptions): string {
	const items = entries
		.map((entry) => {
			const categories = entry.categories
				.map((label) => `      <category>${escapeXml(label)}</category>`)
				.join("\n");

			return `    <item>
      <title>${escapeXml(entry.title)}</title>
      <link>${entry.link}</link>
      <guid isPermaLink="true">${entry.link}</guid>
      <pubDate>${entry.publishedAt.toUTCString()}</pubDate>
      <description>${escapeXml(entry.description)}</description>
${categories}
    </item>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <description>${escapeXml(siteTagline)}</description>
    <link>${new URL(homePath, siteUrl).href}</link>
    <atom:link href="${new URL(selfPath, siteUrl).href}" rel="self" type="application/rss+xml"/>
    <language>${DEFAULT_LOCALE.toLowerCase()}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
}
