/**
 * 后台两页的纯函数层测试。
 *
 * 不起 workerd：直接调 `admin` 路由处理器 + 内存版存储，然后用宿主同款
 * `validateBlocks` 复核响应 —— Block Kit 校验不过就是后台整页 502
 * `INVALID_BLOCK_RESPONSE`，所以每个页面、每个子视图都要过一遍。
 *
 * 路由级的端到端（真实沙箱宿主）在 `plugin.test.ts` 里，避免再起一个 workerd。
 */

import { validateBlocks } from "@emdash-cms/blocks";
import { describe, expect, it } from "vitest";

import plugin from "../src/plugin";
import type { SubscriptionEvent } from "../src/events";
import type { GroupRecord } from "../src/groups";
import type { SubscriberRecord } from "../src/subscribers";

type Json = Record<string, unknown>;
type BlockResponse = { blocks: Json[]; toast?: { type: string; message: string } };

// ---------- 内存版插件存储（只实现插件真正用到的那部分） ----------

interface QueryOptions {
	where?: Record<string, unknown>;
	orderBy?: Record<string, "asc" | "desc">;
	limit?: number;
	cursor?: string;
}

function memoryCollection<T extends object>() {
	const map = new Map<string, T>();

	const matches = (data: T, where?: Record<string, unknown>): boolean => {
		if (!where) return true;
		return Object.entries(where).every(
			([key, value]) => (data as Record<string, unknown>)[key] === value,
		);
	};

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
		async count(where?: Record<string, unknown>): Promise<number> {
			return [...map.values()].filter((data) => matches(data, where)).length;
		},
		async query(options: QueryOptions = {}) {
			let items = [...map.entries()]
				.filter(([, data]) => matches(data, options.where))
				.map(([id, data]) => ({ id, data }));

			if (options.orderBy) {
				const [key, dir] = Object.entries(options.orderBy)[0] ?? [];
				if (key) {
					items = items.sort((a, b) => {
						const left = String((a.data as Record<string, unknown>)[key] ?? "");
						const right = String((b.data as Record<string, unknown>)[key] ?? "");
						return dir === "desc" ? right.localeCompare(left) : left.localeCompare(right);
					});
				}
			}

			// 游标就是字符串化的偏移量（真实存储用的是不透明游标，这里语义等价）。
			const offset = options.cursor ? Number(options.cursor) || 0 : 0;
			const limit = options.limit ?? items.length;
			const page = items.slice(offset, offset + limit);
			const next = offset + page.length;
			return {
				items: page,
				...(next < items.length ? { cursor: String(next) } : {}),
				hasMore: next < items.length,
			};
		},
	};
}

type MemoryCollection<T extends object> = ReturnType<typeof memoryCollection<T>>;

function fakeCtx() {
	const subscribers = memoryCollection<SubscriberRecord>();
	const groups = memoryCollection<GroupRecord>();
	const events = memoryCollection<SubscriptionEvent>();

	return {
		subscribers: subscribers as MemoryCollection<SubscriberRecord>,
		groups: groups as MemoryCollection<GroupRecord>,
		events: events as MemoryCollection<SubscriptionEvent>,
		ctx: {
			storage: { subscribers, groups, events },
			settings: {
				async get(): Promise<unknown> {
					return null;
				},
				async set(): Promise<void> {},
			},
			site: { name: "Suda Pulse" },
			url: (path: string): string => `https://suda.im${path}`,
		},
	};
}

type Ctx = ReturnType<typeof fakeCtx>["ctx"];

async function runAdmin(ctx: Ctx, input: Json): Promise<BlockResponse> {
	const route = (plugin.routes as Record<string, { handler?: unknown }> | undefined)?.admin;
	const handler = route?.handler;
	if (typeof handler !== "function") throw new Error("admin route handler is not a function");
	return (await handler({ input }, ctx)) as BlockResponse;
}

/** 宿主会对每个响应跑一遍 Block Kit 校验（就是 502 的来源），测试里同步复核。 */
function expectValidBlocks(result: BlockResponse): void {
	const { valid, errors } = validateBlocks(result.blocks, {});
	expect(errors).toEqual([]);
	expect(valid).toBe(true);
}

