/**
 * pulse-ai — Suda Pulse 的 AI 接入层（插件侧）。
 *
 * 职责：
 * 1. **配置**：`admin.settingsSchema` 自动生成设置页（provider / Account ID / Gateway /
 *    模型 / API Key（加密）/ 超时 / 自定义端点）。
 * 2. **信任契约**：`network:request` + `allowedHosts`（`ctx.http` 的白名单）。
 * 3. **后台「AI 网关」页**：展示当前解析出的端点与配置来源，并提供一个「测试连接」
 *    按钮发一次真实补全 —— 免去为了验证网关通不通而去翻容器日志。
 *
 * 实际调用逻辑在 `./client.mjs`，由消费方（目前是 `pulse-review` 的评论审核）
 * 同进程引用 —— EmDash 没有跨插件 hook / 共享设置，本项目所有插件同进程运行，
 * 直接引用是最干净的复用方式。**打包约束见 `client.mjs` 文件头**（改前必读）。
 */

import type { PluginContext, SandboxedPlugin, SandboxedRouteContext } from "emdash/plugin";

import { aiComplete, buildAiRequest, isConfigured, readAiSettings, usesGateway } from "./client.mjs";

type Json = Record<string, unknown>;

const PROVIDER_LABEL: Record<string, string> = {
	"workers-ai": "Cloudflare Workers AI",
	openai: "OpenAI",
	anthropic: "Anthropic",
	"openai-compatible": "OpenAI 兼容（自建 / 第三方）",
};

const TEST_ACTION = "ai-test";

/** 读取本插件的 AI 配置（用 `ctx.settings`，不绕 `emdash` 主包）。 */
async function readSettings(ctx: PluginContext) {
	return readAiSettings((key) => ctx.settings.get(key));
}

function mask(key: string): string {
	return key === "" ? "（未设置）" : `已设置 ••••${key.slice(-4)}`;
}

async function pageBlocks(ctx: PluginContext, notice?: Json): Promise<Json[]> {
	const settings = await readSettings(ctx);
	const request = buildAiRequest(settings, { messages: [] });
	const configured = isConfigured(settings);

	const blocks: Json[] = [
		{ type: "header", text: "AI 网关" },
		{
			type: "section",
			text: "本插件把「用哪个模型、怎么调」收敛到一处，供评论审核等能力复用。模型可经 **Cloudflare AI Gateway** 统一入口，便于后续接入更多 provider。",
		},
		...(notice ? [notice] : []),
		{ type: "divider" },
		{
			type: "table",
			columns: [
				{ key: "item", label: "配置项" },
				{ key: "value", label: "当前值" },
			],
			rows: [
				{ item: "提供方", value: PROVIDER_LABEL[settings.provider] ?? settings.provider },
				{ item: "模型", value: settings.model },
				{ item: "Account ID", value: settings.accountId || "（未设置）" },
				{
					item: "AI Gateway",
					value: usesGateway(settings) ? `${settings.gatewayId}（已启用）` : "未启用（直连 provider）",
				},
				{ item: "端点", value: request ? request.url : "（未解析：缺 API Key / Account ID / Base URL）" },
				{ item: "API Key", value: mask(settings.apiKey) },
				{ item: "超时", value: `${settings.timeoutMs} ms` },
				{ item: "最大输出", value: `${settings.maxTokens} tokens` },
			],
			empty_text: "",
		},
		{
			type: "context",
			text: configured
				? "点「测试连接」会用上面的「自检提示词」发一次真实请求。"
				: "尚未配置完整：请在下方设置里填好 API Key（Workers AI 还需 Account ID）。",
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: TEST_ACTION,
					label: "测试连接",
					value: "test",
					...(configured ? {} : { style: "danger" }),
				},
			],
		},
	];

	return blocks;
}

/** 跑一次真实补全，把结果转成提示块（成功 / 失败都返回块，不抛错）。 */
async function runTest(ctx: PluginContext): Promise<{ block: Json; toast: Json }> {
	const settings = await readSettings(ctx);
	const prompt = (await ctx.settings.get<string>("testPrompt")) || "只回复两个字：正常";

	if (!ctx.http) {
		return {
			block: {
				type: "section",
				text: "⚠️ 无法发起请求：本插件没有 `network:request` 能力（或宿主未提供 `ctx.http`）。",
			},
			toast: { type: "error", message: "缺少 network:request 能力" },
		};
	}

	const result = await aiComplete(
		(url, init) => ctx.http!.fetch(url, init),
		{ messages: [{ role: "user", content: prompt }] },
		settings,
	);

	if (!result.ok) {
		return {
			block: {
				type: "section",
				text: `❌ 调用失败：**${result.error}**。检查 API Key / Account ID / 模型名，以及该主机是否在插件的 allowedHosts 白名单里。`,
			},
			toast: { type: "error", message: `调用失败：${result.error}` },
		};
	}

	const text = result.text.trim().slice(0, 500) || "（空响应）";
	return {
		block: {
			type: "section",
			text: `✅ 调用成功（${result.latencyMs} ms，${settings.model}）：\n\n> ${text.replace(/\n/g, "\n> ")}`,
		},
		toast: { type: "success", message: `调用成功（${result.latencyMs} ms）` },
	};
}

const plugin: SandboxedPlugin = {
	routes: {
		// ===== 后台「AI 网关」页（Block Kit）=====
		//
		// 路由名固定为 `admin`：宿主按 manifest 的 `admin.pages[].path` 派发到这里。
		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx: SandboxedRouteContext, ctx: PluginContext) => {
				const input = (routeCtx.input ?? {}) as { type?: string; action_id?: string };

				if (input.type === "block_action" && input.action_id === TEST_ACTION) {
					const { block, toast } = await runTest(ctx);
					return { blocks: await pageBlocks(ctx, block), toast };
				}

				return { blocks: await pageBlocks(ctx) };
			},
		},
	},
};

export default plugin;
