/**
 * 动效运行时的延迟引导（**不含 motion**）。
 *
 * 运行时要等两道门都通过才值得下载：
 *   1. reduced-motion 未开启（开启时整个运行时都不该加载）；
 *   2. 页面里真的用到了动效 —— 有 `[data-reveal]` / `details[data-motion-disclosure]`
 *      / `[data-motion-lightbox]` 之一。多数静态页（版块 / 归档 / 订阅页…）没有目标，
 *      于是连 `motion/mini` 都不会请求。
 *
 * 通过后也不立即加载：先 `requestIdleCallback`（回退 `setTimeout`）等空闲；若用户
 * 先滚动 / 按下 / 按键，则立刻加载。这样动效引擎不参与首屏的 LCP / TBT。
 *
 * 降级：运行时就绪前点开灯箱，`lightbox:open` 无人监听 → 灯箱正常打开但没有进场动画；
 * 关闭时 `lightbox:close-request` 返回 `true` → 组件走原生 `dialog.close()`。
 * 这正是既有的「无 JS / 减动效」兜底路径，行为不退化。
 */
import { initReducedMotion } from "./reduced-motion";

/** 用到动效的标记。与三个 init 的查询保持一致。 */
const TARGETS = "[data-reveal], details[data-motion-disclosure], [data-motion-lightbox]";
/** 空闲回调的兜底超时：浏览器一直不空闲也别无限等。 */
const IDLE_TIMEOUT = 2000;
/** 用户先动起来就立刻加载，别等空闲。 */
const EAGER_EVENTS = ["scroll", "pointerdown", "keydown"] as const;

let started = false;

function start(): void {
	if (started) return;
	started = true;
	import("./runtime")
		.then((module) => module.run())
		.catch((error) => console.warn("[motion] load failed", error));
}

function schedule(): void {
	if (typeof requestIdleCallback === "function") {
		requestIdleCallback(start, { timeout: IDLE_TIMEOUT });
	} else {
		window.setTimeout(start, 0);
	}
	for (const type of EAGER_EVENTS) {
		window.addEventListener(type, start, { once: true, passive: true });
	}
}

function boot(): void {
	if (initReducedMotion()) return;
	if (document.querySelector(TARGETS) === null) return;
	schedule();
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
	boot();
}
