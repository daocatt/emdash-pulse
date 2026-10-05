import type { APIRoute } from "astro";
import { getSiteSettings } from "emdash";
import { renderSitemapIndex, siteOrigin, XML_HEADERS } from "../utils/sitemap";

/**
 * 站点 sitemap 索引（**覆盖** EmDash 内置实现）。
 *
 * EmDash 内置的 `/sitemap.xml` 只列 `has_seo=1 && routable=1` 的**内容集合**，
 * 不含版块/标签这类分类聚合页。这里保留集合 sitemap（仍由 EmDash 的
 * `/sitemap-[collection].xml` 动态路由生成），并追加两个分类 sitemap。
 *
 * 路径必须保持 `/sitemap.xml`：EmDash 中间件把该路径列入 PUBLIC_RUNTIME_ROUTES，
 * 才会注入 `locals.emdash.db`（见 middleware 的 `PUBLIC_RUNTIME_ROUTES`）。
 */
export const GET: APIRoute = async ({ locals, url }) => {
	const db = locals.emdash?.db;
	const settings = await getSiteSettings();
	const origin = siteOrigin(settings.url, url);

	const paths: string[] = [];

	if (db) {
		const collections = await db
			.selectFrom("_emdash_collections")
			.select("slug")
			.where("has_seo", "=", 1)
			.where("routable", "=", 1)
			.orderBy("slug")
			.execute();
		for (const col of collections) {
			paths.push(`/sitemap-${encodeURIComponent(col.slug)}.xml`);
		}
	}

	paths.push("/sitemap-sections.xml", "/sitemap-tags.xml");

	const body = renderSitemapIndex(paths.map((path) => `${origin}${path}`));
	return new Response(body, { status: 200, headers: XML_HEADERS });
};
