/**
 * sitemap 渲染工具。
 *
 * 本项目覆盖了 EmDash 内置的 `/sitemap.xml`（只含内容集合），把版块/标签
 * 分类页也纳入索引。三个 sitemap 路由共用这里的序列化逻辑（转义在 `./xml`）。
 */

import { escapeXml } from "./xml";

/** 站点绝对地址（去掉结尾斜杠）。 */
export function siteOrigin(settingsUrl: string | undefined, url: URL): string {
	return (settingsUrl || url.origin).replace(/\/$/, "");
}

/** `<urlset>` 文档。 */
export function renderUrlset(locs: string[]): string {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
	];
	for (const loc of locs) {
		lines.push("  <url>");
		lines.push(`    <loc>${escapeXml(loc)}</loc>`);
		lines.push("  </url>");
	}
	lines.push("</urlset>");
	return lines.join("\n");
}

/** `<sitemapindex>` 文档。 */
export function renderSitemapIndex(locs: string[]): string {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
	];
	for (const loc of locs) {
		lines.push("  <sitemap>");
		lines.push(`    <loc>${escapeXml(loc)}</loc>`);
		lines.push("  </sitemap>");
	}
	lines.push("</sitemapindex>");
	return lines.join("\n");
}

export const XML_HEADERS = {
	"Content-Type": "application/xml; charset=utf-8",
	"Cache-Control": "public, max-age=3600",
} as const;

/**
 * 分类聚合页的 URL 列表。
 *
 * 只纳入 `count > 0` 的项：空分类页只有空列表，属薄内容，不应进 sitemap。
 */
export function taxonomyTermLocs(
	terms: Array<{ slug: string; count?: number }>,
	basePath: string,
	origin: string,
): string[] {
	return terms
		.filter((term) => (term.count ?? 0) > 0)
		.map((term) => `${origin}${basePath}/${term.slug}`);
}

