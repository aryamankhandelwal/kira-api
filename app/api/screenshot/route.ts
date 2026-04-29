import { NextRequest, NextResponse } from "next/server";
import { extractProductImageFromHtml } from "@/lib/gemini";

export const runtime = "nodejs";
export const maxDuration = 60;

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function fetchHtml(url: string, timeoutMs = 4000): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": MOBILE_UA, Accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.text();
}

// ─── Trusted fashion CDN check (Phase C) ──────────────────────────────────────

const TRUSTED_CDN_PATTERNS = [
  /^https?:\/\/cdn\.shopify\.com\/s\/files\/.+\/products\//i,
  /^https?:\/\/res\.cloudinary\.com\/.+\/image\/upload\//i,
  /^https?:\/\/assets\.ajio\.com\//i,
  /^https?:\/\/images\.ajio\.com\//i,
  /^https?:\/\/assets\.myntassets\.com\//i,
  /^https?:\/\/cdn\.perniaspopupshop\.com\//i,
  /^https?:\/\/media\.rawmango\.in\//i,
  /^https?:\/\/.+\.akamaized\.net\/.+\/(product|catalog|item)\//i,
];

function isTrustedCdnUrl(url: string): boolean {
  return TRUSTED_CDN_PATTERNS.some((p) => p.test(url));
}

// ─── SPA shell detection ──────────────────────────────────────────────────────

