/**
 * 集合条目的类型别名。
 *
 * 类型来自 EmDash 生成的 emdash-env.d.ts（通过 InferCollectionData 解析），
 * 避免在组件里到处写泛型。
 */

import type { ContentEntry, InferCollectionData } from "emdash";

export type ArticleData = InferCollectionData<"articles">;
export type EditionData = InferCollectionData<"editions">;
export type PageData = InferCollectionData<"pages">;
export type AssignmentData = InferCollectionData<"assignments">;

export type ArticleEntry = ContentEntry<ArticleData>;
export type EditionEntry = ContentEntry<EditionData>;
export type PageEntry = ContentEntry<PageData>;
