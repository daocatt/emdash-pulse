/**
 * pulse-subscriptions — Suda Pulse 读者订阅（自研，替代 bulletin 依赖）。
 *
 * 职责：
 * - **双确认订阅**：`subscribe/request` 建 pending 记录并发确认邮件（一次性 token）；
 *   `subscribe/confirm` 校验 token 后转 confirmed，并轮换出退订 token。
 * - **退订 / 偏好**：`unsubscribe` 凭退订 token 转 unsubscribed；
 *   `preferences` 让读者在管理页读改自己的订阅分组。
 * - **分组**：`groups/public` 给前台表单取启用中的分组。
 * - **订阅者管理**：私有 `subscribers/*`、`groups/*`（`plugins:manage`）+ MCP，
 *   以及后台「订阅者」「订阅分组」两页（见 `admin.ts`）。
 *
 * 邮件走 `ctx.email`（`email:send` + 已配置 provider）。**未配置 provider 时不报错**，
 * 而是把邮件快照落库为 `pendingEmail` 待发。无邮件服务时可开 `autoConfirm` 走单确认。
 *
 * 订阅者身份存于插件存储，**不是** EmDash 用户。
 *
 * 状态机：`pending` → `confirmed` → `unsubscribed`，另有只能由后台进出的 `paused`
 * （读者重新提交订阅**不会**自动恢复，见 `operations.ts`）。
 */

import {
	pluginResponse,
	type PluginContext,
	type PluginResponse,
	type SandboxedPlugin,
	type SandboxedRouteContext,
} from "emdash/plugin";
import { z } from "zod";

import { renderAdmin, type AdminInput } from "./admin";
import { listEvents, recordEvent, type EventType } from "./events";
import { deleteGroup, listActiveGroups, listGroups, saveGroup, sanitizeGroupSlugs } from "./groups";
import { buildConfirmEmail, buildWelcomeEmail, deliver, linkWithToken, type EmailSender } from "./mail";
import { pauseSubscriber, resumeSubscriber, setSubscriberGroups, unsubscribeSubscriber } from "./operations";
import { checkRateLimit, clientIp } from "./rate-limit";
import { syncSubscriber } from "./segments";
import {
	findSubscriberByEmailHash,
	findSubscriberByTokenHash,
	maskEmail,
	newSubscriberId,
	scanSubscribers,
	subscriberStore,
	type SubscriberRecord,
	type SubscriberStatus,
	type TokenPurpose,
} from "./subscribers";
import { generateToken, hashEmail, hashSecret, normalizeEmail, tokenPrefix } from "./token";
import { resolveTransport } from "./transport";

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

/**
 * 读取已声明的请求头（大小写两种都试）。
 *
 * 宿主只把 `request.headers` 里**显式声明**的头交给插件，其余被过滤（`Authorization`
 * / `Cookie` / `X-EmDash-Request` 即使声明也会被拒）。Resend Webhook 的签名头
 * （`svix-id` 等）不在过滤名单里，声明即可拿到。
 */
function readHeader(routeCtx: SandboxedRouteContext, name: string): string {
	const headers = routeCtx.request?.headers ?? {};
	const value = headers[name] ?? headers[name.toLowerCase()];
	return typeof value === "string" ? value : "";
}

/** Resend Webhook 事件 → 本地事件类型（未列出的忽略）。 */
const WEBHOOK_EVENT_TYPES: Record<string, EventType> = {
	"email.delivered": "email_delivered",
	"email.bounced": "email_bounced",
	"email.complained": "email_complained",
	"email.opened": "email_opened",
	"email.clicked": "email_clicked",
};

// ---------- 输入校验 ----------

const groupSlugs = z.array(z.string().trim().min(1).max(40)).max(20);

const requestInput = z.object({
	email: z.string().trim().email().max(200),
	source: z.string().trim().max(64).optional(),
	groups: groupSlugs.optional(),
});

const tokenInput = z.object({ token: z.string().trim().min(8).max(200) });

