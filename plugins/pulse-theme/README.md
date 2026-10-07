# pulse-theme

Suda Pulse **前台主题切换**沙箱插件。

## 做什么

后台侧栏「前台主题」页（Block Kit `radio`）选择当前渲染的主题。选定后写入
**插件设置** `plugin:pulse-theme:settings:theme`，由宿主信任代码
`src/middleware.ts` 通过 `getPluginSetting("pulse-theme", "theme")` 读取，
把干净路径 rewrite 到 `/_t/<theme>/…`。**切换即时全站生效**，无需重新部署。

## 能力与存储

- capabilities：无（只写自己的插件设置，不碰内容 / 媒体 / 用户 / 网络）
- storage：无

## 路由

| 路由 | 可见性 | 权限 | 说明 |
| --- | --- | --- | --- |
| `admin` | 私有 | `plugins:manage` | 后台「前台主题」页；`block_action: theme-switch` 写入设置 |

## 约束

`src/plugin.ts` 的 `THEMES` 名称必须与 `astro.config.mjs` 的 `THEME_NAMES` **完全一致**
（路由前缀 `/_t/<theme>/…` 由后者注入）。新增主题要三处同步：本插件 `THEMES`、
`astro.config.mjs` 的 `THEME_NAMES`、`src/themes/<name>/` 目录。

## 命令

```bash
npm run build   # 构建 dist/*（根目录 npm run plugin:build 会一起跑）
npm run test    # validate + vitest
```
