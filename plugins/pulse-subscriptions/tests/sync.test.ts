/**
 * 分组 ↔ Resend Segment 同步 + 群发的测试。
 *
 * 这里把 `loadResendConfig` mock 掉（它要动态 `import("emdash")` 拿宿主设置，
 * 单测环境里拿不到），其余（`ensureSegment` / `upsertContact` / `createBroadcast`）
 * 走真实实现，网络用桩 fetcher 拦下 —— 覆盖的是「本地状态 → Resend 请求」的映射，
 * 以及所有失败路径都**不抛错**的旁路约定。
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

import { listBroadcastHistory, sendBroadcastToSegment, type BroadcastRecord } from "../src/broadcast";
import type { SubscriptionEvent } from "../src/events";
import type { GroupRecord } from "../src/groups";
import { loadResendConfig, type Fetcher } from "../src/resend";
import { readSyncSettings, segmentName, syncSubscriber } from "../src/segments";
import type { SubscriberRecord } from "../src/subscribers";

// ---------- 内存版插件存储 ----------

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

/** 记录调用、按 handler 决定响应的桩 fetcher。 */
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

/** 内存版插件 KV（cadence 受众 id 缓存用）。 */
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

function fakeCtx(options: { http?: Fetcher | null; settings?: Record<string, unknown> } = {}) {
	const groups = memoryCollection<GroupRecord>();
	const events = memoryCollection<SubscriptionEvent>();
	const broadcasts = memoryCollection<BroadcastRecord>();
	const kv = memoryKv();

	const http = options.http === null ? undefined : options.http ? { fetch: options.http } : undefined;
	const ctx = {
		storage: { groups, events, broadcasts },
		kv,
		settings: {
			async get(key: string): Promise<unknown> {
				return options.settings?.[key] ?? null;
			},
			async set(): Promise<void> {},
		},
		http,
		site: { name: "Suda Pulse" },
		url: (path: string): string => `https://pulse.suda.im${path}`,
	} as unknown as PluginContext;

	return { ctx, groups, events, broadcasts, kv };
}

const NOW = "2026-05-01T00:00:00.000Z";

function group(slug: string, overrides: Partial<GroupRecord> = {}): GroupRecord {
	return { name: slug, sortOrder: 0, active: true, createdAt: NOW, ...overrides };
}

function subscriber(overrides: Partial<SubscriberRecord> & { email: string }): SubscriberRecord {
	return {
		emailHash: `hash-${overrides.email}`,
		status: "confirmed",
		createdAt: NOW,
		requestedAt: NOW,
		emailDelivered: true,
		...overrides,
	} as SubscriberRecord;
}

beforeEach(() => {
	vi.mocked(loadResendConfig).mockResolvedValue({
		apiKey: "re_test",
		fromAddress: "Pulse <news@example.com>",
	});
});

// ---------- 设置与命名 ----------

describe("segments · 设置与命名", () => {
	it("segmentName 加前缀并截断到 120", () => {
		expect(segmentName("Pulse · ", "每日摘要")).toBe("Pulse · 每日摘要");
		expect(segmentName("", "x".repeat(200)).length).toBe(120);
	});

	it("readSyncSettings 未配置时用默认值，配置后覆盖", async () => {
		const plain = fakeCtx();
		expect(await readSyncSettings(plain.ctx)).toEqual({
			enabled: true,
			prefix: "Pulse · ",
			defaultCadence: "weekly",
		});

		const custom = fakeCtx({
			settings: { resendSyncEnabled: false, resendSegmentPrefix: "S", defaultCadence: "monthly" },
		});
		expect(await readSyncSettings(custom.ctx)).toEqual({
			enabled: false,
			prefix: "S",
			defaultCadence: "monthly",
		});
	});
});

// ---------- 同步 ----------

