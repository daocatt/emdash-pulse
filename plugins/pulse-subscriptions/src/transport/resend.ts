/**
 * Resend transport —— `BroadcastTransport` 的第一个实现。
 *
 * 把 `../resend.ts`（REST 客户端 + Svix 验签 + 事件映射）适配成 provider 无关的
 * 语义接口，并在此封装两件 Resend 特有的事：
 *
 * - **凭证来源**：API key / From 复用「Resend」插件（`emdash-resend`）的后台设置，
 *   本插件不重复配置（见 `../resend.ts` 头部说明）。
 * - **Webhook 密钥来源**：Svix 签名密钥读本插件的 `resendWebhookSecret` 设置。
 *
 * 新增其它 provider 时照抄本文件的形状即可 —— 接口见 `./index.ts`。
 */

import type { PluginContext } from "emdash/plugin";

import {
	createBroadcast,
	ensureSegment,
	loadResendConfig,
	mapResendEvent,
	upsertContact,
	verifyResendSignature,
	type Fetcher,
	type ResendConfig,
} from "../resend";
import { httpFetcher } from "./http";
import type {
	BroadcastTransport,
	TransportAudience,
	TransportBroadcastInput,
	TransportContactInput,
	TransportEvent,
	TransportResult,
	WebhookVerdict,
} from "./index";

/** 本插件设置里的 Webhook 签名密钥（`whsec_…`；留空 = 未启用）。 */
async function readWebhookSecret(ctx: PluginContext): Promise<string> {
	try {
		const value = await ctx.settings.get("resendWebhookSecret");
		return typeof value === "string" ? value : "";
	} catch {
		return "";
	}
}

export function createResendTransport(ctx: PluginContext): BroadcastTransport {
	/** 取「已配置的凭证 + 可用的 fetcher」；缺任一项返回 null。 */
	async function ready(): Promise<{ config: ResendConfig; fetcher: Fetcher } | null> {
		const fetcher = httpFetcher(ctx);
		if (!fetcher) return null;
		const config = await loadResendConfig();
		if (!config) return null;
		return { config, fetcher };
	}

	return {
		id: "resend",
		label: "Resend",

		async isConfigured(): Promise<boolean> {
			return (await loadResendConfig()) !== null;
		},

		async fromAddress(): Promise<string> {
			return (await loadResendConfig())?.fromAddress ?? "";
		},

		async ensureAudience(name: string): Promise<TransportResult<TransportAudience>> {
			const ctxReady = await ready();
			if (!ctxReady) return { ok: false, error: "resend_not_configured" };
			const result = await ensureSegment(ctxReady.fetcher, ctxReady.config, name);
			if (!result.ok) return { ok: false, error: result.error };
			return { ok: true, data: { id: result.data.id, name } };
		},

		async syncContact(input: TransportContactInput): Promise<TransportResult<void>> {
			const ctxReady = await ready();
			if (!ctxReady) return { ok: false, error: "resend_not_configured" };
			const result = await upsertContact(ctxReady.fetcher, ctxReady.config, {
				email: input.email,
				unsubscribed: input.unsubscribed,
				segmentIds: input.audienceIds,
			});
			return result.ok ? { ok: true, data: undefined } : { ok: false, error: result.error };
		},

		async send(input: TransportBroadcastInput): Promise<TransportResult<{ id: string }>> {
			const ctxReady = await ready();
			if (!ctxReady) return { ok: false, error: "resend_not_configured" };
			if (ctxReady.config.fromAddress === "") return { ok: false, error: "resend_from_address_missing" };

			const result = await createBroadcast(ctxReady.fetcher, ctxReady.config, {
				segmentId: input.audienceId,
				subject: input.subject,
				...(input.html ? { html: input.html } : {}),
				...(input.text ? { text: input.text } : {}),
				...(input.name ? { name: input.name } : {}),
				...(input.replyTo ? { replyTo: input.replyTo } : {}),
				send: true,
			});
			return result.ok ? { ok: true, data: { id: result.data.id } } : { ok: false, error: result.error };
		},

		async verifyWebhook({
			payload,
			headers,
		}: {
			payload: string;
			headers: Record<string, string>;
		}): Promise<WebhookVerdict> {
			const secret = await readWebhookSecret(ctx);
			if (secret === "") return "disabled";
			const verified = await verifyResendSignature({
				payload,
				headers: {
					id: headers["svix-id"] ?? "",
					timestamp: headers["svix-timestamp"] ?? "",
					signature: headers["svix-signature"] ?? "",
				},
				secret,
			});
			return verified ? "ok" : "invalid";
		},

		mapWebhookEvent(payload: unknown): TransportEvent | null {
			return mapResendEvent(payload);
		},
	};
}
