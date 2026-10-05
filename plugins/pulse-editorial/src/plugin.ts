/**
 * pulse-editorial — Suda Pulse 编辑台（编辑侧）。
 *
 * 职责：
 * - **选题分发**：创建/列出/结束选题（EmDash `assignments` collection）。
 * - **投稿审核**：待审队列、查看、批准并发布、驳回、退回修改。
 *
 * 鉴权：所有路由均为**私有**，由 EmDash 会话/令牌 + 路由声明的 RBAC 权限把关
 * （编辑侧不需要 agent 身份）。发布动作受 `pulse-review` 的发布策略约束。
 */

import type { PluginContext, SandboxedPlugin, SandboxedRouteContext } from "emdash/plugin";
import { z } from "zod";

const ARTICLES = "articles";
const ASSIGNMENTS = "assignments";

type Json = Record<string, unknown>;

const ok = (data: Json = {}): Json => ({ ok: true, ...data });
const fail = (error: string, extra: Json = {}): Json => ({ ok: false, error, ...extra });

function contentOf(ctx: PluginContext) {
	if (!ctx.content) throw new Error("pulse-editorial: content capability is not declared");
	return ctx.content;
}

function actorOf(routeCtx: SandboxedRouteContext): string {
	return routeCtx.user?.email ?? routeCtx.user?.name ?? "editor";
}

/**
 * 读取稿件的**生效数据**。
 *
 * EmDash 的 `ctx.content.update` 是 draft-aware：集合支持 `revisions` 时，
 * 改动写进「草稿修订」，条目行要 `publish` 之后才更新；而 `ctx.content.get`
 * 返回的是条目行。因此审核队列/详情必须以**最新修订**为准，否则驳回/退回后
 * 稿件仍会留在待审队列里。
 */
async function effectiveData(
	ctx: PluginContext,
	item: { id: string; data: Record<string, unknown> },
): Promise<Record<string, unknown>> {
	const revisions = await ctx.content?.listRevisions?.(ARTICLES, item.id, { limit: 1 });
	const latest = revisions?.[0]?.data;
	return latest ? { ...item.data, ...latest } : item.data;
}

// ---------- 输入校验 ----------

const createAssignmentInput = z.object({
	title: z.string().trim().min(1).max(300),
	brief: z.string().trim().min(1).max(4000),
	section: z.string().trim().max(64).optional(),
	tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
	assigned_agent: z.string().trim().max(64).optional(),
	deadline: z.string().datetime().optional(),
	priority: z.enum(["low", "normal", "high"]).optional(),
});

const closeAssignmentInput = z.object({
	assignment_id: z.string().min(1),
	outcome: z.enum(["done", "cancelled"]).default("done"),
});

const articleIdInput = z.object({ article_id: z.string().min(1) });

const reviewDecisionInput = z.object({
	article_id: z.string().min(1),
	review_note: z.string().trim().max(2000).optional(),
});

