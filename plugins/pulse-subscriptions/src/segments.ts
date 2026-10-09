/**
 * 订阅分组 ↔ 远端受众（Resend Segment 等）的同步。
 *
 * 分组的 slug 是本地的（`groups` 集合的 id），远端受众是服务侧对象，两者靠
 * 「组记录上的 `resendSegmentId` 缓存 + 按名字兜底查找」绑定：
 *
 *   - 首次同步时按 `前缀 + 分组名` 找受众，找不到就创建，并把 id 写回组记录；
 *   - 之后直接用缓存 id，不再打列表接口。
 *
 * `resendSegmentId` 字段名沿用历史（当时只有 Resend），语义是「**当前 transport
 * 的受众 id**」—— 调用方只把它当不透明字符串缓存与回传。
 *
 * ## 为什么全程 best-effort
 *
 * 订阅是主流程，邮件服务是**旁路**：任何一步失败（未配置 key、网络抖动、额度用尽）
 * 都只记一条事件日志，绝不让 `subscribe/confirm` 或后台操作失败。同步是最终一致的 ——
 * 下一次状态变更会再试。
 *
 * 只同步 `confirmed` 的订阅者：`pending` 还没确认邮箱，不该进联系人表；
 * `paused` / `unsubscribed` 同步为 `unsubscribed: true`（服务侧据此跳过群发），
 * 记录本身仍留在本地。
 */

import type { PluginContext } from "emdash/plugin";

import { recordEvent } from "./events";
import { groupStore, listGroups, type GroupListEntry } from "./groups";
import { cadenceOf, isCadence, CADENCE_LABELS, type Cadence, type SubscriberRecord } from "./subscribers";
import { httpFetcher, resolveTransport, type BroadcastTransport } from "./transport";

/** 受众名字前缀：同一个远端账号被多环境（staging / prod）共用时避免撞名。 */
export const DEFAULT_SEGMENT_PREFIX = "Pulse · ";

export interface ResendSyncSettings {
	enabled: boolean;
	prefix: string;
	/** 订阅者未显式选择节奏时的默认档位（摘要用）。 */
	defaultCadence: Cadence;
}

export const DEFAULT_SYNC_SETTINGS: ResendSyncSettings = {
	enabled: true,
	prefix: DEFAULT_SEGMENT_PREFIX,
	defaultCadence: "weekly",
};

export async function readSyncSettings(ctx: PluginContext): Promise<ResendSyncSettings> {
	const get = async (key: string): Promise<unknown> => {
		try {
			return await ctx.settings.get(key);
		} catch {
			return null;
		}
	};
	const [enabled, prefix, defaultCadence] = await Promise.all([
		get("resendSyncEnabled"),
		get("resendSegmentPrefix"),
		get("defaultCadence"),
	]);
	return {
		enabled: typeof enabled === "boolean" ? enabled : DEFAULT_SYNC_SETTINGS.enabled,
		prefix:
			typeof prefix === "string" && prefix.trim() !== ""
				? prefix.trim()
				: DEFAULT_SYNC_SETTINGS.prefix,
		defaultCadence: isCadence(defaultCadence) ? defaultCadence : DEFAULT_SYNC_SETTINGS.defaultCadence,
	};
}

/** 分组在远端受众列表里的名字。 */
export function segmentName(prefix: string, groupName: string): string {
	return `${prefix}${groupName}`.slice(0, 120);
}

/**
 * 确保分组有对应的远端受众，返回受众 id（失败返回 null）。
 * 首次成功后把 id 写回组记录，后续调用直接命中缓存。
 */
export async function ensureGroupAudience(
	ctx: PluginContext,
	transport: BroadcastTransport,
	group: GroupListEntry,
	prefix: string,
): Promise<string | null> {
	if (group.data.resendSegmentId) return group.data.resendSegmentId;

	const result = await transport.ensureAudience(segmentName(prefix, group.data.name));
	if (!result.ok) return null;

	await groupStore(ctx).put(group.slug, {
		...group.data,
		resendSegmentId: result.data.id,
		updatedAt: new Date().toISOString(),
	});
	return result.data.id;
}

/** cadence 受众 id 的 KV 缓存键（分组把 id 写回组记录，cadence 没有记录可写，故用 KV）。 */
const cadenceCacheKey = (cadence: Cadence): string => `digest.segment.${cadence}`;

/**
 * 确保某档节奏有对应的远端受众，返回受众 id（失败返回 null）。
 *
 * 与 `ensureGroupAudience` 的区别：cadence 没有「组记录」可以回写，缓存落在
 * `ctx.kv`。KV 不可用时退化为每次都查（`ensureAudience` 本身幂等，只是多一次请求）。
 */
export async function cadenceAudienceId(
	ctx: PluginContext,
	transport: BroadcastTransport,
	cadence: Cadence,
	prefix: string,
): Promise<string | null> {
	const key = cadenceCacheKey(cadence);
	try {
		const cached = await ctx.kv?.get<string>(key);
		if (typeof cached === "string" && cached !== "") return cached;
	} catch {
		// KV 读失败：继续走 ensureAudience（幂等）。
	}

	const result = await transport.ensureAudience(segmentName(prefix, CADENCE_LABELS[cadence]));
	if (!result.ok) return null;

	try {
		await ctx.kv?.set(key, result.data.id);
	} catch {
		// 缓存写失败不影响本次返回。
	}
	return result.data.id;
}

export interface SyncOutcome {
	/** 是否真正发起了同步（未配置 / 已禁用 / 无网络时为 false）。 */
	attempted: boolean;
	ok: boolean;
	error?: string;
}

/**
 * 把一个订阅者的当前状态同步到远端。**永不抛错**。
 *
 * 目标状态：
 *   - `confirmed` → contact `unsubscribed:false` + 属于其分组的受众 + 其节奏（cadence）受众
 *   - `paused` / `unsubscribed` → contact `unsubscribed:true`，且清空受众归属
 *   - `pending` → 跳过（邮箱未确认）
 */
export async function syncSubscriber(
	ctx: PluginContext,
	entry: { id: string; data: SubscriberRecord },
): Promise<SyncOutcome> {
	try {
		const settings = await readSyncSettings(ctx);
		if (!settings.enabled) return { attempted: false, ok: true };

		// 能力缺失（未声明 network:request）先于凭证判断 —— 否则会误报「未配置」。
		if (!httpFetcher(ctx)) return { attempted: false, ok: false, error: "no_http" };

		const transport = await resolveTransport(ctx);
		if (!transport || !(await transport.isConfigured())) {
			return { attempted: false, ok: false, error: "resend_not_configured" };
		}

		const record = entry.data;
		if (record.status === "pending") return { attempted: false, ok: true };

		const confirmed = record.status === "confirmed";
		const audienceIds: string[] = [];
		if (confirmed) {
			if ((record.groups ?? []).length > 0) {
				const wanted = new Set(record.groups ?? []);
				const groups = (await listGroups(ctx)).filter(
					(group) => wanted.has(group.slug) && group.data.active,
				);
				for (const group of groups) {
					const audienceId = await ensureGroupAudience(ctx, transport, group, settings.prefix);
					if (audienceId) audienceIds.push(audienceId);
				}
			}
			// 节奏受众：摘要按它群发（见 digest.ts）。
			const cadenceId = await cadenceAudienceId(
				ctx,
				transport,
				cadenceOf(record, settings.defaultCadence),
				settings.prefix,
			);
			if (cadenceId) audienceIds.push(cadenceId);
		}

		const result = await transport.syncContact({
			email: record.email,
			unsubscribed: !confirmed,
			audienceIds,
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
