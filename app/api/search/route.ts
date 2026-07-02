import { NextRequest, NextResponse } from "next/server";
import { detectExplicit, deterministicParse, mergeParsed } from "../lib/deterministic-parse";
import { parseSearchQuery, ParsedQuery, sanitiseParsed } from "../lib/gemini";
import { Product, runSearchPipeline, supabase, toOutfitCard } from "../lib/search-core";

// Gemini parse + Supabase queries can exceed Vercel's default 10s function limit.
export const maxDuration = 25;

// ── Answer merger (deterministic — no Gemini call needed for known suggestions) ──

const KNOWN_SUGGESTIONS = new Set([
  "Under ₹5,000", "₹5,000–₹20,000", "₹20,000+",
  "I'm the bride", "I'm a guest", "Part of the wedding party",
  "Open to anything", "Pastels & soft tones", "Bold & vibrant", "Neutrals & nudes",
  "Traditional & classic", "Contemporary & fashion-forward", "Fusion & experimental",
  "Light & flowy", "Rich & structured", "Comfortable & breathable",
  // embellishment_level
  "Minimal & understated", "Elegant with some detail", "Heavily embellished & statement",
  // occasion_formality
  "Grand & traditional", "Chic & contemporary", "Relaxed & intimate",
  // silhouette
  "Long & flowing (lehenga / anarkali / saree)", "Straight cut (kurta / salwar / suit)", "Draped or co-ordinated sets",
]);

function dedup<T>(arr: T[]): T[] { return [...new Set(arr)]; }