const unsubscribeInput = z.object({
	token: z.string().trim().min(8).max(200),
	reason: z.string().trim().max(200).optional(),
});

const preferencesInput = z.object({
	token: z.string().trim().min(8).max(200),
	groups: groupSlugs.optional(),
});

const listInput = z.object({
	status: z.enum(["pending", "confirmed", "unsubscribed", "paused"]).optional(),
	group: z.string().trim().max(40).optional(),
	q: z.string().trim().max(200).optional(),
	limit: z.number().int().min(1).max(100).optional(),
});

const updateInput = z.object({
	id: z.string().trim().min(1).max(120),
	action: z.enum(["pause", "resume", "unsubscribe", "set_groups"]),
	reason: z.string().trim().max(200).optional(),
	groups: groupSlugs.optional(),
});

const eventsInput = z.object({
	id: z.string().trim().min(1).max(120),
	limit: z.number().int().min(1).max(200).optional(),
});

const groupSaveInput = z.object({
	// `true` = 新建（slug 必须不存在）；缺省 = 更新（slug 必须已存在）。见 groups.ts 的 saveGroup。
	create: z.boolean().optional(),
	slug: z.string().trim().min(1).max(40).optional(),
	name: z.string().trim().min(1).max(80),
	description: z.string().trim().max(200).optional(),
	sortOrder: z.number().int().min(-9999).max(9999).optional(),
	active: z.boolean().optional(),
});

