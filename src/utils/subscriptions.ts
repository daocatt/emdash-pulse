/**
 * 读者订阅（pulse-subscriptions 插件）的前台接线。
 *
 * 公开路由挂在 `/_emdash/api/plugins/pulse-subscriptions/<route>`：
 * - 确认 / 退订走 SSR（`getPublicPluginApiRouteHandler`）——token 即凭证，
 *   无需前端 JS，也不受订阅提交的 IP 限流影响。
 * - 订阅提交由浏览器直接 `fetch`（见 SubscribeForm.astro）——该端点按客户端 IP
 *   限流，SSR 代理会丢失真实 IP（`cf` 对象不在合成 Request 上），因此不能走服务端。
 */

import { getPublicPluginApiRouteHandler, type PublicPluginRuntimeLocals } from "emdash/plugin-utils";

export const SUBSCRIPTIONS_PLUGIN_ID = "pulse-subscriptions";
export const SUBSCRIPTIONS_API_BASE = `/_emdash/api/plugins/${SUBSCRIPTIONS_PLUGIN_ID}`;

export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed" | "paused";

/** 订阅分组（前台表单与订阅管理页共用）。 */
export interface SubscriptionGroup {
	slug: string;
	name: string;
	description: string | null;
}

export interface SubscriptionResponse {
	status: number;
	ok: boolean;
	body: Record<string, unknown>;
}

/** raw 路由在宿主里的信封形状（body 是 JSON 字符串）。 */
interface RawEnvelope {
	__emdashPluginResponse?: boolean;
	status?: number;
	body?: { kind?: string; value?: string };
}

