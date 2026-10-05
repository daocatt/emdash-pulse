import type { APIRoute } from "astro";
import { getSiteSettings } from "emdash";
import { siteOrigin } from "../utils/sitemap";

/**
 * robots.txt（**覆盖** EmDash 内置实现）。
 *
 * 在 EmDash 默认规则（`Allow: /` + 屏蔽 `/_emdash/`）之上，额外屏蔽
 * `/spike/`（Phase 0 遗留探针，无索引价值）。若站点在后台配置了自定义
 * `seo.robotsTxt`，仍以其为准，并补齐 `Sitemap:` 行。
 *
 * 路径必须保持 `/robots.txt`：EmDash 中间件把该路径列入 PUBLIC_RUNTIME_ROUTES。
 */
export const GET: APIRoute = async ({ url }) => {
	const settings = await getSiteSettings();
	const sitemapUrl = `${siteOrigin(settings.url, url)}/sitemap.xml`;

	const configured = settings.seo?.robotsTxt;
	if (configured) {
		const body = configured.toLowerCase().includes("sitemap:")
			? configured
			: `${configured.trimEnd()}\n\nSitemap: ${sitemapUrl}\n`;
		return new Response(body, {
			status: 200,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
		});
	}

	const body = [
		"User-agent: *",
		"Allow: /",
		"",
		"# 管理后台与 API",
		"Disallow: /_emdash/",
		"",
		"# Phase 0 遗留探针",
		"Disallow: /spike/",
		"",
		`Sitemap: ${sitemapUrl}`,
		"",
	].join("\n");

	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
	});
};