const groupDeleteInput = z.object({ slug: z.string().trim().min(1).max(40) });

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
	const [
		autoConfirm,
		replyTo,
		confirmSubject,
		welcomeSubject,
		confirmPath,
		unsubscribePath,
	] = await Promise.all([
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

/** 分组 slug 列表的展示/返回形态（去掉 undefined，稳定为数组）。 */
const groupsOf = (record: SubscriberRecord): string[] => record.groups ?? [];

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

				// 被后台暂停的邮箱：不改状态、不发信，只留一条「读者想回来」的记录，
				// 让编辑部决定是否恢复（暂停的语义就是「只能后台恢复」）。
				if (existing?.data.status === "paused") {
					await recordEvent(ctx, {
						subscriberId: existing.id,
						type: "request_blocked",
						actor: "reader",
						reason: "邮箱处于暂停状态",
					});
					return ok({ status: "paused", email, blocked: true, delivered: false });
				}

				// 分组：显式传了（哪怕是空数组）就覆盖；没传则沿用已有。
				const groups =
					parsed.data.groups === undefined
						? existing
							? groupsOf(existing.data)
							: []
						: await sanitizeGroupSlugs(ctx, parsed.data.groups);

				// 已确认（且非单确认模式）：幂等返回，不重复发信（避免被当作骚扰工具）。
				// 但分组是「读者偏好」，允许在这里顺手更新。
				if (!settings.autoConfirm && existing?.data.status === "confirmed") {
					if (parsed.data.groups !== undefined) {
						await setSubscriberGroups(ctx, existing.id, parsed.data.groups, "reader");
					}
					return ok({ status: "confirmed", email, already: true, delivered: false, groups });
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
					groups,
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

				const id = existing?.id ?? newSubscriberId();
				await sendAndRecord(ctx, record, message, now);
				await store.put(id, record);
				await recordEvent(ctx, {
					subscriberId: id,
					type: settings.autoConfirm ? "confirmed" : "requested",
					actor: "reader",
					detail: groups.join(","),
				});
				// 旁路同步（pending 会被跳过，autoConfirm 时立即进 Resend）。
				await syncSubscriber(ctx, { id, data: record });

				return ok({
					status: record.status,
					email,
					groups,
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
				if (found.data.status === "unsubscribed" || found.data.status === "paused") {
					return fail("INVALID_TOKEN");
				}

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
				await recordEvent(ctx, {
					subscriberId: found.id,
					type: "confirmed",
					actor: "reader",
				});
				await syncSubscriber(ctx, { id: found.id, data: record });

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

				const parsed = unsubscribeInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const found = await findSubscriberByTokenHash(ctx, await hashSecret(parsed.data.token));
				if (!found) return fail("INVALID_TOKEN");
				if (found.data.status === "unsubscribed") {
					return ok({ status: "unsubscribed", email: found.data.email, already: true });
				}

				const result = await unsubscribeSubscriber(ctx, found.id, {
					actor: "reader",
					...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
				});
				if (!result.ok) return fail("INVALID_TOKEN");

				// 保留 token：重复点击退订链接幂等（confirm 对已退订记录仍会拒绝）。
				return ok({
					status: "unsubscribed",
					email: result.record.email,
					unsubscribed_at: result.record.unsubscribedAt,
				});
			}),
		},

		// 读者自助管理（token 即凭证）：退订页用它读/改分组。
		preferences: {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json" },
			handler: rawJson(async (routeCtx, ctx): Promise<Json> => {
				const rate = await checkRateLimit(ctx, `preferences:${clientIp(routeCtx.requestMeta)}`, 60, 60);
				if (!rate.allowed) return fail("RATE_LIMITED", { retry_after: rate.retryAfter });

				const parsed = preferencesInput.safeParse(routeCtx.input);
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const found = await findSubscriberByTokenHash(ctx, await hashSecret(parsed.data.token));
				if (!found) return fail("INVALID_TOKEN");

				const available = (await listActiveGroups(ctx)).map((group) => ({
					slug: group.slug,
					name: group.data.name,
					description: group.data.description ?? null,
				}));

				let record = found.data;
				let updated = false;
				if (parsed.data.groups !== undefined) {
					const result = await setSubscriberGroups(ctx, found.id, parsed.data.groups, "reader");
					if (result.ok) {
						record = result.record;
						updated = true;
					}
				}

				return ok({
					email: record.email,
					status: record.status,
					groups: groupsOf(record),
					available,
					updated,
				});
			}),
		},

		// 前台订阅表单取「启用中的分组」。公开只读，且**不加 IP 限流** ——
		// SSR 里的合成 Request 取不到真实 IP，加了会让所有页面渲染挤进同一个桶。
		"groups/public": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "json" },
			handler: rawJson(async (_routeCtx, ctx): Promise<Json> => {
				const groups = (await listActiveGroups(ctx)).map((group) => ({
					slug: group.slug,
					name: group.data.name,
					description: group.data.description ?? null,
				}));
				return ok({ groups });
			}),
		},

		// ===== 投递回执 Webhook（公开，验签） =====
		//
		// 收投递回执（delivered / bounced / complained / opened / clicked），按收件人
		// 反查订阅者并落一条事件日志（后台「订阅记录」里可回放）。
		//
		// 路由名沿用 `resend/webhook`（已配置的 Webhook URL 不变），但**验签与载荷映射
		// 交给当前 transport**（见 `src/transport/`）—— 换 provider 时这里不用改。
		//
		// **`request: { body: "text" }` 是必须的**：验签对象是原始请求体字节，
		// 让宿主先 `JSON.parse` 再 `JSON.stringify` 会改变字节（键序 / 空白 / 转义），
		// 验签必然失败。签名头（Resend 是 Svix 三件套）需显式声明才会透传给插件。
		//
		// 未配置签名密钥时返回 503（而不是静默 200）—— 否则运营在服务后台看到
		// 「投递成功」，却永远等不到回执，无从排查。
		"resend/webhook": {
			public: true,
			response: "raw",
			methods: ["POST"],
			request: { body: "text", headers: ["svix-id", "svix-timestamp", "svix-signature"] },
			handler: async (routeCtx, ctx): Promise<PluginResponse> => {
				const transport = await resolveTransport(ctx);
				if (!transport) return json(503, { ok: false, error: "WEBHOOK_DISABLED" });

				const payload = typeof routeCtx.input === "string" ? routeCtx.input : "";
				const verdict = await transport.verifyWebhook({
					payload,
					headers: {
						"svix-id": readHeader(routeCtx, "svix-id"),
						"svix-timestamp": readHeader(routeCtx, "svix-timestamp"),
						"svix-signature": readHeader(routeCtx, "svix-signature"),
					},
				});
				if (verdict === "disabled") return json(503, { ok: false, error: "WEBHOOK_DISABLED" });
				if (verdict !== "ok") return json(401, { ok: false, error: "INVALID_SIGNATURE" });

				let parsed: unknown;
				try {
					parsed = JSON.parse(payload);
				} catch {
					return json(400, { ok: false, error: "INVALID_BODY" });
				}

				const event = transport.mapWebhookEvent(parsed);
				const type = event ? WEBHOOK_EVENT_TYPES[event.type] : undefined;
				if (!event || !type) return json(200, { ok: true, ignored: true });

				// 只留痕，不改订阅状态：退信 / 投诉的处置是人工决定（暂停还是拉黑），
				// 自动退订会误伤（软退信 ≠ 用户不想收）。
				const found = event.email
					? await findSubscriberByEmailHash(ctx, await hashEmail(normalizeEmail(event.email)))
					: null;
				if (found) {
					await recordEvent(ctx, {
						subscriberId: found.id,
						type,
						actor: "system",
						...(event.broadcastId ? { detail: `broadcast ${event.broadcastId}` } : {}),
						...(event.reason ? { reason: event.reason } : {}),
					});
				}

				return json(200, { ok: true, matched: Boolean(found) });
			},
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
				const { status, group, q, limit } = parsed.data;

				const store = subscriberStore(ctx);
				const [pending, confirmed, unsubscribed, paused] = await Promise.all([
					store.count({ status: "pending" }),
					store.count({ status: "confirmed" }),
					store.count({ status: "unsubscribed" }),
					store.count({ status: "paused" }),
				]);

				// 分组 / 邮箱关键词是数组字段与子串匹配，插件存储的索引做不到，
				// 只能把记录读回来内存过滤（见 scanSubscribers 的护栏说明）。
				const needsScan = Boolean(group) || Boolean(q);
				const source = needsScan
					? (await scanSubscribers(ctx)).items
					: (
							await store.query({
								...(status ? { where: { status } } : {}),
								orderBy: { createdAt: "desc" },
								limit: clamp(limit ?? 50, 1, 100),
							})
						).items;

				const needle = q?.toLowerCase() ?? "";
				const filtered = needsScan
					? source.filter((item) => {
							if (status && item.data.status !== status) return false;
							if (group && !groupsOf(item.data).includes(group)) return false;
							if (needle && !item.data.email.toLowerCase().includes(needle)) return false;
							return true;
						})
					: source;

				const sliced = filtered.slice(0, clamp(limit ?? 50, 1, 100));

				return ok({
					total: pending + confirmed + unsubscribed + paused,
					by_status: { pending, confirmed, unsubscribed, paused },
					count: sliced.length,
					matched: filtered.length,
					has_more: filtered.length > sliced.length,
					subscribers: sliced.map((item) => ({
						id: item.id,
						email: item.data.email,
						status: item.data.status,
						source: item.data.source ?? null,
						groups: groupsOf(item.data),
						created_at: item.data.createdAt,
						confirmed_at: item.data.confirmedAt ?? null,
						unsubscribed_at: item.data.unsubscribedAt ?? null,
						unsubscribe_reason: item.data.unsubscribeReason ?? null,
						paused_at: item.data.pausedAt ?? null,
						pause_reason: item.data.pauseReason ?? null,
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

		"subscribers/update": {
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = updateInput.safeParse(routeCtx.input ?? {});
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });
				const { id, action, reason, groups } = parsed.data;

				const result =
					action === "pause"
						? await pauseSubscriber(ctx, id, { by: "admin", ...(reason ? { reason } : {}) })
						: action === "resume"
							? await resumeSubscriber(ctx, id)
							: action === "unsubscribe"
								? await unsubscribeSubscriber(ctx, id, { actor: "admin", ...(reason ? { reason } : {}) })
								: await setSubscriberGroups(ctx, id, groups ?? [], "admin");

				if (!result.ok) return fail(result.error);
				return ok({
					id,
					status: result.record.status,
					groups: groupsOf(result.record),
				});
			},
		},

		"subscribers/events": {
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = eventsInput.safeParse(routeCtx.input ?? {});
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const record = await subscriberStore(ctx).get(parsed.data.id);
				if (!record) return fail("NOT_FOUND");

				const events = await listEvents(ctx, parsed.data.id, parsed.data.limit ?? 50);
				return ok({
					email: maskEmail(record.email),
					status: record.status,
					events: events.map((event) => ({
						at: event.data.at,
						type: event.data.type,
						actor: event.data.actor,
						reason: event.data.reason ?? null,
						detail: event.data.detail ?? null,
					})),
				});
			},
		},

		"groups/list": {
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (_routeCtx, ctx): Promise<Json> => {
				const groups = await listGroups(ctx);
				const { items } = await scanSubscribers(ctx);
				const counts = new Map<string, number>();
				for (const item of items) {
					for (const slug of groupsOf(item.data)) {
						counts.set(slug, (counts.get(slug) ?? 0) + 1);
					}
				}

				return ok({
					count: groups.length,
					groups: groups.map((group) => ({
						slug: group.slug,
						name: group.data.name,
						description: group.data.description ?? null,
						sort_order: group.data.sortOrder,
						active: group.data.active,
						members: counts.get(group.slug) ?? 0,
						created_at: group.data.createdAt,
						updated_at: group.data.updatedAt ?? null,
					})),
				});
			},
		},

		"groups/save": {
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = groupSaveInput.safeParse(routeCtx.input ?? {});
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const result = await saveGroup(ctx, parsed.data);
				if (!result.ok) return fail(result.error);
				return ok({ slug: result.slug, created: result.created });
			},
		},

		"groups/delete": {
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx): Promise<Json> => {
				const parsed = groupDeleteInput.safeParse(routeCtx.input ?? {});
				if (!parsed.success) return fail("INVALID_INPUT", { issues: parsed.error.issues });

				const slug = parsed.data.slug;
				const store = subscriberStore(ctx);
				const { items } = await scanSubscribers(ctx);
				let detached = 0;
				for (const item of items) {
					const current = groupsOf(item.data);
					if (!current.includes(slug)) continue;
					const next = current.filter((value) => value !== slug);
					await store.put(item.id, { ...item.data, groups: next });
					await recordEvent(ctx, {
						subscriberId: item.id,
						type: "groups_changed",
						actor: "admin",
						detail: next.join(","),
						reason: `分组「${slug}」已删除`,
					});
					detached += 1;
				}

				const deleted = await deleteGroup(ctx, slug);
				if (!deleted) return fail("NOT_FOUND");
				return ok({ slug, detached });
			},
		},

		// ===== 后台页（Block Kit，两个页面共用此路由，靠 input.page 分派） =====

		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx): Promise<Json> => {
				const result = await renderAdmin(ctx, (routeCtx.input ?? {}) as AdminInput);
				return { blocks: result.blocks, ...(result.toast ? { toast: result.toast } : {}) };
			},
		},
	},

	mcp: {
		tools: {
			listSubscribers: {
				description:
					"列出读者订阅者（可按 status 过滤：pending/confirmed/unsubscribed/paused，按 group 过滤分组 slug，按 q 模糊匹配邮箱），并返回各状态计数。",
				route: "subscribers/list",
				input: z.object({
					status: z.enum(["pending", "confirmed", "unsubscribed", "paused"]).optional(),
					group: z.string().max(40).optional(),
					q: z.string().max(200).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				}),
				destructive: false,
			},
			listGroups: {
				description: "列出读者订阅分组（含每组订阅人数）。",
				route: "groups/list",
				input: z.object({}),
				destructive: false,
			},
		},
	},
};

export default plugin;
