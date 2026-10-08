/**
 * pulse-editor-applications — Suda Pulse「第三方成为 editor」的申请与审批。
 *
 * 模型（D22，见 docs/13-editor-onboarding.md）：**用户**成为 editor，其 agent 通过
 * EmDash 原生 OAuth 以该用户身份连 MCP，自动继承能力。**没有「agent 注册成 editor」**。
 *
 * 本插件只负责「申请 → 审批」这一段（原生没有「申请升角色」）：
 * - `applications/submit` / `mine` —— 登录用户（Subscriber+）提交 / 查看自己的申请；
 *   身份取自宿主解析的 `routeCtx.user`，**不接受请求体自报**。
 * - `applications/list` / `approve` / `reject` —— 管理员（`plugins:manage`）审批。
 * - 后台页 `/_emdash/admin/plugins/pulse-editor-applications/editor-applications`（Block Kit 队列）。
 *
 * **批准不改角色**：插件没有 user 写能力。批准后需管理员到后台 Users 页把该用户
 * 角色改为 Editor(40)，其 agent 才能经 OAuth 获得编辑能力。
 */

import {
	type PluginContext,
	type SandboxedPlugin,
	type SandboxedRouteContext,
} from "emdash/plugin";
import { z } from "zod";

import {
	applicationStore,
	findByUserId,
	newApplicationId,
	type ApplicationRecord,
	type ApplicationStatus,
} from "./applications";

/** 管理端路由 / 后台页的权限。 */
const ADMIN_PERMISSION = "plugins:manage";
/**
 * 申请端路由的权限：`content:read` 是 Subscriber(10) 的最低权限，
 * 用它表达「任意已登录用户可申请」。匿名会话在宿主鉴权阶段即被拒。
 */
const MEMBER_PERMISSION = "content:read";

/** EmDash 角色：Editor = 40（见 docs/13 §3）。 */
const ROLE_EDITOR = 40;

type Json = Record<string, unknown>;

const ok = (data: Json = {}): Json => ({ ok: true, ...data });
const fail = (error: string, extra: Json = {}): Json => ({ ok: false, error, ...extra });

const isoNow = (): string => new Date().toISOString();

// ---------- 输入校验 ----------

const submitInput = z.object({
	purpose: z.string().trim().min(1).max(1000),
	organization: z.string().trim().max(200).optional(),
	agentName: z.string().trim().max(200).optional(),
	links: z.string().trim().max(500).optional(),
	contact: z.string().trim().max(200).optional(),
});

const decideInput = z.object({
	application_id: z.string().min(1),
	note: z.string().trim().max(500).optional(),
});

// ---------- 视图 ----------

/** 对外暴露的申请视图（管理端）。 */
function adminView(id: string, record: ApplicationRecord): Json {
	return {
		id,
		user_id: record.userId,
		email: record.email,
		name: record.name ?? null,
		organization: record.organization ?? null,
		purpose: record.purpose,
		agent_name: record.agentName ?? null,
		links: record.links ?? null,
		contact: record.contact ?? null,
		status: record.status,
		submitted_at: record.submittedAt,
		updated_at: record.updatedAt,
		decided_at: record.decidedAt ?? null,
		decided_by: record.decidedBy ?? null,
		note: record.note ?? null,
	};
}

/** 对外暴露的申请视图（申请人自己看，少暴露管理字段）。 */
function selfView(id: string, record: ApplicationRecord): Json {
	return {
		application_id: id,
		status: record.status,
		purpose: record.purpose,
		organization: record.organization ?? null,
		agent_name: record.agentName ?? null,
		links: record.links ?? null,
		contact: record.contact ?? null,
		submitted_at: record.submittedAt,
		updated_at: record.updatedAt,
		decided_at: record.decidedAt ?? null,
		note: record.note ?? null,
	};
}

/** 申请人是否已是 editor（或更高）。 */
const isEditor = (role: number | undefined): boolean => typeof role === "number" && role >= ROLE_EDITOR;

