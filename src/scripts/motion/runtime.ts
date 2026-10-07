/**
 * 动效运行时（**含 motion 引擎**，只由 `boot.ts` 动态 `import()`）。
 *
 * 这里是被延迟加载的重活：具体动效在 `reveal.ts` / `disclosure.ts` / `lightbox.ts`，
 * 组件侧只加 `data-*`：
 *
 *   data-reveal[ data-reveal-stagger]   滚动进场（仅视口下方才生效）
 *   data-motion-disclosure               <details> 开合
 *   data-motion-panel                    <details> 内的面板
 *   data-motion-lightbox                 灯箱（配合组件的 lightbox:open / lightbox:close-request 事件）
 *
 * 纯状态类交互（`data-press` 按压、`data-hover-lift` 抬升）留在 CSS，见 `src/styles/base.css`。
 *
 * **不要**从别处静态 import 本模块 —— 一旦被静态引用就会把 `motion/mini` 拉回首屏包，
 * 延迟加载失效。入口是 `boot.ts`，挂在两套 `layout/Base.astro` 的 `<MotionRuntime />`。
 */
import { initDisclosures } from "./disclosure";
import { initLightbox } from "./lightbox";
import { initReveal } from "./reveal";

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

/** 逐个 init；单个失败只回滚隐藏态，不影响其余。 */
export function run(): void {
	// 标记运行时已接管：组件里的 CSS 兜底动画（页面刚打开、运行时还没绑定时用）
	// 靠这个属性让位，避免和 WAAPI 同时驱动同一条属性。
	document.documentElement.dataset.motionReady = "1";
	for (const init of [initReveal, initDisclosures, initLightbox]) {
		try {
			init();
		} catch (error) {
			clearHiddenState();
			console.warn("[motion] init failed", error);
		}
	}
}
