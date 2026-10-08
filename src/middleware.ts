/**
 * 运行期前台主题切换。
 *
 * 路由编排（见 `astro.config.mjs` 的 `themeRoutes()`）：
 * - **默认主题**（构建期 `SITE_THEME`）注册在干净路径上；
 * - 另一套注册在 `/_t/<theme>/…`。
 *
 * 后台「前台主题」页把选择写进插件设置（`plugin:pulse-theme:settings:theme`），这里读它，
 * 需要时把当前请求 rewrite 到前缀路由。默认主题不动，所以常见情况下零开销、零风险。
 *
 * ## 为什么这样写
 *
 * - **中间件位置**：EmDash 的内置中间件全部是 `order: "pre"`，Astro 组链为
 *   `sequence(...pre, onRequest)`，所以本文件**排在最后** —— EmDash 的 redirect / setup /
 *   auth 看到的仍是原始路径（`locals.emdash.db` 注入、redirect 命中、404 记账都不受影响）。
 * - **必须用 `next(payload)`，不能用 `context.rewrite()`**：后者走 `executeRewrite` →
 *   `handleMiddleware`（`core/rewrites/handler.js`），会**重跑整条中间件链**，既重复执行
 *   EmDash 的中间件，也会递归回本文件。
 * - **默认主题留在干净路径**还有一个前提作用：只有干净路径能命中路由，`routePattern`
 *   才会是真实页面的 pattern；否则所有请求都会落到 404 路由，无法区分「真 404」。
 * - **rewrite 不保留查询串**，必须显式拼 `context.url.search`。
 *
 * ## 主题页面的约定
 *
 * rewrite 会改写 `Astro.url`，原路径落在 `Astro.originPathname`。主题页面里取路径一律用
 * `Astro.originPathname`（canonical / JSON-LD `path` / `isHome` / 导航高亮 / 语言切换），
 * 否则会带上 `/_t/<theme>` 前缀。`Astro.url.origin` 与 `Astro.url.searchParams` 不受影响。
 */

import { defineMiddleware } from "astro:middleware";
import { getPluginSetting } from "emdash";

/** 主题值存这个插件的设置里（见 `plugins/pulse-theme/`）。 */
const THEME_PLUGIN_ID = "pulse-theme";
const THEME_SETTING_KEY = "theme";

/** 与 `astro.config.mjs` 的 `THEME_NAMES` 保持一致。 */
const THEME_NAMES: readonly string[] = ["news-factory", "pulse-news"];

/** 构建期注入的默认主题（`astro.config.mjs` 的 `vite.define`）。 */
const DEFAULT_THEME = __DEFAULT_SITE_THEME__;

/** 非默认主题的路由前缀，与 `astro.config.mjs` 的 `THEME_PREFIX` 一致。 */
const THEME_PREFIX = "/_t";

/**
 * 不参与主题切换的路径前缀：EmDash 后台 / API、图片端点、构建产物、机器端点，
 * 以及 `/.well-known`（EmDash 注入 OAuth 发现文档，无扩展名，靠前缀跳过）。
 */
const SKIP_PREFIXES = ["/_emdash", "/_image", "/_astro", "/agent", "/spike", "/.well-known"];

/** 精确跳过的机器端点。 */
const SKIP_EXACT = new Set([
	"/rss.xml",
	"/feed.json",
	"/llms.txt",
	"/robots.txt",
	"/sitemap.xml",
	"/sitemap-sections.xml",
	"/sitemap-tags.xml",
]);

/** 带扩展名的一律按静态 / 机器资源处理（`/sitemap-articles.xml`、`/favicon.ico`…）。 */
const HAS_EXTENSION = /\.[^/]+$/;

function isUnder(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** 当前主题；未设置 / 值非法 / 读失败时回退构建期默认值。 */
async function currentTheme(): Promise<string> {
	try {
		const value = await getPluginSetting<string>(THEME_PLUGIN_ID, THEME_SETTING_KEY);
		return typeof value === "string" && THEME_NAMES.includes(value) ? value : DEFAULT_THEME;
	} catch {
		// 设置表读不到时不要因此 500，退回默认主题。
		return DEFAULT_THEME;
	}
}

/** 换掉响应状态码，body 与响应头原样保留。 */
function withStatus(response: Response, status: number): Response {
	return new Response(response.body, {
		status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * 必须显式 `private, no-store` 的路径。
 *
 * 启用 Workers Cache（`astro.config.mjs` 的 `cache` provider + `routeRules`）后，
 * **没有 `Cache-Control` 的 200 响应会被 Cloudflare 按启发式规则缓存 2 小时**。
 * 以下页面依赖会话 / token / 查询串，且都不调用 `Astro.cache.set`（不参与路由缓存），
 * 必须显式关掉共享缓存 —— 否则「未登录」提示会被缓存并发给已登录用户、确认/退订页
 * 会带着过期状态被反复命中。
 */
const NO_STORE_PREFIXES = ["/search", "/subscribe", "/editor", "/spike"];
const NO_STORE_EXACT = new Set(["/404"]);

function needsNoStore(pathname: string): boolean {
	return (
		NO_STORE_EXACT.has(pathname) ||
		NO_STORE_PREFIXES.some((prefix) => isUnder(pathname, prefix))
	);
}

/** 按需给响应加 `private, no-store`（其余路径不动，交给 `routeRules` 或 EmDash 自身的头）。 */
function finalize(response: Response, pathname: string): Response {
	if (needsNoStore(pathname)) response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { pathname } = context.url;

	// `/_t/<theme>/**` 只作内部命名空间：直接访问一律送回干净路径。
	if (isUnder(pathname, THEME_PREFIX)) {
		const segments = pathname.split("/").filter(Boolean);
		const clean = `/${segments.slice(2).join("/")}`;
		return context.redirect(`${clean}${context.url.search}`, 302);
	}

	// EmDash / 机器端点 / 静态资源不参与主题切换（也因此不查设置表）。
	if (SKIP_PREFIXES.some((prefix) => isUnder(pathname, prefix))) {
		return finalize(await next(), pathname);
	}
	if (SKIP_EXACT.has(pathname) || HAS_EXTENSION.test(pathname)) {
		return finalize(await next(), pathname);
	}

	const theme = await currentTheme();
	// 默认主题本来就注册在干净路径上，无需 rewrite。
	if (theme === DEFAULT_THEME) return finalize(await next(), pathname);

	// 没命中任何页面（落到自定义 404 路由）。默认主题在干净路径上注册，
	// 所以这个判断在运行期依然可靠。
	const isNotFound = context.routePattern === "/404";
	const target = isNotFound
		? `${THEME_PREFIX}/${theme}/404`
		: `${THEME_PREFIX}/${theme}${pathname}`;

	const response = await next(new URL(`${target}${context.url.search}`, context.url.origin));

	// rewrite 会把状态重置成 200，这里把 404 还回去。
	return finalize(isNotFound ? withStatus(response, 404) : response, pathname);
});
