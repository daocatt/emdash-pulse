import { describe, expect, it } from "vitest";

import plugin from "../src/plugin";

/** Block Kit 元素（只声明测试用到的字段）。 */
type Block = {
	type?: string;
	text?: string;
	action_id?: string;
	initial_value?: string;
	options?: Array<{ label: string; value: string }>;
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

const radio = (result: AdminResult): Block => {
	const element = result.blocks.find((block) => block.type === "radio");
	if (!element) throw new Error("radio block is missing");
	return element;
};

describe("pulse-theme · admin", () => {
	it("首次打开：渲染两套主题的 radio，初始值为默认主题", async () => {
		const { ctx } = fakeCtx();
		const result = await runAdmin(ctx, {});

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

		expect(store.has("theme")).toBe(false);
		expect(result.toast).toMatchObject({ type: "error" });
		expect(radio(result).initial_value).toBe("news-factory");
	});
});
