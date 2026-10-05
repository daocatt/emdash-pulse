import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import {
	DEFAULT_SETTINGS,
	decide,
	type CommentInput,
	type CollectionSettingsInput,
	type ModerationSettings,
} from "./moderation";

/**
 * pulse-review — Suda Pulse 编审策略。
 *
 * 1. 发布门禁：只有 review_status === "approved" 的文章才允许发布/定时发布。
 *    该策略对所有来源生效（Admin UI、REST、MCP、视觉编辑、插件、定时任务）。
 * 2. 评论审核：注册**独占** `comment:moderate`，替换内置审核器 ——
 *    规则引擎（链接/黑名单/重复/引流）+ 可选 Workers AI（Llama Guard）。
 */

const ARTICLES = "articles";
const APPROVED = "approved";

function reviewStatusOf(content: unknown): unknown {
	if (!content || typeof content !== "object") return undefined;
	const data = (content as { data?: unknown }).data;
	if (!data || typeof data !== "object") return undefined;
	return (data as Record<string, unknown>).review_status;
}

const REJECT_REASON = "稿件需经编辑审核通过（review_status=approved）后方可发布。";

// ---------- 设置读取 ----------

function str(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

async function readSettings(ctx: PluginContext): Promise<ModerationSettings> {
	const get = async (key: string): Promise<unknown> => {
		try {
			return await ctx.settings.get(key);
		} catch {
			return null;
		}
	};
	const [rulesEnabled, bannedWords, maxLinks, maxLength, minLength, aiEnabled, aiAutoApprove, aiAccountId, aiApiToken, aiModel, aiTimeoutMs] =
		await Promise.all([
			get("rulesEnabled"),
			get("bannedWords"),
			get("maxLinks"),
			get("maxLength"),
			get("minLength"),
			get("aiEnabled"),
			get("aiAutoApprove"),
			get("aiAccountId"),
			get("aiApiToken"),
			get("aiModel"),
			get("aiTimeoutMs"),
		]);

	return {
		rulesEnabled: bool(rulesEnabled, DEFAULT_SETTINGS.rulesEnabled),
		bannedWords:
			typeof bannedWords === "string"
				? bannedWords
						.split(/[,\n，、]/)
						.map((w) => w.trim())
						.filter(Boolean)
				: DEFAULT_SETTINGS.bannedWords,
		maxLinks: num(maxLinks, DEFAULT_SETTINGS.maxLinks),
		maxLength: num(maxLength, DEFAULT_SETTINGS.maxLength),
		minLength: num(minLength, DEFAULT_SETTINGS.minLength),
		aiEnabled: bool(aiEnabled, DEFAULT_SETTINGS.aiEnabled),
		aiAutoApprove: bool(aiAutoApprove, DEFAULT_SETTINGS.aiAutoApprove),
		aiAccountId: str(aiAccountId, DEFAULT_SETTINGS.aiAccountId),
		aiApiToken: str(aiApiToken, DEFAULT_SETTINGS.aiApiToken),
		aiModel: str(aiModel, DEFAULT_SETTINGS.aiModel),
		aiTimeoutMs: num(aiTimeoutMs, DEFAULT_SETTINGS.aiTimeoutMs),
	};
}

const plugin: SandboxedPlugin = {
	hooks: {
		"content:beforePublish": async (event) => {
			if (event.collection !== ARTICLES) return;
			if (reviewStatusOf(event.content) !== APPROVED) {
				return { cancel: true, reason: REJECT_REASON };
			}
		},
		"content:beforeSchedule": async (event) => {
			if (event.collection !== ARTICLES) return;
			if (reviewStatusOf(event.content) !== APPROVED) {
				return { cancel: true, reason: "定时发布前需先审核通过（review_status=approved）。" };
			}
		},

		"comment:moderate": {
			// 独占：注册后替换内置审核器（故必须复刻内置逻辑，见 moderation.ts）。
			exclusive: true,
			// 需覆盖内部 AI 超时（默认 3s）+ 余量。
			timeout: 10_000,
			handler: async (event, ctx) => {
				const settings = await readSettings(ctx);
				const comment: CommentInput = {
					body: String(event.comment.body ?? ""),
					authorName: String(event.comment.authorName ?? ""),
					authorEmail: String(event.comment.authorEmail ?? ""),
					authorUserId: event.comment.authorUserId ?? null,
				};
				const collectionSettings: CollectionSettingsInput = {
					commentsModeration: event.collectionSettings.commentsModeration,
					commentsAutoApproveUsers: event.collectionSettings.commentsAutoApproveUsers,
				};

				const fetcher = ctx.http
					? (url: string, init?: RequestInit) => ctx.http!.fetch(url, init)
					: () => Promise.reject(new Error("network:request not available"));

				const decision = await decide({
					comment,
					collectionSettings,
					priorApprovedCount: event.priorApprovedCount ?? 0,
					settings,
					fetcher,
				});

				ctx.log.info("comment moderated", {
					status: decision.status,
					reason: decision.reason,
				});
				return decision;
			},
		},
	},
};

export default plugin;
