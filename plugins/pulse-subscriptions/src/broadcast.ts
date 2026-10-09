/**
 * 群发（走当前 transport，默认 Resend Broadcasts）。
 *
 * 群发是「面向受众的 broadcast」：没有受众（Resend 的 segment）就没有收件人池，
 * 因此这里的分组 → 受众映射复用 `segments.ts`（同一个 `resendSegmentId` 缓存）。
 *
 * 群发**不走** `ctx.email`（那是事务性邮件），而是调 transport 的 `send()`：
 * 由服务侧按受众展开收件人、自动带上退订链接、并遵守 contact 的 `unsubscribed`
 * 状态（Resend 用 `{{{RESEND_UNSUBSCRIBE_URL}}}` 占位）。
 *
 * 每次发送都在插件存储 `broadcasts` 里留一条记录（服务侧也有列表接口，但本地留痕
 * 便于在后台直接看到「谁在什么时候发了什么」）。
 */

import type { PluginContext } from "emdash/plugin";

import { listGroups } from "./groups";
import { ensureGroupAudience, readSyncSettings } from "./segments";
import { httpFetcher, resolveTransport } from "./transport";

export interface BroadcastRecord {
	subject: string;
	/** 目标分组 slug。 */
	segmentSlug: string;
	/** 远端受众 id（Resend segment id）。 */
	segmentId: string;
	/** 服务侧的 broadcast id。 */
	resendId: string;
	status: "sent" | "failed";
	createdAt: string;
	createdBy?: string;
	error?: string;
}

export interface BroadcastStore {
	put(id: string, data: BroadcastRecord): Promise<void>;
	query(options?: {
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: BroadcastRecord }>; cursor?: string; hasMore: boolean }>;
}

export function broadcastStore(ctx: PluginContext): BroadcastStore {
	return ctx.storage.broadcasts as unknown as BroadcastStore;
}

export const newBroadcastId = (): string => `bc_${crypto.randomUUID().replace(/-/g, "")}`;

/** 群发历史（新→旧）。 */
export async function listBroadcastHistory(ctx: PluginContext, limit = 20): Promise<BroadcastRecord[]> {
	try {
		const result = await broadcastStore(ctx).query({
			orderBy: { createdAt: "desc" },
			limit: Math.min(Math.max(limit, 1), 100),
		});
		return result.items.map((item) => item.data);
	} catch {
		return [];
	}
}

export type SendBroadcastResult =
	| { ok: true; resendId: string; segmentId: string }
	| { ok: false; error: string };

export interface SendBroadcastInput {
	subject: string;
	html?: string;
	text?: string;
	/** 目标分组 slug。 */
	segmentSlug: string;
	/** 后台操作者（仅留痕）。 */
	actor?: string;
}

/**
 * 向某个分组的受众群发。
 *
 * 失败时同样落一条 `status:"failed"` 的历史记录 —— 否则后台只会看到「点过按钮
 * 但什么也没发生」。返回值给路由层转成 toast。
 */
export async function sendBroadcastToSegment(
	ctx: PluginContext,
	input: SendBroadcastInput,
): Promise<SendBroadcastResult> {
	const settings = await readSyncSettings(ctx);

	// 能力缺失先于凭证判断 —— 否则会误报「未配置」。
	if (!httpFetcher(ctx)) return { ok: false, error: "no_http" };

	const transport = await resolveTransport(ctx);
	if (!transport || !(await transport.isConfigured())) {
		return { ok: false, error: "resend_not_configured" };
	}
	if ((await transport.fromAddress()) === "") return { ok: false, error: "resend_from_address_missing" };

	const group = (await listGroups(ctx)).find((entry) => entry.slug === input.segmentSlug);
	if (!group) return { ok: false, error: "segment_not_found" };

	const segmentId = await ensureGroupAudience(ctx, transport, group, settings.prefix);
	if (!segmentId) return { ok: false, error: "segment_sync_failed" };

	const created = await transport.send({
		audienceId: segmentId,
		subject: input.subject,
		...(input.html ? { html: input.html } : {}),
		...(input.text ? { text: input.text } : {}),
		name: `${input.segmentSlug} · ${new Date().toISOString()}`,
	});

	const now = new Date().toISOString();
	if (!created.ok) {
		await recordBroadcast(ctx, {
			subject: input.subject,
			segmentSlug: input.segmentSlug,
			segmentId,
			resendId: "",
			status: "failed",
			createdAt: now,
			...(input.actor ? { createdBy: input.actor } : {}),
			error: created.error,
		});
		return { ok: false, error: created.error };
	}

	await recordBroadcast(ctx, {
		subject: input.subject,
		segmentSlug: input.segmentSlug,
		segmentId,
		resendId: created.data.id,
		status: "sent",
		createdAt: now,
		...(input.actor ? { createdBy: input.actor } : {}),
	});
	return { ok: true, resendId: created.data.id, segmentId };
}

/** 写一条群发历史；失败不抛（历史是旁路）。 */
async function recordBroadcast(ctx: PluginContext, record: BroadcastRecord): Promise<void> {
	try {
		await broadcastStore(ctx).put(newBroadcastId(), record);
	} catch {
		// 旁路：历史写不进去不影响已经发出的邮件。
	}
}
