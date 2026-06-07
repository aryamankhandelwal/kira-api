// TODO: extract shared query builder + helpers with search/route.ts
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { classifyProduct } from "../lib/classifier";
import { ParsedQuery, RefineItem, refineSearchQuery } from "../lib/gemini";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// ── Types & constants (duplicated from search/route.ts — see TODO above) ──

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
  available_sizes: string[] | null;
  style_register: string | null;
}

const MARKETPLACE_SOURCES = new Set(["nykaa", "ajio", "tatacliq", "myntra", "azafashions", "kalkifashion", "fabindia"]);

const SOURCE_TIER: Record<string, number> = {
  manish_malhotra: 4, falguni_shane_peacock: 4, tarun_tahiliani: 4,
  gaurav_gupta: 4, anamika_khanna: 4, rohit_bal: 4, punit_balana: 4, jayanti_reddy: 4,
  anita_dongre: 3, raw_mango: 3, torani: 3, house_of_masaba: 3, payal_singhal: 3,
  ridhi_mehra: 3, aisha_rao: 3, mishru: 3, sheetal_batra: 3, suruchi_parakh: 3,
  studio_bagechaa: 3, devnaagri: 3, old_marigold: 3, ritu_kumar: 3,
  saaksha_kinni: 3, taali: 3, basanti_ke_kapde: 3,
  perniaspopupshop: 2, azafashions: 2, ogaan: 2, ensemble: 2, aashni: 2,
  the_loom: 1, manyavar: 1, tasva: 1, jade_blue: 1,
  benzer: 1, ahi_clothing: 1, karaj_jaipur: 1, gyans: 1, pratap_sons: 1,
  ridhiiee_suuri: 1, meena_bazaar: 1, tjori: 1, nalli: 1,
  bunaai: 1, indethnic: 1, weaverstory: 1,
  clothsvilla: 1, suta: 1, fashor: 1, soch: 1, w_for_woman: 1, libas: 1,
  kalkifashion: 0, chhabra555: 0, vastramay: 0, vasansi: 0, jaipurkurti: 0,
};
function sourceTier(source: string): number { return SOURCE_TIER[source] ?? 0; }

const SOURCE_STYLE_REGISTER: Record<string, "contemporary" | "traditional" | "bridal" | "mixed"> = {
  clothsvilla: "contemporary", suta: "contemporary", torani: "contemporary",
  raw_mango: "contemporary", house_of_masaba: "contemporary", fashor: "contemporary",
  w_for_woman: "contemporary", saaksha_kinni: "contemporary", devnaagri: "contemporary",
  old_marigold: "contemporary", mishru: "contemporary", basanti_ke_kapde: "contemporary",
  bunaai: "contemporary", studio_bagechaa: "contemporary",
  manish_malhotra: "bridal", gaurav_gupta: "bridal", falguni_shane_peacock: "bridal",
  tarun_tahiliani: "bridal", anamika_khanna: "bridal", punit_balana: "bridal",
  jayanti_reddy: "bridal", payal_singhal: "bridal", ridhi_mehra: "bridal", aisha_rao: "bridal",
  kankatala: "traditional", pothys: "traditional", nalli: "traditional",
  kalkifashion: "traditional", chhabra555: "traditional", vastramay: "traditional",
  vasansi: "traditional", jaipurkurti: "traditional",
  azafashions: "mixed", perniaspopupshop: "mixed", nykaa: "mixed",
  ajio: "mixed", myntra: "mixed", anita_dongre: "mixed", ritu_kumar: "mixed",
};

function toOutfitCard(p: Product) {
  const isMarketplace = MARKETPLACE_SOURCES.has(p.source);
  const brand = isMarketplace ? p.source : p.source.replace(/_/g, " ");
  return {
    id: p.id,
    brand,
    name: p.title,
    price: p.price != null ? `₹${p.price.toLocaleString("en-IN")}` : null,
    price_numeric: p.price,
    currency: p.currency ?? "INR",
    occasion: null,
    tags: [p.source],
    garment_type: p.garment_type ?? null,
    color: p.color ?? null,
    fabric: p.fabric ?? null,
    embellishments: p.embellishments ?? [],
    available_sizes: p.available_sizes ?? [],
    thumbnail_url: p.image_url,
    image_url: p.image_url,
    sourceURL: p.product_url,
  };
}

// ── Dedup helpers ───────────────────────────────────────────────────

