import { describe, expect, it, vi } from "vitest";

import {
	AI_DEFAULTS,
	aiComplete,
	buildAiRequest,
	isConfigured,
	parseAiResponse,
	parseGuardVerdict,
	readAiSettings,
	usesGateway,
} from "../src/client.mjs";

/** 完整可用的连接配置（provider 默认 workers-ai）。 */
const settings = (overrides = {}) => ({
	...AI_DEFAULTS,
	accountId: "acc",
	apiKey: "tok",
	...overrides,
});

const okFetch = (payload: unknown) =>
	vi.fn(async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);

/** `AiRequest.body` 是 `unknown`（各 provider 形状不同），测试里统一取字段。 */
const bodyOf = (req: { body: unknown }): Record<string, unknown> => req.body as Record<string, unknown>;

describe("buildAiRequest", () => {
	it("workers-ai 直连（无 gateway）", () => {
		const req = buildAiRequest(settings({ model: "@cf/meta/llama-guard-3-8b" }), {
			messages: [{ role: "user", content: "hi" }],
		});
		expect(req.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/meta/llama-guard-3-8b",
		);
		expect(req.headers.authorization).toBe("Bearer tok");
		expect(req.body).toMatchObject({ messages: [{ role: "user", content: "hi" }] });
	});

	it("workers-ai 走 AI Gateway", () => {
		const req = buildAiRequest(settings({ gatewayId: "gw" }), { messages: [] });
		expect(req.url).toBe(
			"https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/@cf/meta/llama-guard-3-8b",
		);
	});

	it("openai 兼容走 Gateway", () => {
		const req = buildAiRequest(
			settings({ provider: "openai", gatewayId: "gw", model: "gpt-4o-mini" }),
			{ messages: [] },
		);
		expect(req.url).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/openai/chat/completions");
		expect(bodyOf(req).model).toBe("gpt-4o-mini");
	});

	it("baseUrl 完全接管端点（自建 / 第三方兼容网关）", () => {
		const req = buildAiRequest(
			settings({ provider: "openai-compatible", baseUrl: "http://ollama:11434/v1/", model: "qwen2.5" }),
			{ messages: [] },
		);
		expect(req.url).toBe("http://ollama:11434/v1/chat/completions");
		expect(bodyOf(req).model).toBe("qwen2.5");
	});

	it("anthropic 把 system 抽成独立字段", () => {
		const req = buildAiRequest(settings({ provider: "anthropic", model: "claude-3-5-haiku-latest" }), {
			messages: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "hi" },
			],
		});
		expect(req.url).toBe("https://api.anthropic.com/v1/messages");
		expect(bodyOf(req).system).toBe("be terse");
		expect(bodyOf(req).messages).toEqual([{ role: "user", content: "hi" }]);
		expect(req.headers["x-api-key"]).toBe("tok");
	});

	it("maxTokens 参数覆盖默认值", () => {
		const req = buildAiRequest(settings(), { messages: [], maxTokens: 7 });
		expect(bodyOf(req).max_tokens).toBe(7);
	});
});

describe("parseAiResponse", () => {
	it("workers-ai", () => {
		expect(parseAiResponse("workers-ai", { result: { response: "safe" } })).toBe("safe");
	});
	it("openai", () => {
		expect(parseAiResponse("openai", { choices: [{ message: { content: "hi" } }] })).toBe("hi");
	});
	it("anthropic", () => {
		expect(parseAiResponse("anthropic", { content: [{ text: "hi" }] })).toBe("hi");
	});
	it("无法识别", () => {
		expect(parseAiResponse("openai", {})).toBeNull();
	});
});

describe("parseGuardVerdict", () => {
	it("safe", () => {
		expect(parseGuardVerdict("safe")).toEqual({ unsafe: false, categories: [] });
	});
	it("unsafe + 类别", () => {
		expect(parseGuardVerdict("unsafe\nS1,S6")).toEqual({ unsafe: true, categories: ["S1", "S6"] });
	});
	it("无法识别按「未知」处理（不可当安全）", () => {
		expect(parseGuardVerdict("我不知道")).toEqual({ unsafe: null, categories: [] });
		expect(parseGuardVerdict("")).toEqual({ unsafe: null, categories: [] });
	});
});

describe("isConfigured / usesGateway", () => {
	it("缺 apiKey → false", () => {
		expect(isConfigured(settings({ apiKey: "" }))).toBe(false);
	});
	it("workers-ai 缺 accountId → false", () => {
		expect(isConfigured(settings({ accountId: "" }))).toBe(false);
	});
	it("openai 只要 apiKey", () => {
		expect(isConfigured(settings({ provider: "openai", accountId: "" }))).toBe(true);
	});
	it("自建端点只要 apiKey", () => {
		expect(isConfigured(settings({ provider: "openai-compatible", accountId: "", baseUrl: "http://x/v1" }))).toBe(
			true,
		);
	});
	it("usesGateway 需同时有 accountId 与 gatewayId，且未设 baseUrl", () => {
		expect(usesGateway(settings({ gatewayId: "gw" }))).toBe(true);
		expect(usesGateway(settings())).toBe(false);
		expect(usesGateway(settings({ gatewayId: "gw", baseUrl: "http://x/v1" }))).toBe(false);
	});
});

describe("readAiSettings", () => {
	it("缺省键回落默认值", async () => {
		const s = await readAiSettings(() => undefined);
		expect(s).toEqual(AI_DEFAULTS);
	});

	it("读取字符串与数字，忽略空串与非法数字", async () => {
		const store: Record<string, unknown> = { provider: "openai", accountId: "a", model: "gpt-4o-mini", apiKey: "k", timeoutMs: 900 };
		const s = await readAiSettings((key) => store[key]);
		expect(s.provider).toBe("openai");
		expect(s.model).toBe("gpt-4o-mini");
		expect(s.timeoutMs).toBe(900);
		// 未提供的键保持默认。
		expect(s.maxTokens).toBe(AI_DEFAULTS.maxTokens);
		expect(s.gatewayId).toBe("");
	});

	it("取值抛错时回落默认值（不冒泡）", async () => {
		const s = await readAiSettings(() => {
			throw new Error("boom");
		});
		expect(s).toEqual(AI_DEFAULTS);
	});
});

describe("aiComplete", () => {
	it("未配置时不发请求", async () => {
		const fetcher = vi.fn();
		const r = await aiComplete(fetcher, { messages: [] }, settings({ apiKey: "" }));
		expect(r).toMatchObject({ ok: false, error: "not_configured" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("成功返回归一化文本与耗时", async () => {
		const r = await aiComplete(okFetch({ result: { response: "unsafe\nS1" } }), { messages: [] }, settings());
		expect(r).toMatchObject({ ok: true, text: "unsafe\nS1" });
		if (r.ok) expect(typeof r.latencyMs).toBe("number");
	});

	it("HTTP 失败", async () => {
		const r = await aiComplete(
			vi.fn(async () => new Response("boom", { status: 429 })),
			{ messages: [] },
			settings(),
		);
		expect(r).toMatchObject({ ok: false, error: "http_429", status: 429 });
	});

	it("网络抛错不冒泡", async () => {
		const r = await aiComplete(() => Promise.reject(new Error("dns")), { messages: [] }, settings());
		expect(r.ok).toBe(false);
	});

	it("响应形状异常 → unexpected_response", async () => {
		const r = await aiComplete(okFetch({ nope: true }), { messages: [] }, settings());
		expect(r).toMatchObject({ ok: false, error: "unexpected_response" });
	});
});