describe("segments · syncSubscriber", () => {
	it("pending 跳过（邮箱未确认，不该进联系人表）", async () => {
		const { fetcher, calls } = stubApi(() => ({ body: {} }));
		const { ctx } = fakeCtx({ http: fetcher });

		const result = await syncSubscriber(ctx, {
			id: "sub_1",
			data: subscriber({ email: "a@example.com", status: "pending" }),
		});

		expect(result).toEqual({ attempted: false, ok: true });
		expect(calls).toHaveLength(0);
	});

	it("同步关闭时直接跳过", async () => {
		const { fetcher, calls } = stubApi(() => ({ body: {} }));
		const { ctx } = fakeCtx({ http: fetcher, settings: { resendSyncEnabled: false } });

		const result = await syncSubscriber(ctx, {
			id: "sub_1",
			data: subscriber({ email: "a@example.com" }),
		});

		expect(result.attempted).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("confirmed：建分组与节奏 segment、写回组记录、把 contact 放进两个 segment", async () => {
		let created = 0;
		const { fetcher, calls } = stubApi((method, path) => {
			if (method === "GET" && path === "/segments") return { body: { data: [] } };
			if (method === "POST" && path === "/segments") {
				created += 1;
				return { body: { id: created === 1 ? "seg_daily" : "seg_weekly" } };
			}
			if (method === "POST" && path === "/contacts") return { body: { id: "ct_1" } };
			return { status: 404, body: { message: "unexpected" } };
		});
		const { ctx, groups } = fakeCtx({ http: fetcher });
		await groups.put("daily", group("daily", { name: "每日摘要" }));

		const result = await syncSubscriber(ctx, {
			id: "sub_1",
			data: subscriber({ email: "a@example.com", groups: ["daily"] }),
		});

		expect(result).toEqual({ attempted: true, ok: true });
		// 分组受众在前、节奏受众在后（各一次 ensure）。
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"GET /segments",
			"POST /segments",
			"GET /segments",
			"POST /segments",
			"POST /contacts",
		]);
		expect(calls[1].body).toEqual({ name: "Pulse · 每日摘要" });
		expect(calls[3].body).toEqual({ name: "Pulse · 每周" });
		expect(calls[4].body).toEqual({
			email: "a@example.com",
			unsubscribed: false,
			segments: [{ id: "seg_daily" }, { id: "seg_weekly" }],
		});
		// segment id 写回组记录，下次不再打列表接口。
		expect(groups.raw.get("daily")?.resendSegmentId).toBe("seg_daily");
	});

	it("分组与节奏 id 都已缓存时不再查列表", async () => {
		const { fetcher, calls } = stubApi((method, path) => {
			if (method === "POST" && path === "/contacts") return { body: { id: "ct_1" } };
			return { status: 404, body: {} };
		});
		const { ctx, groups, kv } = fakeCtx({ http: fetcher });
		await groups.put("daily", group("daily", { resendSegmentId: "seg_cached" }));
		await kv.set("digest.segment.weekly", "seg_weekly_cached");

		await syncSubscriber(ctx, {
			id: "sub_1",
			data: subscriber({ email: "a@example.com", groups: ["daily"] }),
		});

		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /contacts"]);
		expect(calls[0].body.segments).toEqual([{ id: "seg_cached" }, { id: "seg_weekly_cached" }]);
	});

	it("节奏受众 id 首次创建后写入 KV 缓存", async () => {
		const { fetcher, calls } = stubApi((method, path) => {
			if (method === "GET" && path === "/segments") return { body: { data: [] } };
			if (method === "POST" && path === "/segments") return { body: { id: "seg_weekly" } };
			if (method === "POST" && path === "/contacts") return { body: { id: "ct_1" } };
			return { status: 404, body: {} };
		});
		const { ctx, kv } = fakeCtx({ http: fetcher, settings: { defaultCadence: "weekly" } });

		await syncSubscriber(ctx, { id: "sub_1", data: subscriber({ email: "a@example.com" }) });

		expect(calls[1].body).toEqual({ name: "Pulse · 每周" });
		expect(kv.raw.get("digest.segment.weekly")).toBe("seg_weekly");
	});

	it("monthly 节奏用「每月」受众", async () => {
		const { fetcher, calls } = stubApi((method, path) => {
			if (method === "GET" && path === "/segments") return { body: { data: [] } };
			if (method === "POST" && path === "/segments") return { body: { id: "seg_monthly" } };
			if (method === "POST" && path === "/contacts") return { body: { id: "ct_1" } };
			return { status: 404, body: {} };
		});
		const { ctx } = fakeCtx({ http: fetcher });

		await syncSubscriber(ctx, {
			id: "sub_1",
			data: subscriber({ email: "a@example.com", cadence: "monthly" }),
		});

		expect(calls[1].body).toEqual({ name: "Pulse · 每月" });
	});

	it("退订 / 暂停同步为 unsubscribed:true 且清空分组", async () => {
		const { fetcher, calls } = stubApi((method, path) => {
			if (method === "POST" && path === "/contacts") return { body: { id: "ct_1" } };
			return { status: 404, body: {} };
		});
		const { ctx, groups } = fakeCtx({ http: fetcher });
		await groups.put("daily", group("daily", { resendSegmentId: "seg_cached" }));

		await syncSubscriber(ctx, {
			id: "sub_1",
			data: subscriber({ email: "a@example.com", status: "unsubscribed", groups: ["daily"] }),
		});

		expect(calls[0].body).toEqual({ email: "a@example.com", unsubscribed: true, segments: [] });
	});

	it("未配置 Resend 时不动网络", async () => {
		vi.mocked(loadResendConfig).mockResolvedValue(null);
		const { fetcher, calls } = stubApi(() => ({ body: {} }));
		const { ctx } = fakeCtx({ http: fetcher });

		const result = await syncSubscriber(ctx, { id: "sub_1", data: subscriber({ email: "a@example.com" }) });
		expect(result).toEqual({ attempted: false, ok: false, error: "resend_not_configured" });
		expect(calls).toHaveLength(0);
	});

	it("同步失败时记事件且不抛错", async () => {
		const { fetcher } = stubApi((method, path) => {
			if (method === "POST" && path === "/contacts") return { status: 500, body: { message: "boom" } };
			return { status: 404, body: {} };
		});
		const { ctx, events } = fakeCtx({ http: fetcher });

		const result = await syncSubscriber(ctx, { id: "sub_1", data: subscriber({ email: "a@example.com" }) });

		expect(result.ok).toBe(false);
		const recorded = [...events.raw.values()];
		expect(recorded).toHaveLength(1);
		expect(recorded[0].type).toBe("resend_sync_failed");
		expect(recorded[0].reason).toBe("http_500: boom");
	});
});

