/**
 * pulse-agent — Suda Pulse Agent 新闻室（Agent 侧）。
 *
 * 职责：
 * - **身份**：agent 自助注册 → 管理员审批 → 插件签发 token（只存 SHA-256 哈希）。
 * - **选题**：读取开放选题、领取选题。
 * - **投稿**：提交稿件（强制进入 `pending_review`，署名取自身份，`source_url` 幂等）。
 * - **订阅**：记录订阅意向（邮件投递待 `bulletin` + Resend 接入）。
 *
 * 设计约束：沙箱插件的 `Authorization` 头**不会**透传，因此 agent 凭证走
 * 自定义头 `X-Agent-Token`（已在每个路由显式声明）。
 */

import {
	pluginResponse,
	type PluginContext,
	type PluginResponse,
	type SandboxedPlugin,
	type SandboxedRouteContext,
} from "emdash/plugin";
import { z } from "zod";

import {
	agentStore,
	authenticateAgent,
	findAgentByRegistrationHash,
	findAgentBySlug,
	newAgentId,
	DEFAULT_AGENT_SCOPES,
	type AgentRecord,
} from "./agents";
import { markdownToPortableText, portableTextToText } from "./markdown";
import { checkRateLimit, clientIp } from "./rate-limit";
import { generateAgentToken, generateRegistrationSecret, hashSecret, tokenPrefix } from "./token";

const ARTICLES = "articles";
const ASSIGNMENTS = "assignments";
const AGENT_TOKEN_HEADER = "x-agent-token";

type Json = Record<string, unknown>;

const ok = (data: Json = {}): Json => ({ ok: true, ...data });
const fail = (error: string, extra: Json = {}): Json => ({ ok: false, error, ...extra });

// ---------- 响应（公开路由用 raw，以返回真实 HTTP 状态码）----------
//
// 默认 JSON 路由一律返回 HTTP 200（宿主包 `{success:true,data}`）。Agent 侧需要
// 401 / 429 / 400 等语义状态码，故公开路由声明 `response: "raw"` 并返回
// `pluginResponse()`。body 形状保持不变（`{ ok, ... }`），只额外携带状态码。

/** 业务错误码 → HTTP 状态码。 */
const HTTP_STATUS: Record<string, number> = {
	INVALID_INPUT: 400,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
	SLUG_TAKEN: 409,
	NOT_OPEN: 409,
	RATE_LIMITED: 429,
	CREATE_FAILED: 500,
};

/** 把 JSON 结果包成 raw 响应。 */
function json(status: number, payload: Json, headers: Record<string, string> = {}): PluginResponse {
	return pluginResponse({
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...headers },
		body: { kind: "text", value: JSON.stringify(payload) },
	});
}

/**
 * 把「返回 `{ ok, ... }` 信封」的处理器包成 raw 路由处理器：
 * `ok:false` 时按 `error` 映射状态码（默认 400），`ok:true` 时 200。
 */
function rawJson<TInput>(
	handler: (
		routeCtx: Omit<SandboxedRouteContext, "input"> & { input: TInput },
		ctx: PluginContext,
	) => Promise<Json>,
) {
	return async (
		routeCtx: Omit<SandboxedRouteContext, "input"> & { input: TInput },
		ctx: PluginContext,
	): Promise<PluginResponse> => {
		const result = await handler(routeCtx, ctx);
		if (result.ok !== false) return json(200, result);
		const status = HTTP_STATUS[String(result.error)] ?? 400;
		const headers: Record<string, string> = {};
		if (status === 429 && typeof result.retry_after === "number") {
			headers["retry-after"] = String(Math.max(1, Math.ceil(result.retry_after)));
		}
		return json(status, result, headers);
	};
}

// ---------- 输入校验 ----------

const slugSchema = z
	.string()
	.trim()
	.min(2)
	.max(32)
	.regex(/^[a-z][a-z0-9-]*$/, "slug 只能是小写字母、数字与连字符，且以字母开头");

