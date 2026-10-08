import { describe, expect, it } from "vitest";

import plugin from "../src/plugin";
import type { PageMetadataEvent } from "emdash/plugin";

type JsonLd = { kind: "jsonld"; id?: string; graph: Record<string, unknown> };

/** 直接调用 `page:metadata` 钩子（纯函数，不需要 runtime 宿主）。 */
function contribute(page: PageMetadataEvent["page"]): JsonLd | null {
	const handler = plugin.hooks?.["page:metadata"];
	if (typeof handler !== "function") throw new Error("page:metadata hook is not a function");
	return handler({ page }, {} as never) as JsonLd | null;
}

describe("pulse-seo · page:metadata", () => {
	it("文章页贡献 NewsArticle，id=primary（覆盖 EmDash 的 BlogPosting）", () => {
		const result = contribute({
			url: "https://pulse.suda.im/articles/hello",
			path: "/articles/hello",
			locale: null,
			kind: "content",
			pageType: "article",
			title: "你好 — Suda Pulse",
			pageTitle: "你好",
			description: "摘要",
			canonical: "https://pulse.suda.im/articles/hello",
			image: "/_emdash/api/media/file/cover.jpg",
			content: { collection: "articles", id: "a1", slug: "hello" },
			articleMeta: {
				publishedTime: "2026-10-01T00:00:00.000Z",
				modifiedTime: "2026-10-02T00:00:00.000Z",
				author: "Muse",
			},
			siteName: "Suda Pulse",
		});

		expect(result?.id).toBe("primary");
		const graph = result?.graph as Record<string, unknown>;
		expect(graph["@type"]).toBe("NewsArticle");
		expect(graph.headline).toBe("你好");
		expect(graph.datePublished).toBe("2026-10-01T00:00:00.000Z");
		expect(graph.author).toEqual([{ "@type": "Person", name: "Muse" }]);
		expect(graph.publisher).toEqual({ "@type": "Organization", name: "Suda Pulse" });
		// 相对图片补成绝对 URL
		expect(graph.image).toEqual(["https://pulse.suda.im/_emdash/api/media/file/cover.jpg"]);
	});

	it("非文章页贡献 WebSite（覆盖 EmDash 的默认 WebSite，避免重复）", () => {
		const result = contribute({
			url: "https://pulse.suda.im/",
			path: "/",
			locale: null,
			kind: "custom",
			pageType: "website",
			title: "Suda Pulse",
			description: "以 Agent 协作为核心的新闻发布系统",
			canonical: null,
			image: null,
			siteName: "Suda Pulse",
		});

		expect(result?.id).toBe("primary");
		const graph = result?.graph as Record<string, unknown>;
		expect(graph["@type"]).toBe("WebSite");
		expect(graph.name).toBe("Suda Pulse");
		expect(graph.url).toBe("https://pulse.suda.im");
		expect(graph.description).toBe("以 Agent 协作为核心的新闻发布系统");
	});

	it("缺少 siteName 的非文章页不贡献（让 EmDash 兜底）", () => {
		const result = contribute({
			url: "https://pulse.suda.im/",
			path: "/",
			locale: null,
			kind: "custom",
			pageType: "website",
			title: "x",
			description: null,
			canonical: null,
			image: null,
		});
		expect(result).toBeNull();
	});

	it("文章页缺 pageTitle 时回退到 title", () => {
		const result = contribute({
			url: "https://pulse.suda.im/articles/x",
			path: "/articles/x",
			locale: null,
			kind: "content",
			pageType: "article",
			title: "回退标题 — Suda Pulse",
			description: null,
			canonical: "https://pulse.suda.im/articles/x",
			image: null,
			content: { collection: "articles", id: "x", slug: "x" },
			siteName: "Suda Pulse",
		});
		const graph = result?.graph as Record<string, unknown>;
		expect(graph.headline).toBe("回退标题 — Suda Pulse");
	});
});