const blockTypes = (result: BlockResponse): string[] => result.blocks.map((block) => String(block.type));

const tableOf = (result: BlockResponse): Json => {
	const table = result.blocks.find((block) => block.type === "table");
	if (!table) throw new Error("响应里没有 table 块");
	return table;
};

// ---------- 夹具 ----------

const NOW = "2026-05-01T00:00:00.000Z";

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

function group(slug: string, overrides: Partial<GroupRecord> = {}): GroupRecord {
	return {
		name: slug,
		sortOrder: 0,
		active: true,
		createdAt: NOW,
		...overrides,
	};
}

// ---------- 用例 ----------

describe("pulse-subscriptions · 后台「订阅者」页", () => {
	it("page_load 渲染统计、筛选表单与订阅者表", async () => {
		const { ctx, subscribers, groups } = fakeCtx();
		await groups.put("daily", group("daily", { name: "每日摘要" }));
		await subscribers.put("sub_1", subscriber({ email: "alice@example.com" }));
		await subscribers.put(
			"sub_2",
			subscriber({ email: "bob@example.com", status: "paused", pausedAt: NOW, pausedFrom: "confirmed" }),
		);
		await subscribers.put(
			"sub_3",
			subscriber({ email: "carol@example.com", status: "unsubscribed", unsubscribedAt: NOW }),
		);

		const result = await runAdmin(ctx, { type: "page_load", page: "/subscribers" });

		expectValidBlocks(result);
		expect(blockTypes(result)).toContain("stats");
		expect(blockTypes(result)).toContain("form");
		expect(blockTypes(result)).toContain("table");

		const stats = result.blocks.find((block) => block.type === "stats") as { items: Array<{ value: number }> };
		expect(stats.items.map((item) => item.value)).toEqual([1, 0, 1, 1]); // 已确认 / 待确认 / 已暂停 / 已退订

		const table = tableOf(result);
		expect((table.rows as Json[]).length).toBe(3);
		// 邮箱脱敏：保留首字符 + 域名，其余打星。
		expect((table.rows as Json[])[0].email).toBe("a****@example.com");
	});

	it("行级 menu 按状态给不同操作", async () => {
		const { ctx, subscribers } = fakeCtx();
		await subscribers.put("sub_1", subscriber({ email: "alice@example.com" }));
		await subscribers.put(
			"sub_2",
			subscriber({ email: "bob@example.com", status: "paused", pausedFrom: "confirmed" }),
		);
		await subscribers.put(
			"sub_3",
			subscriber({ email: "carol@example.com", status: "unsubscribed", unsubscribedAt: NOW }),
		);

		const result = await runAdmin(ctx, { type: "page_load", page: "/subscribers" });
		expectValidBlocks(result);

		const rows = tableOf(result).rows as Array<{ email: string; action: { items: Array<{ value: string }> } }>;
		const byEmail = new Map(rows.map((row) => [row.email, row.action.items.map((item) => item.value)]));

		expect(byEmail.get("a****@example.com")?.some((value) => value.startsWith("pause:"))).toBe(true);
		expect(byEmail.get("b**@example.com")?.some((value) => value.startsWith("resume:"))).toBe(true);
		// 已退订：既不能暂停也不能恢复
		const gone = byEmail.get("c****@example.com") ?? [];
		expect(gone.some((value) => value.startsWith("pause:"))).toBe(false);
		expect(gone.some((value) => value.startsWith("resume:"))).toBe(false);
		expect(gone.some((value) => value.startsWith("unsubscribe:"))).toBe(false);
	});

	it("暂停 / 恢复 / 退订走事件日志，且状态正确流转", async () => {
		const { ctx, subscribers, events } = fakeCtx();
		await subscribers.put("sub_1", subscriber({ email: "a@example.com" }));

		const paused = await runAdmin(ctx, {
			type: "block_action",
			action_id: "subscriber-action",
			value: "pause:sub_1",
		});
		expectValidBlocks(paused);
		expect(paused.toast?.type).toBe("success");
		expect((await subscribers.get("sub_1"))?.status).toBe("paused");
		expect((await subscribers.get("sub_1"))?.pausedFrom).toBe("confirmed");

		const resumed = await runAdmin(ctx, {
			type: "block_action",
			action_id: "subscriber-action",
			value: "resume:sub_1",
		});
		expectValidBlocks(resumed);
		expect((await subscribers.get("sub_1"))?.status).toBe("confirmed");
		expect((await subscribers.get("sub_1"))?.pausedAt).toBeUndefined();

		const gone = await runAdmin(ctx, {
			type: "block_action",
			action_id: "subscriber-action",
			value: "unsubscribe:sub_1",
		});
		expectValidBlocks(gone);
		expect((await subscribers.get("sub_1"))?.status).toBe("unsubscribed");

		const types = [...events.raw.values()].map((event) => event.type);
		expect(types).toEqual(["paused", "resumed", "unsubscribed"]);
	});

	it("对已退订记录暂停会失败并提示", async () => {
		const { ctx, subscribers } = fakeCtx();
		await subscribers.put("sub_1", subscriber({ email: "a@example.com", status: "unsubscribed" }));

		const result = await runAdmin(ctx, {
			type: "block_action",
			action_id: "subscriber-action",
			value: "pause:sub_1",
		});

		expectValidBlocks(result);
		expect(result.toast?.type).toBe("error");
		expect((await subscribers.get("sub_1"))?.status).toBe("unsubscribed");
	});

	it("筛选表单按状态 / 分组 / 关键词过滤并重置到第 1 页", async () => {
		const { ctx, subscribers, groups } = fakeCtx();
		await groups.put("daily", group("daily", { name: "每日摘要" }));
		await groups.put("weekly", group("weekly", { name: "每周精选" }));
		await subscribers.put("sub_1", subscriber({ email: "a@example.com", groups: ["daily"] }));
		await subscribers.put("sub_2", subscriber({ email: "b@example.com", groups: ["weekly"] }));
		await subscribers.put("sub_3", subscriber({ email: "c@example.com", status: "paused", groups: ["daily"] }));

		const byStatus = await runAdmin(ctx, {
			type: "form_submit",
			action_id: "subscriber-filter-apply",
			values: { status: "paused", group: "", q: "" },
		});
		expectValidBlocks(byStatus);
		expect((tableOf(byStatus).rows as Json[]).length).toBe(1);

		const byGroup = await runAdmin(ctx, {
			type: "form_submit",
			action_id: "subscriber-filter-apply",
			values: { status: "all", group: "daily", q: "" },
		});
		expect((tableOf(byGroup).rows as Json[]).length).toBe(2);

		const byQuery = await runAdmin(ctx, {
			type: "form_submit",
			action_id: "subscriber-filter-apply",
			values: { status: "all", group: "", q: "B@" },
		});
		expect((tableOf(byQuery).rows as Json[]).length).toBe(1);
	});

	it("超过一页时给出分页按钮，且翻页保住筛选条件", async () => {
		const { ctx, subscribers, groups } = fakeCtx();
		await groups.put("daily", group("daily", { name: "每日摘要" }));
		// 45 条里 23 条属于 daily（i 为偶数）—— 超过 PAGE_SIZE（20），必然分两页。
		for (let i = 0; i < 45; i += 1) {
			await subscribers.put(
				`sub_${i}`,
				subscriber({
					email: `reader${String(i).padStart(2, "0")}@example.com`,
					groups: i % 2 === 0 ? ["daily"] : [],
					createdAt: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
				}),
			);
		}

		const page1 = await runAdmin(ctx, {
			type: "form_submit",
			action_id: "subscriber-filter-apply",
			values: { status: "all", group: "daily", q: "" },
		});
		expectValidBlocks(page1);
		expect((tableOf(page1).rows as Json[]).length).toBe(20); // 第 1 页满页

		const actions = page1.blocks.find((block) => block.type === "actions") as {
			elements: Array<{ value?: string }>;
		};
		expect(actions).toBeTruthy();

		const next = actions.elements[0]?.value;
		expect(typeof next).toBe("string");

		const page2 = await runAdmin(ctx, { type: "block_action", action_id: "subscribers-page", value: next });
		expectValidBlocks(page2);
		// 仍是 daily 筛选下的结果：23 条里剩 3 条（若筛选丢了会是 45 - 20 = 25 条）
		expect((tableOf(page2).rows as Json[]).length).toBe(3);
	});

	it("「改分组」子视图渲染 checkbox 并回填当前分组", async () => {
		const { ctx, subscribers, groups } = fakeCtx();
		await groups.put("daily", group("daily", { name: "每日摘要" }));
		await groups.put("weekly", group("weekly", { name: "每周精选" }));
		await subscribers.put("sub_1", subscriber({ email: "a@example.com", groups: ["weekly"] }));

		const result = await runAdmin(ctx, {
			type: "block_action",
			action_id: "subscriber-action",
			value: "groups:sub_1",
		});

		expectValidBlocks(result);
		const form = result.blocks.find((block) => block.type === "form") as {
			block_id: string;
			fields: Array<{ type: string; initial_value?: unknown }>;
		};
		expect(form.block_id).toBe("subscriber-groups:sub_1");
		expect(form.fields[0].type).toBe("checkbox");
		expect(form.fields[0].initial_value).toEqual(["weekly"]);
	});

	it("保存分组写库并记事件", async () => {
		const { ctx, subscribers, groups, events } = fakeCtx();
		await groups.put("daily", group("daily", { name: "每日摘要" }));
		await groups.put("weekly", group("weekly", { name: "每周精选" }));
		await groups.put("retired", group("retired", { name: "已停用", active: false }));
		await subscribers.put("sub_1", subscriber({ email: "a@example.com", groups: ["daily"] }));

		const result = await runAdmin(ctx, {
			type: "form_submit",
			action_id: "subscriber-groups-save",
			block_id: "subscriber-groups:sub_1",
			// retired 已停用，应被过滤掉
			values: { groups: ["weekly", "retired"] },
		});

		expectValidBlocks(result);
		expect((await subscribers.get("sub_1"))?.groups).toEqual(["weekly"]);
		expect([...events.raw.values()].map((event) => event.type)).toEqual(["groups_changed"]);
	});

	it("「订阅记录」子视图渲染时间线表", async () => {
		const { ctx, subscribers, events } = fakeCtx();
		await subscribers.put("sub_1", subscriber({ email: "a@example.com" }));
		await events.put("evt_1", {
			subscriberId: "sub_1",
			type: "paused",
			at: NOW,
			actor: "admin",
			reason: "投诉",
		});

		const result = await runAdmin(ctx, {
			type: "block_action",
			action_id: "subscriber-action",
			value: "events:sub_1",
		});

		expectValidBlocks(result);
		const rows = tableOf(result).rows as Json[];
		expect(rows.length).toBe(1);
		expect(rows[0].type).toBe("暂停");
		expect(rows[0].actor).toBe("后台");
		expect(rows[0].detail).toBe("投诉");
	});
});