function mergeAnswers(
  base: ParsedQuery,
  answers: Array<{ question: string; answer: string }>
): ParsedQuery {
  let p: ParsedQuery = { ...base, colors: [...base.colors], fabrics: [...base.fabrics] };

  for (const { answer } of answers) {
    // Budget
    if (answer === "Under ₹5,000")          { p = { ...p, max_price: 5000 }; continue; }
    if (answer === "₹5,000–₹20,000")        { p = { ...p, min_price: 5000, max_price: 20000 }; continue; }
    if (answer === "₹20,000+")              { p = { ...p, min_price: 20000 }; continue; }
    // Role
    if (answer === "I'm the bride")         { p = { ...p, garment_types: ["lehenga"] }; continue; }
    if (answer === "I'm a guest")           { p = { ...p, garment_types: ["anarkali", "lehenga", "salwar"] }; continue; }
    if (answer === "Part of the wedding party") { p = { ...p, garment_types: ["anarkali", "sharara", "salwar"] }; continue; }
    // Color families
    if (answer === "Pastels & soft tones")  {
      p = { ...p, colors: dedup([...p.colors, "blush", "lavender", "mint", "ivory", "peach", "powder blue", "champagne", "lilac"]) };
      continue;
    }
    if (answer === "Bold & vibrant")        {
      p = { ...p, colors: dedup([...p.colors, "red", "maroon", "fuchsia", "cobalt", "royal blue", "saffron", "gold", "magenta"]) };
      continue;
    }
    if (answer === "Neutrals & nudes")      {
      p = { ...p, colors: dedup([...p.colors, "nude", "beige", "ivory", "cream", "taupe", "camel", "fawn"]) };
      continue;
    }
    // Style / fabric
    if (answer === "Traditional & classic") { p = { ...p, fabrics: dedup([...p.fabrics, "silk", "velvet", "brocade"]) }; continue; }
    if (answer === "Contemporary & fashion-forward") { p = { ...p, fabrics: dedup([...p.fabrics, "georgette", "crepe", "organza"]) }; continue; }
    if (answer === "Light & flowy")         { p = { ...p, fabrics: dedup([...p.fabrics, "georgette", "chiffon", "crepe"]) }; continue; }
    if (answer === "Rich & structured")     { p = { ...p, fabrics: dedup([...p.fabrics, "silk", "velvet", "brocade"]) }; continue; }
    // "Open to anything", "Comfortable & breathable", "Fusion & experimental" → no filter change

    // Embellishment level
    if (answer === "Minimal & understated")          { p = { ...p, embellishments: [] }; continue; }
    if (answer === "Elegant with some detail")       { p = { ...p, embellishments: dedup([...p.embellishments, "embroidery", "thread work"]) }; continue; }
    if (answer === "Heavily embellished & statement") { p = { ...p, embellishments: dedup([...p.embellishments, "zardozi", "gota patti", "mirror work", "stone work", "sequins", "crystals"]) }; continue; }

    // Occasion formality / vibe
    if (answer === "Grand & traditional")  { p = { ...p, fabrics: dedup([...p.fabrics, "silk", "velvet", "brocade"]), embellishments: dedup([...p.embellishments, "zardozi", "gota patti", "resham"]) }; continue; }
    if (answer === "Chic & contemporary") { p = { ...p, fabrics: dedup([...p.fabrics, "georgette", "organza", "crepe"]), embellishments: dedup([...p.embellishments, "sequins", "crystals", "thread work"]) }; continue; }
    if (answer === "Relaxed & intimate")  { p = { ...p, fabrics: dedup([...p.fabrics, "cotton", "chiffon", "georgette"]), embellishments: [] }; continue; }

    // Silhouette (additive — broadens rather than resets garment_types)
    if (answer === "Long & flowing (lehenga / anarkali / saree)") { p = { ...p, garment_types: dedup([...p.garment_types, "lehenga", "anarkali", "saree", "gown"]) }; continue; }
    if (answer === "Straight cut (kurta / salwar / suit)")        { p = { ...p, garment_types: dedup([...p.garment_types, "kurta", "salwar", "suit", "kurti"]) }; continue; }
    if (answer === "Draped or co-ordinated sets")                 { p = { ...p, garment_types: dedup([...p.garment_types, "saree", "co-ord", "sharara", "palazzo"]) }; continue; }
  }
  return p;
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
  const userId: string | undefined = body.userId;

  if (!occasion) {
    return NextResponse.json(
      { ok: false, error: "occasion is required" },
      { status: 400 }
    );
  }

  const sessionToken: string | undefined = body.sessionToken;
  const followUpAnswers: Array<{ question: string; answer: string }> = body.followUpAnswers ?? [];

  // ── Test fixture short-circuit (no Gemini call) ───────────────────
  if (occasion.trim().toLowerCase() === "test prompt") {
    const { data: testData, error: testError } = await supabase
      .from("products")
      .select("*")
      .not("image_url", "is", null)
      .neq("image_url", "")
      .order("id")
      .limit(20);

    if (testError) {
      return NextResponse.json({ ok: false, error: testError.message }, { status: 500 });
    }

    const cards = (testData as Product[]).map(toOutfitCard);
    return NextResponse.json({ ok: true, cards, _parsed: { _test: true } });
  }

  // ── Resolve ParsedQuery — use sessionToken (no Gemini) or fall back to Gemini ──
  let parsed: ParsedQuery;
  if (sessionToken) {
    try {
      // Sanitise the decoded token — stale/garbage tokens must not inject filter values
      const base = sanitiseParsed(JSON.parse(Buffer.from(sessionToken, "base64").toString("utf8")));
      // If any answer is custom (not in our known suggestion set), re-parse with Gemini
      const hasCustom = followUpAnswers.some(a => a.answer && !KNOWN_SUGGESTIONS.has(a.answer) && a.answer !== "Open to anything");
      if (hasCustom) {
        const enriched = `${occasion}. ${followUpAnswers.map(a => a.answer).filter(Boolean).join(". ")}.`;
        parsed = await parseSearchQuery(enriched, userGender);
      } else {
        parsed = mergeAnswers(base, followUpAnswers);
      }
    } catch {
      // Token corrupt — fall back to Gemini
      parsed = await parseSearchQuery(occasion, userGender);
    }
  } else {
    // Legacy path (no token) — enrich occasion with any answers and parse
    const enriched = followUpAnswers.length > 0
      ? `${occasion}. ${followUpAnswers.map(a => a.answer).join(". ")}.`
      : occasion;
    parsed = await parseSearchQuery(enriched, userGender);
  }

  // Merge with the regex parse of the raw occasion — constraints the user
  // literally typed (price cap, garment, craft, color) can never be dropped
  // by a failed or lossy Gemini parse.
  parsed = mergeParsed(parsed, deterministicParse(occasion));

  // Determine effective gender — prefer explicit user profile gender over hint
  const effectiveUserGender = userGender ?? parsed.gender_hint ?? undefined;
  const userSize = ((body.top_size || body.bottom_size || "") as string).toUpperCase() || undefined;

  let allCards: ReturnType<typeof toOutfitCard>[];
  try {
    const result = await runSearchPipeline({
      parsed,
      occasion,
      explicit: detectExplicit(occasion),
      effectiveUserGender,
      userId,
      userSize,
    });
    allCards = result.cards;
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  // Optional pagination — iOS can request a slice to show first cards sooner.
  // If omitted, the full list is returned (backwards-compatible).
  const limit: number | undefined  = typeof body.limit  === "number" ? body.limit  : undefined;
  const offset: number | undefined = typeof body.offset === "number" ? body.offset : undefined;
  const cards = (limit != null)
    ? allCards.slice(offset ?? 0, (offset ?? 0) + limit)
    : allCards;
  const total = allCards.length;

  return NextResponse.json({ ok: true, cards, total, _parsed: parsed });
}
