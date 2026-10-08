/**
 * Editor 申请表：插件存储 `applications` 的读写封装。
 *
 * 语义：**用户级**申请（不是 agent 级）。一个 EmDash 用户最多一条申请
 * （`uniqueIndexes: ["userId"]`）。批准只改申请状态；真正的 `role → Editor(40)`
 * 由管理员在后台 Users 页完成 —— 插件没有 user 写能力。
 */

import type { PluginContext } from "emdash/plugin";

export type ApplicationStatus = "pending" | "approved" | "rejected";

export interface ApplicationRecord {
	/** 申请人的 EmDash 用户 id（来自宿主解析的 `routeCtx.user`，不可伪造）。 */
	userId: string;
	email: string;
	name?: string;
	organization?: string;
	/** 申请用途（必填）。 */
	purpose: string;
	agentName?: string;
	links?: string;
	contact?: string;
	status: ApplicationStatus;
	submittedAt: string;
	updatedAt: string;
	decidedAt?: string;
	decidedBy?: string;
	note?: string;
}

export interface ApplicationQueryOptions {
	where?: Record<string, unknown>;
	orderBy?: Record<string, "asc" | "desc">;
	limit?: number;
	cursor?: string;
}

export interface ApplicationQueryResult {
	items: Array<{ id: string; data: ApplicationRecord }>;
	cursor?: string;
	hasMore: boolean;
}

/** 插件存储集合的最小可用接口（避免依赖 EmDash 内部类型）。 */
export interface ApplicationStore {
	get(id: string): Promise<ApplicationRecord | null>;
	put(id: string, data: ApplicationRecord): Promise<void>;
	exists(id: string): Promise<boolean>;
	query(options?: ApplicationQueryOptions): Promise<ApplicationQueryResult>;
}

export function applicationStore(ctx: PluginContext): ApplicationStore {
	return ctx.storage.applications as unknown as ApplicationStore;
}

export const newApplicationId = (): string => `ea_${crypto.randomUUID().replace(/-/g, "")}`;

/** 按用户 id 取申请（唯一索引保证最多一条）。 */
export async function findByUserId(
	ctx: PluginContext,
	userId: string,
): Promise<{ id: string; data: ApplicationRecord } | null> {
	const result = await applicationStore(ctx).query({ where: { userId }, limit: 1 });
	return result.items[0] ?? null;
}
