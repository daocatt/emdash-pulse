import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

// 审核流转涉及内容「写动作」（update/publish），必须用 runtime 宿主；
// 沙箱 runner（workerd）启动成本高，整个文件复用同一个 host。
let host: PluginRuntimeTestHost;
const ids: Record<string, string> = {};

beforeAll(async () => {
	host = await createPluginRuntimeTestHost();
	await host.fixtures.collection({
		slug: "articles",
		label: "Articles",
		fields: [
			{ slug: "title", label: "标题", type: "string" },
			{ slug: "review_status", label: "审核状态", type: "string", indexed: true },
			{ slug: "review_note", label: "审核意见", type: "string" },
			{ slug: "author_agent", label: "作者 Agent", type: "string", indexed: true },
		],
	});

	await host.fixtures.collection({
		slug: "assignments",
		label: "Assignments",
		fields: [
			{ slug: "title", label: "标题", type: "string" },
			{ slug: "brief", label: "任务说明", type: "string" },
			{ slug: "section", label: "版块", type: "string" },
			{ slug: "priority", label: "优先级", type: "string" },
			{ slug: "task_status", label: "状态", type: "string", indexed: true },
			{ slug: "created_by", label: "发起人", type: "string" },
		],
	});

	const seed = async (slug: string, title: string, author: string): Promise<void> => {
		const item = await host.fixtures.content("articles", {
			slug,
			status: "draft",
			data: { title, review_status: "pending_review", author_agent: author },
		});
		ids[slug] = item.id;
	};

	await seed("pending-a", "待审稿 A", "muse");
	await seed("pending-b", "待审稿 B", "dots");
	await seed("pending-c", "待审稿 C", "muse");
	await seed("pending-d", "待审稿 D", "muse");
	await host.fixtures.content("articles", {
		slug: "published-e",
		status: "published",
		data: { title: "已发布稿", review_status: "approved", author_agent: "muse" },
	});
});

afterAll(async () => {
	await host?.dispose();
});

type Res = Record<string, any>;

const call = async (route: string, input: unknown): Promise<Res> =>
	(await host.transport.invokeRoute(route, input, {
		method: "POST",
		headers: {},
		meta: { ip: "10.2.0.1", userAgent: null, referer: null, geo: { country: null, region: null, city: null } },
	} as never)) as Res;

describe("pulse-editorial 投稿审核", () => {
	it("review/queue 只返回 pending_review 稿件", async () => {
		const queue = await call("review/queue", { limit: 50 });
		expect(queue.ok).toBe(true);
		const titles = (queue.submissions as Res[]).map((item) => item.title);
		expect(titles).toContain("待审稿 A");
		expect(titles).not.toContain("已发布稿");
	});

	it("review/get 缺 article_id 返回 INVALID_INPUT", async () => {
		const result = await call("review/get", {});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_INPUT");
	});

	it("review/get 返回稿件详情", async () => {
		const fetched = await call("review/get", { article_id: ids["pending-b"] });
		expect(fetched.ok).toBe(true);
		expect(fetched.article.data.title).toBe("待审稿 B");
		expect(fetched.article.data.author_agent).toBe("dots");
	});

	it("review/reject 写入 rejected 与 review_note", async () => {
		const rejected = await call("review/reject", {
			article_id: ids["pending-a"],
			review_note: "事实需核实",
		});
		expect(rejected.ok).toBe(true);
		expect(rejected.status).toBe("rejected");

		const fetched = await call("review/get", { article_id: ids["pending-a"] });
		expect(fetched.article.data.review_status).toBe("rejected");
		expect(fetched.article.data.review_note).toBe("事实需核实");
	});

	it("review/request-changes 退回 draft", async () => {
		const result = await call("review/request-changes", {
			article_id: ids["pending-c"],
			review_note: "补充来源",
		});
		expect(result.status).toBe("draft");

		const fetched = await call("review/get", { article_id: ids["pending-c"] });
		expect(fetched.article.data.review_status).toBe("draft");
	});

	it("review/approve 设 approved 并发布", async () => {
		const approved = await call("review/approve", { article_id: ids["pending-d"] });
		expect(approved.ok).toBe(true);
		expect(approved.status).toBe("published");

		const fetched = await call("review/get", { article_id: ids["pending-d"] });
		expect(fetched.article.data.review_status).toBe("approved");
		expect(fetched.article.status).toBe("published");
	});

	it("review/reject 对不存在的稿件返回 NOT_FOUND", async () => {
		const result = await call("review/reject", { article_id: "does-not-exist" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("NOT_FOUND");
	});
});

describe("pulse-editorial 选题", () => {
	it("assignments/create 缺 brief 返回 INVALID_INPUT", async () => {
		const result = await call("assignments/create", { title: "只有标题" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_INPUT");
	});

	it("assignments/create 创建后可列出", async () => {
		const created = await call("assignments/create", {
			title: "报道城市夜间经济",
			brief: "走访三个夜市，聚焦小微摊主。",
			section: "business",
		});
		expect(created.ok).toBe(true);
		expect(created.status).toBe("open");

		const list = await call("assignments/list", { status: "open" });
		expect(list.ok).toBe(true);
		expect((list.assignments as Res[]).some((a) => a.title === "报道城市夜间经济")).toBe(true);
	});
});
