/**
 * 作者（byline）展示工具。
 *
 * 头像：`BylineSummary` 的 `avatarMediaId` 走媒体文件端点；作者卡在拿不到
 * 头像时必须能降级成「姓名首字色块」—— 因为 seed 里的 byline 头像要求文件
 * 已在 storage（本地 `./uploads`），未落地时 `avatarMediaId` 为空。
 */
import type { BylineSummary } from "emdash";
import { resolveMediaUrl } from "./media";

/** 头像 URL；没有头像时返回 null（调用方走首字回退）。 */
export function bylineAvatarUrl(byline: Pick<BylineSummary, "avatarMediaId">): string | null {
	return resolveMediaUrl({ id: byline.avatarMediaId ?? undefined });
}

/**
 * 姓名首字：中文取第一个字，拉丁文取前两个词的首字母。
 * 例：「张伟」→「张」，「Maria Rodale」→「MR」。
 */
export function bylineInitials(displayName: string): string {
	const name = displayName.trim();
	if (!name) return "?";
	if (/^[\x00-\x7F]+$/.test(name)) {
		const words = name.split(/\s+/).slice(0, 2);
		return words.map((word) => word[0]?.toUpperCase() ?? "").join("");
	}
	return [...name][0] ?? "?";
}
