/**
 * 评论审核策略：规则引擎 + AI（经 pulse-ai）。
 *
 * 背景：`comment:moderate` 是**独占** hook，插件注册后**替换**内置审核器
 * （`emdash-default-comment-moderator`）。因此这里必须**复刻内置逻辑**
 * （见 `baselineDecision`），否则 CMS 用户自动通过 / moderation=none 等行为会丢失。
 *
 * 决策顺序：
 *   1. 规则引擎命中 spam → 直接 spam（不再调用 AI，省成本）
 *   2. AI 启用且已配置 → 调用模型（provider / AI Gateway / 模型 / 密钥来自 pulse-ai）
 *        - unsafe → spam
 *        - safe 且开启 aiAutoApprove → approved
 *        - 调用失败/超时 → 不改变结论（fail-safe：绝不因故障而自动通过）
 *   3. 否则回落到内置逻辑（approved / pending）
 *
 * AI 连接（provider / Account ID / Gateway / 模型 / API Key）统一由 `pulse-ai` 插件配置，
 * 这里通过 `pulse-ai/client` 同进程调用；本文件只保留「审核严格度」相关设置。
 */

import { aiComplete, parseGuardVerdict, type AiProvider, type AiSettings } from "pulse-ai/client";

export type ModerationStatus = "approved" | "pending" | "spam";

export interface ModerationDecision {
	status: ModerationStatus;
	reason: string;
}

export interface ModerationSettings {
	/** 规则引擎总开关。关掉后退化为内置行为（+ AI）。 */
	rulesEnabled: boolean;
	/** 命中即判 spam 的词（小写比较，子串匹配）。 */
	bannedWords: string[];
	/** 正文中允许的最大链接数。 */
	maxLinks: number;
	/** 正文最大字符数。 */
	maxLength: number;
	/** 正文最小字符数。 */
	minLength: number;
	/** 是否启用 AI 审核。 */
	aiEnabled: boolean;
	/** AI 判定 safe 时是否直接通过（默认 false = 仅作建议）。 */
	aiAutoApprove: boolean;
	/** AI 提供方（来自 pulse-ai）。 */
	aiProvider: AiProvider;
	aiAccountId: string;
	/** AI Gateway 名称（来自 pulse-ai；为空则直连 provider）。 */
	aiGatewayId: string;
	/** 自定义端点覆盖（自建 / 第三方 OpenAI 兼容网关；来自 pulse-ai）。 */
	aiBaseUrl: string;
	aiApiToken: string;
	aiModel: string;
	aiTimeoutMs: number;
}

export const DEFAULT_SETTINGS: ModerationSettings = {
	rulesEnabled: true,
	bannedWords: [],
	maxLinks: 3,
	maxLength: 2000,
	minLength: 2,
	aiEnabled: false,
	aiAutoApprove: false,
	aiProvider: "workers-ai",
	aiAccountId: "",
	aiGatewayId: "",
	aiBaseUrl: "",
	aiApiToken: "",
	aiModel: "@cf/meta/llama-guard-3-8b",
	aiTimeoutMs: 3000,
};

export interface CommentInput {
	body: string;
	authorName: string;
	authorEmail: string;
	authorUserId: string | null;
}

export interface CollectionSettingsInput {
	commentsModeration: "all" | "first_time" | "none";
	commentsAutoApproveUsers: boolean;
}

// ---------- 规则引擎 ----------

interface RuleHit {
	code: string;
	status: "pending" | "spam";
	detail: string;
}

const URL_PATTERN = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/gi;
const CONTACT_PATTERN =
	/(?:\+?\d[\d\s-]{7,}\d)|(?:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})|(?:微信|wechat|qq|telegram|whatsapp|加我|私聊|联系我)\s*[:：]?\s*[a-z0-9_-]{3,}/gi;
const REPEAT_PATTERN = /(.)\1{14,}/;
const HTML_PATTERN = /<\s*(a|script|iframe|img|div|span)\b/i;

/** 纯函数：对单条评论跑规则，返回命中项。 */
export function runRules(comment: CommentInput, settings: ModerationSettings): RuleHit[] {
	const hits: RuleHit[] = [];
	if (!settings.rulesEnabled) return hits;

	const body = comment.body ?? "";
	const trimmed = body.trim();

	if (trimmed.length < settings.minLength) {
		hits.push({ code: "too_short", status: "spam", detail: `正文过短（${trimmed.length} 字符）` });
	}
	if (trimmed.length > settings.maxLength) {
		hits.push({ code: "too_long", status: "pending", detail: `正文过长（${trimmed.length} 字符）` });
	}

	const links = trimmed.match(URL_PATTERN) ?? [];
	if (links.length > settings.maxLinks) {
		hits.push({ code: "link_flood", status: "spam", detail: `链接过多（${links.length} 个）` });
	}

	const lower = trimmed.toLowerCase();
	const banned = settings.bannedWords
		.map((w) => w.trim().toLowerCase())
		.filter((w) => w.length > 0)
		.filter((w) => lower.includes(w));
	if (banned.length > 0) {
		hits.push({ code: "banned_word", status: "spam", detail: `命中黑名单词：${banned.join(", ")}` });
	}

	if (CONTACT_PATTERN.test(trimmed)) {
		CONTACT_PATTERN.lastIndex = 0;
		hits.push({ code: "contact_spam", status: "pending", detail: "含疑似联系方式或引流话术" });
	} else {
		CONTACT_PATTERN.lastIndex = 0;
	}

	if (REPEAT_PATTERN.test(trimmed)) {
		hits.push({ code: "repeat_chars", status: "pending", detail: "含大量重复字符" });
	}

	if (HTML_PATTERN.test(trimmed)) {
		hits.push({ code: "raw_html", status: "spam", detail: "正文含原始 HTML 标签" });
	}

	if (URL_PATTERN.test(comment.authorName ?? "")) {
		URL_PATTERN.lastIndex = 0;
		hits.push({ code: "name_is_url", status: "spam", detail: "昵称含链接" });
	} else {
		URL_PATTERN.lastIndex = 0;
	}

	return hits;
}

