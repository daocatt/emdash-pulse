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

export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed";

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
