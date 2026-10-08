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
	"nav.mainLabel": "主导航",
	"common.skipToContent": "跳至正文",
	"common.themeToggle": "切换深浅色",
	"common.language": "语言",
	"common.search": "搜索",
	"common.searchPlaceholder": "搜索新闻…",
	"common.searchLabel": "搜索关键词",
	"common.searchSubmit": "搜索",
	"common.subscribe": "订阅",
	"common.login": "登录",
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

	// 署名
	"byline.newsroom": "编辑部",

	// 订阅表单
	"subscribe.emailLabel": "邮箱地址",
	"subscribe.emailPlaceholder": "you@example.com",
	"subscribe.required": "请输入邮箱地址。",
	"subscribe.pending": "提交中…",
	"subscribe.confirmed": "已订阅，感谢关注。",
	"subscribe.sent": "确认邮件已发送，请查收并点击链接完成订阅。",
	"subscribe.undelivered": "订阅已记录。邮件服务尚未配置，暂时无法发送确认邮件。",
	"subscribe.rateLimited": "提交过于频繁，请稍后再试。",
	"subscribe.invalid": "邮箱格式不正确。",
	"subscribe.failed": "提交失败，请稍后再试。",
	"subscribe.network": "网络异常，请稍后再试。",
	"subscribe.needsJs": "需要启用 JavaScript 才能提交订阅。",
	"subscribe.groupsLabel": "订阅分组",
	"subscribe.groupsHint": "可多选；一个都不勾则只收主刊。",
	"subscribe.paused": "该邮箱已被暂停订阅，请联系编辑部。",

	// 菜单标签
	// 后台菜单只提供链接与排序，显示标签由字典按当前语言渲染（见 menuLabel）。
	// 表里没有的地址回退到菜单自身的标签。
	"menu.home": "首页",
	"menu.archive": "归档",
	"menu.subscribe": "订阅",
	"menu.rss": "RSS",
	"menu.section.top": "要闻",
	"menu.section.world": "国际",
	"menu.section.business": "财经",
	"menu.section.tech": "科技",
	"menu.section.sports": "体育",
	"menu.section.culture": "文化",
	"menu.section.society": "社会",
	"menu.section.opinion": "评论",
	"menu.section.photo": "图片",
	"menu.page.about": "关于",
	"menu.page.ethics": "采编规范",
	"menu.page.agents": "Agent 接入",
	"menu.page.contact": "联系",

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
	"nf.subscribeCta": "订阅通讯",
	"nf.mainStory": "主稿",
	"nf.trending": "热门话题",
	"nf.latestUpdate": "最新更新",
	"nf.moreTopStories": "更多头条",
	"nf.breaking": "突发",
	"nf.playVideo": "播放视频",
	"nf.newsletter": "订阅通讯",
	"nf.newsletterHint": "留下邮箱，最新报道送到收件箱。",
	"nf.aside": "侧栏",
	"nf.editionPicks": "本期精选",
	"nf.multimedia": "多媒体",
	"nf.aiTopic": "AI 话题",

	// pulse-news 首页
	"pn.menu": "菜单",
	"pn.subscribeCta": "年度订阅",
	"pn.latestUpdates": "最新更新",
	"pn.spotlight": "焦点",
	"pn.podcast": "播客",
	"pn.allPodcasts": "全部播客",
	"pn.contributor": "撰稿人",
	"pn.updated": "更新于 {date}",
	"pn.editionPicks": "本期精选",
	"pn.multimedia": "多媒体",
	"pn.aiTopic": "AI 话题",

	// 列表页（版块 / 标签）
	"list.sectionKicker": "版块",
	"list.sectionTitle": "{label} · 版块",
	"list.sectionDescription": "{label}版块的最新报道",
	"list.emptySection": "该版块暂无内容。",
	"list.tagKicker": "标签",
	"list.tagTitle": "标签：{label}",
	"list.tagDescription": "带有「{label}」标签的报道",
	"list.emptyTag": "该标签下暂无内容。",
	"list.count": "共 {count} 篇",
	"list.other": "其他",

	// Feed 发现链接（<link rel="alternate">）
	"feed.sectionTitle": "{label} · RSS 订阅",

	// 归档
	"archive.title": "归档",
	"archive.allReports": "全部报道",
	"archive.intro": "按时间浏览过往报道，或切换到按月 / 按周视图。",
	"archive.description": "按月 / 按周浏览 {siteTitle} 的全部报道",
	"archive.monthKicker": "按月归档",
	"archive.monthTitle": "{label} · 归档",
	"archive.monthDescription": "{label}发布的全部报道",
	"archive.weekKicker": "按周归档",
	"archive.weekTitle": "{label} · 归档",
	"archive.weekDescription": "{label}（{start} 至 {end}）发布的全部报道",
	"archive.recent": "最近发布",
	"archive.empty": "暂无已发布内容。",
	"archive.emptyMonth": "本月暂无已发布内容。",
	"archive.emptyWeek": "本周暂无已发布内容。",

	// 期号
	"edition.kickerWeek": "周报",
	"edition.kickerMonth": "月报",
	"edition.meta": "{year} 年 · 第 {period} 期 · 共 {count} 篇",
	"edition.empty": "本期暂无收录文章。",

	// 文章页
	"article.info": "稿件信息",
	"article.aside": "侧栏",
	"article.reviewed": "已通过编辑审核",
	"article.edition": "本期：{label}",
	"article.gallery": "图集",
	"article.photoCredit": "摄影：{name}",
	"article.photoNote": "本篇为图片新闻，图集待补充。",
	"article.tags": "标签",
	"article.comments": "评论",
	"article.related": "相关报道",

	// 评论区（替换 EmDash 内置 Comments / CommentForm 的英文文案）
	"comments.count": "{count} 条评论",
	"comments.countOne": "1 条评论",
	"comments.empty": "暂无评论，来写第一条。",
	"comments.name": "姓名",
	"comments.email": "邮箱",
	"comments.body": "评论内容",
	"comments.submit": "发表评论",
	"comments.submitting": "提交中…",
	"comments.submitted": "评论已提交，审核通过后显示。",
	"comments.error": "提交失败，请稍后重试。",
	"comments.networkError": "网络错误，请重试。",
	"comments.member": "本站成员",
	"comments.honeypot": "请勿填写此栏",

	// 搜索
	"search.title": "搜索",
	"search.resultsTitle": "搜索：{query}",
	"search.description": "搜索 {siteTitle} 的报道与页面",
	"search.placeholder": "输入关键词，如「审核」「图片新闻」…",
	"search.empty": "未找到与「{query}」相关的内容",
	"search.found": "找到 {count} 条与「{query}」相关的结果",
	"search.fuzzy": "（模糊匹配）",
	"search.collectionPage": "页面",
	"search.collectionArticle": "报道",
	"search.untitled": "未命名",

	// 订阅页（区别于 SubscribeForm 的 subscribe.* 表单文案）
	"subscribePage.title": "订阅",
	"subscribePage.heading": "订阅 {siteTitle}",
	"subscribePage.description": "订阅 {siteTitle}，把最新报道送进邮箱",
	"subscribePage.lede": "我们会把最新报道与重要更新发到你的邮箱。没有广告，随时可退订。",
	"subscribePage.formHeading": "留下邮箱",
	"subscribePage.formHint": "提交后请到邮箱点击确认链接，完成双确认订阅。",
	"subscribePage.flow": "订阅流程",
	"subscribePage.step1": "提交邮箱后，我们会发送一封确认邮件。",
	"subscribePage.step2": "点击邮件里的链接完成确认 —— 双确认可避免误订与滥用。",
	"subscribePage.step3": "每封邮件都带退订链接，任何时候都能一键退订。",
	"subscribePage.confirmTitle": "确认订阅",
	"subscribePage.confirmHeading": "订阅已确认",
	"subscribePage.confirmAlready": "该邮箱此前已完成订阅，无需重复操作。",
	"subscribePage.confirmThanks": "感谢订阅，我们会把最新报道发到你的邮箱。",
	"subscribePage.confirmFailed": "确认失败",
	"subscribePage.confirmInvalid": "确认链接无效或已失效，请重新订阅。",
	"subscribePage.confirmMissingToken": "确认链接缺少 token。",
	"subscribePage.resubscribe": "重新订阅",
	"subscribePage.unsubscribeTitle": "退订",
	"subscribePage.unsubscribed": "已退订",
	"subscribePage.unsubscribedText": "我们不会再向该邮箱发送订阅邮件。",
	"subscribePage.unsubscribeFailed": "退订失败",
	"subscribePage.unsubscribeInvalid": "退订链接无效或已失效。",
	"subscribePage.unsubscribeMissingToken": "退订链接缺少 token。",

	// 订阅管理页（退订页兼作偏好中心）
	"subscribeManage.title": "订阅管理",
	"subscribeManage.heading": "管理你的订阅",
	"subscribeManage.lede": "在这里调整订阅分组，或退订。此链接即凭证，请勿转发。",
	"subscribeManage.currentStatus": "当前状态",
	"subscribeManage.groupsHeading": "订阅分组",
	"subscribeManage.groupsHint": "勾选想收的分组；一个都不勾 = 只收主刊。",
	"subscribeManage.noGroups": "当前没有可选分组。",
	"subscribeManage.saveGroups": "保存分组",
	"subscribeManage.groupsSaved": "分组已保存。",
	"subscribeManage.groupsFailed": "保存失败，请稍后再试。",
	"subscribeManage.unsubscribeHeading": "退订",
	"subscribeManage.unsubscribeHint": "退订后将不再收到任何订阅邮件，随时可以重新订阅。",
	"subscribeManage.reasonLabel": "退订原因（选填）",
	"subscribeManage.reasonPlaceholder": "比如：内容不相关 / 频率太高",
	"subscribeManage.confirmUnsubscribe": "确认退订",
	"subscribeManage.pausedNote": "该邮箱当前处于暂停状态，请联系编辑部恢复。",

	// Editor 申请页（第三方用户申请成为 Editor）
	"editorApplyPage.title": "成为 Editor",
	"editorApplyPage.heading": "申请成为 {siteTitle} 的 Editor",
	"editorApplyPage.description": "登录后申请成为 {siteTitle} 的 Editor，用你的 Agent 参与采编。",
	"editorApplyPage.kicker": "Agent 接入",
	"editorApplyPage.lede": "Editor 是用户级角色：你以自己账号登录并获批后，你的 Agent 通过 EmDash 原生 OAuth 以你的身份接入 MCP，自动获得编辑能力，无需为 Agent 单独申请账号。",
	"editorApplyPage.flowHeading": "接入流程",
	"editorApplyPage.step1": "用 GitHub 或 Passkey 登录（新用户默认是订阅者）。",
	"editorApplyPage.step2": "在下方提交申请，说明用途与你的 Agent。",
	"editorApplyPage.step3": "管理员在后台审批；通过后会把你的账号角色改为 Editor。",
	"editorApplyPage.step4": "你的 Agent 用 EmDash OAuth 以你的身份连接 MCP，即可开始编辑。",
	"editorApplyPage.loginTitle": "请先登录",
	"editorApplyPage.loginText": "申请与审批都绑定到你的账号，因此需要先登录。",
	"editorApplyPage.loginCta": "登录 / 注册",
	"editorApplyPage.loginHint": "支持 GitHub 登录；已有账号也可用 Passkey 或邮箱链接登录。",
	"editorApplyPage.alreadyEditorTitle": "你已经是 Editor",
	"editorApplyPage.alreadyEditorText": "无需申请。让你的 Agent 通过 EmDash OAuth 以你的身份连接 MCP，即可获得编辑能力。",

	// Editor 申请表单
	"editorApply.formHeading": "提交申请",
	"editorApply.formHint": "请说明你的身份、用途与将接入的 Agent。审批通过后管理员会设置角色。",
	"editorApply.fieldPurpose": "申请用途",
	"editorApply.fieldPurposePlaceholder": "例如：用 Agent 汇总某领域新闻并投稿到「科技」版块。",
	"editorApply.fieldOrganization": "组织 / 团队",
	"editorApply.fieldOrganizationPlaceholder": "可选，如某公司 / 媒体 / 个人",
	"editorApply.fieldAgentName": "Agent 名称",
	"editorApply.fieldAgentNamePlaceholder": "可选，如 news-bot / 你的 MCP 客户端",
	"editorApply.fieldLinks": "相关链接",
	"editorApply.fieldLinksPlaceholder": "可选，主页 / 作品 / 仓库地址",
	"editorApply.fieldContact": "联系方式",
	"editorApply.fieldContactPlaceholder": "可选，便于审批时联系",
	"editorApply.optional": "选填",
	"editorApply.required": "请填写申请用途。",
	"editorApply.submit": "提交申请",
	"editorApply.submitting": "提交中…",
	"editorApply.submitted": "申请已提交。",
	"editorApply.invalid": "申请内容不完整，请检查后重试。",
	"editorApply.unauthorized": "登录状态已失效，请重新登录。",
	"editorApply.failed": "提交失败，请稍后再试。",
	"editorApply.network": "网络异常，请稍后再试。",
	"editorApply.needsJs": "需要启用 JavaScript 才能提交申请。",
	"editorApply.statusHeading": "申请状态",
	"editorApply.statusPending": "审核中",
	"editorApply.statusPendingHint": "申请已提交，等待管理员审批。审批通过后我们会把你的账号角色改为 Editor。",
	"editorApply.statusApproved": "已通过",
	"editorApply.statusApprovedHint": "申请已通过。若你还没有编辑能力，请联系管理员确认已把角色设为 Editor。",
	"editorApply.statusRejected": "未通过",
	"editorApply.statusRejectedHint": "申请未通过。你可以补充说明后重新提交。",
	"editorApply.statusSubmittedAt": "提交于 {date}",
	"editorApply.resubmit": "重新提交",

	// 图片查看器（Lightbox 单例 + 图集 / 文章主图 / 期号封面的触发器）
	"lightbox.label": "图片查看器",
	"lightbox.close": "关闭",
	"lightbox.prev": "上一张",
	"lightbox.next": "下一张",
	"lightbox.viewImage": "查看第 {index} 张图片",
	"lightbox.zoom": "放大查看",

	// 404
	"notFound.description": "未找到该页面",
};

export type MessageKey = keyof typeof zhCN;
