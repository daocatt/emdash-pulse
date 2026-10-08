/**
 * pulse-ai 客户端：provider 无关的 AI 调用（零静态依赖的 ESM 库）。
 *
 * ## 为什么是「库」而不是「跨插件 hook」
 *
 * EmDash 的 hook 名是**封闭枚举**，插件之间没有自定义事件总线；插件设置 / KV 也按
 * plugin id 隔离（`ctx.settings` 只能读自己的）。本项目所有插件都在宿主进程内运行，
 * 因此**同进程直接引用**是唯一干净的复用方式 —— 消费方（目前是 `pulse-review` 的
 * 评论审核）引用本模块，再用 `loadAiSettings()` 读 pulse-ai 自己的配置。
 *
 * ## 两条必须遵守的打包约束（改动前务必先读）
 *
 * 1. **本文件必须零静态依赖**（不 `import` 任何东西）。`emdash-plugin build` 用
 *    rolldown 打包 `src/plugin.ts` 及其静态依赖，**除了 `emdash/plugin` 与 `zod`
 *    之外，任何裸模块名都会被判为 external**；产物被拷到临时目录做 probe 时解析不到
 *    就整包构建失败（实测：`Cannot find package 'pulse-ai'`）。
 * 2. **消费方不要把 `pulse-ai` 写进自己的 `dependencies`**。rolldown 按「声明过的依赖」
 *    做 external 判定：一旦声明，`pulse-ai/client` 会变成 external import → 构建失败。
 *    不声明时它会被**内联**进消费方产物（实测：pulse-review 的 plugin.mjs 由 5.9KB → 7.8KB）。
 *
 * `loadAiSettings()` 里对 `emdash` 的引用是**动态** `import(...)`，且用模板字符串拼接，
 * 让 rolldown 无法静态分析 → 原样保留到运行期，由 Node 从插件所在目录向上解析到
 * **宿主同一份** `emdash` 实例（因此 `getDb()` 的 AsyncLocalStorage 请求上下文有效）。
 */

/** pulse-ai 的插件 id。设置存于 options 表的 `plugin:pulse-ai:settings:*`。 */
export const AI_PLUGIN_ID = "pulse-ai";

/**
 * 默认连接配置。`admin.settingsSchema` 的默认值**不会**自动落库，
 * 读取方（本模块）必须自行兜底。
 */
export const AI_DEFAULTS = {
	provider: "workers-ai",
	accountId: "",
	gatewayId: "",
	baseUrl: "",
	model: "@cf/meta/llama-guard-3-8b",
	apiKey: "",
	timeoutMs: 5000,
	maxTokens: 256,
};

/** 需要从插件设置里读取的键（与 `emdash-plugin.jsonc` 的 settingsSchema 对应）。 */
const STRING_KEYS = ["provider", "accountId", "gatewayId", "baseUrl", "model", "apiKey"];
const NUMBER_KEYS = ["timeoutMs", "maxTokens"];

/**
 * 用任意的「按 key 取值」函数拼出连接配置（缺省键回落 `AI_DEFAULTS`）。
 *
 * 抽出来是为了让两处共用同一套键与兜底逻辑：
 * - 本模块的 `loadAiSettings()`（跨插件读，走动态 import 的 `getPluginSetting`）；
 * - pulse-ai 自己的后台页（用 `ctx.settings.get`，不绕 `emdash` 主包）。
 */
export async function readAiSettings(get) {
	const settings = { ...AI_DEFAULTS };
	const keys = [...STRING_KEYS, ...NUMBER_KEYS];
	const values = await Promise.all(keys.map((key) => Promise.resolve().then(() => get(key)).catch(() => undefined)));
	keys.forEach((key, index) => {
		const value = values[index];
		if (typeof value === "string" && value.length > 0) settings[key] = value;
		else if (typeof value === "number" && Number.isFinite(value)) settings[key] = value;
	});
	return settings;
}

/**
 * 读取 pulse-ai 的插件设置（含加密存储的 `apiKey`），供**其它插件**使用。
 *
 * 读不到 / 读失败一律回落默认值（`apiKey` 为空即视为未配置），**绝不抛错** ——
 * 审核路径依赖它：配置缺失时必须降级，不能把评论审核整条打挂。
 */
export async function loadAiSettings() {
	try {
		// 见文件头：动态 + 模板字符串，保证 rolldown 不做静态解析。
		const { getPluginSetting } = await import(`${"emdash"}`);
		return await readAiSettings((key) => getPluginSetting(AI_PLUGIN_ID, key));
	} catch {
		// `emdash` 不可用（纯单测 / 宿主未就绪）：返回默认（未配置）。
		return { ...AI_DEFAULTS };
	}
}

/** AI Gateway 统一入口前缀。 */
const GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com/v1";

/**
 * 由连接配置拼出请求（URL / headers / body）。
 *
 * 端点优先级：`baseUrl`（自建 / 第三方兼容网关）> AI Gateway（配了 accountId +
 * gatewayId）> provider 官方域名。
 */
