/**
 * Editor 申请（pulse-editor-applications 插件）的前台接线。
 *
 * 前台申请页 `/editor/apply` 需要两件事：
 * - 判断调用者是否已是 Editor —— SSR 直接读 `Astro.locals.user.role`（EmDash 认证中间件
 *   对公开路由做软鉴权，有会话就设 `locals.user`），不需要插件；
 * - 读取 / 提交申请 —— 走插件的**私有**路由 `applications/mine` / `applications/submit`。
 *
 * 为什么读取也在客户端：SSR 侧的 `getPublicPluginApiRouteHandler` 只派发 `public` 路由，
 * 私有路由拿不到。私有路由由宿主按会话鉴权（`routeCtx.user`），所以必须由浏览器携带
 * cookie 直接 POST，并带 `X-EmDash-Request: 1` CSRF 头（见 EmDash 插件 API 约定）。
 * 这也意味着插件侧**永远不信任请求体里的身份**——申请人取自会话。
 */

export const EDITOR_APPLICATIONS_PLUGIN_ID = "pulse-editor-applications";

/** 私有路由基址；`applications/*` 挂在其下。 */
export const EDITOR_APPLICATIONS_API_BASE = `/_emdash/api/plugins/${EDITOR_APPLICATIONS_PLUGIN_ID}`;

/** EmDash 角色：Editor = 40（见 docs/13-editor-onboarding.md §3）。 */
export const ROLE_EDITOR = 40;

/** 是否达到 Editor（或更高）角色。 */
export const isEditorRole = (role: number | null | undefined): boolean =>
	typeof role === "number" && role >= ROLE_EDITOR;

export type EditorApplicationStatus = "pending" | "approved" | "rejected";

/** 申请人自己看到的申请视图（对应插件 `selfView`）。 */
export interface EditorApplicationView {
	application_id: string;
	status: EditorApplicationStatus;
	purpose: string;
	organization: string | null;
	agent_name: string | null;
	links: string | null;
	contact: string | null;
	submitted_at: string;
	updated_at: string;
	decided_at: string | null;
	note: string | null;
}
