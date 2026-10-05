import type { APIRoute } from "astro";
import { getEmDashCollection, getTaxonomyTermsWithCacheHint } from "emdash";
import { resolveSiteIdentity } from "../utils/site-identity";
import { getSiteSettings } from "emdash";

/**
 * GET /llms.txt —— 面向 LLM / agent 的站点指引（纯文本，llms.txt 约定）。
 */
export const GET: APIRoute = async ({ url }) => {
	const origin = url.origin;
	const { siteTitle, siteTagline } = resolveSiteIdentity(await getSiteSettings());

	const [{ entries: latest }, sections] = await Promise.all([
		getEmDashCollection("articles", { orderBy: { published_at: "desc" }, limit: 10 }),
		getTaxonomyTermsWithCacheHint("section", { includeCounts: true }),
	]);

	const lines: string[] = [];
	lines.push(`# ${siteTitle}`);
	lines.push("");
	lines.push(`> ${siteTagline}`);
	lines.push("");
	lines.push(
		`${siteTitle} 是一个由 Agent 与人类编辑协作产出的新闻站点。人类阅读请访问网页；agent 阅读请使用下方只读 JSON API。所有稿件发布前均经编辑审核。`,
	);
	lines.push("");
	lines.push("## Agent Read API（公开只读）");
	lines.push("");
	lines.push(`- 文章列表：${origin}/agent/news?limit=20`);
	lines.push(`- 最新报道：${origin}/agent/news/latest?limit=10`);
	lines.push(`- 单篇详情：${origin}/agent/news/{slug}`);
	lines.push(`- 版块列表：${origin}/agent/sections`);
	lines.push(`- 期号列表：${origin}/agent/editions`);
	lines.push(`- 期号详情：${origin}/agent/editions/{slug}`);
	lines.push(`- JSON Feed：${origin}/agent/feed.json`);
	lines.push(`- 自描述 schema：${origin}/agent/schema`);
	lines.push("");
	lines.push("查询参数（/agent/news）：section, tag, edition, type, since, until, order, limit, cursor, offset。");
	lines.push("正文同时提供 Portable Text（content）、纯文本（text）与 markdown（markdown）。");
	lines.push("");
	lines.push("## 版块");
	lines.push("");
	for (const section of sections.data) {
		lines.push(`- ${section.label}（${section.count ?? 0} 篇）：${origin}/sections/${section.slug}`);
	}
	lines.push("");
	lines.push("## 最新报道");
	lines.push("");
	for (const article of latest) {
		lines.push(`- [${article.data.title}](${origin}/articles/${article.id})`);
	}
	lines.push("");
	lines.push("## 人类阅读");
	lines.push("");
	lines.push(`- 头版：${origin}/`);
	lines.push(`- 归档：${origin}/archive`);
	lines.push(`- 搜索：${origin}/search?q=`);
	lines.push(`- RSS：${origin}/rss.xml`);
	lines.push(`- JSON Feed：${origin}/feed.json`);
	lines.push("");

	return new Response(lines.join("\n"), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=600",
			"Access-Control-Allow-Origin": "*",
		},
	});
};
