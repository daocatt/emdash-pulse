/**
 * 滚动进场：视口下方的区块随滚动渐显。
 *
 * 硬约束 —— SSR 内容必须对「无 JS / JS 报错 / 爬虫」完全可见，且 `Astro.cache`
 * 会缓存 HTML，所以**初始隐藏态只能由这里在运行时添加**，HTML 与 CSS 里绝不出现。
 * 于是：
 *   1. SSR 只输出静态 `data-reveal` 属性，元素正常可见；
 *   2. 首屏元素（含 LCP）直接跳过 —— 不隐藏、不注册观察器；
 *   3. 其余元素先设 `opacity: 0`，同一 tick 内注册观察器，进入视口后播一次。
 *
 * 只动 `opacity` 与 `y`（合成层），不碰布局属性，所以不产生 CLS。
 *
 * 用原生 `IntersectionObserver` + `motion/mini` 的 `animate`：mini 的 `delay`
 * 支持 `(i, total) => number`，错峰不用额外引 `stagger`。
 */
import { animate } from "motion/mini";
import { prefersReducedMotion } from "./index";
import { durationSeconds, easing, shift, staggerSeconds } from "./tokens";

/** 首屏判定：元素顶部高于视口 90% 就算首屏，不进场。 */
const ABOVE_FOLD_RATIO = 0.9;

/** 进场目标：默认整块，带 `data-reveal-stagger` 时是逐个直接子元素。 */
function targetsOf(container: HTMLElement): HTMLElement[] {
	if (!container.hasAttribute("data-reveal-stagger")) return [container];
	return Array.from(container.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
}

export function initReveal(): void {
	if (prefersReducedMotion()) return;
	if (typeof IntersectionObserver === "undefined") return;

	const containers = document.querySelectorAll<HTMLElement>("[data-reveal]");
	if (containers.length === 0) return;

	const fold = window.innerHeight * ABOVE_FOLD_RATIO;

	for (const container of containers) {
		if (container.getBoundingClientRect().top < fold) continue;

		const targets = targetsOf(container);
		if (targets.length === 0) continue;

		const from = shift(container, "--motion-shift-md", "10px");
		const duration = durationSeconds(container, "--motion-duration-slow", 320);
		const step = staggerSeconds(container, 45);
		const ease = easing(container);

		const clear = () => {
			for (const target of targets) {
				target.style.removeProperty("opacity");
				target.style.removeProperty("transform");
			}
		};

		// 隐藏态只加 opacity：元素此时不可见，动画起始的位移不会造成可见跳动。
		for (const target of targets) target.style.opacity = "0";

		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				observer.disconnect(); // 只播一次，离开视口不重播

				try {
					animate(
						targets,
						{ opacity: [0, 1], y: [from, "0px"] },
						{ duration, ease, delay: (index) => index * step },
					).then(clear);
				} catch (error) {
					clear();
					console.warn("[motion] reveal failed", error);
					return;
				}
				// 兜底：动画被取消时 then 不触发，别把内容留在隐藏态。
				window.setTimeout(clear, (duration + step * targets.length) * 1000 + 1000);
			},
			{ rootMargin: "0px 0px -12% 0px" },
		);

		observer.observe(container);
	}
}
