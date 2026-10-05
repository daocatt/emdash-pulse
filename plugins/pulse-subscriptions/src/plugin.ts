/**
 * pulse-subscriptions — Suda Pulse 读者订阅（自研，替代 bulletin 依赖）。
 *
 * 职责：
 * - **双确认订阅**：`subscribe/request` 建 pending 记录并发确认邮件（一次性 token）；
 *   `subscribe/confirm` 校验 token 后转 confirmed，并轮换出退订 token。
 * - **退订**：`unsubscribe` 凭退订 token 转 unsubscribed。
 * - **订阅者管理**：私有 `subscribers/list`（`plugins:manage`）+ MCP `listSubscribers`，
 *   以及后台「订阅者」页。
 *
 * 邮件走 `ctx.email`（`email:send` + 已配置 provider）。**未配置 provider 时不报错**，
 * 而是把邮件快照落库为 `pendingEmail` 待发。无邮件服务时可开 `autoConfirm` 走单确认。
 *
 * 订阅者身份存于插件存储，**不是** EmDash 用户。
 */

import {
	pluginResponse,
	type PluginContext,
	type PluginResponse,
	type SandboxedPlugin,
	type SandboxedRouteContext,
} from "emdash/plugin";
import { z } from "zod";

import { buildConfirmEmail, buildWelcomeEmail, deliver, linkWithToken, type EmailSender } from "./mail";
import { checkRateLimit, clientIp } from "./rate-limit";
import {
	findSubscriberByEmailHash,
	findSubscriberByTokenHash,
	maskEmail,
	newSubscriberId,
	subscriberStore,
	type SubscriberRecord,
	type TokenPurpose,
} from "./subscribers";
import { generateToken, hashEmail, hashSecret, normalizeEmail, tokenPrefix } from "./token";

type Json = Record<string, unknown>;

const ok = (data: Json = {}): Json => ({ ok: true, ...data });
const fail = (error: string, extra: Json = {}): Json => ({ ok: false, error, ...extra });

const isoNow = (): string => new Date().toISOString();

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

// ---------- 响应（公开路由用 raw，以返回真实 HTTP 状态码）----------
//
// 默认 JSON 路由一律返回 HTTP 200（宿主包 `{success:true,data}`）。公开订阅路由
// 需要 400 / 429 等语义状态码，故声明 `response: "raw"` 并返回 `pluginResponse()`。

const HTTP_STATUS: Record<string, number> = {
	INVALID_INPUT: 400,
	INVALID_TOKEN: 400,
	RATE_LIMITED: 429,
};

function json(status: number, payload: Json, headers: Record<string, string> = {}): PluginResponse {
	return pluginResponse({
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...headers },
		body: { kind: "text", value: JSON.stringify(payload) },
	});
}

/** 把「返回 `{ ok, ... }` 信封」的处理器包成 raw 路由处理器。 */
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

const requestInput = z.object({
	email: z.string().trim().email().max(200),
	source: z.string().trim().max(64).optional(),
});

const tokenInput = z.object({ token: z.string().trim().min(8).max(200) });

const listInput = z.object({
	status: z.enum(["pending", "confirmed", "unsubscribed"]).optional(),
	limit: z.number().int().min(1).max(100).optional(),
});

// ---------- 设置 ----------

interface SubscriptionSettings {
	autoConfirm: boolean;
	replyTo: string;
	confirmSubject: string;
	welcomeSubject: string;
	confirmPath: string;
	unsubscribePath: string;
}

const DEFAULT_SETTINGS: SubscriptionSettings = {
	autoConfirm: false,
	replyTo: "",
	confirmSubject: "确认订阅 Suda Pulse",
	welcomeSubject: "欢迎订阅 Suda Pulse",
	confirmPath: "/subscribe/confirm",
	unsubscribePath: "/subscribe/unsubscribe",
};

