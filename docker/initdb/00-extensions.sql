-- Postgres 容器首次初始化时执行（挂载到 /docker-entrypoint-initdb.d）。
-- 只在**空数据目录**上跑一次；已有数据的库不会重跑。
--
-- pg_trgm：供自建中文搜索（pulse_search 的 GIN trigram 索引）使用。
-- 见 docs/16-vps-deployment.md 与 scripts/search-rebuild.mjs。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