async function decide(
	ctx: PluginContext,
	routeCtx: SandboxedRouteContext,
	status: Extract<ApplicationStatus, "approved" | "rejected">,
	note?: string,
): Promise<Json> {
	const parsed = decideInput.safeParse(routeCtx.input);
	if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

	const store = applicationStore(ctx);
	const record = await store.get(parsed.data.application_id);
	if (!record) return fail("NOT_FOUND");
	if (record.status === status) return ok({ application_id: parsed.data.application_id, status });

	const updated: ApplicationRecord = {
		...record,
		status,
		decidedAt: isoNow(),
		...(routeCtx.user?.email ? { decidedBy: routeCtx.user.email } : {}),
		...(note ? { note } : {}),
	};
	await store.put(parsed.data.application_id, updated);

	return ok({
		application_id: parsed.data.application_id,
		status,
		email: record.email,
		next_step:
			status === "approved"
				? "请在后台 Users 页把该用户角色改为 Editor(40)，其 agent 才能经 OAuth 获得编辑能力。"
				: undefined,
	});
}

// ---------- 插件定义 ----------

const plugin: SandboxedPlugin = {
	routes: {
		// ===== 申请（登录用户）=====

		"applications/submit": {
			permission: MEMBER_PERMISSION,
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const user = routeCtx.user;
				if (!user) return fail("UNAUTHORIZED");
				if (isEditor(user.role)) return ok({ status: "already_editor" });

				const parsed = submitInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const store = applicationStore(ctx);
				const existing = await findByUserId(ctx, user.id);
				if (existing?.data.status === "approved") {
					return ok({ status: "approved", application_id: existing.id });
				}

				const now = isoNow();
				const input = parsed.data;
				const record: ApplicationRecord = {
					userId: user.id,
					email: user.email,
					...(user.name ? { name: user.name } : {}),
					...(input.organization ? { organization: input.organization } : {}),
					purpose: input.purpose,
					...(input.agentName ? { agentName: input.agentName } : {}),
					...(input.links ? { links: input.links } : {}),
					...(input.contact ? { contact: input.contact } : {}),
					status: "pending",
					submittedAt: existing?.data.submittedAt ?? now,
					updatedAt: now,
				};

				const id = existing?.id ?? newApplicationId();
				await store.put(id, record);
				return ok({ status: "pending", application_id: id, resubmitted: Boolean(existing) });
			},
		},

		"applications/mine": {
			permission: MEMBER_PERMISSION,
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const user = routeCtx.user;
				if (!user) return fail("UNAUTHORIZED");

				const existing = await findByUserId(ctx, user.id);
				return ok({
					role: user.role,
					is_editor: isEditor(user.role),
					application: existing ? selfView(existing.id, existing.data) : null,
				});
			},
		},

		// ===== 审批（管理员）=====

		"applications/list": {
			permission: ADMIN_PERMISSION,
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const query = (routeCtx.input ?? {}) as { status?: string; limit?: number | string };
				const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
				const where = query.status ? { status: query.status } : undefined;

				const result = await applicationStore(ctx).query({
					...(where ? { where } : {}),
					orderBy: { createdAt: "desc" },
					limit,
				});

				return ok({
					count: result.items.length,
					has_more: result.hasMore,
					applications: result.items.map((item) => adminView(item.id, item.data)),
				});
			},
		},

		"applications/approve": {
			permission: ADMIN_PERMISSION,
			methods: ["POST"],
			request: { body: "json" },
			handler: (routeCtx, ctx): Promise<Json> => decide(ctx, routeCtx, "approved"),
		},

		"applications/reject": {
			permission: ADMIN_PERMISSION,
			methods: ["POST"],
			request: { body: "json" },
			handler: (routeCtx, ctx): Promise<Json> => {
				const note = (routeCtx.input as { note?: string } | undefined)?.note;
				return decide(ctx, routeCtx, "rejected", note);
			},
		},

		// ===== 后台审批页（Block Kit）=====

		admin: {
			permission: ADMIN_PERMISSION,
			handler: async (routeCtx, ctx): Promise<Json> => {
				const input = (routeCtx.input ?? {}) as {
					type?: string;
					action_id?: string;
					value?: unknown;
				};

				if (input.type === "block_action" && input.action_id === "editor-application-decision") {
					const value = typeof input.value === "string" ? input.value : "";
					const [action, applicationId] = value.split(":");
					const store = applicationStore(ctx);
					const record = applicationId ? await store.get(applicationId) : null;

					if (record && (action === "approve" || action === "reject")) {
						const status = action === "approve" ? "approved" : "rejected";
						await store.put(applicationId, {
							...record,
							status,
							decidedAt: isoNow(),
							...(routeCtx.user?.email ? { decidedBy: routeCtx.user.email } : {}),
						});
						const toast =
							action === "approve"
								? {
										type: "success",
										message: `已批准 ${record.email} —— 请到 Users 页把角色改为 Editor`,
									}
								: { type: "success", message: `已驳回 ${record.email}` };
						return { blocks: await applicationBlocks(ctx), toast };
					}

					return { blocks: await applicationBlocks(ctx) };
				}

				return { blocks: await applicationBlocks(ctx) };
			},
		},
	},

	mcp: {
		tools: {
			listEditorApplications: {
				description:
					"列出第三方「成为 editor」的申请（可按 status 过滤：pending/approved/rejected）。",
				route: "applications/list",
				input: z.object({
					status: z.enum(["pending", "approved", "rejected"]).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				}),
				destructive: false,
			},
			approveEditorApplication: {
				description:
					"批准一条 editor 申请。**不改角色** —— 批准后仍需在后台 Users 页把该用户角色设为 Editor(40)。",
				route: "applications/approve",
				input: z.object({ application_id: z.string().min(1) }),
				destructive: true,
			},
			rejectEditorApplication: {
				description: "驳回一条 editor 申请（可附说明）。",
				route: "applications/reject",
				input: z.object({
					application_id: z.string().min(1),
					note: z.string().max(500).optional(),
				}),
				destructive: true,
			},
		},
	},
};

