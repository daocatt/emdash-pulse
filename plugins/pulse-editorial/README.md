# pulse-editorial

Suda Pulse **编辑台（编辑侧）** 沙箱插件。

## 能力

- capabilities：`content:read`、`content:write`、`content:publish`
- storage：无

## 路由（全部私有，EmDash 会话/令牌 + RBAC 权限）

| 路由 | 方法 | 权限 | 说明 |
| --- | --- | --- | --- |
| `assignments/create` | POST | `content:create` | 创建选题（`task_status=open`） |
| `assignments/list` | GET | `content:read` | 列出选题（可按 `task_status` 过滤） |
| `assignments/close` | POST | `content:edit_any` | 结束/取消选题 |
| `review/queue` | GET | `content:read_drafts` | 待审队列（`review_status=pending_review`） |
| `review/get` | GET | `content:read_drafts` | 单篇详情（含 Portable Text 正文） |
| `review/approve` | POST | `content:publish_any` | 设 `approved` 并发布 |
| `review/reject` | POST | `content:edit_any` | 驳回 |
| `review/request-changes` | POST | `content:edit_any` | 退回修改 |

MCP 工具：`createAssignment` / `listAssignments` / `closeAssignment` / `reviewQueue` / `getSubmission` / `approveArticle` / `rejectArticle` / `requestArticleChanges`。

## 命令

```bash
npm run build   # 构建 dist/*
npm run test    # validate + vitest
```
