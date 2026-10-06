/**
 * UI 文案多语言（只覆盖界面文案，不翻译内容）。
 *
 * 设计取舍：
 * - **不打开 Astro 的 i18n**。EmDash 只在 Astro 配了多个 locale 时才激活内容
 *   翻译链路，而它会按 locale 过滤所有内容查询 —— 现有内容行的 locale 是 `en`，
 *   默认语言设成 `zh-CN` 会让列表与详情全部查空。
 * - **运行时切换**：语言存在 cookie（`suda-pulse-lang`），另支持 `?lang=` 查询
 *   参数（首次点击切换链接时 cookie 还没写，靠查询参数生效）。
 * - 组件里用 `getTranslations(Astro)` 拿到绑定好的 `t()`，不需要逐层传 prop。
 */
import { en } from "./en";
import { zhCN, type MessageKey } from "./zh-CN";

export type { MessageKey };

export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh-CN";

/** 语言 cookie 名。 */
export const LOCALE_COOKIE = "suda-pulse-lang";

/** 语言切换控件显示用的短标签。 */
export const LOCALE_LABELS: Record<Locale, string> = {
	"zh-CN": "中文",
	en: "English",
};

const MESSAGES: Record<Locale, Record<MessageKey, string>> = {
	"zh-CN": zhCN,
	en,
};

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** `resolveLocale` 需要的最小上下文（Astro 全局对象满足此结构）。 */
export interface LocaleSource {
	cookies: { get(name: string): { value: string } | undefined };
	url: URL;
}

/** cookie 优先，其次 `?lang=`，最后默认语言。 */
export function resolveLocale(source: LocaleSource): Locale {
	const fromCookie = source.cookies.get(LOCALE_COOKIE)?.value;
	if (isLocale(fromCookie)) return fromCookie;
	const fromQuery = source.url.searchParams.get("lang");
	if (isLocale(fromQuery)) return fromQuery;
	return DEFAULT_LOCALE;
}

export type Translator = (key: MessageKey, params?: Record<string, string | number>) => string;

/** 生成绑定到某个语言的 `t()`；缺键时回退默认语言，再回退键名本身。 */
export function createTranslator(locale: Locale): Translator {
	const dict = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
	return (key, params) => {
		const template = dict[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
		if (!params) return template;
		return template.replace(/\{(\w+)\}/g, (match, name: string) =>
			name in params ? String(params[name]) : match,
		);
	};
}

export function getTranslations(source: LocaleSource): { locale: Locale; t: Translator } {
	const locale = resolveLocale(source);
	return { locale, t: createTranslator(locale) };
}

/** 同一条路径在另一个语言下的地址（保留当前查询参数，覆盖 `lang`）。 */
export function localeHref(url: URL, locale: Locale): string {
	const next = new URL(url);
	next.searchParams.set("lang", locale);
	return `${next.pathname}${next.search}`;
}

/**
 * 菜单标签的字典键，按「规范化后的路径」匹配。
 *
 * 后台菜单只负责链接与排序，标签在渲染期按当前语言取，避免英文界面里
 * 导航仍是中文。表里没有的地址回退到菜单自身的标签（后台填的中文）。
 */
const MENU_LABEL_KEYS: Record<string, MessageKey> = {
	"/": "menu.home",
	"/archive": "menu.archive",
	"/subscribe": "menu.subscribe",
	"/rss.xml": "menu.rss",
	"/sections/top": "menu.section.top",
	"/sections/world": "menu.section.world",
	"/sections/business": "menu.section.business",
	"/sections/tech": "menu.section.tech",
	"/sections/sports": "menu.section.sports",
	"/sections/culture": "menu.section.culture",
	"/sections/society": "menu.section.society",
	"/sections/opinion": "menu.section.opinion",
	"/sections/photo": "menu.section.photo",
	"/pages/about": "menu.page.about",
	"/pages/ethics": "menu.page.ethics",
	"/pages/agents": "menu.page.agents",
	"/pages/contact": "menu.page.contact",
};

/** 菜单项的显示标签：命中字典键用当前语言，否则回退菜单自身标签。 */
export function menuLabel(url: string, fallback: string, t: Translator): string {
	const path = url.split(/[?#]/)[0].replace(/\/$/, "") || "/";
	const key = MENU_LABEL_KEYS[path];
	return key ? t(key) : fallback;
}