/** 规则命中 → 结论（spam 优先于 pending）。 */
export function rulesDecision(hits: RuleHit[]): ModerationDecision | null {
	if (hits.length === 0) return null;
	const spam = hits.find((h) => h.status === "spam");
	if (spam) return { status: "spam", reason: `规则：${spam.detail}` };
	const pending = hits[0];
	return { status: "pending", reason: `规则：${pending.detail}` };
}

// ---------- 内置逻辑复刻 ----------

/**
 * 复刻 `emdash-default-comment-moderator` 的四步决策。
 * 注册独占 hook 会替换内置审核器，所以必须自己实现。
 */
export function baselineDecision(
	comment: CommentInput,
	collectionSettings: CollectionSettingsInput,
	priorApprovedCount: number,
): ModerationDecision {
	if (collectionSettings.commentsAutoApproveUsers && comment.authorUserId) {
		return { status: "approved", reason: "已登录站点用户（自动通过）" };
	}
	if (collectionSettings.commentsModeration === "none") {
		return { status: "approved", reason: "该集合未开启评论审核" };
	}
	if (collectionSettings.commentsModeration === "first_time" && priorApprovedCount > 0) {
		return { status: "approved", reason: "老读者（曾通过审核）" };
	}
	return { status: "pending", reason: "待编辑审核" };
}

// ---------- AI（经 pulse-ai：provider / AI Gateway 无关）----------

export interface AiResult {
	ok: boolean;
	unsafe?: boolean;
	/** 命中的安全类别（Llama Guard 返回，如 S1、S6）。 */
	categories?: string[];
	error?: string;
}

/** 解析审核模型输出的判定（`safe` / `unsafe\nS1,S2`）。 */
export function parseVerdict(text: string): AiResult {
	const verdict = parseGuardVerdict(text);
	// 输出不是 safe / unsafe 时视为**未判定**（`ok:false`），而不是当成 unsafe ——
	// 否则模型换了措辞就会把正常评论全判成 spam。
	if (verdict.unsafe === null) return { ok: false, error: "unexpected_response" };
	return { ok: true, unsafe: verdict.unsafe, categories: verdict.categories };
}

/** 调用审核模型。任何异常都返回 `{ ok:false }`，由调用方降级。 */
export async function classifyWithAi(
	fetcher: (url: string, init?: RequestInit) => Promise<Response>,
	comment: CommentInput,
	settings: ModerationSettings,
): Promise<AiResult> {
	if (!settings.aiEnabled) return { ok: false, error: "disabled" };

	const prompt = [
		"请判断以下网站评论是否属于需要拦截的有害内容（辱骂、骚扰、仇恨、色情、暴力、垃圾广告、诈骗）。",
		"只输出 safe 或 unsafe，不要解释。",
		"",
		`昵称：${comment.authorName}`,
		`内容：${comment.body}`,
	].join("\n");

	// 连接参数整体来自 pulse-ai 插件（见 plugin.ts 的 readSettings）。
	const ai: AiSettings = {
		provider: settings.aiProvider,
		accountId: settings.aiAccountId,
		gatewayId: settings.aiGatewayId,
		baseUrl: settings.aiBaseUrl,
		model: settings.aiModel,
		apiKey: settings.aiApiToken,
		timeoutMs: settings.aiTimeoutMs,
		maxTokens: 64,
	};

	const result = await aiComplete(fetcher, { messages: [{ role: "user", content: prompt }] }, ai);
	if (!result.ok) return { ok: false, error: result.error };
	return parseVerdict(result.text);
}

// ---------- 组合 ----------

export interface DecideInput {
	comment: CommentInput;
	collectionSettings: CollectionSettingsInput;
	priorApprovedCount: number;
	settings: ModerationSettings;
	fetcher: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * 最终决策。规则 → AI → 内置逻辑。
 * AI 失败一律降级（绝不自动通过），保证故障不会放开审核。
 */
export async function decide(input: DecideInput): Promise<ModerationDecision> {
	const { comment, collectionSettings, priorApprovedCount, settings, fetcher } = input;

	const ruleDecision = rulesDecision(runRules(comment, settings));
	if (ruleDecision?.status === "spam") return ruleDecision;

	const ai = await classifyWithAi(fetcher, comment, settings);
	const aiNote = ai.ok
		? ai.unsafe
			? `AI：不安全${ai.categories?.length ? `（${ai.categories.join(",")}）` : ""}`
			: "AI：安全"
		: `AI：未判定（${ai.error}）`;

	if (ai.ok && ai.unsafe) {
		return { status: "spam", reason: aiNote };
	}

	if (ruleDecision) {
		return { status: ruleDecision.status, reason: `${ruleDecision.reason}；${aiNote}` };
	}

	const baseline = baselineDecision(comment, collectionSettings, priorApprovedCount);
	if (ai.ok && !ai.unsafe && settings.aiAutoApprove && baseline.status === "pending") {
		return { status: "approved", reason: `${aiNote}（自动通过）` };
	}
	return { status: baseline.status, reason: `${baseline.reason}；${aiNote}` };
}
