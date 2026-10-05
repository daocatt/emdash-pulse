/**
 * Agent 注册表：插件存储 `agents` 的读写封装。
 *
 * 身份模型：agent 自助注册 → 管理员审批 → 插件签发 token（只存哈希）。
 * 沙箱插件的存储按插件隔离，因此**身份必须与使用它的路由同处一个插件**。
 */

import type { PluginContext } from "emdash/plugin";

import { hashSecret } from "./token";

export type AgentStatus = "pending" | "approved" | "rejected" | "revoked";

/** agent 默认可用能力（审批时可覆盖）。 */
export const DEFAULT_AGENT_SCOPES = ["submit", "claim", "subscribe"] as const;

export interface AgentRecord {
	slug: string;
	name: string;
	description?: string;
	contact?: string;
	status: AgentStatus;
	scopes: string[];
	tokenHash?: string;
	tokenPrefix?: string;
	registrationSecretHash: string;
	requestedAt: string;
	decidedAt?: string;
	decidedBy?: string;
}

export interface AgentQueryOptions {
	where?: Record<string, unknown>;
	orderBy?: Record<string, "asc" | "desc">;
	limit?: number;
	cursor?: string;
}

export interface AgentQueryResult {
	items: Array<{ id: string; data: AgentRecord }>;
	cursor?: string;
	hasMore: boolean;
}

/** 插件存储集合的最小可用接口（避免依赖 EmDash 内部类型）。 */
export interface AgentStore {
	get(id: string): Promise<AgentRecord | null>;
	put(id: string, data: AgentRecord): Promise<void>;
	exists(id: string): Promise<boolean>;
	query(options?: AgentQueryOptions): Promise<AgentQueryResult>;
	count(where?: Record<string, unknown>): Promise<number>;
}

export function agentStore(ctx: PluginContext): AgentStore {
	return ctx.storage.agents as unknown as AgentStore;
}

export const newAgentId = (): string => `ag_${crypto.randomUUID().replace(/-/g, "")}`;

export async function findAgentBySlug(ctx: PluginContext, slug: string): Promise<{ id: string; data: AgentRecord } | null> {
	const result = await agentStore(ctx).query({ where: { slug }, limit: 1 });
	return result.items[0] ?? null;
}

export async function findAgentByTokenHash(
	ctx: PluginContext,
	tokenHash: string,
): Promise<{ id: string; data: AgentRecord } | null> {
	const result = await agentStore(ctx).query({ where: { tokenHash }, limit: 1 });
	return result.items[0] ?? null;
}

export async function findAgentByRegistrationHash(
	ctx: PluginContext,
	registrationSecretHash: string,
): Promise<{ id: string; data: AgentRecord } | null> {
	const result = await agentStore(ctx).query({ where: { registrationSecretHash }, limit: 1 });
	return result.items[0] ?? null;
}

/** 校验 agent 身份（用于公开路由的 `x-agent-token` 头）。 */
export async function authenticateAgent(
	ctx: PluginContext,
	token: string | undefined,
): Promise<AgentRecord | null> {
	if (!token) return null;
	const tokenHash = await hashSecret(token);
	const found = await findAgentByTokenHash(ctx, tokenHash);
	if (!found) return null;
	if (found.data.status !== "approved") return null;
	return found.data;
}
