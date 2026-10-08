/**
 * `pulse-ai/client` 的类型声明。
 *
 * 运行时代码是 `client.mjs`（**手写 ESM、零依赖**，见该文件头部对打包约束的说明）。
 * 这里手写声明而不是用 tsc 生成，是因为运行期文件本身就是产物：`emdash-plugin build`
 * 只构建 `src/plugin.ts`，没有第二个构建步骤来产出 `.mjs`。改动 `client.mjs` 的导出
 * 时**必须同步这里**。
 */

export type AiProvider = "workers-ai" | "openai" | "anthropic" | "openai-compatible";

export interface AiSettings {
	provider: AiProvider;
	/** Cloudflare 账号 ID。走 AI Gateway 或直连 Workers AI 时必填。 */
	accountId: string;
	/** AI Gateway 名称。与 `accountId` 同时存在时经网关统一入口。 */
	gatewayId: string;
	/** 完整端点基址覆盖（自建 / 第三方 OpenAI 兼容网关）。非空时接管 URL 组装。 */
	baseUrl: string;
	model: string;
	apiKey: string;
	timeoutMs: number;
	maxTokens: number;
}

export interface AiMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface AiRequest {
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

export type AiCompletion =
	| { ok: true; text: string; latencyMs: number }
	| { ok: false; error: string; status?: number };

export type AiFetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** pulse-ai 的插件 id（设置存于 options 表的 `plugin:pulse-ai:settings:*`）。 */
export const AI_PLUGIN_ID: "pulse-ai";

export const AI_DEFAULTS: AiSettings;

/** 用任意的「按 key 取值」函数拼出连接配置（缺省键回落 `AI_DEFAULTS`）。 */
export function readAiSettings(get: (key: string) => unknown): Promise<AiSettings>;

/** 读取 pulse-ai 的插件设置（含加密存储的 `apiKey`）；读失败回落默认值，绝不抛错。 */
export function loadAiSettings(): Promise<AiSettings>;

/** 由连接配置拼出请求（端点优先级：`baseUrl` > AI Gateway > 官方域名）。 */
export function buildAiRequest(
	settings: AiSettings,
	options?: { messages?: AiMessage[]; maxTokens?: number },
): AiRequest;

/** 把各 provider 的响应归一成一段文本；无法识别返回 null。 */
export function parseAiResponse(provider: AiProvider | string, payload: unknown): string | null;

/** 解析 Llama Guard 判定。解析失败返回 `unsafe: null`（未知，不可当安全）。 */
export function parseGuardVerdict(text: string): { unsafe: boolean | null; categories: string[] };

/** 连接是否具备发起请求的最低条件。 */
export function isConfigured(settings: Partial<AiSettings> | null | undefined): boolean;

/** 端点是否经过 AI Gateway。 */
export function usesGateway(settings: Partial<AiSettings> | null | undefined): boolean;

/** 发起一次补全；任何异常都收敛成 `{ ok:false, error }`，由调用方降级。 */
export function aiComplete(
	fetcher: AiFetcher,
	options: { messages?: AiMessage[]; maxTokens?: number },
	settings: AiSettings,
): Promise<AiCompletion>;
