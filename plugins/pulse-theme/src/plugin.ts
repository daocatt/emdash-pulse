/**
 * pulse-theme — Suda Pulse 前台主题切换（后台侧）。
 *
 * 职责：后台「前台主题」页用 Block Kit `radio` 选择要渲染的主题，写入**插件设置**
 * （options 表的 `plugin:pulse-theme:settings:theme`）。
 *
 * 消费方是宿主信任代码 `src/middleware.ts`：它用
 * `getPluginSetting("pulse-theme", "theme")` 读同一个键，再把干净路径 rewrite 到
 * `/_t/<theme>/…`。因此：
 * - 下面的 `THEMES` 名称必须与 `astro.config.mjs` 的 `THEME_NAMES` **完全一致**；
 * - 本插件不写内容、不发邮件、不访问网络，`capabilities` 为空。
 */

import type { PluginContext, SandboxedPlugin, SandboxedRouteContext } from "emdash/plugin";

/** 可选主题。名称必须与 `astro.config.mjs` 的 `THEME_NAMES` 一致。 */
const THEMES = [
	{ value: "news-factory", label: "报纸头版（news-factory）" },
	{ value: "pulse-news", label: "杂志式（pulse-news）" },
] as const;

/** 插件设置键。`src/middleware.ts` 读的是同一个键。 */
const SETTING_KEY = "theme";
const DEFAULT_THEME = "news-factory";

const THEME_VALUES: readonly string[] = THEMES.map((theme) => theme.value);

function isTheme(value: unknown): value is string {
	return typeof value === "string" && THEME_VALUES.includes(value);
}

/** 当前主题；未设置 / 值非法 / 读失败时回退默认（settingsSchema 默认值不会自动落库）。 */
async function currentTheme(ctx: PluginContext): Promise<string> {
	try {
		const value = await ctx.settings.get<string>(SETTING_KEY);
		return isTheme(value) ? value : DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

async function themeBlocks(ctx: PluginContext, notice?: string): Promise<Array<Record<string, unknown>>> {
	const current = await currentTheme(ctx);
	return [
		{ type: "header", text: "前台主题" },
		{
			type: "section",
			text: `当前主题：**${current}**。切换后**全站立即生效**，无需重新部署。`,
		},
		...(notice ? [{ type: "section", text: notice }] : []),
		{ type: "divider" },
		{
			// `radio` 是**元素**而非**块**：顶层 blocks[] 只接受块类型，元素必须包在
			// `actions`（或 `form`）里，否则宿主校验直接 502 INVALID_BLOCK_RESPONSE。
			// 选中即派发 `block_action`（见 blocks 的 RadioElementComponent）。
			type: "actions",
			elements: [
				{
					type: "radio",
					action_id: "theme-switch",
					label: "选择前台主题",
					options: THEMES.map((theme) => ({ label: theme.label, value: theme.value })),
					initial_value: current,
				},
			],
		},
	];
}

const plugin: SandboxedPlugin = {
	routes: {
		// ===== 后台「前台主题」页（Block Kit）=====

		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx: SandboxedRouteContext, ctx: PluginContext) => {
				const input = (routeCtx.input ?? {}) as {
					type?: string;
					action_id?: string;
					value?: unknown;
				};

				if (input.type === "block_action" && input.action_id === "theme-switch") {
					if (!isTheme(input.value)) {
						return {
							blocks: await themeBlocks(ctx, "⚠️ 收到未知主题，已忽略。"),
							toast: { type: "error", message: "未知主题" },
						};
					}

					await ctx.settings.set(SETTING_KEY, input.value);
					return {
						blocks: await themeBlocks(ctx, `已切换到 **${input.value}**。`),
						toast: { type: "success", message: `已切换到 ${input.value}` },
					};
				}

				return { blocks: await themeBlocks(ctx) };
			},
		},
	},
};

export default plugin;
