import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_SETTINGS,
	baselineDecision,
	classifyWithAi,
	decide,
	parseLlamaGuard,
	rulesDecision,
	runRules,
	type CommentInput,
	type ModerationSettings,
} from "../src/moderation";

const comment = (overrides: Partial<CommentInput> = {}): CommentInput => ({
	body: "这是一条正常的读者评论。",
	authorName: "读者甲",
	authorEmail: "reader@example.com",
	authorUserId: null,
	...overrides,
});

const settings = (overrides: Partial<ModerationSettings> = {}): ModerationSettings => ({
	...DEFAULT_SETTINGS,
	...overrides,
});

const collectionSettings = (
	overrides: Partial<{ commentsModeration: "all" | "first_time" | "none"; commentsAutoApproveUsers: boolean }> = {},
) => ({
	commentsModeration: "all" as const,
	commentsAutoApproveUsers: false,
	...overrides,
});

/** 永不调用的 fetcher：用于断言「不该发起网络请求」。 */
const noNetwork = () => vi.fn(() => Promise.reject(new Error("network should not be called")));

const aiFetch = (response: string, ok = true) =>
	vi.fn(async () =>
		ok
			? new Response(JSON.stringify({ result: { response } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			: new Response("boom", { status: 500 }),
	);

describe("runRules 规则引擎", () => {
	it("正常评论无命中", () => {
		expect(runRules(comment(), settings())).toEqual([]);
	});

	it("链接超限判 spam", () => {
		const hits = runRules(
			comment({ body: "看 https://a.com https://b.com https://c.com https://d.com" }),
			settings({ maxLinks: 3 }),
		);
		expect(rulesDecision(hits)?.status).toBe("spam");
		expect(hits.map((h) => h.code)).toContain("link_flood");
	});

	it("黑名单词命中判 spam（不区分大小写、支持中文逗号分隔）", () => {
		const hits = runRules(comment({ body: "这里有 SPAM 字样" }), settings({ bannedWords: ["spam", "赌场"] }));
		expect(rulesDecision(hits)).toMatchObject({ status: "spam" });
	});

	it("正文过短判 spam", () => {
		const hits = runRules(comment({ body: "a" }), settings({ minLength: 2 }));
		expect(rulesDecision(hits)?.status).toBe("spam");
	});

	it("正文过长转待审", () => {
		const hits = runRules(comment({ body: "字".repeat(50) }), settings({ maxLength: 10 }));
		expect(rulesDecision(hits)?.status).toBe("pending");
	});

	it("疑似引流（联系方式）转待审", () => {
		const hits = runRules(comment({ body: "加我微信 abc123456 详聊" }), settings());
		expect(rulesDecision(hits)?.status).toBe("pending");
		expect(hits.map((h) => h.code)).toContain("contact_spam");
	});

	it("大量重复字符转待审", () => {
		const hits = runRules(comment({ body: `好${"！".repeat(20)}` }), settings());
		expect(rulesDecision(hits)?.status).toBe("pending");
	});

	it("原始 HTML 判 spam", () => {
		const hits = runRules(comment({ body: '<script>alert(1)</script>' }), settings());
		expect(rulesDecision(hits)?.status).toBe("spam");
	});

	it("昵称含链接判 spam", () => {
		const hits = runRules(comment({ authorName: "推广 https://spam.example" }), settings());
		expect(rulesDecision(hits)?.status).toBe("spam");
	});

	it("关闭规则后退化为无命中", () => {
		const hits = runRules(comment({ body: '<script>x</script>' }), settings({ rulesEnabled: false }));
		expect(hits).toEqual([]);
	});

	it("spam 优先于 pending", () => {
		const hits = runRules(
			comment({ body: "加我微信 abc123 https://a.com https://b.com https://c.com https://d.com" }),
			settings({ maxLinks: 1 }),
		);
		expect(rulesDecision(hits)?.status).toBe("spam");
	});
});

describe("baselineDecision 复刻内置逻辑", () => {
	it("登录用户 + 自动通过开关 → approved", () => {
		const d = baselineDecision(comment({ authorUserId: "u1" }), collectionSettings({ commentsAutoApproveUsers: true }), 0);
		expect(d.status).toBe("approved");
	});

	it("moderation=none → approved", () => {
		expect(baselineDecision(comment(), collectionSettings({ commentsModeration: "none" }), 0).status).toBe("approved");
	});

	it("first_time 且老读者 → approved", () => {
		expect(baselineDecision(comment(), collectionSettings({ commentsModeration: "first_time" }), 2).status).toBe("approved");
	});

	it("first_time 但首次 → pending", () => {
		expect(baselineDecision(comment(), collectionSettings({ commentsModeration: "first_time" }), 0).status).toBe("pending");
	});

	it("默认 → pending", () => {
		expect(baselineDecision(comment(), collectionSettings(), 0).status).toBe("pending");
	});
});

describe("parseLlamaGuard", () => {
	it("safe", () => {
		expect(parseLlamaGuard({ result: { response: "safe" } })).toMatchObject({ ok: true, unsafe: false });
	});

	it("unsafe + 类别", () => {
		const r = parseLlamaGuard({ result: { response: "unsafe\nS1,S6" } });
		expect(r).toMatchObject({ ok: true, unsafe: true });
		expect(r.categories).toEqual(["S1", "S6"]);
	});

	it("形状异常", () => {
		expect(parseLlamaGuard({})).toMatchObject({ ok: false });
	});
});

describe("classifyWithAi", () => {
	it("未启用时不发请求", async () => {
		const fetcher = noNetwork();
		const r = await classifyWithAi(fetcher, comment(), settings({ aiEnabled: false }));
		expect(r.ok).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("启用但缺凭证时不发请求", async () => {
		const fetcher = noNetwork();
		const r = await classifyWithAi(fetcher, comment(), settings({ aiEnabled: true, aiAccountId: "", aiApiToken: "" }));
		expect(r).toMatchObject({ ok: false, error: "not_configured" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("HTTP 失败返回 ok:false", async () => {
		const r = await classifyWithAi(
			aiFetch("", false),
			comment(),
			settings({ aiEnabled: true, aiAccountId: "acc", aiApiToken: "tok" }),
		);
		expect(r).toMatchObject({ ok: false, error: "http_500" });
	});

	it("网络抛错返回 ok:false（不冒泡）", async () => {
		const r = await classifyWithAi(
			() => Promise.reject(new Error("dns")),
			comment(),
			settings({ aiEnabled: true, aiAccountId: "acc", aiApiToken: "tok" }),
		);
		expect(r.ok).toBe(false);
	});
});

describe("decide 组合", () => {
	it("规则判 spam 时不调用 AI", async () => {
		const fetcher = noNetwork();
		const d = await decide({
			comment: comment({ body: '<script>x</script>' }),
			collectionSettings: collectionSettings(),
			priorApprovedCount: 0,
			settings: settings({ aiEnabled: true, aiAccountId: "a", aiApiToken: "t" }),
			fetcher,
		});
		expect(d.status).toBe("spam");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("AI 判 unsafe → spam", async () => {
		const d = await decide({
			comment: comment(),
			collectionSettings: collectionSettings({ commentsModeration: "none" }),
			priorApprovedCount: 0,
			settings: settings({ aiEnabled: true, aiAccountId: "a", aiApiToken: "t" }),
			fetcher: aiFetch("unsafe\nS1"),
		});
		expect(d.status).toBe("spam");
		expect(d.reason).toContain("S1");
	});

	it("AI 失败时降级，绝不自动通过", async () => {
		const d = await decide({
			comment: comment(),
			collectionSettings: collectionSettings({ commentsModeration: "all" }),
			priorApprovedCount: 0,
			settings: settings({ aiEnabled: true, aiAccountId: "a", aiApiToken: "t" }),
			fetcher: () => Promise.reject(new Error("timeout")),
		});
		expect(d.status).toBe("pending");
	});

	it("AI 判 safe 且未开自动通过 → 仍待审", async () => {
		const d = await decide({
			comment: comment(),
			collectionSettings: collectionSettings(),
			priorApprovedCount: 0,
			settings: settings({ aiEnabled: true, aiAccountId: "a", aiApiToken: "t", aiAutoApprove: false }),
			fetcher: aiFetch("safe"),
		});
		expect(d.status).toBe("pending");
	});

	it("AI 判 safe 且开自动通过 → approved", async () => {
		const d = await decide({
			comment: comment(),
			collectionSettings: collectionSettings(),
			priorApprovedCount: 0,
			settings: settings({ aiEnabled: true, aiAccountId: "a", aiApiToken: "t", aiAutoApprove: true }),
			fetcher: aiFetch("safe"),
		});
		expect(d.status).toBe("approved");
	});

	it("无 AI 时正常评论走内置逻辑（pending）", async () => {
		const d = await decide({
			comment: comment(),
			collectionSettings: collectionSettings(),
			priorApprovedCount: 0,
			settings: settings(),
			fetcher: noNetwork(),
		});
		expect(d.status).toBe("pending");
	});

	it("无 AI 时 moderation=none 正常通过", async () => {
		const d = await decide({
			comment: comment(),
			collectionSettings: collectionSettings({ commentsModeration: "none" }),
			priorApprovedCount: 0,
			settings: settings(),
			fetcher: noNetwork(),
		});
		expect(d.status).toBe("approved");
	});
});