function detectSpaShell(html: string): boolean {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const textContent = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (textContent.length < 500) return true;
  // Empty root div — dead giveaway of a JS-rendered SPA
  if (/<div[^>]+id=["'](__next|root)["'][^>]*>\s*<\/div>/i.test(html)) return true;
  return false;
}

// ─── Image extraction ─────────────────────────────────────────────────────────

interface ImageCandidate {
  url: string;
  score: number;
}

/**
 * Score an image URL.
 * @param isSpaOgImage - when true, cap score to 0 (SPA og:image is almost always a logo/social card)
 */
function scoreImageUrl(imgUrl: string, baseScore: number, isSpaOgImage = false): number {
  if (isSpaOgImage) return Math.min(baseScore, 0);

  let score = baseScore;
  const lower = imgUrl.toLowerCase();

  // Logo / UI element penalties
  if (
    /\/(logo|icon|brand|banner|header|footer|sprite|favicon|watermark|site-logo|brand-logo)/.test(lower)
  ) {
    score -= 80;
  }

  // Known product CDN paths — very reliable
  if (/cdn\.shopify\.com\/s\/files\/.+\/products\//.test(lower)) score += 50;
  if (/res\.cloudinary\.com\/.+\/image\/upload\//.test(lower)) score += 30;
  if (/\/(product|catalog|media\/catalog|item|pdp)\//.test(lower)) score += 15;

  // Dimensions embedded in URL: _800x1000, -800x1000
  const dimMatch = lower.match(/[_-](\d{2,4})x(\d{2,4})/);
  if (dimMatch) {
    const w = parseInt(dimMatch[1]);
    const h = parseInt(dimMatch[2]);
    if (w < 200 && h < 200) score -= 60; // tiny → icon/pixel
    else if (w >= 200 && w <= 400 && Math.abs(w - h) < 60) score -= 30; // small square → logo
    else if (w > h * 1.5) score -= 40; // landscape → banner
    else if (h >= w * 1.2 && h >= 600) score += 40; // tall portrait + large → product photo
    else if (h >= w) score += 20; // portrait / square → likely product
  }

  return score;
}

function extractProductImageCandidates(html: string, isSpa: boolean): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  // 1. JSON-LD Product schema (most reliable on non-SPA pages)
  for (const imgUrl of extractJsonLdProductImages(html)) {
    candidates.push({ url: imgUrl, score: scoreImageUrl(imgUrl, 100) });
  }

  // 2. og:image — penalised hard when page is an SPA shell
  const ogUrl = extractOgImage(html);
  if (ogUrl) {
    candidates.push({ url: ogUrl, score: scoreImageUrl(ogUrl, 50, isSpa) });
  }

  // 3. twitter:image
  const twitterImg =
    extractMetaContent(html, /name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ??
    extractMetaContent(html, /content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (twitterImg?.startsWith("http")) {
    candidates.push({ url: twitterImg, score: scoreImageUrl(twitterImg, 30) });
  }

  // 4. Body <img> tags (including data-src for lazy-loaded images)
  for (const img of extractBodyImages(html)) {
    candidates.push({ url: img, score: scoreImageUrl(img, 25) });
  }

  // Deduplicate by URL, keeping highest score
  const seen = new Map<string, ImageCandidate>();
  for (const c of candidates) {
    const ex = seen.get(c.url);
    if (!ex || c.score > ex.score) seen.set(c.url, c);
  }

  return Array.from(seen.values())
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score);
}

// ─── POST handler — 4-phase agentic loop ─────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { url, thumbnail_url } = await req.json();
    if (!url) {
      return NextResponse.json({ ok: false, error: "url is required" }, { status: 400 });
    }

    // ── Phase A: Fast static extraction ──────────────────────────────────────
    let html = "";
    try {
      html = await fetchHtml(url, 4000);
    } catch {
      // fetch timed out or failed — proceed without HTML
    }

    const isSpa = html ? detectSpaShell(html) : false;
    const candidates = html ? extractProductImageCandidates(html, isSpa) : [];
    const best = candidates[0];

    // High-confidence static hit — return immediately without calling Gemini
    if (best && best.score >= 80) {
      return NextResponse.json({ ok: true, image_url: best.url });
    }

    // ── Phase B: Gemini agent ─────────────────────────────────────────────────
    // Gemini classifies the page and extracts the product image (or finds the PDP link)
    if (html) {
      try {
        const geminiResult = await extractProductImageFromHtml(url, html);

        if (geminiResult) {
          if (geminiResult.page_type === "listing" && geminiResult.product_url) {
            // Navigate to the actual product detail page
            try {
              const pdpHtml = await fetchHtml(geminiResult.product_url, 3000);
              const pdpResult = await extractProductImageFromHtml(
                geminiResult.product_url,
                pdpHtml,
              );
              if (pdpResult?.found && pdpResult.image_url) {
                return NextResponse.json({
                  ok: true,
                  image_url: pdpResult.image_url,
                  resolved_url: geminiResult.product_url,
                });
              }
            } catch {
              // PDP fetch failed — fall through
            }
          } else if (geminiResult.found && geminiResult.image_url) {
            return NextResponse.json({ ok: true, image_url: geminiResult.image_url });
          }
        }
      } catch (err) {
        console.error("[screenshot] gemini phase failed:", err);
      }
    }

    // ── Phase C: Brave thumbnail CDN trust check ──────────────────────────────
    // Thumbnails from known fashion CDNs are reliable product photos
    if (thumbnail_url && isTrustedCdnUrl(thumbnail_url)) {
      return NextResponse.json({ ok: true, image_url: thumbnail_url });
    }

    // ── Phase D: Best available fallback ──────────────────────────────────────
    if (best) {
      return NextResponse.json({ ok: true, image_url: best.url });
    }
    if (thumbnail_url) {
      return NextResponse.json({ ok: true, image_url: thumbnail_url });
    }

    return NextResponse.json({ ok: false, error: "No product image found" }, { status: 404 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal error";
    console.error("[screenshot]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── Meta tag helpers ─────────────────────────────────────────────────────────

function extractOgImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]?.startsWith("http")) return m[1];
  }
  return null;
}

function extractMetaContent(html: string, pattern: RegExp): string | null {
  return html.match(pattern)?.[1] ?? null;
}

// ─── Body <img> extraction ────────────────────────────────────────────────────

function extractBodyImages(html: string): string[] {
  // Match src AND data-src (lazy-loaded images)
  const imgPattern = /<img\s[^>]*(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*>/gi;
  const results: string[] = [];
  const rejectKeywords =
    /logo|icon|brand|banner|header|footer|sprite|favicon|watermark|social|share|tracking|pixel/i;
  let match: RegExpExecArray | null;

  while ((match = imgPattern.exec(html)) !== null) {
    const src = match[1];
    if (!src.startsWith("http")) continue;
    const tag = match[0];
    if (rejectKeywords.test(src)) continue;
    const altMatch = tag.match(/alt=["']([^"']*)/i);
    if (altMatch && rejectKeywords.test(altMatch[1])) continue;
    results.push(src);
    if (results.length >= 5) break;
  }

  return results;
}

// ─── JSON-LD Product image extraction ────────────────────────────────────────

function extractJsonLdProductImages(html: string): string[] {
  const images: string[] = [];
  const scriptPattern =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1]);
      collectProductImages(json, images);
    } catch {
      // skip malformed JSON
    }
  }
  return images;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectProductImages(schema: any, out: string[]): void {
  if (!schema) return;
  if (Array.isArray(schema["@graph"])) {
    for (const n of schema["@graph"]) collectProductImages(n, out);
    return;
  }
  if (Array.isArray(schema)) {
    for (const n of schema) collectProductImages(n, out);
    return;
  }
  const type: string = schema["@type"] ?? "";
  if (type !== "Product" && !type.includes("Product")) return;

  const image = schema["image"];
  if (typeof image === "string" && image.startsWith("http")) out.push(image);
  else if (Array.isArray(image)) {
    for (const img of image) {
      if (typeof img === "string" && img.startsWith("http")) out.push(img);
      else if (typeof img === "object" && img?.url?.startsWith("http")) out.push(img.url);
    }
  } else if (typeof image === "object" && image?.url?.startsWith("http")) {
    out.push(image.url);
  }
}
