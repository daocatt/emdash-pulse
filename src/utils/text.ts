/**
 * 从 Portable Text / 嵌套 JSON 中提取纯文本。
 *
 * 直接复用 EmDash 的 `extractPlainText`：它只遍历已知的内容块形状
 * （span.text / image alt / caption / code 等），不会把 `_type`、`style`
 * 等结构字段当作正文（自研的朴素递归会泄漏 "block normal" 之类的噪声）。
 */

export { extractPlainText } from "emdash";
