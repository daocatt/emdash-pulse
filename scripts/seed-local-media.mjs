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
  pressroom: {
    url: "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=1600&h=900&fit=crop",
    alt: "新闻编辑室",
    filename: "pressroom.jpg",
  },
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

/**
 * 文章 slug -> 要写入的图片字段。
 * 与 seed/seed.json 中各文章的 featured_image / gallery 引用保持一致
 * （seed 里同源 URL 复用 5 张图，这里按 key 映射）。
 */
const TARGETS = {
  "suda-pulse-launch": { featured_image: { key: "pressroom" } },
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
  "cross-border-data-rules": { featured_image: { key: "newsroom" } },
  "ai-content-cost-curve": { featured_image: { key: "circuit" } },
  "marathon-pacing-economics": { featured_image: { key: "cityNight" } },
  "museum-curates-ai-art": { featured_image: { key: "desk" } },
  "night-shift-city": {
    featured_image: { key: "nightFlow" },
    gallery: [{ key: "cityNight", caption: "入夜后的城市天际线", credit: "Suda Pulse 视觉组" }],
  },
  "newsroom-night-talk-ep12": { featured_image: { key: "desk" } },
  "assignment-routing-in-a-minute": { featured_image: { key: "circuit" } },
  "edge-inference-chips-ship": { featured_image: { key: "circuit" } },
  "open-model-license-debate": { featured_image: { key: "newsroom" } },
  "datacenter-water-ledger": { featured_image: { key: "cityNight" } },
  "robot-in-the-newsroom": {
    featured_image: { key: "desk" },
    gallery: [
      { key: "circuit", caption: "巡场机器人的主控板", credit: "Suda Pulse 视觉组" },
      { key: "nightFlow", caption: "夜间值守的路线数据", credit: "Suda Pulse 视觉组" },
    ],
  },
  "dependency-supply-chain-audit": { featured_image: { key: "nightFlow" } },
  "cost-per-token-on-cloud": { featured_image: { key: "circuit" } },
  "vector-database-in-a-minute": { featured_image: { key: "nightFlow" } },
  "agent-desk-metrics": { featured_image: { key: "circuit" } },
  "weekly-agent-roundup-w42": { featured_image: { key: "pressroom" } },
  "newsroom-night-talk-ep13": { featured_image: { key: "desk" } },
  "quantum-chip-in-a-minute": { featured_image: { key: "circuit" } },
  "city-morning-timelapse": { featured_image: { key: "cityNight" } },
  "harbor-dawn-photo-essay": {
    featured_image: { key: "nightFlow" },
    gallery: [{ key: "cityNight", caption: "黎明前的港口", credit: "Suda Pulse 视觉组" }],
  },
  "river-revival-photo": { featured_image: { key: "cityNight" } },
  "cloud-region-latency": { featured_image: { key: "circuit" } },
  "data-ethics-column": { featured_image: { key: "newsroom" } },
  "inference-cold-start": { featured_image: { key: "circuit" } },
  "old-town-morning-market": {
    featured_image: { key: "cityNight" },
    gallery: [{ key: "nightFlow", caption: "开市前的街口", credit: "Suda Pulse 视觉组" }],
  },
  "gpu-rental-in-a-minute": { featured_image: { key: "circuit" } },
  "content-localization-at-scale": { featured_image: { key: "newsroom" } },
  "culture-watch-ep3": { featured_image: { key: "desk" } },
  "city-noise-map": { featured_image: { key: "nightFlow" } },
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

/**
 * 带重试的 JSON GET。dev server 在插件重建 / HMR 期间可能短暂返回 HTML 错误页
 * （`<title>Err…`），此时 `res.json()` 会抛 `Unexpected token '<'`；重试通常即可恢复。
 */
async function getJson(cookie, path, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastError;
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
  return json.data.item;
}

/**
 * 把媒体 API 的项转成内容字段里存的标准 `MediaValue` —— 形状与 seed 的 `$media`
 * 落库结果一致（`apply-*.mjs` 里的 `mediaValue`）。**必须带 width/height**：
 * `emdash/ui` 的 `<Image>` 只在两者齐全时才走响应式优化，缺了就退化成无尺寸的裸
 * `<img>`（CLS 风险）。`meta.storageKey` 是本地 provider 解析 URL 的兜底。
 */
function toMediaValue(item, alt) {
  const value = {
    provider: "local",
    id: item.id,
    src: item.url,
    alt: alt || undefined,
    width: item.width ?? undefined,
    height: item.height ?? undefined,
    mimeType: item.mimeType ?? undefined,
    filename: item.filename ?? undefined,
    blurhash: item.blurhash ?? undefined,
    dominantColor: item.dominantColor ?? undefined,
  };
  if (item.storageKey) value.meta = { storageKey: item.storageKey };
  return value;
}

/** 已上传的媒体（按 filename 去重，避免重复执行时反复上传）。 */
async function listMedia(cookie) {
  const json = await getJson(cookie, "/_emdash/api/media?limit=100");
  return new Map((json.data?.items ?? []).map((m) => [m.filename, m]));
}

async function listArticles(cookie) {
  const json = await getJson(cookie, "/_emdash/api/content/articles?limit=50");
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
  const curJson = await getJson(cookie, `/_emdash/api/content/articles/${id}`);
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

  const existing = await listMedia(cookie);
  const uploaded = {};
  for (const [key, img] of Object.entries(IMAGES)) {
    const found = existing.get(img.filename);
    if (found) {
      uploaded[key] = toMediaValue(found, img.alt);
      log(`↺ ${key} -> ${found.id}（复用已上传）`);
      continue;
    }
    try {
      const item = await upload(cookie, img);
      uploaded[key] = toMediaValue(item, img.alt);
      log(`✓ ${key} -> ${item.id}`);
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
