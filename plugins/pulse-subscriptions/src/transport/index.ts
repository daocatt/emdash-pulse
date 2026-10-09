/**
 * 邮件投递 transport 抽象层。
 *
 * 订阅主流程（分组同步、群发、Webhook 回执）只依赖本文件的 `BroadcastTransport`
 * 接口，**不直接依赖任何具体邮件服务**。当前只有 Resend 一个实现
 * （`./resend.ts`）；以后接 Rilay 或其它服务时，只需：
 *
 *   1. 新增 `./<provider>.ts`，实现 `BroadcastTransport`；
 *   2. 在 `TRANSPORT_LABELS` 加一项、在 `resolveTransport()` 的 switch 里登记；
 *   3. manifest 的 `broadcastProvider` 选项里加一项，并把该服务的 host 加进
 *      `allowedHosts`。
 *
 * ## 约定（所有实现都要遵守）
 *
 * - **不抛错**：失败一律返回 `{ ok:false, error }`，由调用方降级。订阅是主流程，
 *   transport 是旁路 —— 绝不能因为邮件服务抖动而让订阅失败。
 * - **受众 id 是不透明字符串**：调用方只负责缓存与回传，不理解其含义
 *   （Resend 是 segment id，别的服务可能是 list / audience id）。
 */

import type { PluginContext } from "emdash/plugin";

import { createResendTransport } from "./resend";

export type TransportId = "resend";

export const TRANSPORT_LABELS: Record<TransportId, string> = {
	resend: "Resend",
};

export const DEFAULT_TRANSPORT: TransportId = "resend";

export function isTransportId(value: unknown): value is TransportId {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(TRANSPORT_LABELS, value);
}

/** 远端受众（Resend segment / 其它服务的 list）。 */
export interface TransportAudience {
	id: string;
	name: string;
}

export type TransportResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface TransportContactInput {
	email: string;
	/** `true` = 标记为已退订（服务侧据此跳过群发）。 */
	unsubscribed: boolean;
	/** 目标受众 id 列表（**整体覆盖**，不是增量）。 */
	audienceIds: string[];
}

export interface TransportBroadcastInput {
	/** 目标受众 id（来自 `ensureAudience`）。 */
	audienceId: string;
	subject: string;
	html?: string;
	text?: string;
	replyTo?: string;
	/** 内部备注名（服务侧列表里显示）。 */
	name?: string;
}

/** 归一化后的入站 Webhook 事件。 */
export interface TransportEvent {
	/** 服务原样的事件类型（如 `email.delivered`）。 */
	type: string;
	/** 收件人邮箱。 */
	email: string;
	broadcastId?: string;
	/** 退信 / 失败原因等。 */
	reason?: string;
}

/**
 * Webhook 验签结果。
 *
 * 三态而非布尔：`disabled`（未配置签名密钥，路由返回 503）与 `invalid`（验签失败，
 * 返回 401）对运营的排查含义完全不同 —— 前者是「还没配」，后者是「有人在伪造」。
 */
export type WebhookVerdict = "ok" | "invalid" | "disabled";

export interface BroadcastTransport {
	readonly id: TransportId;
	readonly label: string;
	/** 凭证是否齐全（未配置时调用方降级）。 */
	isConfigured(): Promise<boolean>;
	/** 发件地址（展示用，可能为空串）。 */
	fromAddress(): Promise<string>;
	/** 按名字找到或创建受众（幂等）。 */
	ensureAudience(name: string): Promise<TransportResult<TransportAudience>>;
	/** 建 / 改联系人并**覆盖**其受众归属。 */
	syncContact(input: TransportContactInput): Promise<TransportResult<void>>;
	/** 创建并**立即发送**一次群发，返回服务端 id。 */
	send(input: TransportBroadcastInput): Promise<TransportResult<{ id: string }>>;
	/** 校验入站 Webhook 签名。 */
	verifyWebhook(input: { payload: string; headers: Record<string, string> }): Promise<WebhookVerdict>;
	/** 把入站 Webhook 载荷映射成归一化事件（无法识别返回 null）。 */
	mapWebhookEvent(payload: unknown): TransportEvent | null;
}

/** 便利再导出：`ctx.http` → `Fetcher` 适配（实现见 `./http.ts`）。 */
export { httpFetcher } from "./http";

/**
 * 解析当前生效的 transport。
 *
 * 读本插件的 `broadcastProvider` 设置（缺省 / 非法值回退 `resend`）。返回 null 表示
 * 该 provider 尚无实现 —— 调用方据此降级，不会抛错。
 */
export async function resolveTransport(ctx: PluginContext): Promise<BroadcastTransport | null> {
	let provider: unknown;
	try {
		provider = await ctx.settings.get("broadcastProvider");
	} catch {
		provider = undefined;
	}
	const id: TransportId = isTransportId(provider) ? provider : DEFAULT_TRANSPORT;

	switch (id) {
		case "resend":
			return createResendTransport(ctx);
		default:
			return null;
	}
}
