// scripts/fetch-deal-images.mjs
// For any deal missing `image`, fetch its page, find a real product image,
// download it, normalize to 800x800 WebP, save under /public/images/<id>.webp,
// and write `image` + `imageAlt` back to src/data/deals.json.
//
// Handles Amazon by:
//  - using browser-like headers
//  - reading JSON-LD
//  - reading #landingImage data-a-dynamic-image / data-old-hires
//  - skipping tracking pixels (fls-na.amazon.com, tiny images)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { fetch } from "undici";

const ROOT = path.resolve(process.cwd()); // should be sites/layerloot
const DEALS_PATH = path.join(ROOT, "src", "data", "deals.json");
const PUBLIC_IMG_DIR = path.join(ROOT, "public", "images");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

function absolutize(url, base) {
  try {
    if (!url) return null;
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

function isAmazonUrl(u) {
  try {
    const { hostname } = new URL(u);
    return /(^|\.)amazon\./i.test(hostname);
  } catch {
    return false;
  }
}
function isTrackingPixelUrl(u) {
  return /fls-.*\.amazon\.com\/.*batch/i.test(u) || /pixel/i.test(u);
}

// ---------- Pickers ----------
function pickOgImage($) {
  const sels = [
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="og:image"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
  ];
  for (const s of sels) {
    const v = $(s).attr("content");
    if (v) return v;
  }
  return null;
}
function pickFromLdJson($) {
  const scripts = $('script[type="application/ld+json"]');
  for (const el of scripts) {
    try {
      const txt = $(el).contents().text();
      if (!txt) continue;
      const data = JSON.parse(txt);

      const pull = (obj) => {
        if (!obj) return null;
        if (typeof obj.image === "string") return obj.image;
        if (Array.isArray(obj.image) && obj.image.length) return obj.image[0];
        if (obj.offers && typeof obj.offers === "object") {
          if (typeof obj.offers.image === "string") return obj.offers.image;
        }
        return null;
      };

      let found = pull(data);
      if (found) return found;

      if (Array.isArray(data)) {
        for (const item of data) {
          found = pull(item);
          if (found) return found;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}
function pickFirstLargeImg($, baseUrl) {
  // Collect many candidates; prefer big ones and media-amazon images
  let candidates = [];
  $("img[src], img[srcset]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) candidates.push(src);
    const srcset = $(el).attr("srcset");
    if (srcset) {
      srcset
        .split(",")
        .map((s) => s.trim().split(" ")[0])
        .filter(Boolean)
        .forEach((u) => candidates.push(u));
    }
    const dyn = $(el).attr("data-a-dynamic-image");
    if (dyn) {
      try {
        const json = JSON.parse(dyn.replace(/&quot;/g, '"'));
        candidates.push(...Object.keys(json));
      } catch {}
    }
  });
  candidates = candidates
    .map((u) => absolutize(u, baseUrl))
    .filter(
      (u) =>
        u &&
        !isTrackingPixelUrl(u) &&
        !/^data:/i.test(u)
    );

  // prefer Amazon media CDN images
  const prefer = candidates.find((u) =>
    /m\.media-amazon\.com\/images\//i.test(u)
  );
  return prefer || candidates[0] || null;
}

// Amazon-specific: #landingImage, data-a-dynamic-image, data-old-hires
function pickAmazonImage($) {
  const tryEl = (el) => {
    if (!el || !el.length) return null;
    const src = el.attr("src");
    const old = el.attr("data-old-hires");
    if (old) return old;
    if (src) return src;
    const dyn = el.attr("data-a-dynamic-image");
    if (dyn) {
      try {
        const json = JSON.parse(dyn.replace(/&quot;/g, '"'));
        // choose largest by area
        let best = null;
        let bestArea = 0;
        for (const [url, size] of Object.entries(json)) {
          const [w, h] = Array.isArray(size) ? size : [0, 0];
          const area = (w || 0) * (h || 0);
          if (area > bestArea) {
            bestArea = area;
            best = url;
          }
        }
        if (best) return best;
      } catch {}
    }
    return null;
  };

  let el = $("#landingImage");
  let pick = tryEl(el);
  if (pick) return pick;

  el = $("#imgTagWrapperId img");
  pick = tryEl(el);
  if (pick) return pick;

  // fallback to any large image we can find
  return pickFirstLargeImg($);
}

// ---------- HTTP ----------
async function getHtml(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function getBuffer(url, referer) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      ...(referer ? { Referer: referer } : {}),
    },
  });
  if (!res.ok) throw new Error(`IMG ${url} -> ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function ensureDirs() {
  await mkdir(PUBLIC_IMG_DIR, { recursive: true });
}

// ---------- Main ----------
async function main() {
  console.log("▶ fetch-deal-images starting…");
  await ensureDirs();

  const raw = await readFile(DEALS_PATH, "utf8");
  const deals = JSON.parse(raw);

  let changed = false;

  for (const d of deals) {
    if (d.image) continue;
    if (!d?.url || !d?.id) continue;

    try {
      console.log(`→ ${d.id}: fetch ${d.url}`);
      const html = await getHtml(d.url);
      const $ = cheerio.load(html);

      let imgUrl = null;
      if (isAmazonUrl(d.url)) {
        imgUrl =
          pickAmazonImage($) ||
          pickOgImage($) ||
          pickFromLdJson($) ||
          pickFirstLargeImg($, d.url);
      } else {
        imgUrl =
          pickOgImage($) ||
          pickFromLdJson($) ||
          pickFirstLargeImg($, d.url);
      }

      imgUrl = absolutize(imgUrl, d.url);

      if (!imgUrl || isTrackingPixelUrl(imgUrl)) {
        console.warn(`! ${d.id}: no usable image found`);
        continue;
      }

      console.log(`  candidate: ${imgUrl}`);
      let buf = await getBuffer(imgUrl, d.url);

      // Guard against 1x1 pixels: check dimensions
      let meta;
      try {
        meta = await sharp(buf).metadata();
      } catch {
        meta = null;
      }
      if (!meta || (meta.width && meta.height && meta.width * meta.height < 10_000)) {
        // too tiny — try a broader scan for a better candidate
        const fallback = pickFirstLargeImg($, d.url);
        const absFallback = absolutize(fallback, d.url);
        if (absFallback && absFallback !== imgUrl && !isTrackingPixelUrl(absFallback)) {
          console.log(`  tiny image; trying fallback: ${absFallback}`);
          buf = await getBuffer(absFallback, d.url);
        }
      }

      const outName = `${d.id}.webp`;
      const outPath = path.join(PUBLIC_IMG_DIR, outName);
      const webp = await sharp(buf)
        .resize(800, 800, { fit: "cover", position: "attention" })
        .webp({ quality: 82 })
        .toBuffer();
      await writeFile(outPath, webp);

      d.image = `/images/${outName}`;
      d.imageAlt = d.imageAlt || d.title;

      console.log(`  ✓ saved ${d.image}`);
      changed = true;
      await sleep(400);
    } catch (e) {
      console.error(`× ${d.id}: ${e.message}`);
    }
  }

  if (changed) {
    await writeFile(DEALS_PATH, JSON.stringify(deals, null, 2) + "\n", "utf8");
    console.log("✓ deals.json updated with image paths");
  } else {
    console.log("No changes needed (all set or none found).");
  }

  console.log("▶ done.");
}

main().catch((e) => {
  console.error("💥 Fatal:", e);
  process.exit(1);
});
