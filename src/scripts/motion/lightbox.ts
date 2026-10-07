/**
 * 灯箱开合动效。
 *
 * `Lightbox.astro` 只负责状态与导航，动画在这里做，两者用 DOM 事件解耦：
 *   - 打开：组件 `showModal()` 后派发 `lightbox:open` → 这里淡入 + 轻微放大；
 *   - 关闭：组件派发**可取消**的 `lightbox:close-request`；这里 `preventDefault()`
 *     接管，播完退场再 `dialog.close()`。没有接管者（无 JS / 减动效）时组件自行
 *     `close()`，行为不退化。
 *
 * 只动 `opacity` / `scale`（合成层），不碰布局属性。
 */
import { animate } from "motion/mini";
import { prefersReducedMotion } from "./index";
import { durationSeconds, easing } from "./tokens";

const OPEN_EVENT = "lightbox:open";
const CLOSE_REQUEST = "lightbox:close-request";
const BOUND_FLAG = "lightboxBound";

export function initLightbox(): void {
	const dialog = document.querySelector<HTMLDialogElement>("[data-motion-lightbox]");
	if (!dialog || dialog.dataset[BOUND_FLAG] === "1") return;
	dialog.dataset[BOUND_FLAG] = "1";

	const figure = dialog.querySelector<HTMLElement>("[data-lightbox-figure]") ?? dialog;
	const duration = durationSeconds(dialog, "--motion-duration-base", 200);
	const ease = easing(dialog);

	dialog.addEventListener(OPEN_EVENT, () => {
		if (prefersReducedMotion()) return;
		animate(figure, { opacity: [0, 1], scale: [0.96, 1] }, { duration, ease });
	});

	dialog.addEventListener(CLOSE_REQUEST, (event) => {
		// 减动效下不接管：让组件走原生 close()，避免依赖被跳过的动画回调。
		if (prefersReducedMotion()) return;
		event.preventDefault();
		animate(figure, { opacity: [1, 0], scale: [1, 0.98] }, { duration: duration * 0.8, ease }).then(() => {
			figure.style.removeProperty("opacity");
			figure.style.removeProperty("transform");
			dialog.close();
		});
	});
}
