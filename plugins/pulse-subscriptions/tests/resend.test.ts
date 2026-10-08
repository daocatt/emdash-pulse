/**
 * Resend 客户端的纯函数层测试。
 *
 * 只测 `src/resend.ts` 本身（REST 封装 + Svix 验签 + Webhook 映射），
 * 不碰 `loadResendConfig()`（它要动态 `import("emdash")` 拿宿主设置，见 sync.test.ts
 * 的 mock 说明）。fetcher 一律用桩，避免真打网络。
 */

import { describe, expect, it } from "vitest";

import {
	createBroadcast,
	ensureSegment,
	mapResendEvent,
	resendCall,
	upsertContact,
	verifyResendSignature,
	WEBHOOK_TOLERANCE_SECONDS,
	type Fetcher,
	type ResendConfig,
} from "../src/resend";

const config: ResendConfig = { apiKey: "re_test_key", fromAddress: "Pulse <news@example.com>" };

type Stub = { status?: number; body?: unknown } | (() => Response);

/** 记录调用、按序返回预置响应的假 fetcher（超出序列后复用最后一项）。 */
function stubFetcher(responses: Stub[]) {
	const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
	let index = 0;

	const fetcher: Fetcher = async (url, init) => {
		calls.push({
			url,
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		const next = responses[Math.min(index, responses.length - 1)];
		index += 1;
		if (typeof next === "function") return next();
		const status = next?.status ?? 200;
		const body = next?.body === undefined ? "" : JSON.stringify(next.body);
		return new Response(body, { status, headers: { "content-type": "application/json" } });
	};

	return { fetcher, calls };
}

describe("resendCall", () => {
	it("带 Bearer 鉴权与 JSON body，并解析响应", async () => {
		const { fetcher, calls } = stubFetcher([{ body: { id: "seg_1" } }]);
		const result = await resendCall<{ id: string }>(fetcher, config, "POST", "/segments", { name: "x" });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.id).toBe("seg_1");
		expect(calls[0].url).toBe("https://api.resend.com/segments");
		expect(calls[0].headers.authorization).toBe("Bearer re_test_key");
		expect(calls[0].body).toEqual({ name: "x" });
	});

	it("非 2xx 时收敛成 { ok:false } 并带上状态码与消息", async () => {
		const { fetcher } = stubFetcher([{ status: 422, body: { message: "invalid email" } }]);
		const result = await resendCall(fetcher, config, "POST", "/contacts", {});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(422);
			expect(result.error).toBe("http_422: invalid email");
		}
	});

	it("网络异常不抛，返回 status 0", async () => {
		const fetcher: Fetcher = async () => {
			throw new TypeError("fetch failed");
		};
		const result = await resendCall(fetcher, config, "GET", "/segments");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(0);
	});
});

describe("ensureSegment", () => {
	it("名字已存在时直接复用，不再创建", async () => {
		const { fetcher, calls } = stubFetcher([
			{ body: { data: [{ id: "seg_old", name: "Pulse · 每日摘要" }] } },
		]);
		const result = await ensureSegment(fetcher, config, "Pulse · 每日摘要");

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.id).toBe("seg_old");
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("GET");
	});

	it("名字不存在时创建", async () => {
		const { fetcher, calls } = stubFetcher([
			{ body: { data: [] } },
			{ body: { id: "seg_new" } },
		]);
		const result = await ensureSegment(fetcher, config, "Pulse · 周刊");

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual({ id: "seg_new", name: "Pulse · 周刊" });
		expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
	});
});

describe("upsertContact", () => {
	it("先 POST /contacts（snake_case segments）", async () => {
		const { fetcher, calls } = stubFetcher([{ body: { id: "ct_1" } }]);
		const result = await upsertContact(fetcher, config, {
			email: "a@example.com",
			unsubscribed: false,
			segmentIds: ["seg_1", "seg_2"],
		});

		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toEqual({
			email: "a@example.com",
			unsubscribed: false,
			segments: [{ id: "seg_1" }, { id: "seg_2" }],
		});
	});

	it("已存在（409）时退回 PATCH /contacts/{email}", async () => {
		const { fetcher, calls } = stubFetcher([
			{ status: 409, body: { message: "contact already exists" } },
			{ body: { id: "ct_1" } },
		]);
		const result = await upsertContact(fetcher, config, {
			email: "a@example.com",
			unsubscribed: true,
			segmentIds: [],
		});

		expect(result.ok).toBe(true);
		expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH"]);
		expect(calls[1].url).toBe("https://api.resend.com/contacts/a%40example.com");
		expect(calls[1].body).toEqual({ unsubscribed: true, segments: [] });
	});

	it("其他错误（400）不重试 PATCH", async () => {
		const { fetcher, calls } = stubFetcher([{ status: 400, body: { message: "bad request" } }]);
		const result = await upsertContact(fetcher, config, {
			email: "a@example.com",
			unsubscribed: false,
			segmentIds: [],
		});

		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(1);
	});
});

