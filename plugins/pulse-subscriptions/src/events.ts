/**
 * 订阅事件日志：插件存储 `events` 的追加式（append-only）记录。
 *
 * 每次状态流转（提交 / 确认 / 退订 / 暂停 / 恢复 / 改分组）都落一条，
 * 后台可按订阅者回放时间线。日志**只写不改**，是审计与「退订记录」的来源。
 *
 * 注意：订阅记录本身仍持有 `unsubscribedAt` 等当前态字段；事件日志是历史，
 * 两者互补，不要试图只靠其中一个还原状态。
 *
 * **事件里刻意不存 `emailHash`**：`subscribers` 声明的 `uniqueIndexes: ["emailHash"]`
 * 会生成 `_plugin_storage(plugin_id, collection, json_extract(data,'$.emailHash'))` 上的
 * **唯一索引，覆盖整张表的所有行** —— 同一订阅者的第 2 条事件就会撞唯一约束而写不进去
 * （`recordEvent` 吞异常 ⇒ 事件静默丢失，且内存版测试宿主不校验索引，测不出来）。
 * 订阅者 id 是稳定的（`subscribe/request` 复用 `existing.id`），按 id 回溯足够。
 */

import type { PluginContext } from "emdash/plugin";

export type EventType =
	| "requested"
	| "confirmed"
	| "unsubscribed"
	| "paused"
	| "resumed"
	| "groups_changed"
	| "cadence_changed"
	| "request_blocked"
	// Resend 同步与投递回执（Webhook 落库，见 resend.ts 的 mapResendEvent）。
	| "resend_sync_failed"
	| "email_delivered"
	| "email_bounced"
	| "email_complained"
	| "email_opened"
	| "email_clicked";

/** 事件的操作者。`reader` = 读者自助（邮件链接 / 前台表单），`admin` = 后台，`system` = 自动。 */
export type EventActor = "reader" | "admin" | "system";

export interface SubscriptionEvent {
	subscriberId: string;
	type: EventType;
	at: string;
	actor: EventActor;
	/** 退订 / 暂停原因等自由文本。 */
	reason?: string;
	/** 附加信息，如变更后的分组 `"daily,weekly"`。 */
	detail?: string;
}

export interface EventStore {
	put(id: string, data: SubscriptionEvent): Promise<void>;
	query(options?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: SubscriptionEvent }>; cursor?: string; hasMore: boolean }>;
}

export function eventStore(ctx: PluginContext): EventStore {
	return ctx.storage.events as unknown as EventStore;
}

export const newEventId = (): string => `evt_${crypto.randomUUID().replace(/-/g, "")}`;

/**
 * 追加一条事件。
 *
 * 事件日志是**旁路**：写失败不应连累主流程（订阅已经落库了），因此这里吞掉异常，
 * 由调用方决定是否关心。返回是否写入成功，供测试断言。
 */
export async function recordEvent(ctx: PluginContext, event: Omit<SubscriptionEvent, "at"> & { at?: string }): Promise<boolean> {
	try {
		const payload: SubscriptionEvent = { ...event, at: event.at ?? new Date().toISOString() };
		await eventStore(ctx).put(newEventId(), payload);
		return true;
	} catch {
		return false;
	}
}

/** 某个订阅者的事件时间线（新→旧）。 */
export async function listEvents(
	ctx: PluginContext,
	subscriberId: string,
	limit = 50,
): Promise<Array<{ id: string; data: SubscriptionEvent }>> {
	if (!subscriberId) return [];
	const result = await eventStore(ctx).query({
		where: { subscriberId },
		orderBy: { at: "desc" },
		limit: Math.min(Math.max(limit, 1), 200),
	});
	return result.items;
}
