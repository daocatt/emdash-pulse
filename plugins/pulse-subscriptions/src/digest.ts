/**
 * 订阅摘要（每周 / 每月）。
 *
 * 机制：每档节奏注册一个插件 cron 任务（见 `schedule.ts`），到点后本模块
 * **生成内容并按节奏受众群发**（走 transport 的 `send()`，即 Resend Broadcasts）。
 *
 * 内容口径是**上一个完整自然周期**（Asia/Shanghai，UTC+8 无 DST）：
 *   - 周报 = 上一自然周（周一 00:00 → 本周一 00:00 CST）
 *   - 月报 = 上一自然月（上月 1 日 00:00 → 本月 1 日 00:00 CST）
 *
 * 因此同一周期算出的 `since/until` 恒定 → 幂等判据直接用 `until`（见 `runDigest`）。
 *
 * 与 transport 的约定一致：**永不抛错**，失败返回 `{ ok:false, status }`，并落一条
 * `digest_runs` 记录（后台「订阅摘要」页据此展示，也是重发保护）。
 */

import type { PluginContext } from "emdash/plugin";

import { cadenceAudienceId, readSyncSettings } from "./segments";
import { isCadence, type Cadence } from "./subscribers";
import { httpFetcher, resolveTransport } from "./transport";

type Json = Record<string, unknown>;

// ---------- 设置 ----------

export interface DigestSettings {
	enabled: boolean;
	defaultCadence: Cadence;
	weeklySchedule: string;
	monthlySchedule: string;
	maxArticles: number;
	weeklySubject: string;
	monthlySubject: string;
}

export const DEFAULT_DIGEST_SETTINGS: DigestSettings = {
	enabled: true,
	defaultCadence: "weekly",
	weeklySchedule: "0 0 * * 1",
	monthlySchedule: "0 0 1 * *",
	maxArticles: 12,
	weeklySubject: "本周回顾 · {site}",
	monthlySubject: "本月回顾 · {site}",
};

