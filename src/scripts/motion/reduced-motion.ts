/**
 * reduced-motion 状态与订阅（**不依赖 motion**）。
 *
 * 单独成文件是为了让 `boot.ts` 能在**不下载** `motion/mini` 的前提下判断是否该启动
 * 运行时：减动效时整个运行时都不加载。`reveal.ts` / `disclosure.ts` / `lightbox.ts`
 * 也从这里读状态，而不是各自 `matchMedia`。
 */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

let reduced = false;

/** 当前是否偏好减动效（由 `initReducedMotion()` 初始化）。 */
export function prefersReducedMotion(): boolean {
	return reduced;
}

function sync(matches: boolean): void {
	reduced = matches;
	document.documentElement.toggleAttribute("data-reduced-motion", matches);
}

/**
 * 同步初始状态、订阅后续变化，并返回当前值。
 *
 * 只在 boot 里调一次。与改造前一致：即使之后用户改了系统设置，也**不会**补跑已经
 * 跳过的 init —— 只把标记与 `data-reduced-motion` 更新到最新。
 */
export function initReducedMotion(): boolean {
	const media = window.matchMedia(REDUCED_MOTION);
	sync(media.matches);
	media.addEventListener("change", (event) => sync(event.matches));
	return media.matches;
}
