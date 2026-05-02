import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { classifyProduct } from "../lib/classifier";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

interface Product {
  id: string;
  title: string;
  price: number | null;
  image_url: string;
  product_url: string;
  source: string;
  gender: string | null;
  garment_type: string | null;
  color: string | null;
  fabric: string | null;
  embellishments: string[];
  currency: string | null;
}

/** Map a Supabase product row into the OutfitCard shape the iOS app expects. */
function toOutfitCard(p: Product) {
  // Extract brand from title: first word(s) before the product description.
  // For "Odette Mauve Georgette..." → brand "Odette", name "Mauve Georgette..."
  // For "MADHURAM Women Pink..." → brand "MADHURAM", name "Women Pink..."
  const parts = p.title.split(" ");
  const brand = parts[0] ?? p.source;
  const name = parts.slice(1).join(" ") || p.title;

  return {
    id: p.id,
    brand,
    name,
    price: p.price != null ? `₹${p.price.toLocaleString("en-IN")}` : null,
    price_numeric: p.price,
    currency: p.currency ?? "INR",
    occasion: null,
    tags: [p.source],
    garment_type: p.garment_type ?? null,
    color: p.color ?? null,
    fabric: p.fabric ?? null,
    embellishments: p.embellishments ?? [],
    thumbnail_url: p.image_url,
    image_url: p.image_url,
    sourceURL: p.product_url,
  };
}

// GET /api/search?q=<query> — raw product data
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  if (!q) {
    return NextResponse.json(
      { ok: false, error: "q parameter is required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("products")
    .select("*")
    .ilike("title", `%${q}%`)
    .limit(10);

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, products: data });
}

// POST /api/search — iOS app sends { occasion, gender, ... }, returns OutfitCard[]
export async function POST(req: NextRequest) {
  const body = await req.json();
  const occasion: string = body.occasion ?? "";
  const userGender: string | undefined = body.gender;

  if (!occasion) {
    return NextResponse.json(
      { ok: false, error: "occasion is required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("products")
    .select("*")
    .ilike("title", `%${occasion}%`)
    .limit(40);

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }

  const filtered = (data as Product[]).filter((p) => {
    // Always run the classifier — it catches off-gender items that were
    // mis-tagged at ingest time (e.g. a women's kurta scraped under "mens kurta").
    const { gender: classified, exclude } = classifyProduct(p);
    if (exclude) return false;

    // Prefer the classifier when it's confident; fall back to stored gender,
    // then "unknown" for legacy rows with no stored gender at all.
    const effectiveGender: string =
      classified !== "unknown" ? classified : (p.gender ?? "unknown");

    if (userGender === "male")
      return effectiveGender === "male" || effectiveGender === "unisex" || effectiveGender === "unknown";
    if (userGender === "female")
      return effectiveGender === "female" || effectiveGender === "unisex" || effectiveGender === "unknown";
    return true;
  });

  const cards = filtered.map(toOutfitCard);
  return NextResponse.json({ ok: true, cards });
}
