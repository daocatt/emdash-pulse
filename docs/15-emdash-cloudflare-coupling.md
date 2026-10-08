# EmDash: Openness and Cloudflare Coupling

> **Scope.** This document answers two architectural questions about the EmDash CMS
> (verified against `emdash@1.2.0`, the version this site runs):
>
> 1. Is EmDash a Cloudflare-targeted program, or a genuinely open, platform-agnostic one?
> 2. How tightly is it coupled to Cloudflare, how hard is decoupling, and how does
>    PostgreSQL fit in? (And: does it need Drizzle ORM?)
>
> Companion to [14-database.md](./14-database.md): that document covers *which database to
> pick for this site*; this one covers *how open the platform boundary is*.

## TL;DR

| Question | Answer |
| --- | --- |
| Cloudflare-targeted or genuinely open? | **Genuinely platform-agnostic.** Cloudflare is a first-class target, not a lock-in. |
| Cloudflare coupling | **Low** — every platform-specific implementation lives in the optional `@emdash-cms/cloudflare` package. |
| Decoupling difficulty | **Low** — swap the adapters in `astro.config.mjs`; zero changes to core code. |
| Standalone (VPS) deployment | **Viable** — an official Node.js deployment path exists and is fully documented. |
| PostgreSQL integration | **First-class, built into core** (adapter + `pg` driver + migrations + connection pooling). |
| Need Drizzle ORM? | **No** — EmDash uses **Kysely**. Swapping the ORM means forking the core. |

## 1. Cloudflare-targeted, or genuinely open?

**Verdict: genuinely platform-agnostic. Cloudflare is a first-class deployment target, not a
bound platform.**

Evidence (all from `emdash@1.2.0`):

| Dimension | Fact |
| --- | --- |
| **Core package dependencies** | The data layer's `dependencies` contains **only `kysely`** — no Cloudflare package, no Drizzle, no Prisma. |
| **Where Cloudflare support lives** | A separate `@emdash-cms/cloudflare` package whose own `dependencies` **include `emdash`** — the direction is "optional extension package", not "core is built on Cloudflare". |
| **Database adapters** | `sqlite`, `libsql`, and **`postgres`** are all built into core `emdash/db` (`src/db/adapters.ts`). The dialect enum is just `sqlite \| postgres`. |
| **Storage adapters** | Core ships `local` and `s3` (`src/storage/`); **R2 lives in the Cloudflare package**. |
| **Object cache** | Core ships `memory` (`src/object-cache/`); **KV lives in the Cloudflare package**. |
| **Platform abstraction** | `virtual:emdash/wait-until`, `/env`, `/scheduler`, `/sandbox-runner`, and friends — core programs against abstract interfaces; the platform package injects implementations. |
| **Cloudflare references in core** | 39 occurrences, **almost all compatibility comments, optional branches, or type declarations** — e.g. `waitUntil` is documented as "Resolves to Cloudflare's `waitUntil` under `@astrojs/cloudflare`; `undefined` on Node"; the `cf` request object "Returns undefined when not running on Cloudflare Workers". |
| **Official deployment docs** | Ship **both** a Node.js and a Cloudflare guide as peers. |

**Where it *is* Cloudflare-first** (this is the source of the "targeted at CF" impression):

- The Cloudflare template (D1 + R2) is the default scaffold.
- A few capabilities currently have **only** a Cloudflare implementation: the Worker Loader
  plugin sandbox, `@cloudflare/ai-search-snippet`, and Cloudflare Access transparent auth.
- Documentation and ecosystem content skew toward Cloudflare.

So the accurate statement is: **an open, platform-agnostic CMS where Cloudflare and Node.js are
peer first-class targets — Cloudflare's templates and docs are simply more complete.**

## 2. Cloudflare coupling and decoupling difficulty

**Coupling: low. Decoupling difficulty: low (the architecture is already decoupled).
Standalone deployment: viable.**

