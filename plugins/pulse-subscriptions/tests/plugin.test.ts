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

describe("pulse-subscriptions 订阅分组", () => {
	const slug = (name: string) => `grp-${name}-${Math.random().toString(36).slice(2, 8)}`;

	it("groups/save 新建、groups/list 带订阅人数、groups/public 只回启用中的", async () => {
		const active = slug("active");
		const retired = slug("retired");

		const created = await invoke("groups/save", { create: true, slug: active, name: "每日摘要", sortOrder: 1 });
		expect(created.ok).toBe(true);
		expect(created.created).toBe(true);

		const second = await invoke("groups/save", { create: true, slug: retired, name: "已停用", active: false });
		expect(second.ok).toBe(true);

		const listed = await invoke("groups/list", {});
		expect(listed.ok).toBe(true);
		const found = listed.groups.find((g: Res) => g.slug === active);
		expect(found).toBeTruthy();
		expect(found.members).toBe(0);

		const pub = await invoke("groups/public", {});
		expect(pub.ok).toBe(true);
		const slugs = pub.groups.map((g: Res) => g.slug);
		expect(slugs).toContain(active);
		expect(slugs).not.toContain(retired);
	});

	it("groups/save 新建时 slug 冲突报 DUPLICATE_SLUG", async () => {
		const dup = slug("dup");
		await invoke("groups/save", { create: true, slug: dup, name: "第一个" });
		const again = await invoke("groups/save", { create: true, slug: dup, name: "第二个" });
		expect(again.ok).toBe(false);
		expect(again.error).toBe("DUPLICATE_SLUG");
	});

	it("订阅时带分组：只保留存在且启用中的 slug", async () => {
		const groupA = slug("a");
		const groupOff = slug("off");
		await invoke("groups/save", { create: true, slug: groupA, name: "甲" });
		await invoke("groups/save", { create: true, slug: groupOff, name: "乙", active: false });

		const email = `groups-${Date.now()}@example.com`;
		const result = await invoke("subscribe/request", {
			email,
			groups: [groupA, groupOff, "does-not-exist"],
		});

		expect(result.ok).toBe(true);
		expect(result.groups).toEqual([groupA]);
	});

	it("groups/delete 从订阅者身上摘掉该 slug", async () => {
		const groupSlug = slug("gone");
		await invoke("groups/save", { create: true, slug: groupSlug, name: "将被删除" });

		const email = `detach-${Date.now()}@example.com`;
		const token = await subscribeAndConfirm(email);
		await invoke("preferences", { token, groups: [groupSlug] });

		const removed = await invoke("groups/delete", { slug: groupSlug });
		expect(removed.ok).toBe(true);
		expect(removed.detached).toBeGreaterThan(0);

		const after = await invoke("preferences", { token });
		expect(after.groups).toEqual([]);
	});
});

