/**
 * 按月 / 按周的日期范围工具。
 *
 * EmDash 的 getEmDashCollection 支持 where 的 WhereRange（gt/gte/lt/lte，string 值），
 * 日期字段按 ISO 字符串比较。这里统一返回半开区间 [gte, lt)，便于直接传给 where。
 */

export interface DateRange {
	gte: string;
	lt: string;
}

/** 某年某月（month: 1-12）的 [起, 止) 区间（UTC）。 */
export function monthRange(year: number, month: number): DateRange {
	const start = new Date(Date.UTC(year, month - 1, 1));
	const end = new Date(Date.UTC(year, month, 1));
	return { gte: start.toISOString(), lt: end.toISOString() };
}

/** 某年某 ISO 周（week: 1-53）的 [周一, 下周一) 区间（UTC）。 */
export function weekRange(year: number, week: number): DateRange {
	const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
	const dow = simple.getUTCDay() || 7; // 周一=1 … 周日=7
	const monday = new Date(simple);
	monday.setUTCDate(simple.getUTCDate() - dow + 1);
	const nextMonday = new Date(monday);
	nextMonday.setUTCDate(monday.getUTCDate() + 7);
	return { gte: monday.toISOString(), lt: nextMonday.toISOString() };
}

/** 某年的 ISO 周总数（52 或 53）。 */
export function isoWeeksInYear(year: number): number {
	const last = new Date(Date.UTC(year, 11, 28));
	const dow = last.getUTCDay() || 7;
	const thursday = new Date(last);
	thursday.setUTCDate(last.getUTCDate() + 4 - dow);
	const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
	return Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