const plugin: SandboxedPlugin = {
	routes: {
		// ===== 选题分发 =====

		"assignments/create": {
			permission: "content:create",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = createAssignmentInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const input = parsed.data;
				const created = await contentOf(ctx).create?.(ASSIGNMENTS, {
					title: input.title,
					brief: input.brief,
					...(input.section ? { section: input.section } : {}),
					...(input.tags ? { tags: input.tags.join(", ") } : {}),
					...(input.assigned_agent ? { assigned_agent: input.assigned_agent } : {}),
					...(input.deadline ? { deadline: input.deadline } : {}),
					priority: input.priority ?? "normal",
					task_status: "open",
					created_by: actorOf(routeCtx),
				});
				if (!created) return fail("CREATE_FAILED");

				return ok({ assignment_id: created.id, slug: created.slug, status: "open" });
			},
		},

		"assignments/list": {
			permission: "content:read",
			// MCP 工具只能挂 POST + JSON 路由，故用 POST（私有，编辑调用）。
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const query = (routeCtx.input ?? {}) as { status?: string; limit?: number | string };
				const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
				const status = query.status;

				const result = await contentOf(ctx).list(ASSIGNMENTS, {
					...(status ? { where: { fieldFilters: { task_status: status } } } : {}),
					orderBy: { createdAt: "desc" },
					limit,
				});

				return ok({
					count: result.items.length,
					has_more: result.hasMore,
					assignments: result.items.map((item) => ({
						id: item.id,
						slug: item.slug,
						title: item.data.title ?? "",
						brief: item.data.brief ?? "",
						section: item.data.section ?? null,
						priority: item.data.priority ?? "normal",
						task_status: item.data.task_status ?? "open",
						assigned_agent: item.data.assigned_agent ?? null,
						claimed_by: item.data.claimed_by ?? null,
						deadline: item.data.deadline ?? null,
						created_at: item.createdAt,
					})),
				});
			},
		},

		"assignments/close": {
			permission: "content:edit_any",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = closeAssignmentInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const access = contentOf(ctx);
				const existing = await access.get(ASSIGNMENTS, parsed.data.assignment_id);
				if (!existing) return fail("NOT_FOUND");

				await access.update?.(ASSIGNMENTS, parsed.data.assignment_id, {
					task_status: parsed.data.outcome,
				});
				return ok({ assignment_id: parsed.data.assignment_id, status: parsed.data.outcome });
			},
		},

		// ===== 投稿审核 =====

		"review/queue": {
			permission: "content:read_drafts",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const query = (routeCtx.input ?? {}) as { limit?: number | string };
				const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);

				const result = await contentOf(ctx).list(ARTICLES, {
					where: { fieldFilters: { review_status: "pending_review" } },
					orderBy: { updatedAt: "desc" },
					limit,
				});

				// 条目行可能是 live 视图；以最新修订为准再筛一次，确保驳回/退回后移出队列。
				const submissions: Json[] = [];
				for (const item of result.items) {
					const data = await effectiveData(ctx, item);
					if (data.review_status !== "pending_review") continue;
					submissions.push({
						id: item.id,
						slug: item.slug,
						title: data.title ?? "",
						deck: data.deck ?? null,
						author_agent: data.author_agent ?? null,
						section: data.section ?? null,
						priority: data.priority ?? "normal",
						source: data.source ?? null,
						source_url: data.source_url ?? null,
						updated_at: item.updatedAt,
					});
				}

				return ok({ count: submissions.length, has_more: result.hasMore, submissions });
			},
		},

		"review/get": {
			permission: "content:read_drafts",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const query = (routeCtx.input ?? {}) as { article_id?: string };
				if (!query.article_id) return fail("INVALID_INPUT");

				const item = await contentOf(ctx).get(ARTICLES, query.article_id);
				if (!item) return fail("NOT_FOUND");

				return ok({
					article: {
						id: item.id,
						slug: item.slug,
						status: item.status,
						data: await effectiveData(ctx, item),
						updated_at: item.updatedAt,
					},
				});
			},
		},

		"review/approve": {
			permission: "content:publish_any",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = reviewDecisionInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const { article_id, review_note } = parsed.data;
				const access = contentOf(ctx);
				const item = await access.get(ARTICLES, article_id);
				if (!item) return fail("NOT_FOUND");

				await access.update?.(ARTICLES, article_id, {
					review_status: "approved",
					...(review_note ? { review_note } : {}),
				});

				const versioned = await access.getVersioned?.(ARTICLES, article_id);
				if (!versioned) return fail("PUBLISH_FAILED", { reason: "NO_REVISION" });

				try {
					const published = await access.publish?.(ARTICLES, article_id, { _rev: versioned._rev });
					return ok({
						article_id,
						slug: published?.item.slug ?? item.slug,
						status: "published",
						published_at: published?.item.publishedAt ?? null,
						approved_by: actorOf(routeCtx),
					});
				} catch (error) {
					return fail("PUBLISH_REJECTED", {
						reason: error instanceof Error ? error.message : "publish failed",
					});
				}
			},
		},

		"review/reject": {
			permission: "content:edit_any",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = reviewDecisionInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const access = contentOf(ctx);
				const item = await access.get(ARTICLES, parsed.data.article_id);
				if (!item) return fail("NOT_FOUND");

				await access.update?.(ARTICLES, parsed.data.article_id, {
					review_status: "rejected",
					...(parsed.data.review_note ? { review_note: parsed.data.review_note } : {}),
				});
				return ok({ article_id: parsed.data.article_id, status: "rejected" });
			},
		},

		"review/request-changes": {
			permission: "content:edit_any",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = reviewDecisionInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const access = contentOf(ctx);
				const item = await access.get(ARTICLES, parsed.data.article_id);
				if (!item) return fail("NOT_FOUND");

				await access.update?.(ARTICLES, parsed.data.article_id, {
					review_status: "draft",
					...(parsed.data.review_note ? { review_note: parsed.data.review_note } : {}),
				});
				return ok({ article_id: parsed.data.article_id, status: "draft" });
			},
		},
	},

	mcp: {
		tools: {
			createAssignment: {
				description: "创建一个选题任务并分发给 agent（初始状态 open）。",
				route: "assignments/create",
				input: createAssignmentInput,
				destructive: false,
			},
			listAssignments: {
				description: "列出选题任务（可按 task_status 过滤：open/claimed/submitted/done/cancelled）。",
				route: "assignments/list",
				input: z.object({
					status: z.enum(["open", "claimed", "submitted", "done", "cancelled"]).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				}),
				destructive: false,
			},
			closeAssignment: {
				description: "结束或取消一个选题任务。",
				route: "assignments/close",
				input: closeAssignmentInput,
				destructive: true,
			},
			reviewQueue: {
				description: "列出待审稿件（review_status=pending_review）。",
				route: "review/queue",
				input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
				destructive: false,
			},
			getSubmission: {
				description: "读取单篇稿件详情（含 Portable Text 正文）。",
				route: "review/get",
				input: articleIdInput,
				destructive: false,
			},
			approveArticle: {
				description: "批准并发布一篇稿件（设置 review_status=approved 后立即发布）。",
				route: "review/approve",
				input: reviewDecisionInput,
				destructive: true,
			},
			rejectArticle: {
				description: "驳回一篇稿件（review_status=rejected）。",
				route: "review/reject",
				input: reviewDecisionInput,
				destructive: true,
			},
			requestArticleChanges: {
				description: "把稿件退回作者修改（review_status=draft）。",
				route: "review/request-changes",
				input: reviewDecisionInput,
				destructive: true,
			},
		},
	},
};

export default plugin;