describe("pulse-subscriptions · 后台「订阅分组」页", () => {
	it("page_load 渲染统计、表单与分组表", async () => {
		const { ctx, groups, subscribers } = fakeCtx();
		await groups.put("daily", group("daily", { name: "每日摘要", sortOrder: 1 }));
		await groups.put("weekly", group("weekly", { name: "每周精选", sortOrder: 2, active: false }));
		await subscribers.put("sub_1", subscriber({ email: "a@example.com", groups: ["daily"] }));

		const result = await runAdmin(ctx, { type: "page_load", page: "/groups" });

		expectValidBlocks(result);
		expect(blockTypes(result)).toContain("stats");
		expect(blockTypes(result)).toContain("form");
		expect(blockTypes(result)).toContain("table");

		const rows = tableOf(result).rows as Json[];
		expect(rows.length).toBe(2);
		const daily = rows.find((row) => row.slug === "daily") as Json;
		expect(daily.members).toBe(1);
		expect(daily.status).toBe("启用");
	});

	it("中文名推不出合法 slug 时拒绝新建并提示", async () => {
		const { ctx, groups } = fakeCtx();
		const result = await runAdmin(ctx, {
			type: "form_submit",
			page: "/groups",
			action_id: "group-save",
			block_id: "group-save",
			values: { name: "突发新闻", slug: "", description: "重大事件即时推送", sortOrder: 3, active: true },
		});

		expectValidBlocks(result);
		expect(result.toast).toBeUndefined();
		expect(await groups.count()).toBe(0);
		// 错误以 section 提示回填在页面上
		const notices = result.blocks
			.filter((block) => block.type === "section")
			.map((block) => String(block.text));
		expect(notices.some((text) => text.includes("slug 不合法"))).toBe(true);
	});

	it("中文名 + 显式 slug 可以新建", async () => {
		const { ctx, groups } = fakeCtx();
		const result = await runAdmin(ctx, {
			type: "form_submit",
			page: "/groups",
			action_id: "group-save",
			block_id: "group-save",
			values: { name: "突发新闻", slug: "breaking", sortOrder: 1, active: true },
		});

		expectValidBlocks(result);
		expect(result.toast?.type).toBe("success");
		expect((await groups.get("breaking"))?.name).toBe("突发新闻");
	});

	it("英文名留空 slug 时自动推导", async () => {
		const { ctx, groups } = fakeCtx();
		const created = await runAdmin(ctx, {
			type: "form_submit",
			page: "/groups",
			action_id: "group-save",
			block_id: "group-save",
			values: { name: "Breaking News", slug: "", sortOrder: 1, active: true },
		});
		expectValidBlocks(created);
		expect(await groups.get("breaking-news")).toBeTruthy();
	});

	it("slug 重复时拒绝新建", async () => {
		const { ctx, groups } = fakeCtx();
		await groups.put("breaking", group("breaking", { name: "既有" }));

		const result = await runAdmin(ctx, {
			type: "form_submit",
			page: "/groups",
			action_id: "group-save",
			block_id: "group-save",
			values: { name: "另一个", slug: "breaking", active: true },
		});

		expectValidBlocks(result);
		expect(result.toast).toBeUndefined();
		expect((await groups.get("breaking"))?.name).toBe("既有");
	});

	it("编辑分组（slug 不可改）", async () => {
		const { ctx, groups } = fakeCtx();
		await groups.put("breaking-news", group("breaking-news", { name: "Breaking News", sortOrder: 1 }));

		const edited = await runAdmin(ctx, {
			type: "form_submit",
			page: "/groups",
			action_id: "group-save",
			block_id: "group-save:breaking-news",
			values: { name: "Breaking", sortOrder: 9, active: false },
		});
		expectValidBlocks(edited);

		const stored = await groups.get("breaking-news");
		expect(stored?.name).toBe("Breaking");
		expect(stored?.sortOrder).toBe(9);
		expect(stored?.active).toBe(false);
	});

	it("点「编辑」预填表单", async () => {
		const { ctx, groups } = fakeCtx();
		await groups.put("daily", group("daily", { name: "每日摘要", sortOrder: 2 }));

		const result = await runAdmin(ctx, {
			type: "block_action",
			page: "/groups",
			action_id: "group-action",
			value: "edit:daily",
		});

		expectValidBlocks(result);
		const form = result.blocks.find((block) => block.type === "form") as {
			block_id: string;
			fields: Array<{ action_id: string; initial_value?: unknown }>;
		};
		expect(form.block_id).toBe("group-save:daily");
		expect(form.fields.find((field) => field.action_id === "name")?.initial_value).toBe("每日摘要");
	});

	it("删除分组会从订阅者身上摘掉该 slug 并记事件", async () => {
		const { ctx, groups, subscribers, events } = fakeCtx();
		await groups.put("daily", group("daily", { name: "每日摘要" }));
		await subscribers.put("sub_1", subscriber({ email: "a@example.com", groups: ["daily"] }));
		await subscribers.put("sub_2", subscriber({ email: "b@example.com", groups: [] }));

		const result = await runAdmin(ctx, {
			type: "block_action",
			page: "/groups",
			action_id: "group-action",
			value: "delete:daily",
		});

		expectValidBlocks(result);
		expect(await groups.get("daily")).toBeNull();
		expect((await subscribers.get("sub_1"))?.groups).toEqual([]);
		expect([...events.raw.values()].map((event) => event.type)).toEqual(["groups_changed"]);
	});
});
