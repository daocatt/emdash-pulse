#!/usr/bin/env node
/**
 * 本地开发媒体填充脚本（seed 的 $media 兜底）。
 *
 * 背景：seed 里的 $media 引用依赖 Cloudflare DoH（cloudflare-dns.com）做 SSRF 校验，
 * 部分受限网络无法访问该域名，导致 `npx emdash seed` 下载媒体失败（字段留空）。
 * 本脚本用普通 fetch 下载图片（仅需目标图床可达），再经 EmDash 媒体上传 API
 * 落盘到本地 storage，最后用内容 API 把图片写回对应文章字段。
 *
 * 用法（dev server 需运行）：
 *   node scripts/seed-local-media.mjs
 *   PULSE_BASE=http://localhost:4321 node scripts/seed-local-media.mjs
 *
 * 幂等：重复执行会重新上传并覆盖同名文章字段。
 */

const BASE = process.env.PULSE_BASE ?? "http://localhost:4321";
const REQ_HEADER = { "X-EmDash-Request": "1" };

/** 需要落地的图片：key -> 源 URL / alt / 文件名 */
const IMAGES = {
  newsroom: {
    url: "https://images.unsplash.com/photo-1495020689067-958852a7765e?w=1600&h=900&fit=crop",
    alt: "报纸版面",
    filename: "newsroom.jpg",
  },
  desk: {
    url: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=1600&h=1067&fit=crop",
    alt: "新闻编辑台",
    filename: "desk.jpg",
  },
  circuit: {
    url: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1600&h=1067&fit=crop",
    alt: "电路板特写",
    filename: "circuit.jpg",
  },
  cityNight: {
    url: "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1600&h=900&fit=crop",
    alt: "城市夜景天际线",
    filename: "city-night.jpg",
  },
  nightFlow: {
    url: "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=1600&h=1067&fit=crop",
    alt: "夜色中的数据流",
    filename: "night-flow.jpg",
  },
};

/** 文章 slug -> 要写入的图片字段 */
const TARGETS = {
  "image-news-on-r2": {
    featured_image: { key: "newsroom" },
    gallery: [
      { key: "desk", caption: "编辑台的清晨", credit: "Suda Pulse 视觉组" },
      { key: "circuit", caption: "技术基础设施", credit: "Suda Pulse 视觉组" },
    ],
  },
  "city-night-walk": {
    featured_image: { key: "cityNight" },
    gallery: [{ key: "nightFlow", caption: "夜色中的城市脉络", credit: "Suda Pulse 视觉组" }],
  },
};

function log(msg) {
  console.log(`[media] ${msg}`);
}

async function authenticate() {
  const res = await fetch(`${BASE}/_emdash/api/setup/dev-bypass?redirect=/`, {
    redirect: "manual",
  });
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("dev-bypass 未返回会话 cookie（是否已启动 dev server？）");
  return cookie;
}

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": "SudaPulse-Dev/1.0" } });
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function upload(cookie, img) {
  const buf = await download(img.url);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/jpeg" }), img.filename);
  const res = await fetch(`${BASE}/_emdash/api/media`, {
    method: "POST",
    headers: { cookie, ...REQ_HEADER },
    body: form,
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(`上传失败: ${JSON.stringify(json)}`);
  const item = json.data.item;
  return { id: item.id, src: item.url, alt: img.alt };
}

async function listArticles(cookie) {
  const res = await fetch(`${BASE}/_emdash/api/content/articles?limit=50`, {
    headers: { cookie },
  });
  if (!res.ok) {
    throw new Error(`列出文章失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  const map = new Map();
  for (const it of json.data?.items ?? []) map.set(it.slug, it.id);
  return map;
}

/**
 * PUT 会**整体替换** draft revision 的 data，所以必须带上当前完整 data 再做
 * 合并；否则 `review_status` 等字段被清空，`publish` 会被发布门禁拒绝，
 * 图片只留在 draft、条目行（live）仍是旧值。
 *
 * 另外清掉 `gallery` 里 `image` 为 null 的项：内容 API 的校验要求每个图集项
 * 的 `image` 是对象，`{ image: null }` 会导致整个 PUT 400。
 */
async function patchArticle(cookie, id, patch) {
  const cur = await fetch(`${BASE}/_emdash/api/content/articles/${id}`, {
    headers: { cookie },
  });
  if (!cur.ok) {
    throw new Error(`读取文章 ${id} 失败 ${cur.status}: ${(await cur.text()).slice(0, 200)}`);
  }
  const curJson = await cur.json();
  const data = { ...(curJson.data?.item?.data ?? {}), ...patch };
  if (Array.isArray(data.gallery)) {
    data.gallery = data.gallery.filter((g) => g && g.image);
  }

  const res = await fetch(`${BASE}/_emdash/api/content/articles/${id}`, {
    method: "PUT",
    headers: { cookie, ...REQ_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(`更新文章失败: ${JSON.stringify(json)}`);
}

/**
 * PUT 只写入 draft revision；已发布文章需再 publish 才能让字段生效到 live。
 * 未通过审核（review_status≠approved）时会被发布门禁拒绝，此处仅告警。
 */
async function publishArticle(cookie, id) {
  const res = await fetch(`${BASE}/_emdash/api/content/articles/${id}/publish`, {
    method: "POST",
    headers: { cookie, ...REQ_HEADER, "Content-Type": "application/json" },
    body: "{}",
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    return `发布被拒（可能未审核通过）：${json.error?.message ?? res.status}`;
  }
  return null;
}

async function main() {
  log(`base = ${BASE}`);
  const cookie = await authenticate();

  const uploaded = {};
  for (const [key, img] of Object.entries(IMAGES)) {
    try {
      uploaded[key] = await upload(cookie, img);
      log(`✓ ${key} -> ${uploaded[key].id}`);
    } catch (err) {
      log(`✗ ${key}: ${err.message}`);
    }
  }

  const articles = await listArticles(cookie);
  for (const [slug, plan] of Object.entries(TARGETS)) {
    const id = articles.get(slug);
    if (!id) {
      log(`跳过 ${slug}（未找到文章）`);
      continue;
    }
    const data = {};
    const f = plan.featured_image && uploaded[plan.featured_image.key];
    if (f) data.featured_image = f;
    if (plan.gallery) {
      data.gallery = plan.gallery
        .filter((g) => uploaded[g.key])
        .map((g) => ({
          image: uploaded[g.key],
          caption: g.caption,
          credit: g.credit,
        }));
    }
    if (Object.keys(data).length === 0) {
      log(`跳过 ${slug}（无可用图片）`);
      continue;
    }
    await patchArticle(cookie, id, data);
    const publishError = await publishArticle(cookie, id);
    log(
      publishError
        ? `✓ ${slug}: 写入 ${Object.keys(data).join(", ")}（${publishError}）`
        : `✓ ${slug}: 写入并发布 ${Object.keys(data).join(", ")}`,
    );
  }

  log("完成");
}

main().catch((err) => {
  console.error(`[media] 失败: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
