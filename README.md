# Suda Pulse

**English** · [简体中文](./README.zh-CN.md)

An **agent-collaborative newsroom publishing system** built on [EmDash](https://github.com/emdash-cms/emdash) + [Astro](https://astro.build/).

Suda Pulse is a full-stack publishing system for newsrooms, newspapers and independent media, designed around AI-agent collaboration. It ships two switchable front-end themes, an editorial review workflow, a multi-user back office, an MCP interface for author/editor agents, and a machine-readable read API for reader agents.

---

## Features

- **Two front-end themes** — `news-factory` (newspaper front page) and `pulse-news` (magazine). The default is chosen at build time via `SITE_THEME`; an editor can switch the live theme from the back office without redeploying.
- **Multi-user RBAC** — EmDash's five roles (Subscriber → Contributor → Author → Editor → Admin) with Passkey sign-in.
- **Editorial workflow** — draft → pending review → approve / reject → publish or schedule. Author submissions are always reviewed before they go live.
- **Agent newsroom** — editors hand out assignments; author agents claim them and submit drafts; editor agents (or humans) review and publish.
- **MCP server** — `POST /_emdash/api/mcp` with native OAuth 2.1 (authorization code + PKCE, device grant) or personal access tokens. A token's scopes are intersected with the user's role.
- **Agent Read API** — public, rate-limited JSON endpoints under `/agent/*` (news, sections, editions, JSON Feed, schema) plus `/llms.txt`.
- **Comments** — built-in comments with rule-based + Cloudflare Workers AI moderation.
- **Email subscriptions** — double opt-in, unsubscribe, subscriber groups and an event log; delivered through [Resend](https://resend.com/).
- **SEO & feeds** — JSON-LD, XML sitemaps, `robots.txt`, RSS and JSON Feed.
- **Bilingual UI** — zh-CN / en runtime switch (content itself is not translated).
- **Media pipeline** — images on R2 with responsive `srcset`, WebP and LQIP.
- **Archives & search** — browse by month/week; full-text search.
- **Third-party editors** — GitHub sign-in, an application page at `/editor/apply`, and an admin approval queue.
- **Scheduled publishing** — a cron trigger drives scheduled posts.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Astro 7 (`output: "server"`, SSR) |
| CMS | [EmDash](https://github.com/emdash-cms/emdash) 1.2 |
| Runtime | Cloudflare Workers |
| Data | Cloudflare D1 (content) |
| Media | Cloudflare R2 |
| AI | Cloudflare Workers AI (comment moderation) |
| UI islands | React 19 |
| Language | TypeScript |
| Extensions | 7 first-party plugins (all in-process) |

## Quick start (local)

Requirements: **Node 22.16+**.

```bash
npm install     # also applies two small upstream-plugin patches (see Notes)
npm run dev     # builds plugins, then starts Astro dev at http://localhost:4321
```

- Local data lives in SQLite (`data.db`) and `./uploads`.
- Back office: <http://localhost:4321/_emdash/admin>. The first visit runs the **setup wizard** — site title/subtitle, admin email, and Passkey registration. It also imports `seed/seed.json` (demo content + media), which can take a few minutes.
- To change the build-time default theme: `SITE_THEME=pulse-news npm run dev`.

## Deploy to Cloudflare

The app runs on Cloudflare Workers with D1, R2 and Workers AI. The repository never stores account details: the committed `wrangler.jsonc` and `*.example` files contain placeholders only, while real values live in git-ignored `wrangler.prod.jsonc` and `.env.deploy`.

### Workers plan: Free vs Paid

**The default setup runs entirely on the Workers Free plan.** All seven plugins run **in-process** (`plugins: []`), so D1, R2, Workers AI and cron are the only Cloudflare products involved — all of which have free tiers. Check Cloudflare's current limits if you expect heavy traffic.

A **Workers Paid plan is only required if you want isolate-level plugin sandboxing.** The only sandbox backend on Workers is the **Worker Loader** (`LOADER` binding), which is a paid feature. If you switch to `sandboxed: []` on a free plan, `@emdash-cms/cloudflare`'s `sandbox()` finds no binding, returns `undefined`, and **every sandboxed plugin silently fails to load** (the build only prints a warning). The local escape hatch `sandbox: false` is rejected at runtime on Workers.

| | Free plan | Paid plan |
| --- | --- | --- |
| In-process plugins (`plugins: []`) — the default | ✅ | ✅ |
| D1 · R2 · Workers AI · cron | ✅ (free tiers) | ✅ |
| Sandboxed plugins (`sandboxed: []` + `LOADER`) | ❌ | ✅ |

### 1. Create the D1 database

```bash
npx wrangler d1 create suda-pulse-db
```

Note the returned `database_id`. (The R2 bucket is created automatically by the deploy script.)

### 2. Configure

```bash
cp wrangler.prod.jsonc.example wrangler.prod.jsonc
```

Fill in:

- `account_id` — your Cloudflare account ID (shown in every dashboard URL).
- `d1_databases[0].database_id` — from step 1.
- `routes[0].pattern` — your custom domain, e.g. `pulse.example.com`. It must already be a zone in the same account. For a quick test you can comment out `routes` and use `suda-pulse.<your-subdomain>.workers.dev`.
- `vars.EMDASH_SITE_URL` — the public origin, e.g. `https://pulse.example.com`. **Required**: Passkey, CSRF, MCP discovery, sitemap and JSON-LD all depend on it, and the setup wizard returns `500 SITE_URL_REQUIRED` without it. The deploy script also passes it to the build so the image domain allow-list stays correct.

Then create the local env files:

```bash
cp .env.deploy.example .env.deploy   # optional: set WRANGLER_HOME to a wrangler login dir
cp .env.example .env                 # set EMDASH_ENCRYPTION_KEY
```

- `EMDASH_ENCRYPTION_KEY` encrypts plugin secrets (API keys) at rest. Generate one with `npx emdash secret`. **Back it up** — changing it makes previously stored encrypted settings unreadable.
- `WRANGLER_HOME` lets you deploy with a specific `wrangler login` profile by pointing at that account's config directory (useful when you have several Cloudflare accounts). If you leave it empty, the script uses your current shell's credentials.

### 3. Deploy

```bash
npm run deploy:cf
```

The script runs, in order: `wrangler whoami` (advisory) → create the R2 bucket (idempotent) → write any missing Worker secrets → build the plugins → `astro build` with the Cloudflare adapter → `wrangler deploy`.

Useful flags: `--skip-build`, `--no-secrets`, `--no-buckets`.

**Simpler alternative:** `npm run deploy` skips the helper script and deploys with the wrangler credentials already active in your shell (`wrangler login`).

### 4. After the first deploy

1. Open `https://<your-domain>/_emdash/admin` and complete the **setup wizard** — it seeds content and registers the first admin Passkey. (The super-admin cannot be pre-created from config; the wizard's WebAuthn registration writes it.)
2. Back office → **Resend** page → set the API key and From address. Without it, magic-link sign-in returns `503 EMAIL_NOT_CONFIGURED` and subscription emails are only queued.
3. *Optional* — **GitHub sign-in**: create a GitHub OAuth App whose callback is `https://<your-domain>/_emdash/api/auth/oauth/github/callback`, put the client ID/secret in `.env` as `EMDASH_OAUTH_GITHUB_CLIENT_ID` / `EMDASH_OAUTH_GITHUB_CLIENT_SECRET`, then re-run `npm run deploy:cf`.
4. If you enable GitHub sign-in, configure an **`allowed-domains`** allow-list (email domain + `defaultRole`) so sign-ups are not open to the whole internet.
5. *Optional* — seed demo engagement data: `npm run demo:data:remote`.

## Configuration

| Variable | Purpose | Required |
| --- | --- | --- |
| `EMDASH_ENCRYPTION_KEY` | Encrypts plugin secrets at rest | **Yes** |
| `EMDASH_SITE_URL` | Public origin (Passkey, CSRF, MCP discovery, sitemap, JSON-LD, image allow-list) | **Yes in production** |
| `SITE_THEME` | Build-time default theme (`news-factory` \| `pulse-news`) | No (defaults to `news-factory`) |
| `EMDASH_OAUTH_GITHUB_CLIENT_ID` | GitHub sign-in client ID | No |
| `EMDASH_OAUTH_GITHUB_CLIENT_SECRET` | GitHub sign-in client secret | No |
| `EMDASH_TRUSTED_PROXY_HEADERS` | Trust proxy headers so rate-limit keys see the real client IP | Recommended |
| `EMDASH_ALLOWED_ORIGINS` | Comma-separated extra origins allowed for Passkey | No |
| `DEPLOY_TARGET` | Set to `cloudflare` to build with the Workers adapter (the deploy script sets this) | No |
| `WRANGLER_HOME` | Wrangler credentials directory used as the child process `HOME` | For `deploy:cf` / remote D1 |

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Build plugins, then start Astro dev (SQLite + `./uploads`) |
| `npm run build` | Build plugins + the default-theme Node bundle |
| `npm run build:news-factory` / `build:pulse-news` | Build a specific theme |
| `npm run build:cf` | Build the Cloudflare (Workers) bundle without deploying |
| `npm run deploy` | Build the Cloudflare bundle and `wrangler deploy` with the current login |
| `npm run deploy:cf` | Account-agnostic deploy (see above) |
| `npm run typecheck` / `typecheck:all` | `astro check` for one / both themes |
| `npm run plugin:build` / `plugin:test` | Build / test all plugins |
| `npm run demo:data` | Seed demo engagement data locally (`:clean` to remove, `:remote` for D1) |
| `npm run perf` | Mobile Lighthouse check across both themes |
| `npm run start` | Serve the built Node bundle |
| `node scripts/configure-search.mjs` | Switch the search index to the trigram tokenizer (for Chinese) |

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

Planning and reference docs live in [`docs/`](./docs/README.md) (Chinese): architecture, content model, front-end themes, admin review, MCP, plugins, roadmap, operations manual, and implementation reports.

## Notes

`postinstall` applies two small, idempotent patches to upstream plugin packages (`scripts/patch-audit-log.mjs`, `scripts/patch-resend.mjs`) so they work with the pinned EmDash version. They are no-ops once upstream is fixed.

## License

[MIT](./LICENSE) © 2026 daocatt
