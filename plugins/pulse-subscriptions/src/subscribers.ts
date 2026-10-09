/**
 * 订阅者注册表：插件存储 `subscribers` 的读写封装。
 *
 * 记录以规范化邮箱的 SHA-256（`emailHash`，唯一索引）去重；
 * 状态机：`pending`（待确认）→ `confirmed`（已确认）→ `unsubscribed`（已退订），
 * 以及只能由后台进出的 `paused`（暂停投递，记录保留）。
 * 确认 / 退订 token 只存哈希（`tokenHash`），随状态流转轮换。
 *
 * `groups` 是分组 slug 列表（见 `groups.ts`）；空数组 = 主刊订阅者。
 * `cadence` 是投递节奏（每周 / 每月，见 `digest.ts`）；缺省用插件设置 `defaultCadence`。
 */

import type { PluginContext } from "emdash/plugin";

export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed" | "paused";

/** 投递节奏：只支持每周 / 每月（不做每天）。 */
export type Cadence = "weekly" | "monthly";

export const CADENCE_VALUES: readonly Cadence[] = ["weekly", "monthly"];

export const CADENCE_LABELS: Record<Cadence, string> = {
	weekly: "每周",
	monthly: "每月",
};

export function isCadence(value: unknown): value is Cadence {
	return value === "weekly" || value === "monthly";
}

/** 可以「暂停」的状态——退订是终态，不再暂停。 */
export type PausableStatus = "pending" | "confirmed";

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
	/** 订阅分组 slug 列表；空数组 / 缺省 = 主刊订阅者。 */
	groups?: string[];
	/** 投递节奏；缺省 = 插件设置 `defaultCadence`（默认 weekly）。 */
	cadence?: Cadence;
	createdAt: string;
	/** 最近一次提交订阅的时间。 */
	requestedAt: string;
	confirmedAt?: string;
	unsubscribedAt?: string;
	/** 退订原因（读者在管理页选填）。 */
	unsubscribeReason?: string;
	/** 后台暂停的时间 / 操作者 / 原因。 */
	pausedAt?: string;
	pausedBy?: string;
	pauseReason?: string;
	/** 暂停前的状态，恢复时还原（暂停只允许从 pending / confirmed 进入）。 */
	pausedFrom?: PausableStatus;
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
	delete(id: string): Promise<boolean>;
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

/**
 * 一次最多扫描的记录数。
 *
 * 「按分组筛选」是数组字段，插件存储建不了索引，因此后台列表走内存筛选 ——
 * 需要先把记录读回来。这个上限既是护栏（防止一次拉爆沙箱），也是 UI 上要
 * 显式告知用户的截断点（超过时提示收窄筛选，而不是静默少几行）。
 */
export const MAX_SCAN = 1000;

const SCAN_PAGE = 200;

export interface SubscriberScan {
	items: Array<{ id: string; data: SubscriberRecord }>;
	/** 是否因为触到 MAX_SCAN 而被截断。 */
	truncated: boolean;
}

/**
 * 按 `createdAt` 倒序扫描订阅者（内部翻页直到 `max` 或取完）。
 *
 * 只在需要「索引做不到的过滤 / 排序」（按分组、按邮箱模糊匹配、自定义排序）时使用；
 * 纯按 `status` 过滤仍可直接用 `query({ where: { status } })`。
 */
export async function scanSubscribers(ctx: PluginContext, max = MAX_SCAN): Promise<SubscriberScan> {
	const store = subscriberStore(ctx);
	const items: Array<{ id: string; data: SubscriberRecord }> = [];
	let cursor: string | undefined;

	while (items.length < max) {
		const remaining = max - items.length;
		const page = await store.query({
			orderBy: { createdAt: "desc" },
			limit: Math.min(SCAN_PAGE, remaining),
			...(cursor ? { cursor } : {}),
		});
		items.push(...page.items);
		if (!page.hasMore || !page.cursor) return { items, truncated: false };
		cursor = page.cursor;
	}

	return { items, truncated: true };
}

/** 记录上的节奏；未设置 / 非法时回退到 `fallback`（来自插件设置）。 */
export function cadenceOf(record: SubscriberRecord, fallback: Cadence): Cadence {
	return isCadence(record.cadence) ? record.cadence : fallback;
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
