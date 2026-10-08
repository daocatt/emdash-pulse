import { validateBlocks } from "@emdash-cms/blocks";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import plugin from "../src/plugin";

// 插件只用 `ctx.storage`（不碰内容），但私有路由需要 `routeCtx.user`，
// 且后台页要跑宿主 Block Kit 校验 → 用 runtime 宿主。
let host: PluginRuntimeTestHost;

beforeAll(async () => {
	host = await createPluginRuntimeTestHost();
});

afterAll(async () => {
	await host?.dispose();
});

type Res = Record<string, any>;

const meta = {
	ip: "10.3.0.1",
	userAgent: null,
	referer: null,
	geo: { country: null, region: null, city: null },
};

/** 测试用户（`role`：10 Subscriber / 40 Editor / 50 Admin）。 */
const member = (id: string, role = 10) => ({
	id,
	email: `${id}@example.com`,
	name: id.toUpperCase(),
	role,
	createdAt: new Date().toISOString(),
});

/** 调私有路由并带上宿主解析的调用者身份。 */
const call = async (route: string, input: unknown, user?: ReturnType<typeof member>): Promise<Res> =>
	(await host.transport.invokeRoute(route, input, {
		method: "POST",
		headers: {},
		meta,
		...(user ? { user } : {}),
	} as never)) as Res;

type Block = {
	type?: string;
	text?: string;
	columns?: Array<{ key?: string; format?: string }>;
	rows?: Array<Record<string, unknown>>;
	elements?: Block[];
};
type AdminResult = { blocks: Block[]; toast?: { type: string; message: string } };

const expectValidBlocks = (blocks: Block[]) => {
	const { valid, errors } = validateBlocks(blocks, {});
	expect(errors).toEqual([]);
	expect(valid).toBe(true);
};

const ALICE = member("alice");
const ADMIN = member("admin", 50);

describe("pulse-editor-applications · 申请", () => {
	it("登录用户提交申请 → pending，身份取自 routeCtx.user", async () => {
		const result = await call("applications/submit", { purpose: "接入新闻聚合" }, ALICE);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("pending");
		expect(typeof result.application_id).toBe("string");
	});

	it("重复提交是幂等的：同一条记录、保留原始提交时间", async () => {
		const first = await call("applications/mine", {}, ALICE);
		const again = await call(
			"applications/submit",
			{ purpose: "接入新闻聚合（更新）", organization: "Acme" },
			ALICE,
		);
		expect(again.ok).toBe(true);
		expect(again.resubmitted).toBe(true);
		// 同一条记录：重新提交复用原 application_id。
		expect(again.application_id).toBe(first.application.application_id);

		const mine = await call("applications/mine", {}, ALICE);
		expect(mine.application.purpose).toBe("接入新闻聚合（更新）");
		expect(mine.application.organization).toBe("Acme");
	});

	it("匿名（无 user）提交 → UNAUTHORIZED", async () => {
		const result = await call("applications/submit", { purpose: "x" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("UNAUTHORIZED");
	});

	it("缺 purpose → INVALID_INPUT", async () => {
		const result = await call("applications/submit", {}, member("bob"));
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_INPUT");
	});

	it("已是 Editor 的用户 → already_editor，不建申请", async () => {
		const result = await call("applications/submit", { purpose: "x" }, member("editor", 40));
		expect(result.ok).toBe(true);
		expect(result.status).toBe("already_editor");
		const mine = await call("applications/mine", {}, member("editor", 40));
		expect(mine.is_editor).toBe(true);
		expect(mine.application).toBeNull();
	});

	it("mine 未提交时返回 null", async () => {
		const mine = await call("applications/mine", {}, member("carol"));
		expect(mine.ok).toBe(true);
		expect(mine.application).toBeNull();
	});
});

describe("pulse-editor-applications · 审批", () => {
	it("list 返回申请（管理员）", async () => {
		const result = await call("applications/list", {}, ADMIN);
		expect(result.ok).toBe(true);
		expect(result.count).toBeGreaterThanOrEqual(1);
		const alice = (result.applications as Res[]).find((item) => item.email === ALICE.email);
		expect(alice?.status).toBe("pending");
	});

	it("approve → approved，并提示去 Users 页改角色", async () => {
		const list = await call("applications/list", { status: "pending" }, ADMIN);
		const target = (list.applications as Res[]).find((item) => item.email === ALICE.email);
		const result = await call("applications/approve", { application_id: target.id }, ADMIN);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("approved");
		expect(String(result.next_step)).toContain("Users");
	});

	it("已批准的申请再次提交 → 保持 approved", async () => {
		const result = await call("applications/submit", { purpose: "再试一次" }, ALICE);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("approved");
	});

	it("reject → rejected 并记录说明", async () => {
		const dave = member("dave");
		const created = await call("applications/submit", { purpose: "测试驳回" }, dave);
		const result = await call(
			"applications/reject",
			{ application_id: created.application_id, note: "用途不明确" },
			ADMIN,
		);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("rejected");

		const mine = await call("applications/mine", {}, dave);
		expect(mine.application.status).toBe("rejected");
		expect(mine.application.note).toBe("用途不明确");
	});

	it("驳回后可重新提交 → 回到 pending", async () => {
		const mine = await call("applications/mine", {}, member("dave"));
		expect(mine.application.status).toBe("rejected");
		const again = await call("applications/submit", { purpose: "补充说明后重提" }, member("dave"));
		expect(again.status).toBe("pending");
	});

	it("未知 application_id → NOT_FOUND", async () => {
		const result = await call("applications/approve", { application_id: "ea_missing" }, ADMIN);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("NOT_FOUND");
	});
});

describe("pulse-editor-applications · 后台页", () => {
	it("后台页渲染合法 Block Kit，pending 行带操作菜单", async () => {
		const page = (await host.admin.loadPage("/editor-applications", { user: ADMIN })) as AdminResult;
		expectValidBlocks(page.blocks);

		const table = page.blocks.find((block) => block.type === "table");
		expect(table).toBeTruthy();
		expect(table?.columns?.some((column) => column.key === "action" && column.format === "element")).toBe(true);
	});

	it("后台派发批准动作 → 写入状态并回 toast", async () => {
		// 造一条 pending。
		const erin = member("erin");
		const created = await call("applications/submit", { purpose: "后台页批准测试" }, erin);

		const response = (await host.admin.act("/editor-applications", "editor-application-decision", {
			user: ADMIN,
			value: `approve:${created.application_id}`,
		})) as AdminResult;

		expect(response.toast).toMatchObject({ type: "success" });
		expect(String(response.toast?.message)).toContain(erin.email);

		const mine = await call("applications/mine", {}, erin);
		expect(mine.application.status).toBe("approved");
	});
});

describe("pulse-editor-applications · MCP 工具声明", () => {
	it("三个工具都引用私有 POST JSON 路由", () => {
		const tools = plugin.mcp?.tools ?? {};
		const names = Object.keys(tools);
		expect(names).toEqual(
			expect.arrayContaining([
				"listEditorApplications",
				"approveEditorApplication",
				"rejectEditorApplication",
			]),
		);

		for (const tool of Object.values(tools)) {
			const route = (plugin.routes as Record<string, { public?: boolean; methods?: string[] }>)[tool.route];
			expect(route, `route ${tool.route} 必须存在`).toBeTruthy();
			expect(route.public ?? false).toBe(false);
			expect(route.methods).toContain("POST");
		}
	});
});
