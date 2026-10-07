/**
 * 构建期注入的全局常量（见 `astro.config.mjs` 的 `vite.define`）。
 */

/** 默认前台主题：`SITE_THEME` 环境变量，未设置时为 `news-factory`。 */
declare const __DEFAULT_SITE_THEME__: string;
