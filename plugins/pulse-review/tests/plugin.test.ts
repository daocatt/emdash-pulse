import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPluginTestHost, type PluginTestHost } from "@emdash-cms/plugin-test";

// 沙箱 runner（workerd）启动成本高，整个文件复用同一个 host。
let host: PluginTestHost;

beforeAll(async () => {
	host = await createPluginTestHost();
});

afterAll(async () => {
	await host?.dispose();
});

const baseEvent = (reviewStatus: string, collection = "articles") => ({
	collection,
	origin: "api",
	content: { data: { review_status: reviewStatus } },
});

describe("pulse-review 发布门禁", () => {
	it("未 approved 的文章拒绝发布", async () => {
		const result = await host.invokeHook("content:beforePublish", baseEvent("pending_review"));
		expect(result).toMatchObject({ cancel: true });
	});

	it("approved 的文章允许发布", async () => {
		const result = await host.invokeHook("content:beforePublish", baseEvent("approved"));
		expect(result == null).toBe(true);
	});

	it("忽略其他集合", async () => {
		const result = await host.invokeHook("content:beforePublish", baseEvent("draft", "pages"));
		expect(result == null).toBe(true);
	});

	it("未 approved 的文章拒绝定时发布", async () => {
		const result = await host.invokeHook("content:beforeSchedule", baseEvent("draft"));
		expect(result).toMatchObject({ cancel: true });
	});
});

// ---------- 评论审核（独占 hook）----------

type Decision = { status: string; reason?: string } | null;

const moderateEvent = (body: string, overrides: Record<string, unknown> = {}) => ({
	comment: {
		collection: "articles",
		contentId: "c1",
		parentId: null,
		authorName: "读者甲",
		authorEmail: "reader@example.com",
		authorUserId: null,
		body,
		ipHash: null,
		userAgent: null,
	},
	metadata: {},
	collectionSettings: {
		commentsEnabled: true,
		commentsModeration: "all",
		commentsClosedAfterDays: 0,
		commentsAutoApproveUsers: false,
	},
	priorApprovedCount: 0,
	...overrides,
});

const moderate = (body: string, overrides: Record<string, unknown> = {}): Promise<Decision> =>
	host.invokeHook("comment:moderate", moderateEvent(body, overrides)) as Promise<Decision>;

describe("pulse-review 评论审核 hook", () => {
	it("正常评论 → pending（默认审核全开）", async () => {
		const decision = await moderate("这条评论内容正常，只是表达观点。");
		expect(decision?.status).toBe("pending");
	});

	it("原始 HTML → spam", async () => {
		const decision = await moderate('<script>alert("x")</script>');
		expect(decision?.status).toBe("spam");
		expect(decision?.reason).toContain("规则");
	});

	it("链接超限 → spam", async () => {
		const decision = await moderate("https://a.com https://b.com https://c.com https://d.com 看看");
		expect(decision?.status).toBe("spam");
	});

	it("复刻内置：moderation=none → approved", async () => {
		const decision = await moderate("随便说说。", {
			collectionSettings: {
				commentsEnabled: true,
				commentsModeration: "none",
				commentsClosedAfterDays: 0,
				commentsAutoApproveUsers: false,
			},
		});
		expect(decision?.status).toBe("approved");
	});

	it("复刻内置：登录用户 + 自动通过 → approved", async () => {
		const decision = await moderate("我是编辑。", {
			comment: {
				collection: "articles",
				contentId: "c1",
				parentId: null,
				authorName: "编辑",
				authorEmail: "editor@example.com",
				authorUserId: "u1",
				body: "我是编辑。",
				ipHash: null,
				userAgent: null,
			},
			collectionSettings: {
				commentsEnabled: true,
				commentsModeration: "all",
				commentsClosedAfterDays: 0,
				commentsAutoApproveUsers: true,
			},
		});
		expect(decision?.status).toBe("approved");
	});

	it("复刻内置：first_time 且老读者 → approved", async () => {
		const decision = await moderate("又来评论了。", {
			priorApprovedCount: 3,
			collectionSettings: {
				commentsEnabled: true,
				commentsModeration: "first_time",
				commentsClosedAfterDays: 0,
				commentsAutoApproveUsers: false,
			},
		});
		expect(decision?.status).toBe("approved");
	});
});
