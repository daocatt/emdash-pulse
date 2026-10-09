/**
 * 订阅摘要（每周 / 每月）测试。
 *
 * 覆盖：自然周期窗口（CST）、取数与排序、邮件模板、幂等与运行留痕、任务名解析。
 * `loadResendConfig` 与 sync.test.ts 一样 mock 掉（要动态 import 宿主设置）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/resend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/resend")>();
	return {
		...actual,
		loadResendConfig: vi.fn(async () => ({
			apiKey: "re_test",
			fromAddress: "Pulse <news@example.com>",
		})),
	};
});

import type { PluginContext } from "emdash/plugin";

import {
	applySubjectTemplate,
	buildDigestEmail,
	digestWindow,
	listDigestRuns,
	runDigest,
	selectDigestArticles,
	type DigestRunRecord,
} from "../src/digest";
import { loadResendConfig, type Fetcher } from "../src/resend";
import { cadenceFromTaskName, ensureDigestSchedules } from "../src/schedule";

// ---------- 内存版插件存储 / KV ----------

function memoryCollection<T extends object>() {
	const map = new Map<string, T>();
	return {
		raw: map,
		async get(id: string): Promise<T | null> {
			return map.get(id) ?? null;
		},
		async put(id: string, data: T): Promise<void> {
			map.set(id, data);
		},
		async delete(id: string): Promise<boolean> {
			return map.delete(id);
		},
		async exists(id: string): Promise<boolean> {
			return map.has(id);
		},
		async count(): Promise<number> {
			return map.size;
		},
		async query(options: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number } = {}) {
			let items = [...map.entries()].map(([id, data]) => ({ id, data }));
			if (options.where) {
				for (const [key, value] of Object.entries(options.where)) {
					items = items.filter((item) => (item.data as Record<string, unknown>)[key] === value);
				}
			}
			const [key, dir] = Object.entries(options.orderBy ?? {})[0] ?? [];
			if (key) {
				items = items.sort((a, b) => {
					const left = String((a.data as Record<string, unknown>)[key] ?? "");
					const right = String((b.data as Record<string, unknown>)[key] ?? "");
					return dir === "desc" ? right.localeCompare(left) : left.localeCompare(right);
				});
			}
			return { items: items.slice(0, options.limit ?? items.length), hasMore: false };
		},
	};
}

function memoryKv() {
	const map = new Map<string, unknown>();
	return {
		raw: map,
		async get<T>(key: string): Promise<T | null> {
			return (map.get(key) as T) ?? null;
		},
		async set(key: string, value: unknown): Promise<void> {
			map.set(key, value);
		},
		async delete(key: string): Promise<boolean> {
			return map.delete(key);
		},
		async list(prefix?: string) {
			return [...map.entries()]
				.filter(([key]) => !prefix || key.startsWith(prefix))
				.map(([key, value]) => ({ key, value }));
		},
	};
}

interface StubArticle {
	id: string;
	slug: string;
	data: Record<string, unknown>;
	publishedAt: string;
}

function fakeContent(articles: StubArticle[]) {
	return {
		async list(_collection: string, options?: { limit?: number }) {
			return { items: articles.slice(0, options?.limit ?? articles.length), hasMore: false };
		},
		async getPublicUrl(_collection: string, id: string) {
			const found = articles.find((article) => article.id === id);
			return found ? `https://pulse.suda.im/articles/${found.slug}` : null;
		},
	};
}

function stubApi(handler: (method: string, path: string, body: any) => { status?: number; body?: unknown }) {
	const calls: Array<{ method: string; path: string; body: any }> = [];
	const fetcher: Fetcher = async (url, init) => {
		const method = init?.method ?? "GET";
		const path = new URL(url).pathname;
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body });
		const res = handler(method, path, body);
		return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
			status: res.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetcher, calls };
}

function fakeCtx(
	options: {
		http?: Fetcher | null;
		settings?: Record<string, unknown>;
		articles?: StubArticle[];
		runs?: DigestRunRecord[];
		now?: () => Date;
	} = {},
) {
	const digestRuns = memoryCollection<DigestRunRecord>();
	for (const run of options.runs ?? []) digestRuns.raw.set(`dg_${digestRuns.raw.size}`, run);

	const kv = memoryKv();
	const http = options.http === null ? undefined : options.http ? { fetch: options.http } : undefined;

	const ctx = {
		storage: { digest_runs: digestRuns },
		kv,
		settings: {
			async get(key: string): Promise<unknown> {
				return options.settings?.[key] ?? null;
			},
			async set(): Promise<void> {},
		},
		content: fakeContent(options.articles ?? []),
		http,
		site: { name: "Suda Pulse" },
		url: (path: string): string => `https://pulse.suda.im${path}`,
		log: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as PluginContext;

	return { ctx, digestRuns, kv };
}

const SETTINGS = {
	digestEnabled: true,
	defaultCadence: "weekly",
	weeklySchedule: "0 0 * * 1",
	monthlySchedule: "0 0 1 * *",
	digestMaxArticles: 12,
	weeklySubject: "本周回顾 · {site}",
	monthlySubject: "本月回顾 · {site}",
};

function article(id: string, publishedAt: string, data: Record<string, unknown> = {}): StubArticle {
	return { id, slug: id, data: { title: `标题 ${id}`, deck: `导语 ${id}`, ...data }, publishedAt };
}

beforeEach(() => {
	vi.mocked(loadResendConfig).mockResolvedValue({
		apiKey: "re_test",
		fromAddress: "Pulse <news@example.com>",
	});
});

// ---------- 窗口 ----------

describe("digest · digestWindow", () => {
	// 2026-05-04 是周一；UTC 00:00 = CST 08:00。
	const monday = new Date("2026-05-04T00:00:00.000Z");

	it("周报 = 上一自然周（周一 00:00 → 本周一 00:00 CST）", () => {
		expect(digestWindow("weekly", monday)).toEqual({
			since: "2026-04-26T16:00:00.000Z", // = 2026-04-27 00:00 CST
			until: "2026-05-03T16:00:00.000Z", // = 2026-05-04 00:00 CST
		});
	});

	it("月报 = 上一自然月（上月 1 日 → 本月 1 日 00:00 CST）", () => {
		expect(digestWindow("monthly", monday)).toEqual({
			since: "2026-03-31T16:00:00.000Z", // = 2026-04-01 00:00 CST
			until: "2026-04-30T16:00:00.000Z", // = 2026-05-01 00:00 CST
		});
	});

	it("跨年月份回退正确（1 月 → 去年 12 月）", () => {
		expect(digestWindow("monthly", new Date("2026-01-15T00:00:00.000Z"))).toEqual({
			since: "2025-11-30T16:00:00.000Z", // = 2025-12-01 00:00 CST
			until: "2025-12-31T16:00:00.000Z", // = 2026-01-01 00:00 CST
		});
	});
});

// ---------- 取数与排序 ----------

describe("digest · selectDigestArticles", () => {
	const window = digestWindow("weekly", new Date("2026-05-04T00:00:00.000Z"));

	it("只保留窗口内文章，按头条 → 权重 → 时间排序", async () => {
		const { ctx } = fakeCtx({
			articles: [
				article("old", "2026-04-01T00:00:00.000Z"), // 窗口外
				article("normal", "2026-04-28T09:00:00.000Z"),
				article("lead", "2026-04-28T08:00:00.000Z", { priority: "lead" }),
				article("featured", "2026-04-28T07:00:00.000Z", { is_featured: true }),
			],
		});

		const picked = await selectDigestArticles(ctx, window, 10);
		expect(picked.map((item) => item.id)).toEqual(["featured", "lead", "normal"]);
		expect(picked[0].url).toBe("https://pulse.suda.im/articles/featured");
		expect(picked[0].title).toBe("标题 featured");
	});

	it("max 截断，且窗口为空时返回空数组", async () => {
		const { ctx } = fakeCtx({
			articles: [
				article("a", "2026-04-28T09:00:00.000Z"),
				article("b", "2026-04-28T10:00:00.000Z"),
			],
		});
		expect((await selectDigestArticles(ctx, window, 1)).map((item) => item.id)).toEqual(["b"]);

		const empty = fakeCtx({ articles: [article("x", "2026-01-01T00:00:00.000Z")] });
		expect(await selectDigestArticles(empty.ctx, window, 10)).toEqual([]);
	});
});

// ---------- 模板 ----------

describe("digest · 模板", () => {
	it("applySubjectTemplate 替换 {site} / {count}", () => {
		expect(applySubjectTemplate("本周回顾 · {site}（{count}）", { site: "Suda Pulse", count: 5 })).toBe(
			"本周回顾 · Suda Pulse（5）",
		);
	});

	it("buildDigestEmail 生成 text 与 html（含退订占位）", () => {
		const email = buildDigestEmail({
			articles: [
				{ id: "a", title: "标题", summary: "导语", url: "https://x/a", publishedAt: "2026-04-28T00:00:00.000Z" },
			],
			siteName: "Suda Pulse",
			subject: "本周回顾",
		});
		expect(email.subject).toBe("本周回顾");
		expect(email.text).toContain("标题");
		expect(email.text).toContain("https://x/a");
		expect(email.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
	});
});

// ---------- 任务名 ----------

describe("digest · 任务名", () => {
	it("cadenceFromTaskName 解析 digest-weekly / digest-monthly", () => {
		expect(cadenceFromTaskName("digest-weekly")).toBe("weekly");
		expect(cadenceFromTaskName("digest-monthly")).toBe("monthly");
		expect(cadenceFromTaskName("digest-daily")).toBeNull();
		expect(cadenceFromTaskName("other")).toBeNull();
	});

	it("ensureDigestSchedules 开启时注册两个任务", async () => {
		const scheduled: Array<{ name: string; schedule: string }> = [];
		const cancelled: string[] = [];
		const { ctx } = fakeCtx({ settings: SETTINGS });
		(ctx as any).cron = {
			async schedule(name: string, opts: { schedule: string }) {
				scheduled.push({ name, schedule: opts.schedule });
			},
			async cancel(name: string) {
				cancelled.push(name);
			},
		};

		await ensureDigestSchedules(ctx);
		expect(scheduled).toEqual([
			{ name: "digest-weekly", schedule: "0 0 * * 1" },
			{ name: "digest-monthly", schedule: "0 0 1 * *" },
		]);
		expect(cancelled).toEqual([]);
	});

	it("ensureDigestSchedules 关闭时取消两个任务", async () => {
		const scheduled: string[] = [];
		const cancelled: string[] = [];
		const { ctx } = fakeCtx({ settings: { ...SETTINGS, digestEnabled: false } });
		(ctx as any).cron = {
			async schedule(name: string) {
				scheduled.push(name);
			},
			async cancel(name: string) {
				cancelled.push(name);
			},
		};

		await ensureDigestSchedules(ctx);
		expect(scheduled).toEqual([]);
		expect(cancelled).toEqual(["digest-weekly", "digest-monthly"]);
	});
});

// ---------- 运行 ----------

const NOW = new Date("2026-05-04T00:00:00.000Z");

describe("digest · runDigest", () => {
	it("成功：向节奏受众群发并落一条 sent 记录", async () => {
		const { fetcher, calls } = stubApi((method, path) => {
			if (method === "POST" && path === "/broadcasts") return { body: { id: "bc_1" } };
			return { status: 404, body: {} };
		});
		const { ctx, digestRuns, kv } = fakeCtx({
			http: fetcher,
			settings: SETTINGS,
			articles: [article("a", "2026-04-28T09:00:00.000Z")],
		});
		await kv.set("digest.segment.weekly", "seg_weekly");

		const result = await runDigest(ctx, "weekly", { now: NOW });

		expect(result).toEqual({ ok: true, status: "sent", count: 1, segmentId: "seg_weekly" });
		expect(calls[0].path).toBe("/broadcasts");
		expect(calls[0].body.segment_id).toBe("seg_weekly");
		expect(calls[0].body.send).toBe(true);
		expect(calls[0].body.subject).toBe("本周回顾 · Suda Pulse");

		const runs = await listDigestRuns(ctx);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ cadence: "weekly", status: "sent", count: 1 });
		expect(digestRuns.raw.size).toBe(1);
	});

	it("窗口内无文章 → skipped no_articles，不发网络请求", async () => {
		const { fetcher, calls } = stubApi(() => ({ body: {} }));
		const { ctx, digestRuns } = fakeCtx({
			http: fetcher,
			settings: SETTINGS,
			articles: [article("old", "2026-01-01T00:00:00.000Z")],
		});

		const result = await runDigest(ctx, "weekly", { now: NOW });
		expect(result).toEqual({ ok: false, status: "skipped", error: "no_articles" });
		expect(calls).toHaveLength(0);
		expect((await listDigestRuns(ctx))[0]).toMatchObject({ status: "skipped", error: "no_articles" });
		expect(digestRuns.raw.size).toBe(1);
	});

	it("同一周期已发送 → skipped already_sent", async () => {
		const { fetcher, calls } = stubApi(() => ({ body: {} }));
		const { ctx } = fakeCtx({
			http: fetcher,
			settings: SETTINGS,
			articles: [article("a", "2026-04-28T09:00:00.000Z")],
			runs: [
				{
					cadence: "weekly",
					windowSince: "2026-04-26T16:00:00.000Z",
					windowUntil: "2026-05-03T16:00:00.000Z",
					sentAt: "2026-05-04T00:00:00.000Z",
					segmentId: "seg_weekly",
					transportId: "resend",
					count: 1,
					status: "sent",
				},
			],
		});

		const result = await runDigest(ctx, "weekly", { now: NOW });
		expect(result).toEqual({ ok: false, status: "skipped", error: "already_sent" });
		expect(calls).toHaveLength(0);
	});

	it("手动触发忽略幂等（manual）", async () => {
		const { fetcher, calls } = stubApi((method, path) => {
			if (method === "POST" && path === "/broadcasts") return { body: { id: "bc_2" } };
			return { status: 404, body: {} };
		});
		const { ctx, kv } = fakeCtx({
			http: fetcher,
			settings: SETTINGS,
			articles: [article("a", "2026-04-28T09:00:00.000Z")],
			runs: [
				{
					cadence: "weekly",
					windowSince: "2026-04-26T16:00:00.000Z",
					windowUntil: "2026-05-03T16:00:00.000Z",
					sentAt: "2026-05-04T00:00:00.000Z",
					segmentId: "seg_weekly",
					transportId: "resend",
					count: 1,
					status: "sent",
				},
			],
		});
		await kv.set("digest.segment.weekly", "seg_weekly");

		const result = await runDigest(ctx, "weekly", { now: NOW, manual: true });
		expect(result.ok).toBe(true);
		expect(calls[0].path).toBe("/broadcasts");
	});

	it("总开关关闭且非手动 → skipped disabled", async () => {
		const { fetcher, calls } = stubApi(() => ({ body: {} }));
		const { ctx } = fakeCtx({
			http: fetcher,
			settings: { ...SETTINGS, digestEnabled: false },
			articles: [article("a", "2026-04-28T09:00:00.000Z")],
		});

		const result = await runDigest(ctx, "weekly", { now: NOW });
		expect(result).toEqual({ ok: false, status: "skipped", error: "disabled" });
		expect(calls).toHaveLength(0);
	});

	it("未配置 Resend → failed resend_not_configured", async () => {
		vi.mocked(loadResendConfig).mockResolvedValue(null);
		const { fetcher, calls } = stubApi(() => ({ body: {} }));
		const { ctx, digestRuns } = fakeCtx({
			http: fetcher,
			settings: SETTINGS,
			articles: [article("a", "2026-04-28T09:00:00.000Z")],
		});

		const result = await runDigest(ctx, "weekly", { now: NOW });
		expect(result).toEqual({ ok: false, status: "failed", error: "resend_not_configured" });
		expect(calls).toHaveLength(0);
		expect((await listDigestRuns(ctx))[0]).toMatchObject({ status: "failed" });
		expect(digestRuns.raw.size).toBe(1);
	});
});