export function buildAiRequest(settings, { messages, maxTokens } = {}) {
	const provider = settings.provider ?? AI_DEFAULTS.provider;
	const account = settings.accountId ?? "";
	const baseUrl = (settings.baseUrl ?? "").replace(/\/+$/, "");
	const gateway =
		account && settings.gatewayId
			? `${GATEWAY_ORIGIN}/${encodeURIComponent(account)}/${encodeURIComponent(settings.gatewayId)}`
			: null;
	const apiKey = settings.apiKey ?? "";
	const model = settings.model ?? "";
	const limit = Number.isFinite(maxTokens) ? maxTokens : (settings.maxTokens ?? AI_DEFAULTS.maxTokens);

	if (provider === "workers-ai") {
		const url = baseUrl
			? `${baseUrl}/${model}`
			: gateway
				? `${gateway}/workers-ai/${model}`
				: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`;
		// Workers AI（含经网关）沿用 `{ messages, max_tokens }`，模型来自 URL。
		return {
			url,
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: { messages, max_tokens: limit },
		};
	}

	if (provider === "anthropic") {
		const url = baseUrl
			? `${baseUrl}/v1/messages`
			: gateway
				? `${gateway}/anthropic/v1/messages`
				: "https://api.anthropic.com/v1/messages";
		const system = messages
			.filter((message) => message.role === "system")
			.map((message) => message.content)
			.join("\n\n");
		return {
			url,
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: {
				model,
				max_tokens: limit,
				messages: messages.filter((message) => message.role !== "system"),
				...(system ? { system } : {}),
			},
		};
	}

	// OpenAI / OpenAI 兼容（AI Gateway 的 openai 路由同形）。
	const url = baseUrl
		? `${baseUrl}/chat/completions`
		: gateway
			? `${gateway}/openai/chat/completions`
			: "https://api.openai.com/v1/chat/completions";
	return {
		url,
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: { model, messages, max_tokens: limit },
	};
}

/** 把各 provider 的响应归一成一段文本；无法识别返回 null。 */
export function parseAiResponse(provider, payload) {
	if (provider === "workers-ai") {
		const response = payload?.result?.response;
		if (typeof response === "string") return response;
	}
	const choice = payload?.choices?.[0]?.message?.content;
	if (typeof choice === "string") return choice;
	if (typeof payload?.result?.choices?.[0]?.message?.content === "string") {
		return payload.result.choices[0].message.content;
	}
	if (Array.isArray(payload?.content)) {
		const block = payload.content.find((entry) => typeof entry?.text === "string");
		if (block) return block.text;
	}
	return null;
}

/**
 * 解析 Llama Guard 的判定：输出形如 `safe` 或 `unsafe\nS1,S6`。
 *
 * 解析失败返回 `unsafe: null`（**未知**）。调用方必须把「未知」当未判定处理，
 * 绝不能当成安全 —— 否则模型输出格式一变就会静默放行。
 */
export function parseGuardVerdict(text) {
	if (typeof text !== "string" || text.trim() === "") return { unsafe: null, categories: [] };
	const [verdict, ...rest] = text.trim().split(/\r?\n/);
	const head = verdict.trim().toLowerCase();
	if (head !== "safe" && head !== "unsafe") return { unsafe: null, categories: [] };
	const categories = rest
		.join(",")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return { unsafe: head === "unsafe", categories };
}

/** 连接是否具备发起请求的最低条件。 */
export function isConfigured(settings) {
	if (!settings?.apiKey) return false;
	const provider = settings.provider ?? AI_DEFAULTS.provider;
	// 自建 / 兼容网关只要有 baseUrl 就够，无需 Cloudflare 账号。
	if (settings.baseUrl) return true;
	if (provider === "workers-ai") return Boolean(settings.accountId);
	return true;
}

/** 端点是否经过 AI Gateway（后台诊断页展示用）。 */
export function usesGateway(settings) {
	return !settings?.baseUrl && Boolean(settings?.accountId) && Boolean(settings?.gatewayId);
}

/**
 * 发起一次补全。任何异常（未配置 / 超时 / 网络 / 非 2xx / 响应形状异常）都返回
 * `{ ok:false, error }`，由调用方决定降级策略 —— **绝不因故障放开业务判断**。
 */
export async function aiComplete(fetcher, { messages, maxTokens } = {}, settings) {
	if (!isConfigured(settings)) return { ok: false, error: "not_configured" };

	const request = buildAiRequest(settings, { messages, maxTokens });
	const controller = new AbortController();
	const timeoutMs = Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : AI_DEFAULTS.timeoutMs;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const startedAt = Date.now();
	try {
		const response = await fetcher(request.url, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal: controller.signal,
		});
		if (!response.ok) return { ok: false, error: `http_${response.status}`, status: response.status };
		const text = parseAiResponse(settings.provider, await response.json());
		if (typeof text !== "string") return { ok: false, error: "unexpected_response" };
		return { ok: true, text, latencyMs: Date.now() - startedAt };
	} catch (error) {
		const name = error instanceof Error ? error.name : "unknown";
		return { ok: false, error: name === "AbortError" ? "timeout" : name };
	} finally {
		clearTimeout(timer);
	}
}
