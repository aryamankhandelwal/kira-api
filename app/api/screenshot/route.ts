import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 10;

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Extract the best product image URL from a page.
// Priority: schema.org Product JSON-LD → og:image → twitter:image → body <img> tags
// Returns the URL directly — iOS loads it via AsyncImage.
export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "url is required" },
        { status: 400 }
      );
    }

    const htmlRes = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": MOBILE_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(4000),
    });

    const html = await htmlRes.text();
    let candidates = extractProductImageCandidates(html);

    // Detect page type. Trust the URL itself first — many Shopify/JS-rendered PDPs
    // lack HTML signals (no JSON-LD, no static "Add to Cart" text) but have
    // clear PDP URL patterns like /products/, /p/, or SKU slugs.
    let resolvedUrl: string | null = null;
    const urlIsPdp = isProductPageUrl(url);
    const pageType = urlIsPdp ? 'pdp' : detectPageType(html);
    if (pageType !== 'pdp') {
      const productUrl = extractFirstProductLink(html, url);
      if (productUrl) {
        try {
          const pdpRes = await fetch(productUrl, {
            redirect: "follow",
            headers: { "User-Agent": MOBILE_UA, Accept: "text/html" },
            signal: AbortSignal.timeout(3000),
          });
          const pdpHtml = await pdpRes.text();
          const pdpCandidates = extractProductImageCandidates(pdpHtml);
          if (pdpCandidates.length > 0) {
            candidates = pdpCandidates;
            resolvedUrl = productUrl;
          }
        } catch {
          // PDP fetch failed — fall back to original candidates
        }
      } else {
        // Category page with no extractable PDP link.
        // Penalize og:image (typically a promotional banner).
        candidates = candidates
          .map((c) => {
            if (c.score >= 50 && !/\/(product|catalog|media\/catalog)\//.test(c.url.toLowerCase())) {
              return { ...c, score: c.score - 40 };
            }
            return c;
          })
          .sort((a, b) => b.score - a.score);
      }
    }

    // Return the best-scoring image URL
    const best = candidates[0];
    if (best) {
      return NextResponse.json({
        ok: true,
        image_url: best.url,
        ...(resolvedUrl ? { resolved_url: resolvedUrl } : {}),
      });
    }

    return NextResponse.json(
      { ok: false, error: "No product image found" },
      { status: 404 }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error("[screenshot]", err?.message);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Internal error" },
      { status: 500 }
    );
  }
}

// ─── Image extraction ─────────────────────────────────────────────────────────

interface ImageCandidate {
  url: string;
  score: number; // higher = better
}

