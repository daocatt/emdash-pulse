/**
 * 公开路由的限流（固定窗口，窗口锚定在该键**首次请求**的时刻）。
 *
 * 用 `ctx.kv` 存 `{ count, resetAt }`：同一 `(route, client)` 只占**一个**键，
 * 窗口过期后原地重置。这样键数被收敛为「路由 × 客户端」，不会像「把时间桶编进
 * 键名」那样无限堆积（`ctx.kv` 没有 TTL）。
 *
 * 说明：这是**按插件实例**的近似限流，Cloudflare 多 isolate 下不是严格全局；
 * 读改写非原子（并发下可能少计）。Phase 5 会换成 Rate Limiting binding /
 * Durable Object。
 */

import type { PluginContext } from "emdash/plugin";

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	retryAfter: number;
}

interface Window {
	/** 本窗口内已计数的请求数。 */
	count: number;
	/** 窗口结束时刻（epoch 秒，开区间）。 */
	resetAt: number;
}

export async function checkRateLimit(
	ctx: PluginContext,
	key: string,
	limit: number,
	windowSec: number,
): Promise<RateLimitResult> {
	const nowSec = Math.floor(Date.now() / 1000);
	const kvKey = `rl:${key}`;
	const stored = await ctx.kv.get<Window>(kvKey);

	// 无记录 / 窗口已过期 → 开启新窗口（原地覆盖，不新增键）。
	if (!stored || typeof stored.resetAt !== "number" || stored.resetAt <= nowSec) {
		await ctx.kv.set(kvKey, { count: 1, resetAt: nowSec + windowSec });
		return { allowed: true, remaining: limit - 1, retryAfter: 0 };
	}

	if (stored.count >= limit) {
		return { allowed: false, remaining: 0, retryAfter: stored.resetAt - nowSec };
	}

	await ctx.kv.set(kvKey, { count: stored.count + 1, resetAt: stored.resetAt });
	return { allowed: true, remaining: limit - stored.count - 1, retryAfter: 0 };
}

/**
 * 从 `routeCtx.requestMeta` 中取客户端 IP。
 *
 * ⚠️ 取不到时回退 `"unknown"`：若部署环境没有把真实 IP 透传进来，**所有**此类
 * 请求会共用一个桶，既可能误伤正常流量，也会让单一来源耗尽全局限额。生产必须
 * 通过 `EMDASH_TRUSTED_PROXY_HEADERS`（如 `x-forwarded-for`）确保 `meta.ip` 有值。
 */
export function clientIp(meta: unknown): string {
	if (meta && typeof meta === "object") {
		const ip = (meta as { ip?: unknown }).ip;
		if (typeof ip === "string" && ip) return ip;
	}
	return "unknown";
}
