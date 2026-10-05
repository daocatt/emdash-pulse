import type { APIRoute } from "astro";
import { agentGuard } from "../../utils/agent-route";
import { jsonResponse } from "../../utils/agent";

/**
 * GET /agent/schema —— 面向 agent 的自描述：端点、查询参数、内容字段。
 *
 * 手写而非从 schema 推导，是为了给 agent 一个**稳定契约**（字段说明与枚举
 * 不随内部实现变动）。
 */
export const GET: APIRoute = async ({ request, url }) => {
	const guard = await agentGuard(request, url);
	if ("response" in guard) return guard.response;

	return jsonResponse(
		{
			...guard.meta,
			read_only: true,
			auth: "none（公开只读，按 IP 尽力限流 120 req/min）",
			endpoints: [
				{ method: "GET", path: "/agent/news", description: "文章列表（支持过滤/分页）" },
				{ method: "GET", path: "/agent/news/latest", description: "最新 N 篇（?limit=）" },
				{ method: "GET", path: "/agent/news/{slug}", description: "单篇详情（含 markdown/纯文本/图片）" },
				{ method: "GET", path: "/agent/sections", description: "版块列表及计数" },
				{ method: "GET", path: "/agent/editions", description: "期号列表" },
				{ method: "GET", path: "/agent/editions/{slug}", description: "期号及其文章" },
				{ method: "GET", path: "/agent/feed.json", description: "JSON Feed 1.1" },
				{ method: "GET", path: "/agent/schema", description: "本自描述文档" },
				{ method: "GET", path: "/llms.txt", description: "站点与 API 指引（纯文本）" },
			],
			query_params: {
				"/agent/news": {
					section: "版块 slug（taxonomy）",
					tag: "标签 slug（taxonomy）",
					edition: "期号 slug（taxonomy）",
					type: "standard | photo | live | video",
					since: "ISO 8601 时间下界（含）",
					until: "ISO 8601 时间上界（不含）",
					order: "desc（默认）| asc",
					limit: "1–100（默认 20）",
					cursor: "keyset 游标（取上一页 next_cursor）",
					offset: "offset 分页（与 cursor 互斥）",
				},
			},
			collections: {
				articles: {
					description: "新闻稿件（人类编辑与 Author agent 产出，发布前强制审核）",
					fields: {
						slug: "URL 标识",
						title: "标题",
						deck: "导语",
						excerpt: "摘要",
						content: "Portable Text 结构",
						text: "正文纯文本",
						markdown: "正文 markdown（尽力转换）",
						article_type: "standard | photo | live | video",
						section: "{ slug, label }",
						tags: "[{ slug, label }]",
						edition: "期号 slug",
						author_agent: "作者 Agent 标识（如 muse / dots）",
						authors: "署名列表",
						source: "来源",
						source_url: "原文链接",
						is_breaking: "是否突发",
						published_at: "ISO 8601 UTC",
						updated_at: "ISO 8601 UTC",
						url: "人类可读页面",
						image: "{ url, alt, width, height }",
						gallery_count: "图集图片数",
						correction: "更正说明",
					},
				},
				editions: {
					description: "期号（周报优先）",
					fields: {
						slug: "期号 slug（如 2026-w40）",
						title: "期号标题",
						period_type: "week | month",
						year: "年",
						period_no: "期序（ISO 周号或月号）",
						summary: "本期导读",
						cover: "{ url, alt, width, height }",
						url: "期号页面",
					},
				},
			},
			enums: {
				article_type: ["standard", "photo", "live", "video"],
				period_type: ["week", "month"],
				review_status: ["draft", "pending_review", "approved", "rejected"],
			},
			notes: [
				"时间统一 ISO 8601 UTC；站点时区见 timezone 字段。",
				"正文同时提供 content / text / markdown 三种形态。",
				"仅返回已发布（published）内容。",
			],
		},
		{ maxAge: 3600 },
	);
};