// ---------- 后台页渲染 ----------

async function applicationBlocks(ctx: PluginContext): Promise<Json[]> {
	const result = await applicationStore(ctx).query({ orderBy: { createdAt: "desc" }, limit: 100 });
	const rows = result.items.map((item) => {
		const items: Json[] = [];
		if (item.data.status === "pending") {
			items.push({ label: "批准", value: `approve:${item.id}` });
			items.push({ label: "驳回", value: `reject:${item.id}` });
		}

		return {
			email: item.data.email,
			name: item.data.name ?? "—",
			organization: item.data.organization ?? "—",
			purpose: item.data.purpose,
			status: item.data.status,
			submitted: item.data.submittedAt,
			action: items.length
				? { type: "menu", action_id: "editor-application-decision", label: "操作", items }
				: null,
		};
	});

	return [
		{ type: "header", text: "Editor 申请审批" },
		{
			type: "section",
			text: "第三方用户登录后提交申请。**批准只改申请状态** —— 批准后请到 Users 页把该用户角色改为 **Editor(40)**，其 agent 才能经 OAuth 获得编辑能力。",
		},
		{ type: "divider" },
		{
			type: "table",
			columns: [
				{ key: "email", label: "用户" },
				{ key: "name", label: "姓名" },
				{ key: "organization", label: "组织" },
				{ key: "purpose", label: "用途" },
				{ key: "status", label: "状态", format: "badge" },
				{ key: "submitted", label: "提交时间", format: "relative_time" },
				{ key: "action", label: "操作", format: "element" },
			],
			rows,
			page_action_id: "editor-applications-page",
			empty_text: "暂无申请。",
		},
	];
}

export default plugin;
