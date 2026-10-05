/**
 * Agent Read API 路由的公共守卫：限流 + 站点上下文。
 *
 * 读端点公开只读，但仍做尽力限流（见 rate-limit.ts）。
 */

import { getSiteSettings } from "emdash";
import { resolveSiteIdentity } from "./site-identity";
import { checkRateLimit, clientKey, tooManyRequests } from "./rate-limit";
import { siteContext } from "./agent";

export type AgentGuard =
	| { ok: true; siteUrl: URL; meta: ReturnType<typeof siteContext> }
	| { ok: false; response: Response };

export async function agentGuard(request: Request, url: URL, limit = 120): Promise<AgentGuard> {
	const rate = checkRateLimit(clientKey(request), { limit });
	if (!rate.ok) return { ok: false, response: tooManyRequests(rate.retryAfterSeconds) };

	const { siteTitle, siteTagline } = resolveSiteIdentity(await getSiteSettings());
	const siteUrl = new URL(url.origin);
	return { ok: true, siteUrl, meta: siteContext(siteUrl, siteTitle, siteTagline) };
}
