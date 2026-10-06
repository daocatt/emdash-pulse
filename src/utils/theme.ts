/**
 * 主题契约。
 *
 * 每套主题在自己的 `theme.config.ts` 里用 `defineTheme()` 声明这份配置；
 * `astro.config.mjs` 只关心目录名（`src/themes/<name>/`），其余信息由主题自述。
 */
export interface ThemeConfig {
	/** 主题标识，写到 `<html data-site-theme>`，与目录名一致 */
	name: string;
	/** 人类可读名称（构建日志 / 调试用） */
	label: string;
	/** 主导航使用的 EmDash 菜单名 */
	menuName: string;
	/** 页脚导航使用的 EmDash 菜单名 */
	footerMenuName: string;
}

export function defineTheme(config: ThemeConfig): ThemeConfig {
	return config;
}
