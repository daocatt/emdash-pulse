/**
 * 订阅者注册表：插件存储 `subscribers` 的读写封装。
 *
 * 记录以规范化邮箱的 SHA-256（`emailHash`，唯一索引）去重；
 * 状态机：`pending`（待确认）→ `confirmed`（已确认）→ `unsubscribed`（已退订）。
 * 确认 / 退订 token 只存哈希（`tokenHash`），随状态流转轮换。
 */

import type { PluginContext } from "emdash/plugin";

export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed";

/** 当前 token 的用途：确认（pending → confirmed）或退订（confirmed → unsubscribed）。 */
export type TokenPurpose = "confirm" | "unsubscribe";

/** 邮件 provider 缺失（或投递失败）时，落库待发的邮件快照。 */
export interface PendingEmail {
	to: string;
	subject: string;
	text: string;
	html?: string;
	reason: string;
	at: string;
}

export interface SubscriberRecord {
	email: string;
	emailHash: string;
	status: SubscriberStatus;
	/** 当前有效 token 的 SHA-256（明文仅在邮件链接中）。 */
	tokenHash?: string;
	tokenPrefix?: string;
	tokenPurpose?: TokenPurpose;
	/** 订阅来源（前台表单 / agent 等）。 */
	source?: string;
	createdAt: string;
	/** 最近一次提交订阅的时间。 */
	requestedAt: string;
	confirmedAt?: string;
	unsubscribedAt?: string;
	/** 最近一次尝试投递的时间。 */
	lastSentAt?: string;
	/** 最近一次投递是否成功。 */
	emailDelivered: boolean;
	/** 投递未成功时保留的待发邮件。 */
	pendingEmail?: PendingEmail;
}

export interface SubscriberQueryOptions {
	where?: Record<string, unknown>;
	orderBy?: Record<string, "asc" | "desc">;
	limit?: number;
	cursor?: string;
}

export interface SubscriberQueryResult {
	items: Array<{ id: string; data: SubscriberRecord }>;
	cursor?: string;
	hasMore: boolean;
}

/** 插件存储集合的最小可用接口（避免依赖 EmDash 内部类型）。 */
export interface SubscriberStore {
	get(id: string): Promise<SubscriberRecord | null>;
	put(id: string, data: SubscriberRecord): Promise<void>;
	exists(id: string): Promise<boolean>;
	query(options?: SubscriberQueryOptions): Promise<SubscriberQueryResult>;
	count(where?: Record<string, unknown>): Promise<number>;
}

export function subscriberStore(ctx: PluginContext): SubscriberStore {
	return ctx.storage.subscribers as unknown as SubscriberStore;
}

export const newSubscriberId = (): string => `sub_${crypto.randomUUID().replace(/-/g, "")}`;

export async function findSubscriberByEmailHash(
	ctx: PluginContext,
	emailHash: string,
): Promise<{ id: string; data: SubscriberRecord } | null> {
	const result = await subscriberStore(ctx).query({ where: { emailHash }, limit: 1 });
	return result.items[0] ?? null;
}

export async function findSubscriberByTokenHash(
	ctx: PluginContext,
	tokenHash: string,
): Promise<{ id: string; data: SubscriberRecord } | null> {
	if (!tokenHash) return null;
	const result = await subscriberStore(ctx).query({ where: { tokenHash }, limit: 1 });
	return result.items[0] ?? null;
}

/** 邮箱脱敏（列表展示用）。 */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf("@");
	if (at <= 0) return "***";
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	const head = local.slice(0, 1);
	return `${head}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}
