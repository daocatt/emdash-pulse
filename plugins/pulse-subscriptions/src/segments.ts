/**
 * 订阅分组 ↔ Resend Segment 的同步。
 *
 * 分组的 slug 是本地的（`groups` 集合的 id），Resend 的 segment 是远端对象，
 * 两者靠「组记录上的 `resendSegmentId` 缓存 + 按名字兜底查找」绑定：
 *
 *   - 首次同步时按 `前缀 + 分组名` 找 Resend segment，找不到就创建，并把 id 写回组记录；
 *   - 之后直接用缓存 id，不再打列表接口。
 *
 * ## 为什么全程 best-effort
 *
 * 订阅是主流程，Resend 是**旁路**：任何一步失败（未配置 key、网络抖动、额度用尽）
 * 都只记一条事件日志，绝不让 `subscribe/confirm` 或后台操作失败。同步是最终一致的 ——
 * 下一次状态变更会再试。
 *
 * 只同步 `confirmed` 的订阅者：`pending` 还没确认邮箱，不该进 Resend 联系人表；
 * `paused` / `unsubscribed` 同步为 `unsubscribed: true`（Resend 会因此跳过所有广播），
 * 记录本身仍留在本地。
 */

import type { PluginContext } from "emdash/plugin";

import { recordEvent } from "./events";
import { groupStore, listGroups, type GroupListEntry } from "./groups";
import {
	ensureSegment,
	loadResendConfig,
	upsertContact,
	type Fetcher,
	type ResendConfig,
} from "./resend";
import type { SubscriberRecord } from "./subscribers";

/** segment 名字前缀：同一个 Resend 账号被多环境（staging / prod）共用时避免撞名。 */
export const DEFAULT_SEGMENT_PREFIX = "Pulse · ";

export interface ResendSyncSettings {
	enabled: boolean;
	prefix: string;
}

export const DEFAULT_SYNC_SETTINGS: ResendSyncSettings = {
	enabled: true,
	prefix: DEFAULT_SEGMENT_PREFIX,
};

export async function readSyncSettings(ctx: PluginContext): Promise<ResendSyncSettings> {
	const get = async (key: string): Promise<unknown> => {
		try {
			return await ctx.settings.get(key);
		} catch {
			return null;
		}
	};
	const [enabled, prefix] = await Promise.all([get("resendSyncEnabled"), get("resendSegmentPrefix")]);
	return {
		enabled: typeof enabled === "boolean" ? enabled : DEFAULT_SYNC_SETTINGS.enabled,
		prefix:
			typeof prefix === "string" && prefix.trim() !== ""
				? prefix.trim()
				: DEFAULT_SYNC_SETTINGS.prefix,
	};
}

/** 分组在 Resend 里的 segment 名。 */
export function segmentName(prefix: string, groupName: string): string {
	return `${prefix}${groupName}`.slice(0, 120);
}

/** 取 `ctx.http.fetch`（未声明 network:request 时为 undefined）。 */
export function httpFetcher(ctx: PluginContext): Fetcher | null {
	const http = ctx.http;
	if (!http) return null;
	return (url, init) => http.fetch(url, init);
}

/**
 * 确保分组有对应的 Resend segment，返回 segment id（失败返回 null）。
 * 首次成功后把 id 写回组记录，后续调用直接命中缓存。
 */
export async function ensureGroupSegment(
	ctx: PluginContext,
	config: ResendConfig,
	fetcher: Fetcher,
	group: GroupListEntry,
	prefix: string,
): Promise<string | null> {
	if (group.data.resendSegmentId) return group.data.resendSegmentId;

	const result = await ensureSegment(fetcher, config, segmentName(prefix, group.data.name));
	if (!result.ok) return null;

	await groupStore(ctx).put(group.slug, {
		...group.data,
		resendSegmentId: result.data.id,
		updatedAt: new Date().toISOString(),
	});
	return result.data.id;
}

export interface SyncOutcome {
	/** 是否真正发起了同步（未配置 / 已禁用 / 无网络时为 false）。 */
	attempted: boolean;
	ok: boolean;
	error?: string;
}

/**
 * 把一个订阅者的当前状态同步到 Resend。**永不抛错**。
 *
 * 目标状态：
 *   - `confirmed` → contact `unsubscribed:false` + 属于其分组的所有 segment
 *   - `paused` / `unsubscribed` → contact `unsubscribed:true`，且清空 segment 归属
 *   - `pending` → 跳过（邮箱未确认）
 */
export async function syncSubscriber(
	ctx: PluginContext,
	entry: { id: string; data: SubscriberRecord },
): Promise<SyncOutcome> {
	try {
		const settings = await readSyncSettings(ctx);
		if (!settings.enabled) return { attempted: false, ok: true };

		const fetcher = httpFetcher(ctx);
		if (!fetcher) return { attempted: false, ok: false, error: "no_http" };

		const config = await loadResendConfig();
		if (!config) return { attempted: false, ok: false, error: "resend_not_configured" };

		const record = entry.data;
		if (record.status === "pending") return { attempted: false, ok: true };

		const confirmed = record.status === "confirmed";
		const segmentIds: string[] = [];
		if (confirmed && (record.groups ?? []).length > 0) {
			const wanted = new Set(record.groups ?? []);
			const groups = (await listGroups(ctx)).filter(
				(group) => wanted.has(group.slug) && group.data.active,
			);
			for (const group of groups) {
				const segmentId = await ensureGroupSegment(ctx, config, fetcher, group, settings.prefix);
				if (segmentId) segmentIds.push(segmentId);
			}
		}

		const result = await upsertContact(fetcher, config, {
			email: record.email,
			unsubscribed: !confirmed,
			segmentIds,
		});

		if (!result.ok) {
			await recordEvent(ctx, {
				subscriberId: entry.id,
				type: "resend_sync_failed",
				actor: "system",
				reason: result.error,
			});
			return { attempted: true, ok: false, error: result.error };
		}
		return { attempted: true, ok: true };
	} catch (error) {
		// 旁路：连读设置都可能抛（宿主未就绪），一并吞掉。
		return {
			attempted: true,
			ok: false,
			error: error instanceof Error ? error.message : "unknown",
		};
	}
}
