import { validateBlocks } from "@emdash-cms/blocks";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import plugin from "../src/plugin";

/** Block Kit 元素（只声明测试用到的字段）。 */
type Block = {
	type?: string;
	text?: string;
	action_id?: string;
	initial_value?: string;
	options?: Array<{ label: string; value: string }>;
	elements?: Block[];
};

type AdminResult = {
	blocks: Block[];
	toast?: { type: string; message: string };
};

/** 内存版插件设置，替代宿主的 options 表。 */
function fakeCtx() {
	const store = new Map<string, unknown>();
	return {
		store,
		ctx: {
			settings: {
				get: async (key: string): Promise<unknown> => (store.has(key) ? store.get(key) : null),
				set: async (key: string, value: unknown): Promise<void> => {
					store.set(key, value);
				},
			},
		},
	};
}

/** 直接调用 `admin` 路由处理器（纯函数，不需要 runtime 宿主）。 */
async function runAdmin(ctx: unknown, input: Record<string, unknown>): Promise<AdminResult> {
	const route = (plugin.routes as Record<string, { handler?: unknown }> | undefined)?.admin;
	const handler = route?.handler;
	if (typeof handler !== "function") throw new Error("admin route handler is not a function");
	return (await handler({ input }, ctx)) as AdminResult;
}

/**
 * 从 `actions` 块里取出 radio **元素**。
 *
 * `radio` 是元素不是块：顶层 `blocks[]` 只接受块类型，元素必须嵌在 `actions` / `form`
 * 内，否则宿主校验会直接回 502 INVALID_BLOCK_RESPONSE。
 */
const radio = (result: AdminResult): Block => {
	for (const block of result.blocks) {
		const element = block.elements?.find((child) => child.type === "radio");
		if (element) return element;
	}
	throw new Error("radio element is missing");
};

/** 宿主会对每个响应跑一遍 Block Kit 校验（就是 502 的来源），测试里同步复核。 */
const expectValidBlocks = (result: AdminResult) => {
	const { valid, errors } = validateBlocks(result.blocks, {});
	expect(errors).toEqual([]);
	expect(valid).toBe(true);
};

describe("pulse-theme · admin", () => {
	it("首次打开：渲染两套主题的 radio，初始值为默认主题", async () => {
		const { ctx } = fakeCtx();
		const result = await runAdmin(ctx, {});

		expectValidBlocks(result);

		const element = radio(result);
		expect(element.action_id).toBe("theme-switch");
		expect(element.options?.map((option) => option.value)).toEqual(["news-factory", "pulse-news"]);
		expect(element.initial_value).toBe("news-factory");
		expect(result.blocks[0]).toMatchObject({ type: "header", text: "前台主题" });
	});

	it("切换主题：写入插件设置并回 toast", async () => {
		const { ctx, store } = fakeCtx();
		const result = await runAdmin(ctx, {
			type: "block_action",
			action_id: "theme-switch",
			value: "pulse-news",
		});

		expectValidBlocks(result);

		expect(store.get("theme")).toBe("pulse-news");
		expect(result.toast).toMatchObject({ type: "success" });
		expect(radio(result).initial_value).toBe("pulse-news");
	});

	it("未知主题：拒绝写入并回 error toast", async () => {
		const { ctx, store } = fakeCtx();
		const result = await runAdmin(ctx, {
			type: "block_action",
			action_id: "theme-switch",
			value: "maple-news",
		});

		expectValidBlocks(result);

		expect(store.has("theme")).toBe(false);
		expect(result.toast).toMatchObject({ type: "error" });
		expect(radio(result).initial_value).toBe("news-factory");
	});
});

// ---------- 宿主端到端（走真实 runtime 宿主，含 Block Kit 校验）----------

// 上面的纯函数用例绕过了宿主校验；这一组直接跑宿主 `admin.loadPage` / `admin.act`，
// 覆盖 502 INVALID_BLOCK_RESPONSE 那条路径（workerd 启动成本高，整个文件复用一个 host）。
let host: PluginRuntimeTestHost;
/** 宿主 fixtures 的 email 有唯一索引，只建一次用户。 */
let user: Awaited<ReturnType<PluginRuntimeTestHost["fixtures"]["user"]>>;

beforeAll(async () => {
	host = await createPluginRuntimeTestHost();
	user = await host.fixtures.user({ email: "dev@suda.im", role: "admin" });
});

afterAll(async () => {
	await host?.dispose();
});

describe("pulse-theme · 宿主后台页", () => {
	it("加载后台页：宿主校验通过并返回 actions 包裹的 radio", async () => {
		const response = await host.admin.loadPage("/theme", { user });

		const { valid, errors } = validateBlocks(response.blocks, {});
		expect(errors).toEqual([]);
		expect(valid).toBe(true);

		const element = radio(response as AdminResult);
		expect(element.action_id).toBe("theme-switch");
		expect(element.initial_value).toBe("news-factory");
	});

	it("切换主题：宿主派发 block_action 后写入设置", async () => {
		const response = await host.admin.act("/theme", "theme-switch", { user, value: "pulse-news" });

		expect(response.toast).toMatchObject({ type: "success" });
		expect(radio(response as AdminResult).initial_value).toBe("pulse-news");
	});
});
