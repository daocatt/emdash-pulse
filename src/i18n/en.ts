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
	"common.login": "Log in",
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

	// 菜单标签
	"menu.home": "Home",
	"menu.archive": "Archive",
	"menu.subscribe": "Subscribe",
	"menu.rss": "RSS",
	"menu.section.top": "Top stories",
	"menu.section.world": "World",
	"menu.section.business": "Business",
	"menu.section.tech": "Tech",
	"menu.section.sports": "Sports",
	"menu.section.culture": "Culture",
	"menu.section.society": "Society",
	"menu.section.opinion": "Opinion",
	"menu.section.photo": "Photo",
	"menu.page.about": "About",
	"menu.page.ethics": "Editorial standards",
	"menu.page.agents": "Agent access",
	"menu.page.contact": "Contact",

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

	// pulse-news 首页
	"pn.menu": "Menu",
	"pn.subscribeCta": "Annual subscription",
	"pn.latestUpdates": "Latest Updates",
	"pn.spotlight": "Spotlight",
	"pn.podcast": "Podcast",
	"pn.allPodcasts": "All podcasts",
	"pn.contributor": "Contributor",
	"pn.updated": "Updated {date}",

	// Listing pages (section / tag)
	"list.sectionKicker": "Section",
	"list.sectionTitle": "{label} · Section",
	"list.sectionDescription": "The latest stories in {label}",
	"list.emptySection": "Nothing in this section yet.",
	"list.tagKicker": "Tag",
	"list.tagTitle": "Tag: {label}",
	"list.tagDescription": "Stories tagged “{label}”",
	"list.emptyTag": "Nothing under this tag yet.",
	"list.count": "{count} stories",
	"list.other": "Other",

	// Feed discovery links (<link rel="alternate">)
	"feed.sectionTitle": "{label} · RSS feed",

	// Archive
	"archive.title": "Archive",
	"archive.allReports": "All stories",
	"archive.intro": "Browse past stories by date, or switch to the month / week view.",
	"archive.description": "Browse every {siteTitle} story by month or by week",
	"archive.monthKicker": "Monthly archive",
	"archive.monthTitle": "{label} · Archive",
	"archive.monthDescription": "Every story published in {label}",
	"archive.weekKicker": "Weekly archive",
	"archive.weekTitle": "{label} · Archive",
	"archive.weekDescription": "Every story published in {label} ({start} – {end})",
	"archive.recent": "Recently published",
	"archive.empty": "Nothing published yet.",
	"archive.emptyMonth": "Nothing published this month.",
	"archive.emptyWeek": "Nothing published this week.",

	// Edition
	"edition.kickerWeek": "Weekly edition",
	"edition.kickerMonth": "Monthly edition",
	"edition.meta": "{year} · No. {period} · {count} stories",
	"edition.empty": "No stories in this edition yet.",

	// Article page
	"article.info": "Story details",
	"article.aside": "Sidebar",
	"article.reviewed": "Passed editorial review",
	"article.edition": "Edition: {label}",
	"article.gallery": "Gallery",
	"article.photoCredit": "Photography: {name}",
	"article.photoNote": "This is a photo story; the gallery is still being assembled.",
	"article.tags": "Tags",
	"article.comments": "Comments",
	"article.related": "Related coverage",

	// Comment area (replaces EmDash's built-in Comments / CommentForm copy)
	"comments.count": "{count} comments",
	"comments.countOne": "1 comment",
	"comments.empty": "No comments yet. Be the first to write one.",
	"comments.name": "Name",
	"comments.email": "Email",
	"comments.body": "Comment",
	"comments.submit": "Post comment",
	"comments.submitting": "Submitting…",
	"comments.submitted": "Comment submitted. It will appear once approved.",
	"comments.error": "Failed to submit. Please try again later.",
	"comments.networkError": "Network error. Please try again.",
	"comments.member": "Site member",
	"comments.honeypot": "Do not fill this in",

	// Search
	"search.title": "Search",
	"search.resultsTitle": "Search: {query}",
	"search.description": "Search stories and pages on {siteTitle}",
	"search.placeholder": "Type a keyword, e.g. “review”, “photo story”…",
	"search.empty": "Nothing found for “{query}”",
	"search.found": "Found {count} results for “{query}”",
	"search.fuzzy": " (fuzzy match)",
	"search.collectionPage": "Page",
	"search.collectionArticle": "Story",
	"search.untitled": "Untitled",

	// Subscription pages (distinct from the subscribe.* form strings)
	"subscribePage.title": "Subscribe",
	"subscribePage.heading": "Subscribe to {siteTitle}",
	"subscribePage.description": "Subscribe to {siteTitle} and get the latest stories by email",
	"subscribePage.lede": "We send the latest stories and important updates to your inbox. No ads, unsubscribe anytime.",
	"subscribePage.formHeading": "Leave your email",
	"subscribePage.formHint": "After submitting, open the confirmation link in your inbox to complete the double opt-in.",
	"subscribePage.flow": "How it works",
	"subscribePage.step1": "After you submit your email, we send a confirmation message.",
	"subscribePage.step2": "Click the link in that email to confirm — double opt-in prevents mistakes and abuse.",
	"subscribePage.step3": "Every email carries an unsubscribe link, so you can leave with one click.",
	"subscribePage.confirmTitle": "Confirm subscription",
	"subscribePage.confirmHeading": "Subscription confirmed",
	"subscribePage.confirmAlready": "This email was already subscribed, so there was nothing to do.",
	"subscribePage.confirmThanks": "Thanks for subscribing — we will send the latest stories to your inbox.",
	"subscribePage.confirmFailed": "Confirmation failed",
	"subscribePage.confirmInvalid": "This confirmation link is invalid or has expired. Please subscribe again.",
	"subscribePage.confirmMissingToken": "The confirmation link is missing its token.",
	"subscribePage.resubscribe": "Subscribe again",
	"subscribePage.unsubscribeTitle": "Unsubscribe",
	"subscribePage.unsubscribed": "Unsubscribed",
	"subscribePage.unsubscribedText": "We will not send any more subscription email to this address.",
	"subscribePage.unsubscribeFailed": "Unsubscribe failed",
	"subscribePage.unsubscribeInvalid": "This unsubscribe link is invalid or has expired.",
	"subscribePage.unsubscribeMissingToken": "The unsubscribe link is missing its token.",

	// Image viewer (Lightbox singleton + gallery / hero / edition cover triggers)
	"lightbox.label": "Image viewer",
	"lightbox.close": "Close",
	"lightbox.prev": "Previous image",
	"lightbox.next": "Next image",
	"lightbox.viewImage": "View image {index}",
	"lightbox.zoom": "View larger",

	// 404
	"notFound.description": "Page not found",
};
