import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 10;

// Fetch the best product image from a page and return it as base64.
// Priority: schema.org Product JSON-LD → og:image → twitter:image
export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "url is required" },
        { status: 400 }
      );
    }

    // Step 1: fetch HTML
    const htmlRes = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(6000),
    });

    const html = await htmlRes.text();

    // Step 2: extract the best product image URL
    const imageUrl = extractProductImage(html);
    if (!imageUrl) {
      return NextResponse.json(
        { ok: false, error: "No product image found" },
        { status: 404 }
      );
    }

    // Step 3: fetch the image and convert to base64
    const imgRes = await fetch(imageUrl, {
      signal: AbortSignal.timeout(4000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Referer: url,
      },
    });

    if (!imgRes.ok) {
      return NextResponse.json(
        { ok: false, error: "Failed to fetch image" },
        { status: 502 }
      );
    }

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    return NextResponse.json({ ok: true, image_base64: base64 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error("[screenshot]", err?.message);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Internal error" },
      { status: 500 }
    );
  }
}

/**
 * Extract the best product image URL from HTML.
 * Priority order:
 *   1. schema.org Product JSON-LD "image" field (most reliable for product pages)
 *   2. og:image meta tag
 *   3. twitter:image meta tag
 */
function extractProductImage(html: string): string | null {
  // 1. Try schema.org JSON-LD (Product type)
  const jsonLdImage = extractJsonLdProductImage(html);
  if (jsonLdImage) return jsonLdImage;

  // 2. Try og:image (both attribute orderings)
  const ogPatterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ];
  for (const pattern of ogPatterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1].startsWith("http")) return match[1];
  }

  return null;
}

function extractJsonLdProductImage(html: string): string | null {
  // Find all <script type="application/ld+json"> blocks
  const scriptPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1]);
      const image = extractImageFromSchema(json);
      if (image) return image;
    } catch {
      // Skip malformed JSON
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImageFromSchema(schema: any): string | null {
  if (!schema) return null;

  // Handle @graph arrays (common pattern)
  if (Array.isArray(schema["@graph"])) {
    for (const node of schema["@graph"]) {
      const img = extractImageFromSchema(node);
      if (img) return img;
    }
  }

  // Handle arrays at root level
  if (Array.isArray(schema)) {
    for (const node of schema) {
      const img = extractImageFromSchema(node);
      if (img) return img;
    }
  }

  // Check if this is a Product type
  const type: string = schema["@type"] ?? "";
  const isProduct = type === "Product" || type.includes("Product");
  if (!isProduct) return null;

  // Extract image field
  const image = schema["image"];
  if (typeof image === "string" && image.startsWith("http")) return image;
  if (Array.isArray(image)) {
    for (const img of image) {
      if (typeof img === "string" && img.startsWith("http")) return img;
      if (typeof img === "object" && img?.url?.startsWith("http")) return img.url;
    }
  }
  if (typeof image === "object" && image?.url?.startsWith("http")) return image.url;

  return null;
}