function normalizeImageUrl(url: string): string {
  let n = url.split("?")[0];
  n = n.replace(
    /_([\d]+x[\d]*|x[\d]+|grande|large|medium|small|compact|master|thumb|icon|pico|nano)(?=\.\w{3,4}$)/i,
    ""
  );
  n = n.replace(/\/[hwq]-\d+(?:,[hwq]-\d+)*\//g, "/");
  return n.toLowerCase();
}

function completenessScore(p: Product): number {
  return (p.garment_type != null ? 1 : 0) +
         (p.color        != null ? 1 : 0) +
         (p.fabric       != null ? 1 : 0);
}
function embellishmentScore(p: Product): number {
  return Math.min((p.embellishments ?? []).length, 3);
}
function rankScore(p: Product): number {
  return (sourceTier(p.source) * 1000) +
         (completenessScore(p) * 3) +
         (embellishmentScore(p) * 2);
}

const EMBELLISHMENT_ALIASES: Record<string, string[]> = {
  "mirror work":  ["shisha", "abla", "sitara", "mirrorwork", "shishay"],
  "embroidery":   ["chikankari", "chikan", "lucknowi", "kantha", "aari", "nakshi",
                   "schiffli", "cutwork", "shadow work", "sozni", "kashida", "handwork",
                   "applique", "patchwork"],
  "thread work":  ["phulkari", "kantha", "kasuti", "mukaish", "badla", "kamdani"],
  "stone work":   ["kundan", "polki", "meenakari"],
  "block print":  ["ajrakh", "dabu", "bagru", "kalamkari", "hand block", "batik"],
  "printed":      ["bandhani", "bandhej", "ikat", "laheriya", "tie dye", "warli",
                   "madhubani", "pichwai", "kalamkari"],
  "zardozi":      ["zardosi", "zari work", "tilla"],
  "gota patti":   ["gota work", "gotta patti"],
  "sequins":      ["sequin", "glitter", "sequence", "sequences", "sequence work", "paillette"],
  "beads":        ["cutdana", "cuttdana", "moti work"],
  "resham":       ["resham work"],
};

function expandSearchTerms(terms: string[]): string[] {
  const expanded = [...terms];
  for (const term of terms) {
    const aliases = EMBELLISHMENT_ALIASES[term.toLowerCase()] ?? [];
    expanded.push(...aliases);
  }
  return [...new Set(expanded)];
}

function titleRelevanceBonus(p: Product, terms: string[]): number {
  if (!terms.length) return 0;
  const title = p.title.toLowerCase();
  let bonus = 0;
  for (const term of terms) {
    const t = term.toLowerCase();
    const tNoSpace = t.replace(/\s+/g, "");
    const idx = title.indexOf(t) !== -1 ? title.indexOf(t) : title.indexOf(tNoSpace);
    if (idx === -1) continue;
    bonus += 2;
    if (idx < 35) bonus += 2;
    const beforeTerm = title.slice(Math.max(0, idx - 15), idx).trimEnd();
    const isAccent = /\b(with|and|featuring|includes?|has)\s*$/.test(beforeTerm);
    const afterTerm = title.slice(idx + t.length, idx + t.length + 20);
    const isDiminished = /^\s*(detail|trim|border|accent|touch|finish)/.test(afterTerm);
    if (isAccent || isDiminished) bonus -= 3;
    const isProminent = /\b(heavy|all[- ]over|dense|full|rich|intricate|elaborate|pure|extensive)\b/.test(beforeTerm);
    if (isProminent) bonus += 2;
  }
  return Math.max(0, Math.min(bonus, 7));
}

const CONTEMPORARY_OCCASION = /\bengagement\b|\bcocktail\b|\bparty\b|\bsangeet\b|\breception\b|\bmehendi\b|\bmodern\b|\bcontemporary\b|\bfusion\b/i;
const BRIDAL_OCCASION       = /\bbridal\b|\bbride\b|\bwedding\b/i;
const TRADITIONAL_OCCASION  = /\bpuja\b|\btemple\b|\btraditional\b|\bclassic\b/i;

function styleRegisterBoost(p: Product, occasion: string): number {
  const reg = p.style_register ?? SOURCE_STYLE_REGISTER[p.source];
  if (!reg || reg === "mixed") return 0;
  if (reg === "contemporary" && CONTEMPORARY_OCCASION.test(occasion)) return 500;
  if (reg === "bridal"       && BRIDAL_OCCASION.test(occasion))       return 500;
  if (reg === "traditional"  && TRADITIONAL_OCCASION.test(occasion))  return 500;
  return 0;
}

function isSetProduct(p: Product): boolean {
  return /\b(pyjama|churidar|dupatta|set)\b| and /i.test(p.title);
}
function pickWinner(a: Product, b: Product): Product {
  const sa = completenessScore(a), sb = completenessScore(b);
  if (sa !== sb) return sa > sb ? a : b;
  if (isSetProduct(a) && !isSetProduct(b)) return a;
  if (isSetProduct(b) && !isSetProduct(a)) return b;
  return (a.price ?? Infinity) <= (b.price ?? Infinity) ? a : b;
}

function deduplicateByImage(products: Product[]): Product[] {
  const seen = new Map<string, Product>();
  for (const p of products) {
    if (!p.image_url) { seen.set(p.id, p); continue; }
    const key = normalizeImageUrl(p.image_url);
    const existing = seen.get(key);
    seen.set(key, existing ? pickWinner(existing, p) : p);
  }
  return Array.from(seen.values());
}

const STOP_WORDS = new Set([
  "and","the","a","an","with","for","in","of","by","set","or","at","to","from",
]);
function wordSet(title: string): Set<string> {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
         .filter(w => w.length > 1 && !STOP_WORDS.has(w))
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let n = 0; for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

function deduplicateByTitle(products: Product[]): Product[] {
  const bySource = new Map<string, Product[]>();
  for (const p of products) {
    const g = bySource.get(p.source) ?? [];
    g.push(p); bySource.set(p.source, g);
  }
  const result: Product[] = [];
  for (const [, group] of bySource) {
    const ws = group.map(p => wordSet(p.title));
    const eliminated = new Set<number>();
    for (let i = 0; i < group.length; i++) {
      if (eliminated.has(i)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (eliminated.has(j)) continue;
        const pi = group[i].price, pj = group[j].price;
        if (pi != null && pj != null && Math.max(pi, pj) / Math.min(pi, pj) > 1.4) continue;
        if (jaccard(ws[i], ws[j]) >= 0.65) {
          const winner = pickWinner(group[i], group[j]);
          if (winner === group[j]) { group[i] = group[j]; ws[i] = ws[j]; }
          eliminated.add(j);
        }
      }
      result.push(group[i]);
    }
  }
  return result;
}

function deduplicateProducts(products: Product[]): Product[] {
  return deduplicateByTitle(deduplicateByImage(products));
}

// ── POST /api/refine ────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json();
  const existingQuery: ParsedQuery | undefined = body.existingQuery;
  const refinement: string | undefined = body.refinement;
  const currentItem: RefineItem | undefined = body.currentItem;
  const userGender: string | undefined = body.gender;

  if (!existingQuery || !refinement || !currentItem) {
    return NextResponse.json(
      { ok: false, error: "existingQuery, refinement, and currentItem are required" },
      { status: 400 }
    );
  }

  // ── Refine the ParsedQuery via Gemini ─────────────────────────────
  const parsed = await refineSearchQuery(existingQuery, refinement, currentItem, userGender);
  const effectiveUserGender = userGender ?? parsed.gender_hint ?? undefined;

  // Use the refinement text as a pseudo-occasion for style register boosting
  const occasion = refinement;

  // ── Build Supabase query (same logic as search/route.ts) ──────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbQuery: any = supabase.from("products").select("*");

  if (parsed.max_price != null) {
    dbQuery = dbQuery.lte("price", parsed.max_price);
  }
  if (parsed.min_price != null) {
    dbQuery = dbQuery.gte("price", parsed.min_price);
  }

  const FALLBACK_FEMALE = ["lehenga", "anarkali", "saree", "salwar", "sharara", "gown"];
  const FALLBACK_MALE   = ["sherwani", "kurta", "bandhgala", "pathani"];
  const FALLBACK_ALL    = [...FALLBACK_FEMALE, ...FALLBACK_MALE];

  let effectiveGarments = parsed.garment_types;
  if (effectiveGarments.length === 0) {
    effectiveGarments = effectiveUserGender === "male" ? FALLBACK_MALE
                      : effectiveUserGender === "female" ? FALLBACK_FEMALE
                      : FALLBACK_ALL;
  }

  const orParts = effectiveGarments
    .flatMap((t) => [`garment_type.eq.${t}`, `title.ilike.%${t}%`])
    .join(",");
  dbQuery = dbQuery.or(orParts);

  if (parsed.colors.length > 0) {
    dbQuery = dbQuery.in("color", parsed.colors);
  }

  if (parsed.fabrics.length > 0) {
    dbQuery = dbQuery.or(`fabric.in.(${parsed.fabrics.join(",")}),fabric.is.null`);
  }

  if (parsed.embellishments.length > 0) {
    const orParts = parsed.embellishments
      .flatMap((e) => {
        const parts = [`embellishments.cs.{${e}}`, `title.ilike.%${e}%`];
        const noSpace = e.replace(/\s+/g, "");
        if (noSpace !== e) parts.push(`title.ilike.%${noSpace}%`);
        return parts;
      })
      .join(",");
    dbQuery = dbQuery.or(orParts);
  }

  dbQuery = dbQuery.limit(90);

  const { data, error } = await dbQuery;

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }

  // ── Gender filter ─────────────────────────────────────────────────
  const passesGender = (p: Product): boolean => {
    const { gender: classified, exclude } = classifyProduct(p);
    if (exclude) return false;
    const dbGender = (p.gender && p.gender !== "unknown") ? p.gender : null;
    const resolvedGender: string = dbGender ?? (classified !== "unknown" ? classified : "unknown");
    if (effectiveUserGender === "male")
      return resolvedGender === "male" || resolvedGender === "unisex" || resolvedGender === "unknown";
    if (effectiveUserGender === "female")
      return resolvedGender === "female" || resolvedGender === "unisex" || resolvedGender === "unknown";
    return true;
  };

  const filtered = (data as Product[]).filter(passesGender);
  const searchTerms = expandSearchTerms([...parsed.embellishments, ...parsed.keywords]);
  const sortByRelevance = (a: Product, b: Product) =>
    (rankScore(b) + titleRelevanceBonus(b, searchTerms) + styleRegisterBoost(b, occasion)) -
    (rankScore(a) + titleRelevanceBonus(a, searchTerms) + styleRegisterBoost(a, occasion));

  let deduped = deduplicateProducts(filtered).sort(sortByRelevance);

  // ── Cascade: relax fabric+color when embellishments over-narrow ───
  if (deduped.length < 20 && parsed.embellishments.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fallback: any = supabase.from("products").select("*");
    if (parsed.max_price != null) fallback = fallback.lte("price", parsed.max_price);
    if (parsed.min_price != null) fallback = fallback.gte("price", parsed.min_price);

    if (parsed.garment_types.length > 0) {
      const garmentOrParts = parsed.garment_types
        .flatMap(t => [`garment_type.eq.${t}`, `title.ilike.%${t}%`])
        .join(",");
      fallback = fallback.or(garmentOrParts);
    }

    const embOrParts = parsed.embellishments
      .flatMap((e) => {
        const parts = [`embellishments.cs.{${e}}`, `title.ilike.%${e}%`];
        const noSpace = e.replace(/\s+/g, "");
        if (noSpace !== e) parts.push(`title.ilike.%${noSpace}%`);
        return parts;
      })
      .join(",");

    const { data: fallbackData } = await fallback.or(embOrParts).limit(60);
    if (fallbackData) {
      const existingIds = new Set(deduped.map(p => p.id));
      const additional = (fallbackData as Product[])
        .filter(passesGender)
        .filter(p => !existingIds.has(p.id));
      deduped = deduplicateProducts([...deduped, ...additional]).sort(sortByRelevance);
    }
  }

  // ── Size filter ───────────────────────────────────────────────────
  const userSize = (body.top_size || body.bottom_size || "").toUpperCase();
  const sized = userSize
    ? deduped
        .filter((p) =>
          !p.available_sizes?.length ||
          p.available_sizes.map((s: string) => s.toUpperCase()).includes(userSize)
        )
        .sort((a, b) => {
          const aHas = a.available_sizes?.map((s: string) => s.toUpperCase()).includes(userSize) ? 0 : 1;
          const bHas = b.available_sizes?.map((s: string) => s.toUpperCase()).includes(userSize) ? 0 : 1;
          return aHas - bHas;
        })
    : deduped;

  const cards = sized.map(toOutfitCard);

  return NextResponse.json({ ok: true, cards, total: cards.length, _parsed: parsed });
}