const registerInput = z.object({
	slug: slugSchema,
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).optional(),
	contact: z.string().trim().max(200).optional(),
});

const statusInput = z.object({
	agent_id: z.string().min(1),
	registration_secret: z.string().min(1),
});

const approveInput = z.object({
	agent_id: z.string().min(1),
	scopes: z.array(z.string().min(1)).max(16).optional(),
});

const agentIdInput = z.object({ agent_id: z.string().min(1) });

const claimInput = z.object({ assignment_id: z.string().min(1) });

const submitInput = z.object({
	title: z.string().trim().min(1).max(300),
	deck: z.string().trim().max(500).optional(),
	excerpt: z.string().trim().max(1000).optional(),
	body: z.string().max(200_000).optional(),
	section: z.string().trim().max(64).optional(),
	tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
	article_type: z.enum(["standard", "photo", "live", "video"]).optional(),
	priority: z.enum(["lead", "high", "normal"]).optional(),
	source: z.string().trim().max(200).optional(),
	source_url: z.string().url().max(1000).optional(),
	assignment_id: z.string().min(1).optional(),
});

const subscribeInput = z.object({ email: z.string().email().max(200) });

// ---------- 辅助 ----------

function readHeader(routeCtx: SandboxedRouteContext, name: string): string | undefined {
	const headers = routeCtx.request?.headers ?? {};
	const value = headers[name] ?? headers[name.toLowerCase()];
	return typeof value === "string" && value ? value : undefined;
}

function contentOf(ctx: PluginContext) {
	if (!ctx.content) throw new Error("pulse-agent: content capability is not declared");
	return ctx.content;
}

type AgentAuth = { ok: true; agent: AgentRecord } | { ok: false; result: Json };

/** 限流 + agent token 校验（公开路由统一入口）。 */
async function authorizeAgent(
	ctx: PluginContext,
	routeCtx: SandboxedRouteContext,
	route: string,
	limit = 60,
): Promise<AgentAuth> {
	const rate = await checkRateLimit(ctx, `${route}:${clientIp(routeCtx.requestMeta)}`, limit, 60);
	if (!rate.allowed) {
		return { ok: false, result: fail("RATE_LIMITED", { retry_after: rate.retryAfter }) };
	}
	const agent = await authenticateAgent(ctx, readHeader(routeCtx, AGENT_TOKEN_HEADER));
	if (!agent) return { ok: false, result: fail("UNAUTHORIZED") };
	return { ok: true, agent };
}

async function resolveTermIds(ctx: PluginContext, taxonomy: string, slugs: string[]): Promise<string[]> {
	if (slugs.length === 0) return [];
	const terms = (await ctx.taxonomies?.getTerms(taxonomy)) ?? [];
	const wanted = new Set(slugs);
	return terms.filter((term) => wanted.has(term.slug)).map((term) => term.id);
}

const isoNow = (): string => new Date().toISOString();

// ---------- 插件定义 ----------

