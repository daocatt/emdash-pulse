/**
 * 公开路由的限流（固定时间桶计数）。
 *
 * 用 `ctx.kv` 存计数，键形如 `rl:<route>:<client>:<bucket>`。
 * 说明：这是**按插件实例**的近似限流，Cloudflare 多 isolate 下不是严格全局；
 * Phase 5 会换成 Rate Limiting binding / Durable Object。
 */

import type { PluginContext } from "emdash/plugin";

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	retryAfter: number;
}

export async function checkRateLimit(
	ctx: PluginContext,
	key: string,
	limit: number,
	windowSec: number,
): Promise<RateLimitResult> {
	const nowSec = Math.floor(Date.now() / 1000);
	const bucket = Math.floor(nowSec / windowSec);
	const kvKey = `rl:${key}:${bucket}`;
	const current = (await ctx.kv.get<number>(kvKey)) ?? 0;

	if (current >= limit) {
		return { allowed: false, remaining: 0, retryAfter: (bucket + 1) * windowSec - nowSec };
	}

	await ctx.kv.set(kvKey, current + 1);
	return { allowed: true, remaining: limit - current - 1, retryAfter: 0 };
}

/** 从 routeCtx.requestMeta 中取客户端 IP（可能为 null）。 */
export function clientIp(meta: unknown): string {
	if (meta && typeof meta === "object") {
		const ip = (meta as { ip?: unknown }).ip;
		if (typeof ip === "string" && ip) return ip;
	}
	return "unknown";
}
