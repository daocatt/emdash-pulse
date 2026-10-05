/**
 * 归档导航数据构建：按月 / 按周两种模式共用，输出 ArchiveNav 的 props。
 */

import { monthRange, weekRange, isoWeeksInYear, addMonths, isValidMonth, isValidWeek } from "./date-range";
import { formatMonthLabel, formatWeekLabel } from "./format";
import type { ArchiveIndex } from "./archive";

export interface NavOption {
	href: string;
	label: string;
	current?: boolean;
}

export interface ArchiveNavData {
	modeLinks: { label: string; href: string; active: boolean }[];
	prevHref: string | null;
	nextHref: string | null;
	periodOptions: NavOption[];
	yearOptions: NavOption[];
}

/** 该 ISO 周起始日所在的月份（用于「按月」链接）。 */
export function monthOfWeek(year: number, week: number): number {
	const start = new Date(weekRange(year, week).gte);
	return start.getUTCMonth() + 1;
}

function yearsOrFallback(index: ArchiveIndex, year: number): number[] {
	return index.years.length > 0 ? index.years : [year];
}

export function buildMonthNav(year: number, month: number, index: ArchiveIndex): ArchiveNavData {
	const week = Math.max(1, Math.min(isoWeeksInYear(year), Math.ceil((month / 12) * isoWeeksInYear(year))));
	const prev = addMonths(year, month, -1);
	const next = addMonths(year, month, 1);

	return {
		modeLinks: [
			{ label: "按月", href: `/archive/${year}/${month}`, active: true },
			{ label: "按周", href: `/archive/${year}/week/${week}`, active: false },
		],
		prevHref: `/archive/${prev.year}/${prev.month}`,
		nextHref: `/archive/${next.year}/${next.month}`,
		periodOptions: Array.from({ length: 12 }, (_, i) => {
			const m = i + 1;
			return { href: `/archive/${year}/${m}`, label: formatMonthLabel(year, m), current: m === month };
		}),
		yearOptions: yearsOrFallback(index, year).map((y) => ({
			href: `/archive/${y}/${isValidMonth(month) ? month : 1}`,
			label: String(y),
			current: y === year,
		})),
	};
}

export function buildWeekNav(year: number, week: number, index: ArchiveIndex): ArchiveNavData {
	const total = isoWeeksInYear(year);
	const month = monthOfWeek(year, week);

	let prevHref: string | null;
	let nextHref: string | null;
	if (week <= 1) {
		const prevYear = year - 1;
		prevHref = `/archive/${prevYear}/week/${isoWeeksInYear(prevYear)}`;
	} else {
		prevHref = `/archive/${year}/week/${week - 1}`;
	}
	if (week >= total) {
		nextHref = `/archive/${year + 1}/week/1`;
	} else {
		nextHref = `/archive/${year}/week/${week + 1}`;
	}

	return {
		modeLinks: [
			{ label: "按月", href: `/archive/${year}/${month}`, active: false },
			{ label: "按周", href: `/archive/${year}/week/${week}`, active: true },
		],
		prevHref,
		nextHref,
		periodOptions: Array.from({ length: total }, (_, i) => {
			const w = i + 1;
			return { href: `/archive/${year}/week/${w}`, label: formatWeekLabel(year, w), current: w === week };
		}),
		yearOptions: yearsOrFallback(index, year).map((y) => ({
			href: `/archive/${y}/week/${isValidWeek(y, week) ? week : 1}`,
			label: String(y),
			current: y === year,
		})),
	};
}
