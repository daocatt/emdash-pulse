/**
 * 动效令牌读取：时长 / 缓动 / 位移 / 错峰全部从 CSS 自定义属性拿。
 *
 * 默认值在 `src/styles/tokens.base.css`，两套主题在各自 `styles/tokens.css` 里覆盖
 * （news-factory 克制 / pulse-news 明显）。因此这里**不判断主题名** —— 新增主题
 * 只改 CSS，JS 不用动。
 *
 * 注意单位：`animate()` 的 `duration` / `delay` 入参是**秒**，CSS 里写的是毫秒。
 */
// 类型只从完整版取（`import type` 会被编译期抹掉，不会把引擎打进包里）；
// 运行时的 `animate` 仍来自 `motion/mini`。
import type { Easing } from "motion";

/** 读一个自定义属性并去掉空白；读不到返回空串。 */
function readToken(el: Element, token: string): string {
	return getComputedStyle(el).getPropertyValue(token).trim();
}

/** 时长（毫秒）。裸数字按毫秒，`s` / `ms` 单位都支持。 */
export function durationMs(el: Element, token: string, fallbackMs: number): number {
	const raw = readToken(el, token);
	if (!raw) return fallbackMs;
	const value = Number.parseFloat(raw);
	if (Number.isNaN(value)) return fallbackMs;
	if (raw.endsWith("ms")) return value;
	if (raw.endsWith("s")) return value * 1000;
	return value;
}

/** 时长（秒），直接喂给 `animate()`。 */
export function durationSeconds(el: Element, token: string, fallbackMs: number): number {
	return durationMs(el, token, fallbackMs) / 1000;
}

/** 错峰间隔（秒）。 */
export function staggerSeconds(el: Element, fallbackMs: number): number {
	return durationMs(el, "--motion-stagger", fallbackMs) / 1000;
}

/** 位移：保留单位原样返回，可直接当关键帧值（如 `"16px"`）。 */
export function shift(el: Element, token: string, fallback: string): string {
	return readToken(el, token) || fallback;
}

/**
 * 缓动：把令牌里的 `cubic-bezier(a, b, c, d)` 解析成 motion 接受的四元组。
 *
 * 令牌存成 CSS 函数形式是为了 CSS `transition` 也能直接用；motion 会把四元组
 * 转成 WAAPI 的 `cubic-bezier(...)`。解析失败退回 `easeOut`，不会因为写错令牌
 * 把动画搞挂。
 */
export function easing(el: Element, fallback: Easing = "easeOut"): Easing {
	const match = /cubic-bezier\(([^)]+)\)/.exec(readToken(el, "--motion-ease"));
	if (!match) return fallback;
	const points = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
	if (points.length !== 4 || points.some((n) => Number.isNaN(n))) return fallback;
	return points as unknown as Easing;
}
