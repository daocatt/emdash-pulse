# pulse-review

A sandboxed plugin for [EmDash CMS](https://emdashcms.com).

## Develop

```sh
npm install
npm run validate
npm run typecheck
npm run test
npm run build
```

To test against a running EmDash site, run `npm run dev` in this
directory (rebuilds on save) and `npm install file:../path/to/this`
in the site. Then `import pulseReview from "pulse-review"` and pass
it into `emdash({ sandboxed: [pulseReview] })`.

`npm run test` builds the plugin and runs its tests through Worker Loader using
EmDash's production sandbox wrapper and host bridge.

## Publish

```sh
npm run login -- alice.example.com
npm run publish          # builds and uploads artifacts to your PDS
```

To publish from GitHub Actions, run `npm run release:setup`. The command
creates one shared workflow at the Git repository root.

## Version bumps

Bump `version` in `package.json` when you ship a release. The
scaffold's `emdash-plugin.jsonc` deliberately omits `version` —
the build pipeline reads it from `package.json` so there's a single
source of truth. **Bump major** for breaking changes, **bump minor**
for new routes or hooks, **bump patch** for fixes.

You MUST bump version whenever you change `capabilities`, `allowedHosts`,
or `storage` in the manifest. Installed users have consented to the
old trust contract; a change without a version bump would let new
behaviour slip past consent.

## AI moderation (via `pulse-ai`)

`comment:moderate` runs the rule engine first, then (when `aiEnabled`) the
configured model. All model connection settings — provider, Cloudflare
account, AI Gateway, base URL, model, API key, timeout — live in the
**`pulse-ai`** plugin; this plugin only owns `aiEnabled` / `aiAutoApprove`.
The client is shared in-process via `import ... from "pulse-ai/client"`.

> **Do NOT add `pulse-ai` to this package's `dependencies`.**
> `emdash-plugin build` externalises declared dependencies; an external
> `pulse-ai/client` import makes the build's probe step fail with
> `Cannot find package 'pulse-ai'`. Left undeclared, the client is inlined
> into `dist/plugin.mjs` (≈5.9 KB → 8.7 KB). See `plugins/pulse-ai/README.md`.

`allowedHosts` here must cover **every endpoint `pulse-ai` may be pointed at**:
the moderation call uses *this* plugin's `ctx.http`, so `pulse-ai`'s own
allow-list does not apply. Add your self-hosted gateway host if you use one.