function str(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

async function readSettings(ctx: PluginContext): Promise<SubscriptionSettings> {
	const get = async (key: string): Promise<unknown> => {
		try {
			return await ctx.settings.get(key);
		} catch {
			return null;
		}
	};
	const [autoConfirm, replyTo, confirmSubject, welcomeSubject, confirmPath, unsubscribePath] = await Promise.all([
		get("autoConfirm"),
		get("replyTo"),
		get("confirmSubject"),
		get("welcomeSubject"),
		get("confirmPath"),
		get("unsubscribePath"),
	]);

	return {
		autoConfirm: bool(autoConfirm, DEFAULT_SETTINGS.autoConfirm),
		replyTo: str(replyTo, DEFAULT_SETTINGS.replyTo),
		confirmSubject: str(confirmSubject, DEFAULT_SETTINGS.confirmSubject),
		welcomeSubject: str(welcomeSubject, DEFAULT_SETTINGS.welcomeSubject),
		confirmPath: str(confirmPath, DEFAULT_SETTINGS.confirmPath),
		unsubscribePath: str(unsubscribePath, DEFAULT_SETTINGS.unsubscribePath),
	};
}

/** 规范化站点路径（补前导斜杠）。 */
function pathOf(value: string, fallback: string): string {
	const path = value.trim() || fallback;
	return path.startsWith("/") ? path : `/${path}`;
}

function brandOf(ctx: PluginContext, settings: SubscriptionSettings): { siteName: string; replyTo?: string } {
	return {
		siteName: ctx.site.name || "Suda Pulse",
		...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
	};
}

/** 发送邮件并返回落库所需的投递状态（provider 缺失/失败时降级）。 */
async function sendAndRecord(
	ctx: PluginContext,
	record: SubscriberRecord,
	message: ReturnType<typeof buildConfirmEmail>,
	at: string,
): Promise<void> {
	const delivery = await deliver(ctx.email as EmailSender | undefined, message);
	record.lastSentAt = at;
	record.emailDelivered = delivery.delivered;
	if (delivery.delivered) {
		delete record.pendingEmail;
	} else {
		record.pendingEmail = {
			to: message.to,
			subject: message.subject,
			text: message.text,
			...(message.html ? { html: message.html } : {}),
			reason: delivery.reason ?? "unknown",
			at,
		};
	}
}

// ---------- 插件定义 ----------

const plugin: SandboxedPlugin = {
	routes: {
		// ===== 订阅（公开） =====

		"subscribe/request": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json" },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const rate = await checkRateLimit(ctx, `subscribe/request:${clientIp(routeCtx.requestMeta)}`, 5, 3600);
				if (!rate.allowed) return fail("RATE_LIMITED", { retry_after: rate.retryAfter });

				const parsed = requestInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const settings = await readSettings(ctx);
				const email = normalizeEmail(parsed.data.email);
				const emailHash = await hashEmail(email);
				const store = subscriberStore(ctx);
				const existing = await findSubscriberByEmailHash(ctx, emailHash);
				const now = isoNow();

				// 已确认（且非单确认模式）：幂等返回，不重复发信（避免被当作骚扰工具）。
				if (!settings.autoConfirm && existing?.data.status === "confirmed") {
					return ok({ status: "confirmed", email, already: true, delivered: false });
				}

				const purpose: TokenPurpose = settings.autoConfirm ? "unsubscribe" : "confirm";
				const token = generateToken(purpose === "confirm" ? "confirm" : "unsub");

				const record: SubscriberRecord = {
					email,
					emailHash,
					status: settings.autoConfirm ? "confirmed" : "pending",
					tokenHash: await hashSecret(token),
					tokenPrefix: tokenPrefix(token),
					tokenPurpose: purpose,
					source: parsed.data.source || existing?.data.source || "web",
					createdAt: existing?.data.createdAt ?? now,
					requestedAt: now,
					emailDelivered: false,
					...(settings.autoConfirm ? { confirmedAt: now } : {}),
				};

				const brand = brandOf(ctx, settings);
				const message = settings.autoConfirm
					? buildWelcomeEmail({
							to: email,
							unsubscribeUrl: linkWithToken(
								ctx.url(pathOf(settings.unsubscribePath, DEFAULT_SETTINGS.unsubscribePath)),
								token,
							),
							subject: settings.welcomeSubject,
							...brand,
						})
					: buildConfirmEmail({
							to: email,
							confirmUrl: linkWithToken(
								ctx.url(pathOf(settings.confirmPath, DEFAULT_SETTINGS.confirmPath)),
								token,
							),
							subject: settings.confirmSubject,
							...brand,
						});

				await sendAndRecord(ctx, record, message, now);
				await store.put(existing?.id ?? newSubscriberId(), record);

				return ok({
					status: record.status,
					email,
					delivered: record.emailDelivered,
					...(record.emailDelivered ? {} : { note: "邮件服务未配置，订阅已记录，待发确认邮件。" }),
				});
			}),
		},

		"subscribe/confirm": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json" },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const rate = await checkRateLimit(ctx, `subscribe/confirm:${clientIp(routeCtx.requestMeta)}`, 30, 60);
				if (!rate.allowed) return fail("RATE_LIMITED", { retry_after: rate.retryAfter });

				const parsed = tokenInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const found = await findSubscriberByTokenHash(ctx, await hashSecret(parsed.data.token));
				if (!found) return fail("INVALID_TOKEN");
				// 幂等：重复点击确认链接（刷新 / 双击）不报错。
				if (found.data.status === "confirmed") {
					return ok({ status: "confirmed", email: found.data.email, already: true });
				}
				if (found.data.status === "unsubscribed") return fail("INVALID_TOKEN");

				const settings = await readSettings(ctx);
				const now = isoNow();
				// 确认后同一 token 转为退订用途（不轮换，保证确认链接可重复访问）。
				const record: SubscriberRecord = {
					...found.data,
					status: "confirmed",
					confirmedAt: now,
					unsubscribedAt: undefined,
					tokenPurpose: "unsubscribe",
					emailDelivered: false,
				};

				const message = buildWelcomeEmail({
					to: record.email,
					unsubscribeUrl: linkWithToken(
						ctx.url(pathOf(settings.unsubscribePath, DEFAULT_SETTINGS.unsubscribePath)),
						parsed.data.token,
					),
					subject: settings.welcomeSubject,
					...brandOf(ctx, settings),
				});

				await sendAndRecord(ctx, record, message, now);
				await subscriberStore(ctx).put(found.id, record);

				return ok({ status: "confirmed", email: record.email, delivered: record.emailDelivered });
			}),
		},

		unsubscribe: {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json" },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const rate = await checkRateLimit(ctx, `unsubscribe:${clientIp(routeCtx.requestMeta)}`, 30, 60);
				if (!rate.allowed) return fail("RATE_LIMITED", { retry_after: rate.retryAfter });

				const parsed = tokenInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const found = await findSubscriberByTokenHash(ctx, await hashSecret(parsed.data.token));
				if (!found) return fail("INVALID_TOKEN");
				if (found.data.status === "unsubscribed") {
					return ok({ status: "unsubscribed", email: found.data.email, already: true });
				}

				const now = isoNow();
				// 保留 token：重复点击退订链接幂等（confirm 对已退订记录仍会拒绝）。
				const record: SubscriberRecord = {
					...found.data,
					status: "unsubscribed",
					unsubscribedAt: now,
				};
				delete record.pendingEmail;

				await subscriberStore(ctx).put(found.id, record);
				return ok({ status: "unsubscribed", email: record.email, unsubscribed_at: now });
			}),
		},

		// ===== 订阅者管理（私有） =====

		"subscribers/list": {
			permission: "plugins:manage",
			// MCP 工具只能挂 POST + JSON 路由，故用 POST。
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = listInput.safeParse(routeCtx.input ?? {});
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });
				const { status, limit } = parsed.data;

				const store = subscriberStore(ctx);
				const result = await store.query({
					...(status ? { where: { status } } : {}),
					orderBy: { createdAt: "desc" },
					limit: clamp(limit ?? 50, 1, 100),
				});
				const [pending, confirmed, unsubscribed] = await Promise.all([
					store.count({ status: "pending" }),
					store.count({ status: "confirmed" }),
					store.count({ status: "unsubscribed" }),
				]);

				return ok({
					total: pending + confirmed + unsubscribed,
					by_status: { pending, confirmed, unsubscribed },
					count: result.items.length,
					has_more: result.hasMore,
					subscribers: result.items.map((item) => ({
						id: item.id,
						email: item.data.email,
						status: item.data.status,
						source: item.data.source ?? null,
						created_at: item.data.createdAt,
						confirmed_at: item.data.confirmedAt ?? null,
						unsubscribed_at: item.data.unsubscribedAt ?? null,
						email_delivered: item.data.emailDelivered,
						pending_email: item.data.pendingEmail
							? {
									subject: item.data.pendingEmail.subject,
									reason: item.data.pendingEmail.reason,
									at: item.data.pendingEmail.at,
								}
							: null,
					})),
				});
			},
		},

		// ===== 后台页（Block Kit） =====

		admin: {
			permission: "plugins:manage",
			handler: async (_routeCtx, ctx): Promise<Json> => {
				const store = subscriberStore(ctx);
				const result = await store.query({ orderBy: { createdAt: "desc" }, limit: 100 });
				const [pending, confirmed, unsubscribed] = await Promise.all([
					store.count({ status: "pending" }),
					store.count({ status: "confirmed" }),
					store.count({ status: "unsubscribed" }),
				]);

				const rows = result.items.map((item) => ({
					email: maskEmail(item.data.email),
					status: item.data.status,
					source: item.data.source ?? "—",
					created: item.data.createdAt,
					delivered: item.data.emailDelivered ? "已投递" : item.data.pendingEmail ? "待发" : "—",
				}));

				return {
					blocks: [
						{ type: "header", text: "读者订阅" },
						{
							type: "section",
							text: `已确认 **${confirmed}** · 待确认 **${pending}** · 已退订 **${unsubscribed}**（共 ${pending + confirmed + unsubscribed}）。`,
						},
						{ type: "divider" },
						{
							type: "table",
							columns: [
								{ key: "email", label: "邮箱" },
								{ key: "status", label: "状态", format: "badge" },
								{ key: "source", label: "来源" },
								{ key: "created", label: "创建时间", format: "relative_time" },
								{ key: "delivered", label: "邮件" },
							],
							rows,
							page_action_id: "subscribers-page",
							empty_text: "暂无订阅者。",
						},
					],
				};
			},
		},
	},

	mcp: {
		tools: {
			listSubscribers: {
				description:
					"列出读者订阅者（可按 status 过滤：pending/confirmed/unsubscribed），并返回各状态计数。",
				route: "subscribers/list",
				input: z.object({
					status: z.enum(["pending", "confirmed", "unsubscribed"]).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				}),
				destructive: false,
			},
		},
	},
};

export default plugin;
