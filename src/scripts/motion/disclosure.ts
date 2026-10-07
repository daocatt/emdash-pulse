/**
 * `<details>` 开合动效。
 *
 * `<details>` 关闭时内容不参与布局，无法直接 transition height，所以主路径是
 * **拦截 `summary` 的 click（可取消）再用 `animate()` 驱动**：
 *   - 绝对定位面板（下拉菜单）脱离文档流 → 只动 `opacity` + `y`，动 height 无意义；
 *   - 普通流面板 → 动 `height`（`0 ↔ scrollHeight`）+ `opacity`。
 *
 * 渐进增强：reduced-motion 或 JS 未加载时**不接管**，原生 `<details>` 照常开合。
 * 键盘 Enter / Space 也会派发 click，因此键盘同样走这套。
 */
import { animate } from "motion/mini";
import { prefersReducedMotion } from "./index";
import { durationSeconds, easing, shift } from "./tokens";

const BOUND_FLAG = "motionBound";

export function initDisclosures(): void {
	if (prefersReducedMotion()) return;

	const list = document.querySelectorAll<HTMLDetailsElement>("details[data-motion-disclosure]");

	for (const details of list) {
		if (details.dataset[BOUND_FLAG] === "1") continue;

		const summary = details.querySelector("summary");
		const panel = details.querySelector<HTMLElement>("[data-motion-panel]");
		if (!summary || !panel) continue;
		details.dataset[BOUND_FLAG] = "1";

		const floating = getComputedStyle(panel).position === "absolute";
		const duration = durationSeconds(panel, "--motion-duration-fast", 140);
		const ease = easing(panel);
		const offset = shift(panel, "--motion-shift-sm", "4px");

		const reset = () => {
			panel.style.removeProperty("height");
			panel.style.removeProperty("overflow");
			panel.style.removeProperty("opacity");
			panel.style.removeProperty("transform");
		};

		const open = () => {
			if (floating) {
				panel.style.opacity = "0"; // 先压住，避免 open 到首帧之间闪一下
				animate(panel, { opacity: [0, 1], y: [offset, "0px"] }, { duration, ease }).then(reset);
				return;
			}
			const height = panel.scrollHeight;
			panel.style.overflow = "hidden";
			panel.style.height = "0px";
			panel.style.opacity = "0";
			animate(panel, { height: ["0px", `${height}px`], opacity: [0, 1] }, { duration, ease }).then(reset);
		};

		const close = (done: () => void) => {
			if (floating) {
				animate(panel, { opacity: [1, 0], y: ["0px", offset] }, { duration, ease }).then(done);
				return;
			}
			panel.style.overflow = "hidden";
			animate(panel, { height: [`${panel.scrollHeight}px`, "0px"], opacity: [1, 0] }, { duration, ease }).then(
				() => {
					reset();
					done();
				},
			);
		};

		summary.addEventListener("click", (event) => {
			event.preventDefault();
			if (details.open) {
				close(() => {
					details.open = false;
				});
				return;
			}
			// 先置 open，内容才可见 / 可测高；隐藏态已在 open() 里同步设好。
			details.open = true;
			open();
		});
	}
}
