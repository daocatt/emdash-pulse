/**
 * 中文字典（默认语言）。
 *
 * 这里是**键的源头**：`MessageKey` 由本文件推导，`en.ts` 必须覆盖全部键
 * （类型上是 `Record<MessageKey, string>`，漏一个就编译失败）。
 *
 * 只放 UI 文案（导航、区块标题、按钮、分页、归档、订阅、404…），
 * 不放内容 —— 稿件与分类名来自 EmDash，不做翻译。
 * 插值用 `{name}`，见 `t()`。
 */
export const zhCN = {
	// 通用
	"common.skipToContent": "跳至正文",
	"common.themeToggle": "切换深浅色",
	"common.language": "语言",
	"common.search": "搜索",
	"common.searchPlaceholder": "搜索新闻…",
	"common.searchLabel": "搜索关键词",
	"common.searchSubmit": "搜索",
	"common.subscribe": "订阅",
	"common.backHome": "返回头版",
	"common.browseArchive": "浏览归档",
	"common.more": "更多",
	"common.readingTime": "{minutes} 分钟阅读",
	"common.source": "来源：{source}",

	// 分页
	"pagination.navLabel": "分页",
	"pagination.prev": "上一页",
	"pagination.next": "下一页",
	"pagination.pageOf": "第 {page} / {total} 页",
	"pagination.status": "第 {page} 页",

	// 更正说明
	"correction.label": "更正",
	"correction.ariaLabel": "更正说明",

	// 归档导航
	"archive.navLabel": "归档导航",
	"archive.modeMonth": "按月",
	"archive.modeWeek": "按周",
	"archive.prevPeriod": "上一期",
	"archive.nextPeriod": "下一期",
	"archive.yearLabel": "年份",
	"archive.periodLabel": "期间",

	// 页脚
	"footer.navLabel": "页脚导航",
	"footer.credit": "© {year} {siteTitle} · 由 Agent 与编辑协作产出",

	// 404
	"notFound.title": "页面未找到",
	"notFound.text": "你要找的报道可能已下架，或链接有误。",

	// news-factory 首页
	"nf.lead": "头条",
	"nf.mainStory": "主稿",
	"nf.trending": "热门话题",
	"nf.latestUpdate": "最新更新",
	"nf.moreTopStories": "更多头条",
	"nf.newsletter": "订阅通讯",
	"nf.newsletterHint": "留下邮箱，最新报道送到收件箱。",
	"nf.newsletterCta": "订阅",
	"nf.video": "视频",

	// maple-news 首页
	"mn.latestUpdates": "最新更新",
	"mn.spotlight": "焦点",
	"mn.podcast": "播客",
	"mn.allPodcasts": "全部播客",
	"mn.contributor": "撰稿人",
};

export type MessageKey = keyof typeof zhCN;