describe("createBroadcast", () => {
	it("载荷用 REST 的 snake_case 字段并立即发送", async () => {
		const { fetcher, calls } = stubFetcher([{ body: { id: "bc_1" } }]);
		const result = await createBroadcast(fetcher, config, {
			segmentId: "seg_1",
			subject: "本周速览",
			html: "<p>hi</p>",
			name: "weekly",
			replyTo: "reply@example.com",
			send: true,
		});

		expect(result.ok).toBe(true);
		expect(calls[0].url).toBe("https://api.resend.com/broadcasts");
		expect(calls[0].body).toEqual({
			segment_id: "seg_1",
			from: "Pulse <news@example.com>",
			subject: "本周速览",
			html: "<p>hi</p>",
			name: "weekly",
			reply_to: "reply@example.com",
			send: true,
		});
	});

	it("不传 html/text 时不带这两个键", async () => {
		const { fetcher, calls } = stubFetcher([{ body: { id: "bc_1" } }]);
		await createBroadcast(fetcher, config, { segmentId: "seg_1", subject: "s", send: false });
		expect(calls[0].body).toEqual({
			segment_id: "seg_1",
			from: "Pulse <news@example.com>",
			subject: "s",
			send: false,
		});
	});
});

// ---------- Svix 验签 ----------

/** 用与生产同款的算法生成一个合法签名（模拟 Resend 侧）。 */
async function sign(secret: string, id: string, timestamp: string, payload: string): Promise<string> {
	const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
	const keyBytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const digest = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`)),
	);
	let binary = "";
	for (const byte of digest) binary += String.fromCharCode(byte);
	return `v1,${btoa(binary)}`;
}

const SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
const PAYLOAD = JSON.stringify({ type: "email.delivered", data: { to: ["a@example.com"] } });

describe("verifyResendSignature", () => {
	const now = 1_700_000_000_000;
	const timestamp = String(Math.floor(now / 1000));

	it("合法签名通过", async () => {
		const signature = await sign(SECRET, "msg_1", timestamp, PAYLOAD);
		const ok = await verifyResendSignature({
			payload: PAYLOAD,
			headers: { id: "msg_1", timestamp, signature },
			secret: SECRET,
			now,
		});
		expect(ok).toBe(true);
	});

	it("载荷被改动后失败", async () => {
		const signature = await sign(SECRET, "msg_1", timestamp, PAYLOAD);
		const ok = await verifyResendSignature({
			payload: `${PAYLOAD} `,
			headers: { id: "msg_1", timestamp, signature },
			secret: SECRET,
			now,
		});
		expect(ok).toBe(false);
	});

	it("时间戳超容忍窗口失败", async () => {
		const stale = String(Math.floor(now / 1000) - WEBHOOK_TOLERANCE_SECONDS - 1);
		const signature = await sign(SECRET, "msg_1", stale, PAYLOAD);
		const ok = await verifyResendSignature({
			payload: PAYLOAD,
			headers: { id: "msg_1", timestamp: stale, signature },
			secret: SECRET,
			now,
		});
		expect(ok).toBe(false);
	});

	it("密钥不对失败", async () => {
		const signature = await sign(SECRET, "msg_1", timestamp, PAYLOAD);
		const ok = await verifyResendSignature({
			payload: PAYLOAD,
			headers: { id: "msg_1", timestamp, signature },
			secret: `whsec_${btoa("ffffffffffffffffffffffffffffffff")}`,
			now,
		});
		expect(ok).toBe(false);
	});

	it("多个候选签名里命中任意一个即通过", async () => {
		const valid = await sign(SECRET, "msg_1", timestamp, PAYLOAD);
		const ok = await verifyResendSignature({
			payload: PAYLOAD,
			headers: { id: "msg_1", timestamp, signature: `v1,AAAA ${valid}` },
			secret: SECRET,
			now,
		});
		expect(ok).toBe(true);
	});

	it("缺头或空密钥直接失败", async () => {
		expect(
			await verifyResendSignature({ payload: PAYLOAD, headers: { id: "", timestamp, signature: "v1,x" }, secret: SECRET, now }),
		).toBe(false);
		expect(
			await verifyResendSignature({ payload: PAYLOAD, headers: { id: "m", timestamp, signature: "v1,x" }, secret: "", now }),
		).toBe(false);
	});
});

describe("mapResendEvent", () => {
	it("取 data.to 的第一项与 broadcast_id", () => {
		expect(
			mapResendEvent({
				type: "email.delivered",
				data: { to: ["a@example.com"], broadcast_id: "bc_1" },
			}),
		).toEqual({ type: "email.delivered", email: "a@example.com", broadcastId: "bc_1" });
	});

	it("退信带上 bounce.message", () => {
		expect(
			mapResendEvent({
				type: "email.bounced",
				data: { to: "b@example.com", bounce: { message: "mailbox full" } },
			}),
		).toEqual({ type: "email.bounced", email: "b@example.com", reason: "mailbox full" });
	});

	it("缺 type 或非对象返回 null", () => {
		expect(mapResendEvent(null)).toBeNull();
		expect(mapResendEvent({ data: {} })).toBeNull();
		expect(mapResendEvent("nope")).toBeNull();
	});
});