function extractProductImageCandidates(html: string): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  // 1. schema.org Product JSON-LD (most reliable for actual product pages)
  const jsonLdImages = extractJsonLdProductImages(html);
  for (const imgUrl of jsonLdImages) {
    candidates.push({ url: imgUrl, score: scoreImageUrl(imgUrl, 100) });
  }

  // 2. og:image
  const ogUrl = extractOgImage(html);
  if (ogUrl) {
    candidates.push({ url: ogUrl, score: scoreImageUrl(ogUrl, 50) });
  }

  // 3. twitter:image
  const twitterImg =
    extractMetaContent(html, /name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ??
    extractMetaContent(html, /content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (twitterImg?.startsWith("http")) {
    candidates.push({ url: twitterImg, score: scoreImageUrl(twitterImg, 30) });
  }

  // 4. Body <img> tags as fallback
  const bodyImages = extractBodyImages(html);
  for (const img of bodyImages) {
    candidates.push({ url: img, score: scoreImageUrl(img, 25) });
  }

  // Deduplicate by URL, keeping highest score
  const seen = new Map<string, ImageCandidate>();
  for (const c of candidates) {
    const existing = seen.get(c.url);
    if (!existing || c.score > existing.score) {
      seen.set(c.url, c);
    }
  }

  return Array.from(seen.values())
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Score an image URL candidate.
 * Penalises URLs containing logo/icon/banner keywords.
 * Rewards product-related URL paths.
 */
function scoreImageUrl(imgUrl: string, baseScore: number): number {
  let score = baseScore;
  const lower = imgUrl.toLowerCase();

  // URL path keywords that suggest a logo or banner
  if (
    /\/(logo|icon|brand|banner|header|footer|sprite|favicon|watermark|site-logo|brand-logo)/.test(lower)
  ) {
    score -= 80;
  }

  // Bonus for product-related URL paths
  if (/\/(product|catalog|media\/catalog|item|pdp)\//.test(lower)) {
    score += 15;
  }

  // Dimensions embedded in the URL, e.g. "800x1000"
  const dimMatch = lower.match(/[_\-x](\d{2,4})[x_\-](\d{2,4})/);
  if (dimMatch) {
    const w = parseInt(dimMatch[1]);
    const h = parseInt(dimMatch[2]);
    if (w < 200 && h < 200) score -= 60;
    else if (w > h * 1.5) score -= 40; // landscape → likely banner
    else if (h >= w) score += 20; // portrait or square → product photo
  }

  return score;
}

// ─── Body <img> extraction ──────────────────────────────────────────────────

function extractBodyImages(html: string): string[] {
  const imgPattern = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
  const results: string[] = [];
  const rejectKeywords = /logo|icon|brand|banner|header|footer|sprite|favicon|watermark|social|share|tracking|pixel/i;
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

// ─── URL-based PDP detection ────────────────────────────────────────────────

function isProductPageUrl(rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  const path = url.pathname.toLowerCase();

  if (/\/(products?|p|dp|buy|item)\//.test(path)) return true;
  if (/\/[a-z0-9-]+-\d{5,}(\/|$)/.test(path)) return true;
  if (/[A-Z]{2,5}\d{3,}/.test(url.pathname)) return true;

  if (/\/(collections?|categories?|c|s|shop|browse)(\/|$)/.test(path)) return false;
  if (/^\/(men|women)\/?$/.test(path)) return false;
  if (/^\/(men|women)\/[a-z-]+\/?$/.test(path) && path.split('/').filter(Boolean).length <= 2) return false;

  return false;
}

// ─── Page type detection ────────────────────────────────────────────────────

function detectPageType(html: string): 'pdp' | 'category' | 'unknown' {
  if (hasProductSchema(html)) return 'pdp';
  if (/add\s+to\s+(cart|bag|basket)|buy\s+now/i.test(html)) return 'pdp';

  const pdpLinkCount = (
    html.match(/<a[^>]+href=["'][^"']*\/(products?|p|dp)\//gi) || []
  ).length;
  if (pdpLinkCount >= 4) return 'category';

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) {
    const title = titleMatch[1].toLowerCase().trim();
    if (/^(shop all|browse|all products|collections?:)/.test(title)) {
      return 'category';
    }
  }

  return 'unknown';
}

// ─── Category → PDP extraction ──────────────────────────────────────────────

function hasProductSchema(html: string): boolean {
  const scriptPattern =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1]);
      if (containsProductType(json)) return true;
    } catch {
      // skip malformed JSON
    }
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function containsProductType(obj: any): boolean {
  if (!obj) return false;
  if (Array.isArray(obj)) return obj.some(containsProductType);
  if (Array.isArray(obj["@graph"])) return obj["@graph"].some(containsProductType);
  const type: string = obj["@type"] ?? "";
  return type === "Product" || type.includes("Product");
}

function extractFirstProductLink(html: string, baseUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  const baseSegments = base.pathname.replace(/\/$/, "").split("/").filter(Boolean).length;
  const linkPattern = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  const pdpPatterns = [
    /\/products?\//i,
    /\/p\//i,
    /\/buy\//i,
    /\/item\//i,
    /\/dp\//i,
    /\/[a-z0-9-]+-\d{5,}/i,
    /[A-Z]{2,5}\d{3,}/,
    /\/[a-z0-9-]+-[a-z]{1,5}\d{3,}/i,
  ];

  const skipPatterns = [
    /\/cart/i, /\/account/i, /\/login/i, /\/wishlist/i,
    /\/review/i, /\/filter/i, /\/sort/i, /\/page\b/i,
    /\/collections?(\/|$)/i, /\/categor/i, /\/blog/i,
  ];

  const seen = new Set<string>();
  const candidateLinks: string[] = [];

  while ((match = linkPattern.exec(html)) !== null) {
    let href = match[1];
    try {
      const resolved = new URL(href, base.origin);
      if (resolved.hostname !== base.hostname) continue;
      href = resolved.href;
    } catch {
      continue;
    }

    if (seen.has(href)) continue;
    seen.add(href);

    const path = new URL(href).pathname.toLowerCase();
    if (skipPatterns.some((p) => p.test(path))) continue;
    if (pdpPatterns.some((p) => p.test(path))) return href;

    candidateLinks.push(href);
  }

  for (const href of candidateLinks) {
    const path = new URL(href).pathname.replace(/\/$/, "");
    const segments = path.split("/").filter(Boolean).length;
    if (segments > baseSegments && segments >= 3) return href;
  }

  return null;
}

// ─── Meta tag helpers ────────────────────────────────────────────────────────

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
