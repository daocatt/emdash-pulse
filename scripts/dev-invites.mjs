#!/usr/bin/env node
/**
 * 本地开发：创建编辑室角色邀请。
 *
 * 通过 Admin-only 的 `POST /_emdash/api/auth/invite` 建邀请，落库于 `auth_tokens`。
 * 邀请的完成依赖 WebAuthn（Passkey）注册——需在浏览器打开邀请链接；本脚本只建邀请。
 *
 * 用法（dev server 需运行，且需先经 dev-bypass 成为 Admin）：
 *   node scripts/dev-invites.mjs
 *
 * 注意：EmDash 无「列出邀请」的公开 API，本脚本无法判重——重复运行会为同一邮箱
 * 新建邀请（旧的仍有效，直到过期）。如需清理（PostgreSQL）：
 *   psql "$DATABASE_URL" -c "delete from auth_tokens where type='invite';"
 */

const BASE = process.env.PULSE_BASE ?? "http://localhost:4321";
const REQ_HEADER = { "X-EmDash-Request": "1" };

/** 角色等级：10 Subscriber · 20 Contributor · 30 Author · 40 Editor · 50 Admin */
const ROLE = { Subscriber: 10, Contributor: 20, Author: 30, Editor: 40, Admin: 50 };

/** 编辑室账号 → 角色 */
const ACCOUNTS = [
  { email: "editor@dev.suda.im", role: ROLE.Editor, note: "人类编辑 / Editor agent" },
  { email: "reporter@dev.suda.im", role: ROLE.Author, note: "本报记者（强制审核）" },
  { email: "contributor@dev.suda.im", role: ROLE.Contributor, note: "外部投稿者" },
  { email: "muse@dev.suda.im", role: ROLE.Contributor, note: "Author agent: Muse" },
  { email: "dots@dev.suda.im", role: ROLE.Contributor, note: "Author agent: Dots" },
];

async function authenticate() {
  const res = await fetch(`${BASE}/_emdash/api/setup/dev-bypass?redirect=/`, { redirect: "manual" });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("dev-bypass 未返回会话 cookie（是否已启动 dev server？）");
  return cookie;
}

async function main() {
  const cookie = await authenticate();
  for (const { email, role, note } of ACCOUNTS) {
    const res = await fetch(`${BASE}/_emdash/api/auth/invite`, {
      method: "POST",
      headers: { cookie, ...REQ_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    const json = await res.json();
    const ok = res.ok && json.success;
    console.log(`[invite] ${ok ? "✓" : "✗"} ${email} (role=${role}, ${note})${ok ? "" : " " + JSON.stringify(json)}`);
  }
}

main().catch((err) => {
  console.error(`[invite] 失败: ${err.message}`);
  process.exit(1);
});
