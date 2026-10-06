import type { MessageKey } from "./zh-CN";

/** 英文字典。键必须与 zh-CN.ts 完全一致（类型上强制）。 */
export const en: Record<MessageKey, string> = {
	// 通用
	"nav.mainLabel": "Main navigation",
	"common.skipToContent": "Skip to content",
	"common.themeToggle": "Toggle light and dark theme",
	"common.language": "Language",
	"common.search": "Search",
	"common.searchPlaceholder": "Search the news…",
	"common.searchLabel": "Search keywords",
	"common.searchSubmit": "Search",
	"common.subscribe": "Subscribe",
	"common.backHome": "Back to front page",
	"common.browseArchive": "Browse the archive",
	"common.more": "More",
	"common.readingTime": "{minutes} min read",
	"common.source": "Source: {source}",

	// 分页
	"pagination.navLabel": "Pagination",
	"pagination.prev": "Previous",
	"pagination.next": "Next",
	"pagination.pageOf": "Page {page} of {total}",
	"pagination.status": "Page {page}",

	// 更正说明
	"correction.label": "Correction",
	"correction.ariaLabel": "Correction notice",

	// 署名
	"byline.newsroom": "The Newsroom",

	// 订阅表单
	"subscribe.emailLabel": "Email address",
	"subscribe.emailPlaceholder": "you@example.com",
	"subscribe.required": "Please enter your email address.",
	"subscribe.pending": "Submitting…",
	"subscribe.confirmed": "Subscribed. Thanks for following.",
	"subscribe.sent": "Confirmation email sent — open it and click the link to finish.",
	"subscribe.undelivered":
		"Subscription recorded. Email delivery is not configured yet, so no confirmation email was sent.",
	"subscribe.rateLimited": "Too many attempts. Please try again later.",
	"subscribe.invalid": "That email address looks invalid.",
	"subscribe.failed": "Submission failed. Please try again later.",
	"subscribe.network": "Network error. Please try again later.",
	"subscribe.needsJs": "JavaScript is required to subscribe.",

	// 归档导航
	"archive.navLabel": "Archive navigation",
	"archive.modeMonth": "By month",
	"archive.modeWeek": "By week",
	"archive.prevPeriod": "Previous",
	"archive.nextPeriod": "Next",
	"archive.yearLabel": "Year",
	"archive.periodLabel": "Period",

	// 页脚
	"footer.navLabel": "Footer navigation",
	"footer.credit": "© {year} {siteTitle} · Produced by agents and editors",

	// 404
	"notFound.title": "Page not found",
	"notFound.text": "This story may have been taken down, or the link is wrong.",

	// news-factory 首页
	"nf.login": "Log in",
	"nf.subscribeCta": "Subscribe",
	"nf.mainStory": "Main story",
	"nf.trending": "Trending topic",
	"nf.latestUpdate": "Latest update",
	"nf.moreTopStories": "More top stories",
	"nf.breaking": "Breaking",
	"nf.playVideo": "Play video",
	"nf.newsletter": "Subscribe our newsletter",
	"nf.newsletterHint": "Leave your email and get the latest stories in your inbox.",
	"nf.aside": "Sidebar",

	// maple-news 首页
	"mn.latestUpdates": "Latest Updates",
	"mn.spotlight": "Spotlight",
	"mn.podcast": "Podcast",
	"mn.allPodcasts": "All podcasts",
	"mn.contributor": "Contributor",
};
