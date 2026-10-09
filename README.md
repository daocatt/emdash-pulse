# Suda Pulse

**English** · [简体中文](./README.zh-CN.md)

An **agent-collaborative newsroom publishing system** built on [EmDash](https://github.com/emdash-cms/emdash) + [Astro](https://astro.build/).

Suda Pulse is a full-stack publishing system for newsrooms, newspapers and independent media, designed around AI-agent collaboration. It ships two switchable front-end themes, an editorial review workflow, a multi-user back office, an MCP interface for author/editor agents, and a machine-readable read API for reader agents. It runs as a **standalone VPS deployment** — three Docker containers, no managed platform required.

---

## Features

- **Two front-end themes** — `news-factory` (newspaper front page) and `pulse-news` (magazine). The default is chosen at build time via `SITE_THEME`; an editor can switch the live theme from the back office without redeploying.
- **Multi-user RBAC** — EmDash's five roles (Subscriber → Contributor → Author → Editor → Admin) with Passkey sign-in.
- **Editorial workflow** — draft → pending review → approve / reject → publish or schedule. Author submissions are always reviewed before they go live.
- **Agent newsroom** — editors hand out assignments; author agents claim them and submit drafts; editor agents (or humans) review and publish.
- **MCP server** — `POST /_emdash/api/mcp` with native OAuth 2.1 (authorization code + PKCE, device grant) or personal access tokens. A token's scopes are intersected with the user's role.
- **Agent Read API** — public, rate-limited JSON endpoints under `/agent/*` (news, sections, editions, JSON Feed, schema) plus `/llms.txt`.
- **Comments** — built-in comments with rule-based + AI moderation, routed through the `pulse-ai` plugin.
- **Email subscriptions** — double opt-in, unsubscribe, subscriber groups and an event log, delivered through [Resend](https://resend.com/). Groups mirror Resend **Segments**; campaigns go out as Resend **Broadcasts**; delivery receipts arrive via a signed **Webhook**.
- **SEO & feeds** — JSON-LD, XML sitemaps, `robots.txt`, RSS and JSON Feed.
- **Bilingual UI** — zh-CN / en runtime switch (content itself is not translated).
- **Media pipeline** — images on local disk or any S3-compatible store, with responsive `srcset`, WebP and LQIP.
- **Archives & search** — browse by month/week; full-text search backed by PostgreSQL `pg_trgm`.
- **Third-party editors** — GitHub sign-in, an application page at `/editor/apply`, and an admin approval queue.
- **Scheduled publishing** — an in-process scheduler drives scheduled posts.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Astro 7 (`output: "server"`, SSR) |
| CMS | [EmDash](https://github.com/emdash-cms/emdash) 1.2 |
| Runtime | Node.js 22 (`@astrojs/node`, standalone) |
| Data | PostgreSQL 17 |
| Cache | Redis 7 (EmDash object cache) |
| Media | Local disk or S3-compatible (R2 / MinIO / …) |
| AI | `pulse-ai` — Cloudflare AI Gateway / OpenAI / Anthropic / any OpenAI-compatible endpoint |
| UI islands | React 19 |
| Language | TypeScript |
| Extensions | 8 first-party plugins (all in-process) |
| Packaging | Docker Compose — `pulse-app` / `pulse-db` / `pulse-redis` |

## Quick start (local)

Requirements: **Node 22.16+** and a reachable **PostgreSQL** (Redis is optional — the object cache degrades to a no-op without it).

```bash
npm install                       # also applies two small upstream-plugin patches (see Notes)

# Easiest: run just the datastores from the compose file
docker compose up -d pulse-db pulse-redis

cp .env.example .env              # set EMDASH_ENCRYPTION_KEY and the PG*/DATABASE_URL values
npm run dev                       # builds plugins, then starts Astro dev at http://localhost:4321
```

- Content lives in PostgreSQL; local media in `./uploads`, sessions in `./data/sessions`.
- Back office: <http://localhost:4321/_emdash/admin>. The first visit runs the **setup wizard** — site title/subtitle, admin email, and Passkey registration. It also imports `seed/seed.json` (demo content + media), which can take a few minutes.
- To change the build-time default theme: `SITE_THEME=pulse-news npm run dev`.
- After dropping and recreating the database, rebuild the search index: `npm run search:rebuild`.

## Deploy to a VPS

The app runs as three Docker containers orchestrated by `docker-compose.yml`; TLS is terminated by a reverse proxy on the host. The repository never stores credentials — everything goes through a git-ignored `.env` (template: `.env.example`).

**The full operations manual is [`docs/16-vps-deployment.md`](./docs/16-vps-deployment.md)** (Chinese). In short:

### 1. Configure

```bash
git clone <repo> /srv/pulse && cd /srv/pulse
cp .env.example .env
```

Required: `EMDASH_ENCRYPTION_KEY` (encrypts plugin secrets at rest — **back it up**, losing it makes stored secrets unreadable), `EMDASH_SITE_URL` (public origin), `POSTGRES_PASSWORD`, and `EMDASH_TRUSTED_PROXY_HEADERS=x-forwarded-for` (so rate limits and subscriptions see the real client IP). Optional: `S3_*` for object storage, `EMDASH_OAUTH_GITHUB_*` for GitHub sign-in, `SITE_THEME`. Compose variables: `DOCKER_DATA_PATH` (host data root, default `./data` — use an absolute path in production), `APP_PORT` (default `4321`), `DB_PORT` (default `5432`), `TZ` (default `Asia/Shanghai`).

### 2. Start

```bash
npm run docker:up     # = docker compose up -d --build
```

This builds `pulse-app` (plugins → Astro build), starts `pulse-db` and `pulse-redis`, and runs migrations on boot. `pulse-db` creates the `pg_trgm` extension on first initialisation (`docker/initdb/00-extensions.sql`). Data lives in bind mounts under `DOCKER_DATA_PATH` (`postgres/`, `app/`, `redis/`) so it can be backed up or moved directly.

### 3. Reverse proxy

Merge the site block from [`deploy/Caddyfile.example`](./deploy/Caddyfile.example) into your host Caddyfile and reload — Caddy obtains certificates automatically. `pulse-app` binds `127.0.0.1:4321` only. An nginx equivalent is documented in the same file.

### 4. After the first boot

1. Open `https://<your-domain>/_emdash/admin` and complete the **setup wizard** — it seeds content and registers the first admin Passkey.
2. Back office → **Resend** page → set the API key and From address. Without it, magic-link sign-in returns `503 EMAIL_NOT_CONFIGURED` and subscription emails are only queued.
3. *Optional* — back office → **AI gateway** page → pick a provider, enter credentials, hit **Test connection**.
4. *Optional* — configure the Resend webhook for delivery receipts (see `docs/16-vps-deployment.md` §7).

### Continuous deployment (GitHub Actions)

`.github/workflows/deploy.yml` deploys on push to the **`production`** branch (`main` is development only and never deploys; there is also a manual `workflow_dispatch`). It first runs a GitHub-side `verify` job (`npm ci` → `plugin:build` → `typecheck:all` → `build`), then SSHes to the VPS to `git reset --hard origin/production`, write `.env`, and run `docker compose build --no-cache && docker compose up -d`.

Configure these repository secrets: `VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`, `VPS_PORT` (optional, default 22), `VPS_PROJECT_PATH` (repo path on the VPS), and `VPS_ENV_FILE` (path to the real `.env` on the VPS, copied into the repo root at deploy time).

### Build-time vs runtime configuration

EmDash serialises the `database` / `storage` / `objectCache` descriptors into the build output, so connection strings must never appear in `astro.config.mjs`. The config only picks the *kind* of adapter at build time; credentials are always read from the environment at runtime.

| Concern | Decided at build time | Read at runtime |
| --- | --- | --- |
| Database | `postgres()` (fixed) | `pg` pool reads `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD`; migrations read `DATABASE_URL` |
| Storage | `S3_ENDPOINT` set → `s3()`, else `local()` | `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` / `S3_PUBLIC_URL` |
| Object cache | entrypoint + serialisable defaults | `REDIS_URL` |
| Image allow-list | `EMDASH_SITE_URL` (+ `S3_PUBLIC_URL`) | — |

**Changing the domain** therefore means editing `EMDASH_SITE_URL` and rebuilding — no source changes.

## Configuration

| Variable | Purpose | Required |
| --- | --- | --- |
| `EMDASH_ENCRYPTION_KEY` | Encrypts plugin secrets at rest | **Yes** |
| `EMDASH_SITE_URL` | Public origin (Passkey, CSRF, MCP discovery, sitemap, JSON-LD, image allow-list) | **Yes in production** |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Database credentials (compose derives `DATABASE_URL` and `PG*` from these) | **Yes** |
| `DOCKER_DATA_PATH` | Host directory for the bind-mounted data (`postgres/`, `app/`, `redis/`); default `./data` | No |
| `APP_PORT` / `DB_PORT` | Host loopback ports for `pulse-app` (4321) / `pulse-db` (5432) | No |
| `DATABASE_URL` | Single connection string for the `emdash` CLI / migrations | One of the two |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | Standard libpq variables for the runtime pool | One of the two |
| `REDIS_URL` | EmDash object cache backend; cache is bypassed when unset | No |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` / `S3_PUBLIC_URL` | S3-compatible media storage (setting `S3_ENDPOINT` at build time selects `s3()`) | No |
| `SITE_THEME` | Build-time default theme (`news-factory` \| `pulse-news`) | No (defaults to `news-factory`) |
| `EMDASH_OAUTH_GITHUB_CLIENT_ID` / `EMDASH_OAUTH_GITHUB_CLIENT_SECRET` | GitHub sign-in | No |
| `EMDASH_TRUSTED_PROXY_HEADERS` | Trust proxy headers so rate-limit keys see the real client IP | Recommended |

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Build plugins, then start Astro dev against PostgreSQL |
| `npm run build` | Build plugins + the default-theme Node bundle |
| `npm run build:news-factory` / `build:pulse-news` | Build a specific theme |
| `npm run docker:up` / `docker:down` | Build and start / stop the three-container stack |
| `npm run start` | Serve the built Node bundle (`dist/server/entry.mjs`) |
| `npm run typecheck` / `typecheck:all` | `astro check` for one / both themes |
| `npm run plugin:build` / `plugin:test` | Build / test all plugins |
| `npm run search:rebuild` | Rebuild the `pulse_search` index (`pg_trgm`) |
| `npm run demo:data` | Seed demo engagement data locally (`:clean` to remove) |
| `npm run perf` | Mobile Lighthouse check across both themes |

## Themes

| Theme | Look | Directory |
| --- | --- | --- |
| `news-factory` | Newspaper front page (deep red, hairline rules, three columns) | `src/themes/news-factory/` |
| `pulse-news` | Magazine (warm paper, generous whitespace, author cards) | `src/themes/pulse-news/` |

Themes are not file routes under `src/pages/`; they are injected via `THEME_ROUTES` in `astro.config.mjs`. The default theme is registered on clean paths, the other under `/_t/<theme>/…`, and `src/middleware.ts` rewrites at request time based on the back-office setting.

## Agents & MCP

Suda Pulse exposes two agent surfaces:

- **Write side (MCP)** — `POST /_emdash/api/mcp`. Author agents register themselves and receive a scoped token; editor agents are EmDash users with the Editor role whose MCP client connects through native OAuth and inherits that user's capability. There is no separate "agent role".
- **Read side (HTTP JSON)** — public, rate-limited endpoints: `/agent/news`, `/agent/news/[slug]`, `/agent/news/latest`, `/agent/sections`, `/agent/editions`, `/agent/feed.json`, `/agent/schema`.

See [`docs/09-agent-newsroom.md`](./docs/09-agent-newsroom.md) and [`docs/06-mcp-agents.md`](./docs/06-mcp-agents.md).

## Documentation

Planning and reference docs live in [`docs/`](./docs/README.md) (Chinese): architecture, content model, front-end themes, admin review, MCP, plugins, roadmap, operations manual, and implementation reports. Start with [`docs/16-vps-deployment.md`](./docs/16-vps-deployment.md) for deployment.

## Notes

`postinstall` applies two small, idempotent patches to upstream plugin packages (`scripts/patch-audit-log.mjs`, `scripts/patch-resend.mjs`) so they work with the pinned EmDash version. They are no-ops once upstream is fixed.

## License

[MIT](./LICENSE) © 2026 daocatt
