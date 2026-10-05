import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

// 投稿走真实内容写动作（create），必须用 runtime 宿主。
// agent 身份直接写入插件存储（省去审批流程），token 用 Node 侧 SHA-256 对齐。
const TOKEN = "sp_muse_submittoken";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

let host: PluginRuntimeTestHost;

beforeAll(async () => {
	host = await createPluginRuntimeTestHost();
	await host.fixtures.collection({
		slug: "articles",
		label: "Articles",
		fields: [
			{ slug: "title", label: "标题", type: "string" },
			{ slug: "deck", label: "导语", type: "text" },
			{ slug: "excerpt", label: "摘要", type: "text" },
			{ slug: "content", label: "正文", type: "portableText" },
			{ slug: "review_status", label: "审核状态", type: "string", indexed: true },
			{ slug: "author_agent", label: "作者 Agent", type: "string", indexed: true },
			{ slug: "source_url", label: "原文链接", type: "url", indexed: true },
			{ slug: "source", label: "来源", type: "string" },
			{ slug: "article_type", label: "类型", type: "string" },
			{ slug: "priority", label: "权重", type: "string" },
		],
	});

	await host.fixtures.plugin.storage("agents", "ag_muse", {
		slug: "muse",
		name: "Muse",
		status: "approved",
		scopes: ["submit", "claim", "subscribe"],
		tokenHash: TOKEN_HASH,
		tokenPrefix: "sp_muse_subm",
		registrationSecretHash: "irrelevant",
		requestedAt: "2026-10-05T00:00:00.000Z",
	});
});

afterAll(async () => {
	await host?.dispose();
});

type Res = Record<string, any>;

const submit = async (body: Record<string, unknown>, token: string = TOKEN): Promise<Res> =>
	(await host.transport.invokeRoute("submissions/submit", body, {
		method: "POST",
		headers: { "x-agent-token": token },
		meta: { ip: "10.4.0.1", userAgent: null, referer: null, geo: { country: null, region: null, city: null } },
	} as never)) as Res;

describe("pulse-agent 投稿", () => {
	it("投稿创建 pending_review 稿件并署名 author_agent", async () => {
		const result = await submit({
			title: "夜市里的经济学",
			body: "## 小标题\n\n这是**正文**第一段。\n\n- 要点一\n- 要点二",
		});
		expect(result.ok).toBe(true);
		expect(result.status).toBe("pending_review");
		expect(result.author_agent).toBe("muse");

		const item = await host.inspect.content.get("articles", result.article_id);
		expect(item?.data.review_status).toBe("pending_review");
		expect(item?.data.author_agent).toBe("muse");
		expect(item?.data.title).toBe("夜市里的经济学");
		// markdown 已转成 Portable Text 块
		expect(Array.isArray(item?.data.content)).toBe(true);
		expect((item?.data.content as unknown[]).length).toBeGreaterThan(0);
	});

	it("无 token 投稿被拒", async () => {
		const result = await submit({ title: "x" }, "sp_nope_bad");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("UNAUTHORIZED");
	});

	it("缺 title 返回 INVALID_INPUT", async () => {
		const result = await submit({ body: "无标题" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_INPUT");
	});

	it("同一 source_url 重复投稿幂等", async () => {
		const first = await submit({
			title: "城市夜行记",
			body: "第一版正文。",
			source_url: "https://example.com/night-walk",
		});
		expect(first.ok).toBe(true);
		expect(first.duplicate).toBeUndefined();

		const second = await submit({
			title: "城市夜行记（重复）",
			body: "重复正文。",
			source_url: "https://example.com/night-walk",
		});
		expect(second.ok).toBe(true);
		expect(second.duplicate).toBe(true);
		expect(second.article_id).toBe(first.article_id);
	});

	it("submissions/mine 只返回自己的投稿", async () => {
		const mine = (await host.transport.invokeRoute("submissions/mine", undefined, {
			method: "GET",
			headers: { "x-agent-token": TOKEN },
			meta: { ip: "10.4.0.2", userAgent: null, referer: null, geo: { country: null, region: null, city: null } },
		} as never)) as Res;

		expect(mine.ok).toBe(true);
		expect(mine.count).toBeGreaterThan(0);
		expect((mine.submissions as Res[]).every((s) => s.status === "pending_review")).toBe(true);
	});
});