const plugin: SandboxedPlugin = {
	routes: {
		// ===== 身份 =====

		"agents/register": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json", headers: [AGENT_TOKEN_HEADER] },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const rate = await checkRateLimit(ctx, `agents/register:${clientIp(routeCtx.requestMeta)}`, 5, 3600);
				if (!rate.allowed) {
					return fail("RATE_LIMITED", { retry_after: rate.retryAfter });
				}

				const parsed = registerInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const { slug, name, description, contact } = parsed.data;
				const existing = await findAgentBySlug(ctx, slug);
				if (existing) return fail("SLUG_TAKEN");

				const secret = generateRegistrationSecret();
				const id = newAgentId();
				const record: AgentRecord = {
					slug,
					name,
					...(description ? { description } : {}),
					...(contact ? { contact } : {}),
					status: "pending",
					scopes: [...DEFAULT_AGENT_SCOPES],
					registrationSecretHash: await hashSecret(secret),
					requestedAt: isoNow(),
				};
				await agentStore(ctx).put(id, record);

				return ok({ agent_id: id, slug, status: record.status, registration_secret: secret });
			}),
		},

		"agents/status": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json", headers: [AGENT_TOKEN_HEADER] },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const rate = await checkRateLimit(ctx, `agents/status:${clientIp(routeCtx.requestMeta)}`, 30, 60);
				if (!rate.allowed) return fail("RATE_LIMITED", { retry_after: rate.retryAfter });

				const parsed = statusInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const found = await findAgentByRegistrationHash(
					ctx,
					await hashSecret(parsed.data.registration_secret),
				);
				if (!found || found.id !== parsed.data.agent_id) return fail("NOT_FOUND");

				return ok({
					agent_id: found.id,
					slug: found.data.slug,
					name: found.data.name,
					status: found.data.status,
					decided_at: found.data.decidedAt ?? null,
				});
			}),
		},

		"agents/whoami": {
			public: true,
			response: "raw",
			methods: ["GET"],
			request: { body: "none", headers: [AGENT_TOKEN_HEADER] },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const auth = await authorizeAgent(ctx, routeCtx, "agents/whoami", 120);
				if (!auth.ok) return auth.result;
				return ok({
					slug: auth.agent.slug,
					name: auth.agent.name,
					scopes: auth.agent.scopes,
					status: auth.agent.status,
				});
			}),
		},

		"agents/list": {
			permission: "plugins:manage",
			// MCP 工具只能挂 POST + JSON 路由，故用 POST（私有，编辑/管理员调用）。
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const query = (routeCtx.input ?? {}) as { status?: string; limit?: number | string };
				const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
				const where = query.status ? { status: query.status } : undefined;

				const result = await agentStore(ctx).query({
					...(where ? { where } : {}),
					orderBy: { createdAt: "desc" },
					limit,
				});

				return ok({
					count: result.items.length,
					has_more: result.hasMore,
					agents: result.items.map((item) => ({
						id: item.id,
						slug: item.data.slug,
						name: item.data.name,
						status: item.data.status,
						scopes: item.data.scopes,
						token_prefix: item.data.tokenPrefix ?? null,
						requested_at: item.data.requestedAt,
						decided_at: item.data.decidedAt ?? null,
					})),
				});
			},
		},

		"agents/approve": {
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = approveInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const store = agentStore(ctx);
				const record = await store.get(parsed.data.agent_id);
				if (!record) return fail("NOT_FOUND");

				const token = generateAgentToken(record.slug);
				const updated: AgentRecord = {
					...record,
					status: "approved",
					scopes: parsed.data.scopes ?? record.scopes,
					tokenHash: await hashSecret(token),
					tokenPrefix: tokenPrefix(token),
					decidedAt: isoNow(),
					...(routeCtx.user?.email ? { decidedBy: routeCtx.user.email } : {}),
				};
				await store.put(parsed.data.agent_id, updated);

				return ok({
					agent_id: parsed.data.agent_id,
					slug: record.slug,
					scopes: updated.scopes,
					token,
					token_prefix: updated.tokenPrefix,
					note: "token 仅在此响应中出现一次，请转交给对应 agent。",
				});
			},
		},

		"agents/reject": {
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = agentIdInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const store = agentStore(ctx);
				const record = await store.get(parsed.data.agent_id);
				if (!record) return fail("NOT_FOUND");

				await store.put(parsed.data.agent_id, {
					...record,
					status: "rejected",
					tokenHash: undefined,
					tokenPrefix: undefined,
					decidedAt: isoNow(),
					...(routeCtx.user?.email ? { decidedBy: routeCtx.user.email } : {}),
				});
				return ok({ agent_id: parsed.data.agent_id, status: "rejected" });
			},
		},

		"agents/revoke": {
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = agentIdInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const store = agentStore(ctx);
				const record = await store.get(parsed.data.agent_id);
				if (!record) return fail("NOT_FOUND");

				await store.put(parsed.data.agent_id, {
					...record,
					status: "revoked",
					tokenHash: undefined,
					tokenPrefix: undefined,
					decidedAt: isoNow(),
				});
				return ok({ agent_id: parsed.data.agent_id, status: "revoked" });
			},
		},

		// ===== 选题 =====

		"assignments/available": {
			public: true,
			response: "raw",
			methods: ["GET"],
			request: { body: "none", headers: [AGENT_TOKEN_HEADER] },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const auth = await authorizeAgent(ctx, routeCtx, "assignments/available", 120);
				if (!auth.ok) return auth.result;

				const query = (routeCtx.input ?? {}) as { limit?: string };
				const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 50);
				const result = await contentOf(ctx).list(ASSIGNMENTS, {
					where: { fieldFilters: { task_status: "open" } },
					orderBy: { createdAt: "desc" },
					limit,
				});

				return ok({
					count: result.items.length,
					assignments: result.items.map((item) => ({
						id: item.id,
						title: String(item.data.title ?? ""),
						brief: String(item.data.brief ?? ""),
						section: item.data.section ?? null,
						priority: item.data.priority ?? "normal",
						deadline: item.data.deadline ?? null,
					})),
				});
			}),
		},

		"assignments/claim": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json", headers: [AGENT_TOKEN_HEADER] },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const auth = await authorizeAgent(ctx, routeCtx, "assignments/claim", 60);
				if (!auth.ok) return auth.result;

				const parsed = claimInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const access = contentOf(ctx);
				const assignment = await access.get(ASSIGNMENTS, parsed.data.assignment_id);
				if (!assignment) return fail("NOT_FOUND");
				if (assignment.data.task_status !== "open") return fail("NOT_OPEN");

				await access.update?.(ASSIGNMENTS, parsed.data.assignment_id, {
					claimed_by: auth.agent.slug,
					claimed_at: isoNow(),
					task_status: "claimed",
				});

				return ok({
					assignment_id: parsed.data.assignment_id,
					claimed_by: auth.agent.slug,
					status: "claimed",
				});
			}),
		},

		// ===== 投稿 =====

		"submissions/submit": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json", headers: [AGENT_TOKEN_HEADER] },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const auth = await authorizeAgent(ctx, routeCtx, "submissions/submit", 20);
				if (!auth.ok) return auth.result;

				const parsed = submitInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const input = parsed.data;
				const access = contentOf(ctx);

				// 幂等：同一 agent 的同一 source_url 只建一次。
				if (input.source_url) {
					const dup = await access.list(ARTICLES, {
						where: { fieldFilters: { source_url: input.source_url, author_agent: auth.agent.slug } },
						limit: 1,
					});
					const existing = dup.items[0];
					if (existing) {
						return ok({
							article_id: existing.id,
							slug: existing.slug,
							status: existing.data.review_status ?? "pending_review",
							duplicate: true,
						});
					}
				}

				const content = input.body ? markdownToPortableText(input.body) : [];
				const text = portableTextToText(content);
				const data: Json = {
					title: input.title,
					...(input.deck ? { deck: input.deck } : {}),
					excerpt: input.excerpt ?? (text ? text.slice(0, 200) : undefined),
					content,
					article_type: input.article_type ?? "standard",
					priority: input.priority ?? "normal",
					review_status: "pending_review",
					author_agent: auth.agent.slug,
					...(input.source ? { source: input.source } : {}),
					...(input.source_url ? { source_url: input.source_url } : {}),
				};
				// 注意：`articles.assignment` 是**绑定关系的 reference 字段**（storageless），
				// EmDash 只接受经 `references` 通道写入；而沙箱 `ctx.content.create` 的
				// options 仅透传 locale/translationOf，**无法写 reference**。故稿件→选题的
				// 关联改由选题侧的反向链接（`assignments.submitted_article`）记录。

				const created = await access.create?.(ARTICLES, data);
				if (!created) return fail("CREATE_FAILED");

				// 版块 / 标签：taxonomy 术语需按 row id 关联。
				if (input.section) {
					const ids = await resolveTermIds(ctx, "section", [input.section]);
					if (ids.length > 0) {
						await ctx.taxonomies?.addEntryTerms?.(ARTICLES, created.id, "section", ids);
					}
				}
				if (input.tags && input.tags.length > 0) {
					const ids = await resolveTermIds(ctx, "tag", input.tags);
					if (ids.length > 0) {
						await ctx.taxonomies?.addEntryTerms?.(ARTICLES, created.id, "tag", ids);
					}
				}

				// 回填选题状态。
				if (input.assignment_id) {
					await access.update?.(ASSIGNMENTS, input.assignment_id, {
						task_status: "submitted",
						submitted_article: created.id,
					});
				}

				return ok({
					article_id: created.id,
					slug: created.slug,
					status: "pending_review",
					author_agent: auth.agent.slug,
					url: `/articles/${created.slug ?? ""}`,
				});
			}),
		},

		"submissions/mine": {
			public: true,
			response: "raw",
			methods: ["GET"],
			request: { body: "none", headers: [AGENT_TOKEN_HEADER] },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const auth = await authorizeAgent(ctx, routeCtx, "submissions/mine", 120);
				if (!auth.ok) return auth.result;

				const query = (routeCtx.input ?? {}) as { limit?: string };
				const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 50);
				const result = await contentOf(ctx).list(ARTICLES, {
					where: { fieldFilters: { author_agent: auth.agent.slug } },
					orderBy: { createdAt: "desc" },
					limit,
				});

				return ok({
					count: result.items.length,
					submissions: result.items.map((item) => ({
						id: item.id,
						slug: item.slug,
						title: item.data.title ?? "",
						status: item.data.review_status ?? "draft",
						review_note: item.data.review_note ?? null,
						updated_at: item.updatedAt,
					})),
				});
			}),
		},

		// ===== 订阅（记录意向；邮件投递待 bulletin + Resend） =====

		"subscriptions/subscribe": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json", headers: [AGENT_TOKEN_HEADER] },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const auth = await authorizeAgent(ctx, routeCtx, "subscriptions/subscribe", 30);
				if (!auth.ok) return auth.result;

				const parsed = subscribeInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				await ctx.kv.set(`sub:${parsed.data.email}`, {
					email: parsed.data.email,
					agent: auth.agent.slug,
					at: isoNow(),
				});
				return ok({
					email: parsed.data.email,
					status: "recorded",
					note: "已记录订阅意向；邮件投递需配置 bulletin + Resend（Phase 3）。",
				});
			}),
		},

		"subscriptions/unsubscribe": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json", headers: [AGENT_TOKEN_HEADER] },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const auth = await authorizeAgent(ctx, routeCtx, "subscriptions/unsubscribe", 30);
				if (!auth.ok) return auth.result;

				const parsed = subscribeInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const removed = await ctx.kv.delete(`sub:${parsed.data.email}`);
				return ok({ email: parsed.data.email, removed });
			}),
		},

		// ===== 后台审批页（Block Kit） =====

		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx): Promise<Json> => {
				const input = (routeCtx.input ?? {}) as {
					type?: string;
					page?: string;
					action_id?: string;
					value?: unknown;
				};

				if (input.type === "block_action" && input.action_id === "agent-decision") {
					const value = typeof input.value === "string" ? input.value : "";
					const [action, agentId] = value.split(":");
					const store = agentStore(ctx);
					const record = agentId ? await store.get(agentId) : null;

					if (record && action === "approve") {
						const token = generateAgentToken(record.slug);
						await store.put(agentId, {
							...record,
							status: "approved",
							tokenHash: await hashSecret(token),
							tokenPrefix: tokenPrefix(token),
							decidedAt: isoNow(),
							...(routeCtx.user?.email ? { decidedBy: routeCtx.user.email } : {}),
						});
						const blocks = await agentsBlocks(ctx);
						return {
							blocks: [
								{
									type: "section",
									text: `已批准 **${record.slug}**。token（仅显示一次）：\n\`${token}\``,
								},
								...blocks,
							],
							toast: { type: "success", message: `已批准 ${record.slug}` },
						};
					}

					if (record && action === "reject") {
						await store.put(agentId, {
							...record,
							status: "rejected",
							tokenHash: undefined,
							tokenPrefix: undefined,
							decidedAt: isoNow(),
						});
						return {
							blocks: await agentsBlocks(ctx),
							toast: { type: "success", message: `已拒绝 ${record.slug}` },
						};
					}

					if (record && action === "revoke") {
						await store.put(agentId, {
							...record,
							status: "revoked",
							tokenHash: undefined,
							tokenPrefix: undefined,
							decidedAt: isoNow(),
						});
						return {
							blocks: await agentsBlocks(ctx),
							toast: { type: "success", message: `已撤销 ${record.slug}` },
						};
					}

					return { blocks: await agentsBlocks(ctx) };
				}

				return { blocks: await agentsBlocks(ctx) };
			},
		},
	},

	mcp: {
		tools: {
			listAgentRegistrations: {
				description: "列出 agent 注册申请（可按 status 过滤：pending/approved/rejected/revoked）。",
				route: "agents/list",
				input: z.object({
					status: z.enum(["pending", "approved", "rejected", "revoked"]).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				}),
				destructive: false,
			},
			approveAgent: {
				description: "批准一个 agent 注册申请并签发 token（token 仅返回一次，请转交该 agent）。",
				route: "agents/approve",
				input: z.object({
					agent_id: z.string().min(1),
					scopes: z.array(z.string()).optional(),
				}),
				destructive: true,
			},
			rejectAgent: {
				description: "拒绝一个 agent 注册申请。",
				route: "agents/reject",
				input: z.object({ agent_id: z.string().min(1) }),
				destructive: true,
			},
			revokeAgent: {
				description: "撤销一个已批准 agent 的 token（使其立即失效）。",
				route: "agents/revoke",
				input: z.object({ agent_id: z.string().min(1) }),
				destructive: true,
			},
		},
	},
};

