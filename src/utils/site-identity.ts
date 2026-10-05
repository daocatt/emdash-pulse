/**
 * 站点身份解析。
 *
 * EmDash 的 SiteSettings 已直接提供 title / tagline / logo / favicon，
 * 这里做一层兜底，保证前台各处拿到非空值。
 */

export interface MediaReference {
	mediaId: string;
	alt?: string;
	url?: string;
}

export interface SiteIdentitySettings {
	title?: string;
	tagline?: string;
	logo?: MediaReference;
	favicon?: MediaReference;
}

const DEFAULT_SITE_TITLE = "Suda Pulse";
const DEFAULT_SITE_TAGLINE = "AI 时代的新闻脉搏";

export function resolveSiteIdentity(settings?: SiteIdentitySettings) {
	return {
		siteTitle: settings?.title?.trim() || DEFAULT_SITE_TITLE,
		siteTagline: settings?.tagline?.trim() || DEFAULT_SITE_TAGLINE,
		siteLogo: settings?.logo?.url ? settings.logo : null,
	};
}