| Coupling point | Where it is implemented | How to decouple |
| --- | --- | --- |
| D1 database | `@emdash-cms/cloudflare` | Switch to `postgres()` / `sqlite()` / `libsql()` |
| R2 storage | same | Switch to `local()` / `s3()` |
| KV object cache | same | Switch to `memory()` (or omit it) |
| Worker Loader sandbox | CF package / `@emdash-cms/sandbox-workerd` | Use `workerd` on Node; **this project's plugins run in-process and need no sandbox at all** |
| Cron Trigger | `wrangler.jsonc` | Use the core built-in `NodeCronScheduler` (a long-lived process) |
| Workers AI | `pulse-review` calls it over **REST**, not a binding | Already portable |
| `waitUntil` / `env` / `cf` | core virtual modules + optional branches | On Node these resolve to `undefined` with a fallback to `import.meta.env` |

**This project is itself proof of decoupling:** the same source tree switches database, storage,
and adapter with a single `if (isCloudflare)` block in `astro.config.mjs` — **no core code changes**.

The key mechanism is the `virtual:emdash/*` module set (`src/virtual-modules.d.ts`). Core code
asks the platform for capabilities through these abstract interfaces; the platform package supplies
the implementation:

- `virtual:emdash/wait-until` — Cloudflare `waitUntil` under `@astrojs/cloudflare`, `undefined` on Node.
- `virtual:emdash/env` — Worker bindings under Cloudflare, `undefined` on Node (callers fall back to `import.meta.env`).
- `virtual:emdash/scheduler` — a `NodeCronScheduler` factory on long-lived runtimes; `null` under serverless adapters, where an external Cron Trigger drives scheduled work.

## 3. PostgreSQL integration

**PostgreSQL is a first-class, core built-in — no community or third-party solution is needed.**

| Layer | Implementation |
| --- | --- |
| Adapter | `postgres({ connectionString \| host/port/database/user/password/ssl, pool: { min, max, … } })` — `src/db/adapters.ts:225` |
| Driver | `optionalDependencies: pg ^8.0.0` |
| Dialect | Kysely `PostgresDialect` |
| Migrations | Core `emdash/internal/db/postgres-migrations` |
| Connection pooling | Built in (`pool.min/max/connectionTimeoutMillis/idleTimeoutMillis`) |
| Backup | `pg_dump --format=custom` (documented) |
| Cross-database move | `emdash site export/import` supports SQLite ↔ PostgreSQL ↔ D1 |

The **only** functional cost is full-text search: FTS5 is SQLite-specific, so on PostgreSQL the
official transfer path marks collections as `search_unsupported` and `/search` degrades to an
in-memory scan. See [14-database.md](./14-database.md) for the full impact analysis.

## 4. Does EmDash need a separate Drizzle ORM integration?

**No — and it should not have one.**

- **EmDash uses Kysely, not Drizzle.** `dependencies: kysely ^0.29.0`; 249 core files reference
  Kysely, and there are **zero** references to Drizzle.
- Kysely is a **type-safe SQL query builder** (not a full ORM). EmDash manages **schema and
  migrations itself** (`src/db/*-migrations.ts` plus the `_emdash_migrations` table) — exactly the
  division of labour Kysely is designed for.
- "Integrating Drizzle" would mean **replacing EmDash's entire data layer** (`src/database/repositories/*`),
  and EmDash **exposes no data-layer extension point** for an external ORM. That is not integration;
  it is a **fork**.
- Bypassing EmDash to talk to the same PostgreSQL database with Drizzle directly would discard the
  content model, RBAC, hooks, and migration system — a net loss.

**Conclusion: Drizzle has no foothold here.** Use the built-in Kysely data layer; to change ORMs you
would have to fork the core.

## 5. Summary

| Question | Answer |
| --- | --- |
| Cloudflare-targeted or genuinely open? | **Genuinely platform-agnostic**; Cloudflare is a first-class target, not a lock-in. |
| Cloudflare coupling | **Low** — all platform implementations sit in the optional package; core depends only on abstract interfaces. |
| Decoupling difficulty | **Low** — change the adapters in `astro.config.mjs`; core code is untouched. |
| Standalone deployment viable? | **Yes** — an official Node.js deployment path exists. |
| PostgreSQL integration | **First-class, built into core** (adapter + `pg` driver + migrations + pooling). |
| Need Drizzle? | **No** — EmDash uses Kysely; switching ORMs means forking. |