function str(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function readDigestSettings(ctx: PluginContext): Promise<DigestSettings> {
	const get = async (key: string): Promise<unknown> => {
		try {
			return await ctx.settings.get(key);
		} catch {
			return null;
		}
	};
	const [enabled, defaultCadence, weeklySchedule, monthlySchedule, maxArticles, weeklySubject, monthlySubject] =
		await Promise.all([
			get("digestEnabled"),
			get("defaultCadence"),
			get("weeklySchedule"),
			get("monthlySchedule"),
			get("digestMaxArticles"),
			get("weeklySubject"),
			get("monthlySubject"),
		]);

	return {
		enabled: typeof enabled === "boolean" ? enabled : DEFAULT_DIGEST_SETTINGS.enabled,
		defaultCadence: isCadence(defaultCadence) ? defaultCadence : DEFAULT_DIGEST_SETTINGS.defaultCadence,
		weeklySchedule: str(weeklySchedule, DEFAULT_DIGEST_SETTINGS.weeklySchedule),
		monthlySchedule: str(monthlySchedule, DEFAULT_DIGEST_SETTINGS.monthlySchedule),
		maxArticles: Math.max(1, Math.min(Math.round(num(maxArticles, DEFAULT_DIGEST_SETTINGS.maxArticles)), 50)),
		weeklySubject: str(weeklySubject, DEFAULT_DIGEST_SETTINGS.weeklySubject),
		monthlySubject: str(monthlySubject, DEFAULT_DIGEST_SETTINGS.monthlySubject),
	};
}

/** 某档节奏的 cron 表达式。 */
export function digestSchedule(settings: DigestSettings, cadence: Cadence): string {
	return cadence === "weekly" ? settings.weeklySchedule : settings.monthlySchedule;
}

/** 某档节奏的主题模板。 */
export function digestSubjectTemplate(settings: DigestSettings, cadence: Cadence): string {
	return cadence === "weekly" ? settings.weeklySubject : settings.monthlySubject;
}

// ---------- 窗口（自然周 / 自然月，CST）----------

/** 本站固定 Asia/Shanghai（UTC+8，无 DST）。 */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestWindow {
	/** 周期起点（含），ISO UTC。 */
	since: string;
	/** 周期终点（不含），ISO UTC。 */
	until: string;
}

/**
 * 上一个完整自然周期。
 *
 * 做法：把 `now` 平移到 CST 墙钟（`+8h` 后用 `getUTC*` 读数即 CST 本地时间），
 * 求出本期起点，再减 `8h` 还原成真实 UTC 瞬间。`Date.UTC` 会归一化越界的
 * 日 / 月（如 `m-1` 为负、`d-7` 为负）。
 */
export function digestWindow(cadence: Cadence, now: Date = new Date()): DigestWindow {
	const cst = new Date(now.getTime() + CST_OFFSET_MS);
	const y = cst.getUTCFullYear();
	const m = cst.getUTCMonth();
	const d = cst.getUTCDate();

	let endCst: number;
	let startCst: number;
	if (cadence === "weekly") {
		// 本周一 00:00 CST（getUTCDay: 0=周日 … 6=周六）。
		const daysSinceMonday = (cst.getUTCDay() + 6) % 7;
		endCst = Date.UTC(y, m, d - daysSinceMonday);
		startCst = endCst - 7 * DAY_MS;
	} else {
		endCst = Date.UTC(y, m, 1);
		startCst = Date.UTC(y, m - 1, 1);
	}

	return {
		since: new Date(startCst - CST_OFFSET_MS).toISOString(),
		until: new Date(endCst - CST_OFFSET_MS).toISOString(),
	};
}

// ---------- 取数 ----------

export interface DigestArticle {
	id: string;
	title: string;
	summary: string;
	url: string;
	publishedAt: string;
}

/** 权重排序（越小越靠前）；未知值排最后。 */
const PRIORITY_RANK: Record<string, number> = { lead: 0, high: 1, normal: 2 };

/** 单次拉取上限：窗口过滤在 JS 里做，取够一批即可（> 100 会被宿主截到 100）。 */
const FETCH_LIMIT = 60;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

async function articleUrl(ctx: PluginContext, id: string, slug: string | null): Promise<string> {
	try {
		const url = await ctx.content?.getPublicUrl?.("articles", id);
		if (typeof url === "string" && url !== "") return url;
	} catch {
		// 取不到公开地址就回退到默认路径。
	}
	return slug ? ctx.url(`/articles/${slug}`) : ctx.url("/");
}

/**
 * 选出窗口内的文章，按「头条候选 → 版面权重 → 时间倒序」排序取前 `max` 条。
 *
 * 插件侧 `ctx.content.list` **不支持按 `published_at` 区间过滤**（`where` 只有
 * status / locale / fieldFilters），所以按 `published_at` 倒序取一批，再在 JS 里
 * 按窗口裁剪。未声明 `content:read` 能力或查询失败时返回空数组（不抛错）。
 */
export async function selectDigestArticles(
	ctx: PluginContext,
	window: DigestWindow,
	max: number,
): Promise<DigestArticle[]> {
	if (!ctx.content) return [];

	let items: Array<{ id: string; slug: string | null; data: Json; publishedAt: string | null }> = [];
	try {
		const result = await ctx.content.list("articles", {
			where: { status: "published" },
			orderBy: { published_at: "desc" },
			limit: FETCH_LIMIT,
		});
		items = result.items.map((item) => ({
			id: item.id,
			slug: item.slug,
			data: (item.data ?? {}) as Json,
			publishedAt: item.publishedAt,
		}));
	} catch {
		return [];
	}

	const sinceMs = Date.parse(window.since);
	const untilMs = Date.parse(window.until);

	const inWindow = items.filter((item) => {
		const at = item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN;
		return Number.isFinite(at) && at >= sinceMs && at < untilMs;
	});

	const ranked = inWindow.sort((a, b) => {
		const fa = a.data.is_featured === true ? 0 : 1;
		const fb = b.data.is_featured === true ? 0 : 1;
		if (fa !== fb) return fa - fb;

		const pa = PRIORITY_RANK[text(a.data.priority)] ?? 3;
		const pb = PRIORITY_RANK[text(b.data.priority)] ?? 3;
		if (pa !== pb) return pa - pb;

		return (Date.parse(b.publishedAt ?? "") || 0) - (Date.parse(a.publishedAt ?? "") || 0);
	});

	const out: DigestArticle[] = [];
	for (const item of ranked.slice(0, Math.max(1, max))) {
		out.push({
			id: item.id,
			title: text(item.data.title) || "（无标题）",
			summary: text(item.data.deck) || text(item.data.excerpt),
			url: await articleUrl(ctx, item.id, item.slug),
			publishedAt: item.publishedAt ?? "",
		});
	}
	return out;
}

// ---------- 邮件模板 ----------

export interface DigestEmail {
	subject: string;
	text: string;
	html: string;
}

/** 主题模板占位符：`{site}` / `{count}`。 */
export function applySubjectTemplate(template: string, vars: { site: string; count: number }): string {
	return template
		.replace(/\{site\}/g, vars.site)
		.replace(/\{count\}/g, String(vars.count))
		.trim();
}

const escapeHtml = (value: string): string =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

/**
 * 摘要邮件（纯函数，便于单测）。
 *
 * HTML 末尾带 `{{{RESEND_UNSUBSCRIBE_URL}}}` 占位 —— 这是当前 transport（Resend
 * Broadcasts）的约定，服务侧会替换为收件人专属退订链接。换 provider 时若约定不同，
 * 在这里调整即可。
 */
export function buildDigestEmail(input: {
	articles: DigestArticle[];
	siteName: string;
	subject: string;
	manageUrl?: string;
}): DigestEmail {
	const { articles, siteName, subject } = input;
	const heading = subject;

	const textLines = [heading, "", `来自 ${siteName} 的本期精选（共 ${articles.length} 篇）：`, ""];
	for (const article of articles) {
		textLines.push(`· ${article.title}`);
		if (article.summary) textLines.push(`  ${article.summary}`);
		textLines.push(`  ${article.url}`);
		textLines.push("");
	}
	if (input.manageUrl) {
		textLines.push(`管理订阅偏好 / 退订：${input.manageUrl}`);
	}

	const itemsHtml = articles
		.map((article) => {
			const summary = article.summary
				? `\n  <p style="margin:4px 0 0;color:#555;">${escapeHtml(article.summary)}</p>`
				: "";
			return `<li style="margin:0 0 16px;">
  <a href="${escapeHtml(article.url)}" style="font-weight:600;font-size:16px;">${escapeHtml(article.title)}</a>${summary}
</li>`;
		})
		.join("\n");

	const manageHtml = input.manageUrl
		? `<p style="font-size:12px;color:#888;">不想再收到？<a href="${escapeHtml(input.manageUrl)}">管理订阅偏好 / 退订</a>，或 <a href="{{{RESEND_UNSUBSCRIBE_URL}}}">一键退订</a>。</p>`
		: `<p style="font-size:12px;color:#888;"><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">一键退订</a></p>`;

	const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;">
<h1 style="font-size:22px;">${escapeHtml(heading)}</h1>
<p style="color:#555;">来自 <strong>${escapeHtml(siteName)}</strong> 的本期精选（共 ${articles.length} 篇）：</p>
<ul style="padding-left:20px;">
${itemsHtml}
</ul>
${manageHtml}
</div>`;

	return { subject, text: textLines.join("\n").trimEnd(), html };
}

// ---------- 运行留痕（digest_runs）----------

export interface DigestRunRecord {
	cadence: Cadence;
	windowSince: string;
	windowUntil: string;
	sentAt: string;
	segmentId: string;
	transportId: string;
	count: number;
	status: "sent" | "skipped" | "failed";
	error?: string;
}

export interface DigestRunStore {
	put(id: string, data: DigestRunRecord): Promise<void>;
	query(options?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: DigestRunRecord }>; cursor?: string; hasMore: boolean }>;
}

export function digestRunStore(ctx: PluginContext): DigestRunStore {
	return ctx.storage.digest_runs as unknown as DigestRunStore;
}

export const newDigestRunId = (): string => `dg_${crypto.randomUUID().replace(/-/g, "")}`;

/** 摘要运行历史（新→旧）。 */
export async function listDigestRuns(ctx: PluginContext, limit = 20): Promise<DigestRunRecord[]> {
	try {
		const result = await digestRunStore(ctx).query({
			orderBy: { sentAt: "desc" },
			limit: Math.min(Math.max(limit, 1), 100),
		});
		return result.items.map((item) => item.data);
	} catch {
		return [];
	}
}

async function recordRun(ctx: PluginContext, record: DigestRunRecord): Promise<void> {
	try {
		await digestRunStore(ctx).put(newDigestRunId(), record);
	} catch {
		// 旁路：留痕写不进去不影响已经发出的邮件。
	}
}

/** 该节奏最近一条运行记录（用于幂等判据）。 */
async function lastRun(ctx: PluginContext, cadence: Cadence): Promise<DigestRunRecord | null> {
	try {
		const result = await digestRunStore(ctx).query({
			where: { cadence },
			orderBy: { sentAt: "desc" },
			limit: 1,
		});
		return result.items[0]?.data ?? null;
	} catch {
		return null;
	}
}

// ---------- 运行 ----------

export type RunDigestResult =
	| { ok: true; status: "sent"; count: number; segmentId: string }
	| { ok: false; status: "skipped" | "failed"; error: string };

export interface RunDigestOptions {
	/** 手动触发（后台按钮）：忽略总开关与幂等判据。 */
	manual?: boolean;
	/** 注入当前时间（测试用）。 */
	now?: Date;
}

/**
 * 生成并群发某档节奏的摘要。
 *
 * 顺序刻意如此：能力 → 通道 → 窗口 → 幂等 → 取数 → 受众 → 发送。任一步失败都
 * **落一条 digest_runs 记录并返回**，不抛错 —— cron 钩子抛错只会让宿主打印日志，
 * 落痕才能让运营在后台看到「为什么这期没发」。
 */
export async function runDigest(
	ctx: PluginContext,
	cadence: Cadence,
	options: RunDigestOptions = {},
): Promise<RunDigestResult> {
	const settings = await readDigestSettings(ctx);
	const now = options.now ?? new Date();
	const sentAt = now.toISOString();
	const window = digestWindow(cadence, now);

	const fail = async (error: string, segmentId = ""): Promise<RunDigestResult> => {
		await recordRun(ctx, {
			cadence,
			windowSince: window.since,
			windowUntil: window.until,
			sentAt,
			segmentId,
			transportId: "",
			count: 0,
			status: "failed",
			error,
		});
		return { ok: false, status: "failed", error };
	};

	const skip = async (error: string): Promise<RunDigestResult> => {
		await recordRun(ctx, {
			cadence,
			windowSince: window.since,
			windowUntil: window.until,
			sentAt,
			segmentId: "",
			transportId: "",
			count: 0,
			status: "skipped",
			error,
		});
		return { ok: false, status: "skipped", error };
	};

	if (!settings.enabled && !options.manual) return { ok: false, status: "skipped", error: "disabled" };

	// 能力缺失先于凭证判断 —— 否则会误报「未配置」。
	if (!httpFetcher(ctx)) return fail("no_http");

	const transport = await resolveTransport(ctx);
	if (!transport || !(await transport.isConfigured())) return fail("resend_not_configured");
	if ((await transport.fromAddress()) === "") return fail("resend_from_address_missing");

	if (!options.manual) {
		const previous = await lastRun(ctx, cadence);
		if (previous && previous.status === "sent" && previous.windowUntil >= window.until) {
			return { ok: false, status: "skipped", error: "already_sent" };
		}
	}

	const articles = await selectDigestArticles(ctx, window, settings.maxArticles);
	if (articles.length === 0) return skip("no_articles");

	const sync = await readSyncSettings(ctx);
	const segmentId = await cadenceAudienceId(ctx, transport, cadence, sync.prefix);
	if (!segmentId) return fail("segment_sync_failed");

	const subject = applySubjectTemplate(digestSubjectTemplate(settings, cadence), {
		site: ctx.site.name || "Suda Pulse",
		count: articles.length,
	});
	const email = buildDigestEmail({
		articles,
		siteName: ctx.site.name || "Suda Pulse",
		subject,
	});

	const created = await transport.send({
		audienceId: segmentId,
		subject: email.subject,
		html: email.html,
		text: email.text,
		name: `${cadence} digest · ${sentAt}`,
	});

	if (!created.ok) {
		await recordRun(ctx, {
			cadence,
			windowSince: window.since,
			windowUntil: window.until,
			sentAt,
			segmentId,
			transportId: transport.id,
			count: articles.length,
			status: "failed",
			error: created.error,
		});
		ctx.log.warn("digest send failed", { cadence, error: created.error });
		return { ok: false, status: "failed", error: created.error };
	}

	await recordRun(ctx, {
		cadence,
		windowSince: window.since,
		windowUntil: window.until,
		sentAt,
		segmentId,
		transportId: transport.id,
		count: articles.length,
		status: "sent",
	});
	ctx.log.info("digest sent", { cadence, count: articles.length, segmentId, broadcastId: created.data.id });

	return { ok: true, status: "sent", count: articles.length, segmentId };
}
