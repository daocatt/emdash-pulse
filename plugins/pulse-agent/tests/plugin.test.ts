import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPluginTestHost, type PluginTestHost } from "@emdash-cms/plugin-test";

// 沙箱 runner（workerd）启动成本高，整个文件复用同一个 host；
// 用例之间用不同的 slug / IP 隔离，避免限流与唯一索引互相干扰。
let host: PluginTestHost;

beforeAll(async () => {
	host = await createPluginTestHost();
});

afterAll(async () => {
	await host?.dispose();
});

type Res = Record<string, any>;

/** raw 路由在测试宿主里回传 pluginResponse 对象（body 是 JSON 字符串）。 */
type RawResponse = {
	__emdashPluginResponse?: true;
	status?: number;
	body?: { kind: string; value: string };
};

let ipSeq = 0;
const nextIp = (): string => {
	ipSeq += 1;
	return `10.1.0.${ipSeq}`;
};

const meta = (ip: string) => ({
	ip,
	userAgent: null,
	referer: null,
	geo: { country: null, region: null, city: null },
});

const postReq = (ip = nextIp(), headers: Record<string, string> = {}) => ({
	method: "POST",
	headers,
	meta: meta(ip),
});

const getReq = (headers: Record<string, string> = {}, ip = nextIp()) => ({
	method: "GET",
	headers,
	meta: meta(ip),
});

/**
 * 调用路由。公开路由为 raw（返回 pluginResponse），这里拆出 HTTP 状态码到
 * `__status`，body 展开到顶层，使断言写法与 JSON 路由一致。
 */
const call = async (route: string, input: unknown, request: unknown): Promise<Res> => {
	const res = (await host.invokeRoute(route, input, request as never)) as RawResponse & Res;
	if (res && res.__emdashPluginResponse) {
		const body = res.body?.value ? (JSON.parse(res.body.value) as Res) : {};
		return { ...body, __status: res.status ?? 200 };
	}
	return res as Res;
};

const register = (slug: string, ip = nextIp()): Promise<Res> =>
	call("agents/register", { slug, name: slug.toUpperCase() }, postReq(ip));

describe("pulse-agent 注册与审批", () => {
	it("自助注册返回 agent_id 与一次性 secret，状态为 pending", async () => {
		const result = await register("muse");
		expect(result.ok).toBe(true);
		expect(result.__status).toBe(200);
		expect(result.status).toBe("pending");
		expect(typeof result.agent_id).toBe("string");
		expect(typeof result.registration_secret).toBe("string");
	});

	it("拒绝非法 slug", async () => {
		const result = await register("Bad Slug!");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_INPUT");
		expect(result.__status).toBe(400);
	});

	it("slug 重复返回 SLUG_TAKEN", async () => {
		await register("dots");
		const again = await call("agents/register", { slug: "dots", name: "Dots" }, postReq());
		expect(again.ok).toBe(false);
		expect(again.error).toBe("SLUG_TAKEN");
		expect(again.__status).toBe(409);
	});

	it("用 secret 查询审批状态", async () => {
		const created = await register("atlas");
		const status = await call(
			"agents/status",
			{ agent_id: created.agent_id, registration_secret: created.registration_secret },
			postReq(),
		);
		expect(status.ok).toBe(true);
		expect(status.__status).toBe(200);
		expect(status.status).toBe("pending");
	});

	it("错误 secret 返回 NOT_FOUND", async () => {
		const created = await register("vega");
		const status = await call(
			"agents/status",
			{ agent_id: created.agent_id, registration_secret: "wrong-secret" },
			postReq(),
		);
		expect(status.ok).toBe(false);
		expect(status.error).toBe("NOT_FOUND");
		expect(status.__status).toBe(404);
	});

	it("超过注册限流返回 RATE_LIMITED", async () => {
		const ip = "203.0.113.9";
		for (let i = 0; i < 5; i += 1) {
			const r = await call("agents/register", { slug: `bulk-${i}`, name: `Bulk ${i}` }, postReq(ip));
			expect(r.ok).toBe(true);
		}
		const blocked = await call("agents/register", { slug: "bulk-x", name: "X" }, postReq(ip));
		expect(blocked.ok).toBe(false);
		expect(blocked.error).toBe("RATE_LIMITED");
		expect(blocked.__status).toBe(429);
	});
});

describe("pulse-agent 身份校验", () => {
	it("批准后签发 token，token 可用于 whoami", async () => {
		const created = await register("cygnus");
		const approved = await call("agents/approve", { agent_id: created.agent_id }, postReq());
		expect(approved.ok).toBe(true);
		expect(typeof approved.token).toBe("string");
		expect(approved.token.startsWith("sp_cygnus_")).toBe(true);

		const who = await call("agents/whoami", undefined, getReq({ "x-agent-token": approved.token }));
		expect(who.ok).toBe(true);
		expect(who.__status).toBe(200);
		expect(who.slug).toBe("cygnus");
		expect(who.status).toBe("approved");
	});

	it("无 token 的 whoami 返回 UNAUTHORIZED（401）", async () => {
		const who = await call("agents/whoami", undefined, getReq());
		expect(who.ok).toBe(false);
		expect(who.error).toBe("UNAUTHORIZED");
		expect(who.__status).toBe(401);
	});

	it("错误 token 返回 UNAUTHORIZED（401）", async () => {
		const who = await call("agents/whoami", undefined, getReq({ "x-agent-token": "sp_nope_deadbeef" }));
		expect(who.ok).toBe(false);
		expect(who.error).toBe("UNAUTHORIZED");
		expect(who.__status).toBe(401);
	});

	it("撤销后 token 立即失效", async () => {
		const created = await register("verne");
		const approved = await call("agents/approve", { agent_id: created.agent_id }, postReq());
		await call("agents/revoke", { agent_id: created.agent_id }, postReq());

		const who = await call("agents/whoami", undefined, getReq({ "x-agent-token": approved.token }));
		expect(who.ok).toBe(false);
		expect(who.error).toBe("UNAUTHORIZED");
		expect(who.__status).toBe(401);
	});

	it("未批准的注册密钥不能当 token 用", async () => {
		const created = await register("hermes");
		const who = await call(
			"agents/whoami",
			undefined,
			getReq({ "x-agent-token": created.registration_secret }),
		);
		expect(who.ok).toBe(false);
		expect(who.error).toBe("UNAUTHORIZED");
		expect(who.__status).toBe(401);
	});

	it("agents/list 返回注册记录", async () => {
		const created = await register("orion");
		await call("agents/approve", { agent_id: created.agent_id }, postReq());
		const list = await call("agents/list", { status: "approved" }, postReq());
		expect(list.ok).toBe(true);
		expect(list.agents.some((a: Res) => a.slug === "orion")).toBe(true);
	});
});