describe("pulse-subscriptions 读者偏好（preferences）", () => {
	it("读偏好返回可选分组；写偏好更新分组并记事件", async () => {
		const groupSlug = `pref-${Math.random().toString(36).slice(2, 8)}`;
		await invoke("groups/save", { create: true, slug: groupSlug, name: "偏好测试" });

		const email = `pref-${Date.now()}@example.com`;
		const token = await subscribeAndConfirm(email);

		const read = await invoke("preferences", { token });
		expect(read.ok).toBe(true);
		expect(read.email).toBe(email);
		expect(read.status).toBe("confirmed");
		expect(read.groups).toEqual([]);
		expect(read.available.map((g: Res) => g.slug)).toContain(groupSlug);

		const write = await invoke("preferences", { token, groups: [groupSlug] });
		expect(write.ok).toBe(true);
		expect(write.updated).toBe(true);
		expect(write.groups).toEqual([groupSlug]);

		const list = await invoke("subscribers/list", { limit: 100 });
		const mine = list.subscribers.find((s: Res) => s.email === email);
		expect(mine.groups).toEqual([groupSlug]);

		const events = await invoke("subscribers/events", { id: mine.id });
		expect(events.ok).toBe(true);
		expect(events.events.some((e: Res) => e.type === "groups_changed")).toBe(true);
	});

	it("token 无效返回 INVALID_TOKEN（400）", async () => {
		const result = await invoke("preferences", { token: "ps_unsub_deadbeefdeadbeef" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_TOKEN");
		expect(result.__status).toBe(400);
	});
});

describe("pulse-subscriptions 后台暂停", () => {
	it("暂停后读者再提交：不改状态、不发信、记 request_blocked", async () => {
		const email = `paused-${Date.now()}@example.com`;
		await subscribeAndConfirm(email);

		const list = await invoke("subscribers/list", { limit: 100 });
		const mine = list.subscribers.find((s: Res) => s.email === email);
		expect(mine).toBeTruthy();

		const paused = await invoke("subscribers/update", { id: mine.id, action: "pause", reason: "投诉" });
		expect(paused.ok).toBe(true);
		expect(paused.status).toBe("paused");

		const before = (await host.inspect.email()).length;
		const retry = await invoke("subscribe/request", { email });
		expect(retry.status).toBe("paused");
		expect(retry.blocked).toBe(true);
		expect(retry.delivered).toBe(false);
		expect((await host.inspect.email()).length).toBe(before);

		const events = await invoke("subscribers/events", { id: mine.id });
		expect(events.events.some((e: Res) => e.type === "request_blocked")).toBe(true);

		const stillPaused = await invoke("subscribers/list", { limit: 100 });
		expect(stillPaused.subscribers.find((s: Res) => s.email === email).status).toBe("paused");
	});

	it("resume 还原到暂停前的状态", async () => {
		const email = `resume-${Date.now()}@example.com`;
		await subscribeAndConfirm(email);
		const list = await invoke("subscribers/list", { limit: 100 });
		const mine = list.subscribers.find((s: Res) => s.email === email);

		await invoke("subscribers/update", { id: mine.id, action: "pause" });
		const resumed = await invoke("subscribers/update", { id: mine.id, action: "resume" });
		expect(resumed.ok).toBe(true);
		expect(resumed.status).toBe("confirmed");
	});

	it("已退订记录不能被暂停（INVALID_STATE）", async () => {
		const email = `nopause-${Date.now()}@example.com`;
		const token = await subscribeAndConfirm(email);
		await invoke("unsubscribe", { token });

		const list = await invoke("subscribers/list", { limit: 100 });
		const mine = list.subscribers.find((s: Res) => s.email === email);

		const result = await invoke("subscribers/update", { id: mine.id, action: "pause" });
		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID_STATE");
	});

	it("退订可带原因，落进事件日志", async () => {
		const email = `reason-${Date.now()}@example.com`;
		const token = await subscribeAndConfirm(email);
		await invoke("unsubscribe", { token, reason: "频率太高" });

		const list = await invoke("subscribers/list", { limit: 100 });
		const mine = list.subscribers.find((s: Res) => s.email === email);
		expect(mine.unsubscribe_reason).toBe("频率太高");

		const events = await invoke("subscribers/events", { id: mine.id });
		const gone = events.events.find((e: Res) => e.type === "unsubscribed");
		expect(gone.reason).toBe("频率太高");
		expect(gone.actor).toBe("reader");
	});

	it("subscribers/list 支持按分组过滤", async () => {
		const groupSlug = `filter-${Math.random().toString(36).slice(2, 8)}`;
		await invoke("groups/save", { create: true, slug: groupSlug, name: "过滤测试" });

		const email = `filter-${Date.now()}@example.com`;
		const token = await subscribeAndConfirm(email);
		await invoke("preferences", { token, groups: [groupSlug] });

		const filtered = await invoke("subscribers/list", { group: groupSlug, limit: 100 });
		expect(filtered.ok).toBe(true);
		expect(filtered.subscribers.length).toBeGreaterThan(0);
		expect(filtered.subscribers.every((s: Res) => s.groups.includes(groupSlug))).toBe(true);
	});
});
