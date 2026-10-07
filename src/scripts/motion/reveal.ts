/**
 * 滚动进场：视口下方的区块随滚动渐显。
 *
 * 硬约束 —— SSR 内容必须对「无 JS / JS 报错 / 爬虫」完全可见，且 `Astro.cache`
 * 会缓存 HTML，所以**初始隐藏态只能由这里在运行时添加**，HTML 与 CSS 里绝不出现。
 * 于是：
 *   1. SSR 只输出静态 `data-reveal` 属性，元素正常可见；
 *   2. 任何已经落在视口内的元素（含 LCP）直接跳过 —— 不隐藏、不注册观察器；
 *   3. 其余元素先设 `opacity: 0`，同一 tick 内注册观察器，进入视口后播一次。
 *
 * 第 2 条判的是「顶部 < innerHeight」而不是「< innerHeight * 0.9」：运行时是
 * **延迟加载**的（见 `boot.ts`），初始化时用户可能已经滚过一段，若把视口下缘那
 * 10% 也算进「要隐藏」，这些元素会在用户眼前闪一下再动画。
 *
 * 只动 `opacity` 与 `y`（合成层），不碰布局属性，所以不产生 CLS。
 *
 * 用原生 `IntersectionObserver` + `motion/mini` 的 `animate`：mini 的 `delay`
 * 支持 `(i, total) => number`，错峰不用额外引 `stagger`。
 */
import { animate } from "motion/mini";
import { prefersReducedMotion } from "./reduced-motion";
import { durationSeconds, easing, shift, staggerSeconds } from "./tokens";

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

	// 只藏「完全在视口下方」的：已在视口内（或已滚过）的一律不动，避免闪一下再进场。
	const fold = window.innerHeight;

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
						// `motion/mini` 不做 `y` → `transform` 的映射：它把 keyframe 的属性名直接交给
						// WAAPI，`y` 不是合法 CSS 属性（实测无任何效果），必须写完整的 `transform`。
						{ opacity: [0, 1], transform: [`translateY(${from})`, "translateY(0px)"] },
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
