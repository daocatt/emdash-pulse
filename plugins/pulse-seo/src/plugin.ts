/**
 * pulse-seo — Suda Pulse 结构化数据（JSON-LD）。
 *
 * 背景：EmDash 的 `<EmDashHead>` 会**自动**为公开页面输出一个 JSON-LD：
 * `pageType === "article"` 时是 `BlogPosting`，否则是 `WebSite`。而模板此前
 * 又各自手工注入了一份（文章页 `NewsArticle`、首页 `WebSite`），导致同一
 * 页面出现两个互相冲突的 Article/WebSite 实体。
 *
 * 修复方式：EmDash 的 `page:metadata` 贡献按 `id` **首个胜出**去重，且插件
 * 贡献排在 base 之前。因此本插件以 `id: "primary"` 贡献唯一的实体，
 * 覆盖 EmDash 的默认块：
 * - 文章页 → `NewsArticle`（报刊语义，优于默认的 `BlogPosting`）
 * - 其余页 → `WebSite`
 *
 * 数据只取自 `PublicPageContext`（标题/描述/时间/作者/图片/站点名），
 * **不做额外查询**——每个公开页面渲染保持零数据库开销。
 */

import type { PageMetadataEvent, SandboxedPlugin } from "emdash/plugin";

/** 把可能为相对路径的 URL 补成绝对地址（JSON-LD 的 image 建议用绝对 URL）。 */
function absoluteUrl(value: string | null | undefined, origin: string | undefined): string | undefined {
	if (!value) return undefined;
	if (/^https?:\/\//i.test(value) || !origin) return value;
	try {
		return new URL(value, origin).href;
	} catch {
		return value;
	}
}

function originOf(page: PageMetadataEvent["page"]): string | undefined {
	if (page.siteUrl) return page.siteUrl.replace(/\/$/, "");
	try {
		return new URL(page.url).origin;
	} catch {
		return undefined;
	}
}

const plugin: SandboxedPlugin = {
	hooks: {
		"page:metadata": (event: PageMetadataEvent) => {
			const { page } = event;
			const origin = originOf(page);

			if (page.pageType === "article") {
				const image = absoluteUrl(page.image, origin);
				const graph = {
					"@context": "https://schema.org",
					"@type": "NewsArticle",
					headline: page.pageTitle ?? page.title ?? undefined,
					description: page.description ?? undefined,
					datePublished: page.articleMeta?.publishedTime ?? undefined,
					dateModified: page.articleMeta?.modifiedTime ?? undefined,
					author: page.articleMeta?.author
						? [{ "@type": "Person", name: page.articleMeta.author }]
						: undefined,
					image: image ? [image] : undefined,
					publisher: page.siteName ? { "@type": "Organization", name: page.siteName } : undefined,
					mainEntityOfPage: page.canonical ?? undefined,
				};
				return { kind: "jsonld", id: "primary", graph };
			}

			if (!page.siteName) return null;
			return {
				kind: "jsonld",
				id: "primary",
				graph: {
					"@context": "https://schema.org",
					"@type": "WebSite",
					name: page.siteName,
					url: origin ?? page.canonical ?? page.url,
					description: page.description ?? undefined,
				},
			};
		},
	},
};

export default plugin;
