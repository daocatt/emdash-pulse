/**
 * `ctx.http` → `Fetcher` 的适配。
 *
 * 单独成文件是为了避开 `index.ts ↔ resend.ts` 的模块环：两个 transport 实现都需要
 * 它，而 `index.ts` 又要 import 具体实现来组装 `resolveTransport()`。
 */

import type { PluginContext } from "emdash/plugin";

import type { Fetcher } from "../resend";

/** `ctx.http.fetch` → `Fetcher`；未声明 `network:request` 能力时为 null。 */
export function httpFetcher(ctx: PluginContext): Fetcher | null {
	const http = ctx.http;
	if (!http) return null;
	return (url, init) => http.fetch(url, init);
}
