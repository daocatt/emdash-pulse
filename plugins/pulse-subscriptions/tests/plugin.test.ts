import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

// 订阅涉及邮件投递（需 runtime 宿主注入 email provider + inspect.email 捕获），
// 故用 runtime 宿主；用例之间用不同邮箱 / IP 隔离，避免限流与唯一索引互相干扰。
let host: PluginRuntimeTestHost;

beforeAll(async () => {
	host = await createPluginRuntimeTestHost();
});

afterAll(async () => {
	await host?.dispose();
});

type Res = Record<string, any>;

type RawResponse = {
	__emdashPluginResponse?: true;
	status?: number;
	body?: { kind: string; value: string };
};

let ipSeq = 0;
const nextIp = (): string => {
	ipSeq += 1;
	return `10.9.0.${ipSeq}`;
};

const meta = (ip: string) => ({
	ip,
	userAgent: null,
	referer: null,
	geo: { country: null, region: null, city: null },
});

/** 调用路由并解包 raw（pluginResponse）信封，把 HTTP 状态码放到 `__status`。 */
const invoke = async (route: string, input: unknown, ip = nextIp()): Promise<Res> => {
	const res = (await host.transport.invokeRoute(route, input, {
		method: "POST",
		headers: {},
		meta: meta(ip),
	} as never)) as RawResponse & Res;
	if (res && res.__emdashPluginResponse) {
		const body = res.body?.value ? (JSON.parse(res.body.value) as Res) : {};
		return { ...body, __status: res.status ?? 200 };
	}
	return res as Res;
};

const tokenFrom = (text: string): string => {
	const match = /[?&]token=([A-Za-z0-9_]+)/.exec(text);
	if (!match) throw new Error(`邮件里没有 token：${text}`);
	return match[1];
};

const lastEmail = async (): Promise<Record<string, any>> => {
	const mails = await host.inspect.email();
	return mails[mails.length - 1] as Record<string, any>;
};

/** 走完「提交 → 确认」，返回订阅管理 token（确认后同一 token 用于退订）。 */
const subscribeAndConfirm = async (email: string): Promise<string> => {
	await invoke("subscribe/request", { email });
	const confirmToken = tokenFrom(String((await lastEmail()).text));
	const confirmed = await invoke("subscribe/confirm", { token: confirmToken });
	expect(confirmed.status).toBe("confirmed");
	return confirmToken;
};

describe("pulse-subscriptions 双确认订阅", () => {
	it("提交邮箱建 pending 并发确认邮件", async () => {
		const email = "reader@example.com";
		const result = await invoke("subscribe/request", { email });

		expect(result.ok).toBe(true);
		expect(result.__status).toBe(200);
		expect(result.status).toBe("pending");
		expect(result.delivered).toBe(true);

		const mail = await lastEmail();
		expect(mail.to).toBe(email);
		expect(String(mail.subject)).toContain("确认订阅");
		expect(tokenFrom(String(mail.text)).startsWith("ps_confirm_")).toBe(true);
	});

	it("非法邮箱返回 INVALID_INPUT（400）", async () => {
		const result = await invoke("subscribe/request", { email: "not-an-email" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_INPUT");
		expect(result.__status).toBe(400);
	});

	it("确认 token 转 confirmed 并发欢迎邮件（含退订链接）", async () => {
		const email = "confirm@example.com";
		await invoke("subscribe/request", { email });
		const confirmToken = tokenFrom(String((await lastEmail()).text));

		const confirmed = await invoke("subscribe/confirm", { token: confirmToken });
		expect(confirmed.ok).toBe(true);
		expect(confirmed.__status).toBe(200);
		expect(confirmed.status).toBe("confirmed");
		expect(confirmed.delivered).toBe(true);

		const welcome = await lastEmail();
		expect(welcome.to).toBe(email);
		expect(String(welcome.subject)).toContain("欢迎订阅");
		// 确认后同一 token 转为订阅管理（退订）用途。
		expect(tokenFrom(String(welcome.text))).toBe(confirmToken);
	});

	it("确认后同一 token 再次确认幂等", async () => {
		const token = await subscribeAndConfirm("swap@example.com");
		const again = await invoke("subscribe/confirm", { token });
		expect(again.ok).toBe(true);
		expect(again.status).toBe("confirmed");
		expect(again.already).toBe(true);
	});

	it("错误 token 返回 INVALID_TOKEN（400）", async () => {
		const result = await invoke("subscribe/confirm", { token: "ps_confirm_deadbeefdeadbeef" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_TOKEN");
		expect(result.__status).toBe(400);
	});

	it("退订 token 转 unsubscribed", async () => {
		const unsubToken = await subscribeAndConfirm("bye@example.com");
		const result = await invoke("unsubscribe", { token: unsubToken });
		expect(result.ok).toBe(true);
		expect(result.__status).toBe(200);
		expect(result.status).toBe("unsubscribed");

		// 重复退订幂等。
		const again = await invoke("unsubscribe", { token: unsubToken });
		expect(again.status).toBe("unsubscribed");
		expect(again.already).toBe(true);
	});

	it("退订后 token 失效", async () => {
		const token = await subscribeAndConfirm("gone@example.com");
		await invoke("unsubscribe", { token });

		const result = await invoke("subscribe/confirm", { token });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_TOKEN");
		expect(result.__status).toBe(400);
	});

	it("已确认邮箱重复提交幂等且不再发信", async () => {
		const email = "idem@example.com";
		await subscribeAndConfirm(email);
		const before = (await host.inspect.email()).length;

		const again = await invoke("subscribe/request", { email });
		expect(again.status).toBe("confirmed");
		expect(again.already).toBe(true);
		expect(again.delivered).toBe(false);
		expect((await host.inspect.email()).length).toBe(before);
	});

	it("退订后可重新订阅（回到 pending）", async () => {
		const email = "again@example.com";
		const unsubToken = await subscribeAndConfirm(email);
		await invoke("unsubscribe", { token: unsubToken });

		const result = await invoke("subscribe/request", { email });
		expect(result.status).toBe("pending");
		expect(result.delivered).toBe(true);
		expect(tokenFrom(String((await lastEmail()).text)).startsWith("ps_confirm_")).toBe(true);
	});

	it("超过提交限流返回 RATE_LIMITED（429）", async () => {
		const ip = "203.0.113.77";
		for (let i = 0; i < 5; i += 1) {
			const r = await invoke("subscribe/request", { email: `bulk-${i}@example.com` }, ip);
			expect(r.ok).toBe(true);
		}
		const blocked = await invoke("subscribe/request", { email: "bulk-x@example.com" }, ip);
		expect(blocked.ok).toBe(false);
		expect(blocked.error).toBe("RATE_LIMITED");
		expect(blocked.__status).toBe(429);
	});

	it("subscribers/list 返回各状态计数与列表", async () => {
		const list = await invoke("subscribers/list", { limit: 100 });
		expect(list.ok).toBe(true);
		expect(list.total).toBeGreaterThan(0);
		expect(list.by_status.confirmed).toBeGreaterThan(0);
		expect(Array.isArray(list.subscribers)).toBe(true);

		const confirmedOnly = await invoke("subscribers/list", { status: "confirmed" });
		expect(confirmedOnly.subscribers.every((s: Res) => s.status === "confirmed")).toBe(true);

		const unsubscribed = await invoke("subscribers/list", { status: "unsubscribed" });
		expect(unsubscribed.by_status.unsubscribed).toBeGreaterThan(0);
	});
});