/** SSR 调用公开插件路由（仅用于 confirm / unsubscribe）。 */
export async function callSubscriptionsRoute(
	locals: unknown,
	route: string,
	payload: Record<string, unknown>,
): Promise<SubscriptionResponse> {
	const handler = getPublicPluginApiRouteHandler(locals as PublicPluginRuntimeLocals | undefined);
	if (!handler) {
		return { status: 500, ok: false, body: { ok: false, error: "PLUGIN_UNAVAILABLE" } };
	}

	const request = new Request(`https://emdash.internal${SUBSCRIPTIONS_API_BASE}/${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});

	const result = await handler(SUBSCRIPTIONS_PLUGIN_ID, "POST", `/${route}`, request);
	const envelope = result.data as RawEnvelope | undefined;

	if (envelope && envelope.__emdashPluginResponse) {
		const status = envelope.status ?? 200;
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(envelope.body?.value ?? "{}") as Record<string, unknown>;
		} catch {
			body = {};
		}
		return { status, ok: status >= 200 && status < 300, body };
	}

	if (result.success) {
		return { status: 200, ok: true, body: (result.data as Record<string, unknown>) ?? {} };
	}
	return {
		status: 400,
		ok: false,
		body: {
			ok: false,
			error: result.error?.code ?? "PLUGIN_ERROR",
			message: result.error?.message,
		},
	};
}

const isGroup = (value: unknown): value is SubscriptionGroup => {
	if (typeof value !== "object" || value === null) return false;
	const group = value as Record<string, unknown>;
	return typeof group.slug === "string" && typeof group.name === "string";
};

/** 取启用中的订阅分组（`/subscribe` 页渲染勾选框用）。失败时返回空数组，页面照常渲染。 */
export async function fetchActiveGroups(locals: unknown): Promise<SubscriptionGroup[]> {
	const result = await callSubscriptionsRoute(locals, "groups/public", {});
	const groups = result.body.groups;
	if (!Array.isArray(groups)) return [];
	return groups.filter(isGroup).map((group) => ({
		slug: group.slug,
		name: group.name,
		description: typeof group.description === "string" ? group.description : null,
	}));
}

export interface PreferencesSnapshot {
	email: string | null;
	status: SubscriberStatus | null;
	groups: string[];
	available: SubscriptionGroup[];
}

/**
 * 读 / 写某邮箱的订阅偏好（token 即凭证）。
 *
 * 传 `groups` 即为写入；不传则纯读取。**GET 打开管理页时不要传 groups** ——
 * 这样邮件客户端预取链接不会改动任何状态。
 */
export async function callPreferences(
	locals: unknown,
	token: string,
	groups?: string[],
): Promise<{ response: SubscriptionResponse; snapshot: PreferencesSnapshot }> {
	const result = await callSubscriptionsRoute(locals, "preferences", {
		token,
		...(groups ? { groups } : {}),
	});

	const available = Array.isArray(result.body.available)
		? (result.body.available as unknown[]).filter(isGroup)
		: [];
	const rawGroups = result.body.groups;
	const status = result.body.status;

	return {
		response: result,
		snapshot: {
			email: typeof result.body.email === "string" ? result.body.email : null,
			status:
				status === "pending" || status === "confirmed" || status === "unsubscribed" || status === "paused"
					? status
					: null,
			groups: Array.isArray(rawGroups) ? rawGroups.filter((slug): slug is string => typeof slug === "string") : [],
			available,
		},
	};
}

/** 订阅管理页的解析结果。页面只按 `kind` 渲染，状态机集中在这里，两套主题不会漂移。 */
export type ManageOutcome =
	| { kind: "missingToken" }
	| { kind: "invalidToken" }
	| { kind: "unsubscribed"; email: string | null; justNow: boolean }
	| { kind: "paused"; email: string | null }
	| {
			kind: "manage";
			token: string;
			email: string | null;
			groups: string[];
			available: SubscriptionGroup[];
			notice: "saved" | "saveFailed" | null;
	  };

export interface ManageRequest {
	/** `Astro.request.method`。 */
	method: string;
	token: string;
	/** POST 表单的 `intent` 字段：`unsubscribe` / `groups` / 其它。 */
	intent: string;
	/** POST 表单勾选的分组。 */
	groups: string[];
	/** POST 表单的退订原因。 */
	reason: string;
}

/**
 * 解析订阅管理页的状态。
 *
 * 关键约束：**GET 一律只读**。旧的「打开即退订」会让邮件客户端的链接预取
 * （以及安全扫描器）把读者悄悄退订掉，所以退订必须是显式 POST。
 */
export async function resolveManageOutcome(
	locals: unknown,
	request: ManageRequest,
): Promise<ManageOutcome> {
	if (!request.token) return { kind: "missingToken" };

	if (request.intent === "unsubscribe") {
		const result = await callSubscriptionsRoute(locals, "unsubscribe", {
			token: request.token,
			...(request.reason ? { reason: request.reason } : {}),
		});
		if (result.ok && result.body.status === "unsubscribed") {
			return {
				kind: "unsubscribed",
				email: typeof result.body.email === "string" ? result.body.email : null,
				justNow: true,
			};
		}
		return { kind: "invalidToken" };
	}

	if (request.intent === "groups") {
		const { response, snapshot } = await callPreferences(locals, request.token, request.groups);
		if (!response.ok) {
			return response.status === 400 ? { kind: "invalidToken" } : { kind: "missingToken" };
		}
		return {
			kind: "manage",
			token: request.token,
			email: snapshot.email,
			groups: snapshot.groups,
			available: snapshot.available,
			notice: "saved",
		};
	}

	// 只读路径。
	const { response, snapshot } = await callPreferences(locals, request.token);
	if (!response.ok) return { kind: "invalidToken" };

	if (snapshot.status === "unsubscribed") {
		return { kind: "unsubscribed", email: snapshot.email, justNow: false };
	}
	if (snapshot.status === "paused") {
		return { kind: "paused", email: snapshot.email };
	}
	if (snapshot.status === "pending" || snapshot.status === "confirmed") {
		return {
			kind: "manage",
			token: request.token,
			email: snapshot.email,
			groups: snapshot.groups,
			available: snapshot.available,
			notice: null,
		};
	}
	return { kind: "invalidToken" };
}