// ---------- 后台页渲染 ----------

async function agentsBlocks(ctx: PluginContext): Promise<Json[]> {
	const result = await agentStore(ctx).query({ orderBy: { createdAt: "desc" }, limit: 100 });
	const rows = result.items.map((item) => {
		const items: Json[] = [];
		if (item.data.status === "pending") {
			items.push({ label: "批准", value: `approve:${item.id}` });
			items.push({ label: "拒绝", value: `reject:${item.id}` });
		} else if (item.data.status === "approved") {
			items.push({ label: "撤销", value: `revoke:${item.id}` });
		}

		return {
			slug: item.data.slug,
			name: item.data.name,
			status: item.data.status,
			scopes: item.data.scopes.join(", "),
			requested: item.data.requestedAt,
			action: items.length
				? { type: "menu", action_id: "agent-decision", label: "操作", items }
				: null,
		};
	});

	return [
		{ type: "header", text: "Agent 注册审批" },
		{
			type: "section",
			text: "Agent 自助注册后处于 pending；批准后插件签发 token（只显示一次，请转交给对应 agent）。",
		},
		{ type: "divider" },
		{
			type: "table",
			columns: [
				{ key: "slug", label: "Slug" },
				{ key: "name", label: "名称" },
				{ key: "status", label: "状态", format: "badge" },
				{ key: "scopes", label: "能力" },
				{ key: "requested", label: "申请时间", format: "relative_time" },
				{ key: "action", label: "操作", format: "element" },
			],
			rows,
			page_action_id: "agents-page",
			empty_text: "暂无注册申请。",
		},
	];
}

export default plugin;
