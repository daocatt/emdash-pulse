/**
 * 日期与文本格式化工具。
 *
 * 站点时区固定为 Asia/Shanghai：展示用 Intl 做时区换算，
 * 归档边界仍走 date-range.ts 的 UTC 半开区间（Phase 5 再精修）。
 */

import { extractPlainText } from "./text";

export const SITE_TIMEZONE = "Asia/Shanghai";

export function toDate(value: Date | string | null | undefined): Date | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** 例：2026年10月6日 */
export function formatDate(value: Date | string | null | undefined, timeZone = SITE_TIMEZONE): string {
	const date = toDate(value);
	if (!date) return "";
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone,
	}).format(date);
}

/** 例：2026年10月6日 14:30 */
export function formatDateTime(value: Date | string | null | undefined, timeZone = SITE_TIMEZONE): string {
	const date = toDate(value);
	if (!date) return "";
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZone,
	}).format(date);
}

/** 报头用短日期，例：2026年10月6日 星期二 */
export function formatMastheadDate(value: Date | string = new Date(), timeZone = SITE_TIMEZONE): string {
	const date = toDate(value) ?? new Date();
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "long",
		day: "numeric",
		weekday: "long",
		timeZone,
	}).format(date);
}

/** 例：2026年10月 */
export function formatMonthLabel(year: number, month: number): string {
	return `${year}年${month}月`;
}

/** 例：2026年第40周 */
export function formatWeekLabel(year: number, week: number): string {
	return `${year}年第${week}周`;
}

/** 返回某个日期所在的 ISO 周（周一为一周起点）。 */
export function isoWeekOf(value: Date | string | null | undefined): { year: number; week: number } | null {
	const date = toDate(value);
	if (!date) return null;
	// 复制到该日 UTC 正午，避免时区抖动
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dayNum = d.getUTCDay() || 7;
	// 移动到本周四，周四所在的年份即 ISO 周所属年份
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	const isoYear = d.getUTCFullYear();
	const yearStart = new Date(Date.UTC(isoYear, 0, 1));
	const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return { year: isoYear, week };
}

/** 粗略估算阅读时长（分钟），中文按 350 字/分钟。 */
export function estimateReadingTime(content: unknown): number {
	const text = extractPlainText(content);
	const count = text.replace(/\s/g, "").length;
	return Math.max(1, Math.round(count / 350));
}