// ---------- 群发 ----------

describe("broadcast · sendBroadcastToSegment", () => {
	it("成功时创建并立即发送，落一条 sent 历史", async () => {
		const { fetcher, calls } = stubApi((method, path) => {
			if (method === "POST" && path === "/broadcasts") return { body: { id: "bc_1" } };
			return { status: 404, body: {} };
		});
		const { ctx, groups, broadcasts } = fakeCtx({ http: fetcher });
		await groups.put("daily", group("daily", { resendSegmentId: "seg_cached" }));

		const result = await sendBroadcastToSegment(ctx, {
			subject: "本周速览",
			html: "<p>hi</p>",
			segmentSlug: "daily",
			actor: "admin",
		});

		expect(result).toEqual({ ok: true, resendId: "bc_1", segmentId: "seg_cached" });
		expect(calls[0].path).toBe("/broadcasts");
		expect(calls[0].body.segment_id).toBe("seg_cached");
		expect(calls[0].body.send).toBe(true);

		const history = await listBroadcastHistory(ctx);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			subject: "本周速览",
			segmentSlug: "daily",
			resendId: "bc_1",
			status: "sent",
			createdBy: "admin",
		});
		expect(broadcasts.raw.size).toBe(1);
	});

	it("发送失败时也落一条 failed 历史", async () => {
		const { fetcher } = stubApi((method, path) => {
			if (method === "POST" && path === "/broadcasts") return { status: 500, body: { message: "boom" } };
			return { status: 404, body: {} };
		});
		const { ctx, groups } = fakeCtx({ http: fetcher });
		await groups.put("daily", group("daily", { resendSegmentId: "seg_cached" }));

		const result = await sendBroadcastToSegment(ctx, { subject: "s", html: "<p>x</p>", segmentSlug: "daily" });

		expect(result.ok).toBe(false);
		const history = await listBroadcastHistory(ctx);
		expect(history).toHaveLength(1);
		expect(history[0].status).toBe("failed");
		expect(history[0].error).toBe("http_500: boom");
	});

	it("分组不存在时直接报错，不落历史", async () => {
		const { fetcher, calls } = stubApi(() => ({ body: {} }));
		const { ctx } = fakeCtx({ http: fetcher });

		const result = await sendBroadcastToSegment(ctx, { subject: "s", html: "<p>x</p>", segmentSlug: "nope" });

		expect(result).toEqual({ ok: false, error: "segment_not_found" });
		expect(calls).toHaveLength(0);
		expect(await listBroadcastHistory(ctx)).toHaveLength(0);
	});

	it("没有 http 能力时降级", async () => {
		const { ctx, groups } = fakeCtx({ http: null });
		await groups.put("daily", group("daily"));
		const result = await sendBroadcastToSegment(ctx, { subject: "s", html: "<p>x</p>", segmentSlug: "daily" });
		expect(result).toEqual({ ok: false, error: "no_http" });
	});
});
