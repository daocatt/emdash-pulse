import type { APIRoute } from "astro";
import { getSiteSettings, getTaxonomyTermsWithCacheHint } from "emdash";
import { renderUrlset, siteOrigin, taxonomyTermLocs, XML_HEADERS } from "../utils/sitemap";

/**
 * 版块（`section` 分类）聚合页 sitemap。
 *
 * 由 `/sitemap.xml` 索引引用。只列有已发布稿件的版块。
 */
export const GET: APIRoute = async ({ url }) => {
	const [settings, terms] = await Promise.all([
		getSiteSettings(),
		getTaxonomyTermsWithCacheHint("section", { includeCounts: true }),
	]);

	const locs = taxonomyTermLocs(terms.data, "/sections", siteOrigin(settings.url, url));
	return new Response(renderUrlset(locs), { status: 200, headers: XML_HEADERS });
};
