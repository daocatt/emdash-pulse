/**
 * 前台动效运行时（全局单例，data 属性驱动）。
 *
 * 入口只做三件事：① reduced-motion 门禁 ② 逐个 init ③ 失败兜底（保证内容可见）。
 * 具体动效在 `reveal.ts` / `disclosure.ts` / `lightbox.ts`，组件侧只加 `data-*`：
 *
 *   data-reveal[ data-reveal-stagger]   滚动进场（视口下方才生效）
 *   data-motion-disclosure               <details> 开合
 *   data-motion-panel                    <details> 内的面板
 *   data-motion-lightbox                 灯箱（配合组件的 lightbox:open / lightbox:close-request 事件）
 *
 * 纯状态类交互（`data-press` 按压、`data-hover-lift` 抬升）留在 CSS，见 `src/styles/base.css`。
 *
 * 由 `src/components/MotionRuntime.astro` 挂进两套 `layout/Base.astro`。
 */
import { initDisclosures } from "./disclosure";
import { initLightbox } from "./lightbox";
import { initReveal } from "./reveal";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

let reduced = false;

export function prefersReducedMotion(): boolean {
	return reduced;
}

function syncReducedMotion(matches: boolean): void {
	reduced = matches;
	document.documentElement.toggleAttribute("data-reduced-motion", matches);
}

/**
 * 清掉滚动进场可能残留的隐藏态。
 *
 * 只在 init 抛错时调用：这时可能已经藏了元素但观察器没注册上，不还原的话
 * 内容会永久不可见。正常路径由 `reveal.ts` 自己在动画结束时清理。
 */
function clearHiddenState(): void {
	for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
		el.style.removeProperty("opacity");
		el.style.removeProperty("transform");
	}
}

function boot(): void {
	const media = window.matchMedia(REDUCED_MOTION);
	syncReducedMotion(media.matches);
	media.addEventListener("change", (event) => syncReducedMotion(event.matches));

	for (const init of [initReveal, initDisclosures, initLightbox]) {
		try {
			init();
		} catch (error) {
			clearHiddenState();
			console.warn("[motion] init failed", error);
		}
	}
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
	boot();
}
