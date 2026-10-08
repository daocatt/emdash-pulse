/**
 * 群发（Resend Broadcasts）。
 *
 * Resend 的群发是「面向 segment 的 Broadcast」：没有 segment 就没有收件人池，
 * 因此这里的分组 → segment 映射复用 `segments.ts`（同一个 `resendSegmentId` 缓存）。
 *
 * 群发**不走** `ctx.email`（那是事务性邮件 `POST /emails`），而是直接调
 * `POST /broadcasts` + `send: true`：这样 Resend 侧会按 segment 展开收件人、
 * 自动带上 `{{{RESEND_UNSUBSCRIBE_URL}}}` 退订链接、并遵守 contact 的
 * `unsubscribed` 状态。
 *
 * 每次发送都在插件存储 `broadcasts` 里留一条记录（Resend 也有列表接口，但
 * 本地留痕便于在后台直接看到「谁在什么时候发了什么」）。
 */

import type { PluginContext } from "emdash/plugin";

import { listGroups } from "./groups";
import { createBroadcast, loadResendConfig, type ResendConfig } from "./resend";
import { ensureGroupSegment, httpFetcher, readSyncSettings } from "./segments";

export interface BroadcastRecord {
	subject: string;
	/** 目标分组 slug。 */
	segmentSlug: string;
	segmentId: string;
	/** Resend 的 broadcast id。 */
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
 * 向某个分组的 segment 群发。
 *
 * 失败时同样落一条 `status:"failed"` 的历史记录 —— 否则后台只会看到「点过按钮
 * 但什么也没发生」。返回值给路由层转成 toast。
 */
export async function sendBroadcastToSegment(
	ctx: PluginContext,
	input: SendBroadcastInput,
): Promise<SendBroadcastResult> {
	const settings = await readSyncSettings(ctx);
	const fetcher = httpFetcher(ctx);
	if (!fetcher) return { ok: false, error: "no_http" };

	const config: ResendConfig | null = await loadResendConfig();
	if (!config) return { ok: false, error: "resend_not_configured" };
	if (config.fromAddress === "") return { ok: false, error: "resend_from_address_missing" };

	const group = (await listGroups(ctx)).find((entry) => entry.slug === input.segmentSlug);
	if (!group) return { ok: false, error: "segment_not_found" };

	const segmentId = await ensureGroupSegment(ctx, config, fetcher, group, settings.prefix);
	if (!segmentId) return { ok: false, error: "segment_sync_failed" };

	const created = await createBroadcast(fetcher, config, {
		segmentId,
		subject: input.subject,
		...(input.html ? { html: input.html } : {}),
		...(input.text ? { text: input.text } : {}),
		name: `${input.segmentSlug} · ${new Date().toISOString()}`,
		send: true,
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
