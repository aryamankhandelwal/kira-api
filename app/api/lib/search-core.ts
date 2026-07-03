// Shared search pipeline used by /api/search and /api/refine.
// Owns: product typing, source tiers, ranking, dedup, taste profile,
// query building, cascade relaxation, gender/size filtering.
import { createClient } from "@supabase/supabase-js";
import { classifyProduct } from "./classifier";
import {
  ExplicitFlags,
  expandColors,
  textMatchesColor,
  textMatchesEmbellishment,
  textMatchesGarment,
} from "./deterministic-parse";
import { ParsedQuery } from "./gemini";
import { rerankCandidates } from "./rerank";

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

export interface Product {
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
  like_count: number;
  dislike_count: number;
  // AI image enrichment (null until the scraper's enrich run has seen the row)
  ai_colors: string[] | null;
  ai_embellishments: string[] | null;
  aesthetic_tags: string[] | null;
  modernity: number | null;
  ai_description: string | null;
}

// Sources where the title belongs to a third-party seller — use the platform name as brand
export const MARKETPLACE_SOURCES = new Set(["nykaa", "ajio", "tatacliq", "myntra", "azafashions", "kalkifashion", "fabindia"]);

export const SOURCE_TIER: Record<string, number> = {
  // Tier 4 — Couture / luxury designers
  manish_malhotra: 4, falguni_shane_peacock: 4, tarun_tahiliani: 4,
  gaurav_gupta: 4, anamika_khanna: 4, rohit_bal: 4, punit_balana: 4, jayanti_reddy: 4,
  // Tier 3 — Contemporary / bridge designers
  anita_dongre: 3, raw_mango: 3, torani: 3, house_of_masaba: 3, payal_singhal: 3,
  ridhi_mehra: 3, aisha_rao: 3, mishru: 3, sheetal_batra: 3, suruchi_parakh: 3,
  studio_bagechaa: 3, devnaagri: 3, old_marigold: 3, ritu_kumar: 3,
  saaksha_kinni: 3, taali: 3, basanti_ke_kapde: 3,
  // Tier 2 — Fashion-forward curators
  perniaspopupshop: 2, azafashions: 2, ogaan: 2, ensemble: 2, aashni: 2,
  // Tier 1 — Curators / fashion-forward retailers / menswear specialists
  the_loom: 1, manyavar: 1, tasva: 1, jade_blue: 1,
  benzer: 1, ahi_clothing: 1, karaj_jaipur: 1, gyans: 1, pratap_sons: 1,
  ridhiiee_suuri: 1, meena_bazaar: 1, tjori: 1, nalli: 1,
  bunaai: 1, indethnic: 1, weaverstory: 1,
  clothsvilla: 1, suta: 1, fashor: 1, soch: 1, w_for_woman: 1, libas: 1,
  // Tier 0 — mass market (default for anything not listed)
  kalkifashion: 0, chhabra555: 0, vastramay: 0, vasansi: 0, jaipurkurti: 0,
};
export function sourceTier(source: string): number { return SOURCE_TIER[source] ?? 0; }

export const SOURCE_STYLE_REGISTER: Record<string, "contemporary" | "traditional" | "bridal" | "mixed"> = {
  // contemporary
  clothsvilla: "contemporary", suta: "contemporary", torani: "contemporary",
  raw_mango: "contemporary", house_of_masaba: "contemporary", fashor: "contemporary",
  w_for_woman: "contemporary", saaksha_kinni: "contemporary", devnaagri: "contemporary",
  old_marigold: "contemporary", mishru: "contemporary", basanti_ke_kapde: "contemporary",
  bunaai: "contemporary", studio_bagechaa: "contemporary",
  // bridal
  manish_malhotra: "bridal", gaurav_gupta: "bridal", falguni_shane_peacock: "bridal",
  tarun_tahiliani: "bridal", anamika_khanna: "bridal", punit_balana: "bridal",
  jayanti_reddy: "bridal", payal_singhal: "bridal", ridhi_mehra: "bridal", aisha_rao: "bridal",
  // traditional
  kankatala: "traditional", pothys: "traditional", nalli: "traditional",
  kalkifashion: "traditional", chhabra555: "traditional", vastramay: "traditional",
  vasansi: "traditional", jaipurkurti: "traditional",
  // mixed
  azafashions: "mixed", perniaspopupshop: "mixed", nykaa: "mixed",
  ajio: "mixed", myntra: "mixed", anita_dongre: "mixed", ritu_kumar: "mixed",
};

/** Map a Supabase product row into the OutfitCard shape the iOS app expects. */
export function toOutfitCard(p: Product) {
  const isMarketplace = MARKETPLACE_SOURCES.has(p.source);
  // Non-marketplace sources are single-brand direct scrapers — use the source as brand.
  // Avoids showing garment descriptors ("Cream", "Embroidered") as the brand name.
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

export type OutfitCard = ReturnType<typeof toOutfitCard>;

// ── Deduplication helpers ─────────────────────────────────────────────

function normalizeImageUrl(url: string): string {
  let n = url.split("?")[0];
  n = n.replace(
    /_([\d]+x[\d]*|x[\d]+|grande|large|medium|small|compact|master|thumb|icon|pico|nano)(?=\.\w{3,4}$)/i,
    ""
  );
  n = n.replace(/\/[hwq]-\d+(?:,[hwq]-\d+)*\//g, "/");
  return n.toLowerCase();
}

export function completenessScore(p: Product): number {
  return (p.garment_type != null ? 1 : 0) +
         (p.color        != null ? 1 : 0) +
         (p.fabric       != null ? 1 : 0);
}
function embellishmentScore(p: Product): number {
  return Math.min((p.embellishments ?? []).length, 3);
}

/**
 * Regional/craft vocabulary aliases for embellishment search terms.
 * Designer brands often use craft-specific names (shisha, abla, chikankari) instead
 * of the generic terms stored in the DB. Expanding search terms with these aliases
 * lets the title relevance bonus fire even for products using craft vocabulary.
 */
export const EMBELLISHMENT_ALIASES: Record<string, string[]> = {
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

export function expandSearchTerms(terms: string[]): string[] {
  const expanded = [...terms];
  for (const term of terms) {
    const aliases = EMBELLISHMENT_ALIASES[term.toLowerCase()] ?? [];
    expanded.push(...aliases);
  }
  return [...new Set(expanded)];
}

// ── Taste profile ──────────────────────────────────────────────────────

interface TasteCard {
  garment_type: string | null;
  color: string | null;
  fabric: string | null;
  embellishments: string[];
  source: string | null;
}

export interface TasteVector {
  garment_types: Record<string, number>;
  colors: Record<string, number>;
  fabrics: Record<string, number>;
  embellishments: Record<string, number>;
  style_registers: Record<string, number>;
}

async function fetchTasteCards(userId: string): Promise<{ liked: TasteCard[]; disliked: TasteCard[] }> {
  const [likedRes, dislikedRes, savedRes] = await Promise.all([
    supabase.from("liked_outfits")
      .select("garment_type,color,fabric,embellishments,source")
      .eq("user_id", userId).order("liked_at", { ascending: false }).limit(200),
    supabase.from("disliked_outfits")
      .select("garment_type,color,fabric,embellishments,source")
      .eq("user_id", userId).order("disliked_at", { ascending: false }).limit(50),
    supabase.from("saved_outfits")
      .select("garment_type,color,fabric,embellishments,tags")
      .eq("user_id", userId).order("saved_at", { ascending: false }).limit(200),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saved = (savedRes.data ?? []).map((r: any) => ({ ...r, source: r.tags?.[0] ?? null }));
  return {
    liked: [...(likedRes.data ?? []), ...saved] as TasteCard[],
    disliked: (dislikedRes.data ?? []) as TasteCard[],
  };
}

function buildTasteVector(cards: TasteCard[]): TasteVector | null {
  if (!cards.length) return null;
  const gt: Record<string, number> = {};
  const co: Record<string, number> = {};
  const fa: Record<string, number> = {};
  const em: Record<string, number> = {};
  const sr: Record<string, number> = {};
  for (const c of cards) {
    if (c.garment_type) gt[c.garment_type] = (gt[c.garment_type] ?? 0) + 1;
    if (c.color)        co[c.color]        = (co[c.color]        ?? 0) + 1;
    if (c.fabric)       fa[c.fabric]       = (fa[c.fabric]       ?? 0) + 1;
    for (const e of (c.embellishments ?? [])) em[e] = (em[e] ?? 0) + 1;
    const reg = c.source ? (SOURCE_STYLE_REGISTER[c.source] ?? null) : null;
    if (reg && reg !== "mixed") sr[reg] = (sr[reg] ?? 0) + 1;
  }
  const n = cards.length;
  const norm = (r: Record<string, number>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v / n]));
  return { garment_types: norm(gt), colors: norm(co), fabrics: norm(fa), embellishments: norm(em), style_registers: norm(sr) };
}

/**
 * Bonus for products where the searched terms appear prominently in the title.
 * Distinguishes primary features ("Mirror Work Lehenga") from accents
 * ("Floral Suit Set With Mirror Work") and penalises the latter.
 */
export function titleRelevanceBonus(p: Product, terms: string[]): number {
  if (!terms.length) return 0;
  const title = p.title.toLowerCase();
  let bonus = 0;
  for (const term of terms) {
    const t = term.toLowerCase();
    const tNoSpace = t.replace(/\s+/g, "");
    const idx = title.indexOf(t) !== -1 ? title.indexOf(t) : title.indexOf(tNoSpace);
    if (idx === -1) continue;

    bonus += 2; // term appears in title at all

    if (idx < 35) bonus += 2; // appears early → primary descriptor

    // Detect "... with mirror work" / "... and mirror work" — accent, not primary feature
    // e.g. "Beige Georgette Floral Print Suit Set With Mirror Work"
    const beforeTerm = title.slice(Math.max(0, idx - 15), idx).trimEnd();
    const isAccent = /\b(with|and|featuring|includes?|has)\s*$/.test(beforeTerm);

    // Detect "mirror work detail / trim / border" — minor finishing detail
    const afterTerm = title.slice(idx + t.length, idx + t.length + 20);
    const isDiminished = /^\s*(detail|trim|border|accent|touch|finish)/.test(afterTerm);

    if (isAccent || isDiminished) bonus -= 3;

    // Detect "heavy / all over / intricate mirror work" — prominently featured
    const isProminent = /\b(heavy|all[- ]over|dense|full|rich|intricate|elaborate|pure|extensive)\b/.test(beforeTerm);
    if (isProminent) bonus += 2;
  }
  // Signed: accent-only mentions ("... with mirror work") go negative so
  // scoreProduct can demote them below products featuring the craft.
  return Math.max(-7, Math.min(bonus, 7));
}

const CONTEMPORARY_OCCASION = /\bengagement\b|\bcocktail\b|\bparty\b|\bsangeet\b|\breception\b|\bmehendi\b|\bmodern\b|\bcontemporary\b|\bfusion\b/i;
const BRIDAL_OCCASION       = /\bbridal\b|\bbride\b|\bwedding\b/i;
const TRADITIONAL_OCCASION  = /\bpuja\b|\btemple\b|\btraditional\b|\bclassic\b/i;

export function styleRegisterBoost(p: Product, occasion: string): number {
  const reg = p.style_register ?? SOURCE_STYLE_REGISTER[p.source];
  if (!reg || reg === "mixed") return 0;
  if (reg === "contemporary" && CONTEMPORARY_OCCASION.test(occasion)) return 140;
  if (reg === "bridal"       && BRIDAL_OCCASION.test(occasion))       return 140;
  if (reg === "traditional"  && TRADITIONAL_OCCASION.test(occasion))  return 140;
  return 0;
}

export function tasteBoost(p: Product, liked: TasteVector | null, disliked: TasteVector | null): number {
  let boost = 0;
  if (liked) {
    if (p.garment_type) boost += (liked.garment_types[p.garment_type] ?? 0) * 75;
    if (p.color)        boost += (liked.colors[p.color]               ?? 0) * 40;
    if (p.fabric)       boost += (liked.fabrics[p.fabric]             ?? 0) * 40;
    for (const e of (p.embellishments ?? [])) boost += (liked.embellishments[e] ?? 0) * 25;
    const reg = p.style_register ?? SOURCE_STYLE_REGISTER[p.source] ?? null;
    if (reg && reg !== "mixed") boost += (liked.style_registers[reg] ?? 0) * 50;
  }
  if (disliked) {
    if (p.garment_type) boost -= (disliked.garment_types[p.garment_type] ?? 0) * 50;
    if (p.color)        boost -= (disliked.colors[p.color]               ?? 0) * 30;
    if (p.fabric)       boost -= (disliked.fabrics[p.fabric]             ?? 0) * 30;
    for (const e of (p.embellishments ?? [])) boost -= (disliked.embellishments[e] ?? 0) * 20;
    const reg = p.style_register ?? SOURCE_STYLE_REGISTER[p.source] ?? null;
    if (reg && reg !== "mixed") boost -= (disliked.style_registers[reg] ?? 0) * 40;
  }
  return Math.max(-120, Math.min(boost, 160));
}

export function globalPopularityBoost(p: Product): number {
  const net = (p.like_count ?? 0) - (p.dislike_count ?? 0);
  return Math.max(-60, Math.min(net * 2, 60));
}

// ── Relevance-first scoring ────────────────────────────────────────────
// Query-match signals dominate (an exact craft+garment+palette match scores
// ~1,100); vibe/taste signals sit in the low hundreds; brand tier is a
// 0–60 tiebreaker. A tier-4 designer piece that ignores the query can never
// outrank an exact match from a mass-market source.

export interface ScoreContext {
  parsed: ParsedQuery;
  /** parsed.embellishments + keywords, expanded with craft aliases. */
  searchTerms: string[];
  occasion: string;
  likedVector: TasteVector | null;
  dislikedVector: TasteVector | null;
}

export function scoreProduct(p: Product, ctx: ScoreContext): number {
  const { parsed } = ctx;
  let score = 0;

  // Requested embellishments — the query's soul when present
  if (parsed.embellishments.length > 0) {
    let columnPoints = 0;
    let titleOnlyHit = false;
    for (const e of parsed.embellishments) {
      const inColumn = (p.embellishments ?? []).includes(e);
      const inTitle = textMatchesEmbellishment(p.title, e);
      if (inColumn) {
        columnPoints += 400;
        if (inTitle) score += 50; // corroborated by the title
      } else if (inTitle) {
        titleOnlyHit = true; // untagged row — title is the only evidence
      }
    }
    score += Math.min(columnPoints, 500);
    if (titleOnlyHit) score += 250;
    // Craft verified VISIBLE in the product photo — highest-trust evidence
    if (parsed.embellishments.some(e => (p.ai_embellishments ?? []).includes(e))) {
      score += 150;
    }
  }

  // Title prominence — keeps the "with mirror work" accent demotion, at scale
  score += titleRelevanceBonus(p, ctx.searchTerms) * 20;

  // Garment type — column beats substring
  if (parsed.garment_types.length > 0) {
    if (p.garment_type != null && parsed.garment_types.includes(p.garment_type)) {
      score += 250;
    } else if (parsed.garment_types.some(g => textMatchesGarment(p.title, g))) {
      score += 100;
    }
  }

  // Color vs requested palette — palette actually shapes ranking now
  if (parsed.colors.length > 0) {
    const aiColors = p.ai_colors ?? [];
    if (aiColors.some(c => parsed.colors.includes(c))) {
      score += 250; // AI-verified from the product photo — highest trust
    } else if (p.color != null && parsed.colors.includes(p.color)) {
      score += 220;
    } else if (parsed.colors.some(c => textMatchesColor(p.title, c))) {
      score += 90;  // palette color in title (column missing or first-match-off)
    } else if (p.color == null && aiColors.length === 0) {
      score -= 120; // unknown color ranks below matches, above conflicts
    } else {
      score -= 250; // known color conflicts the palette — sinks
    }
  }

  // Vibe tags — occasion mood vs the product photo's aesthetic tags
  const vibeTags = parsed.vibe_tags ?? [];
  if (vibeTags.length > 0 && p.aesthetic_tags != null) {
    const matched = vibeTags.filter(t => p.aesthetic_tags!.includes(t)).length;
    score += Math.min(matched * 120, 240);
  }

  // Modern pieces get a nudge on contemporary occasions
  if (p.modernity != null && p.modernity >= 65 && CONTEMPORARY_OCCASION.test(ctx.occasion)) {
    score += 80;
  }

  // Fabric — soft signal
  if (parsed.fabrics.length > 0 && p.fabric != null) {
    score += parsed.fabrics.includes(p.fabric) ? 70 : -50;
  }

  score += styleRegisterBoost(p, ctx.occasion);
  score += tasteBoost(p, ctx.likedVector, ctx.dislikedVector);
  score += globalPopularityBoost(p);

  // Micro tiebreakers
  score += completenessScore(p) * 3;
  score += embellishmentScore(p) * 2;
  score += sourceTier(p.source) * 15;

  return score;
}

/**
 * Word-boundary garment check killing ILIKE substring false positives —
 * "suit" matching "jumpsuit", a drape dress passing a lehenga query.
 * Keeps rows whose garment_type column matches OR whose title mentions a
 * requested garment under any regional spelling (sari, chaniya choli, …).
 */
export function postFilterGarment(products: Product[], garmentTypes: string[]): Product[] {
  if (garmentTypes.length === 0) return products;
  return products.filter(p =>
    (p.garment_type != null && garmentTypes.includes(p.garment_type)) ||
    garmentTypes.some(g => textMatchesGarment(p.title, g))
  );
}

/**
 * Brand diversity guard: never more than `maxRun` consecutive cards from one
 * source. Items breaking a run are deferred and re-emitted as soon as the
 * source changes (they keep outranking everything below them). When a single
 * source dominates the pool, its surplus necessarily runs together at the
 * tail — only the head of the feed can be kept diverse.
 */
export function diversify(products: Product[], maxRun = 2): Product[] {
  const result: Product[] = [];
  const deferred: Product[] = [];

  const runSource = (): string | null => {
    if (result.length < maxRun) return null;
    const s = result[result.length - 1].source;
    for (let i = result.length - maxRun; i < result.length; i++) {
      if (result[i].source !== s) return null;
    }
    return s;
  };

  const flushDeferred = () => {
    let emitted = true;
    while (emitted) {
      emitted = false;
      const blocked = runSource();
      const i = deferred.findIndex(d => d.source !== blocked);
      if (i !== -1) {
        result.push(deferred.splice(i, 1)[0]);
        emitted = true;
      }
    }
  };

  for (const p of products) {
    flushDeferred(); // deferred items rank higher — emit them first when allowed
    if (p.source === runSource()) {
      deferred.push(p);
    } else {
      result.push(p);
    }
  }
  flushDeferred();
  return [...result, ...deferred];
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

/** 1a — dedupe by normalized image_url (same photo, different SKU) */
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

/** 1b — dedupe by title Jaccard within same source (variants from same vendor) */
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
        // Price guard: skip if prices differ by >40% (different products, not variants)
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

export function deduplicateProducts(products: Product[]): Product[] {
  return deduplicateByTitle(deduplicateByImage(products));
}

// ── Query building ─────────────────────────────────────────────────────

// The AI-enrichment columns (migrations/001_enrichment.sql in shauk-scraper)
// may not exist yet. Probe once per lambda instance and degrade the color
// filter gracefully so deploys are never gated on the migration.
let enrichmentProbe: Promise<boolean> | null = null;
function enrichmentAvailable(): Promise<boolean> {
  if (!enrichmentProbe) {
    enrichmentProbe = (async () => {
      try {
        const { error } = await supabase.from("products").select("ai_colors").limit(1);
        if (error) console.warn("[search-core] enrichment columns unavailable:", error.message);
        return !error;
      } catch {
        return false;
      }
    })();
  }
  return enrichmentProbe;
}

const OCCASION_GARMENTS: Record<string, string[]> = {
  wedding: ["lehenga", "anarkali", "salwar"],
  bride: ["lehenga"],
  bridal: ["lehenga"],
  sangeet: ["lehenga", "sharara", "anarkali"],
  reception: ["lehenga", "gown", "saree"],
  engagement: ["lehenga", "anarkali"],
  mehndi: ["anarkali", "salwar"],
  mehendi: ["anarkali", "salwar"],
  haldi: ["salwar", "kurti"],
  cocktail: ["gown", "lehenga", "anarkali"],
  party: ["anarkali", "lehenga", "gown"],
  diwali: ["anarkali", "salwar", "lehenga"],
  eid: ["anarkali", "salwar"],
  festive: ["anarkali", "salwar"],
  puja: ["salwar", "saree", "kurta"],
  temple: ["salwar", "saree"],
  casual: ["kurta", "salwar", "kurti"],
  office: ["kurta", "suit", "salwar"],
  formal: ["kurta", "suit", "sherwani"],
};

function garmentOrParts(garmentTypes: string[]): string {
  return garmentTypes
    .flatMap((t) => [`garment_type.eq.${t}`, `title.ilike.%${t}%`])
    .join(",");
}

function embellishmentOrParts(embellishments: string[]): string {
  return embellishments
    .flatMap((e) => {
      const parts = [`embellishments.cs.{${e}}`, `title.ilike.%${e}%`];
      // Also try the no-space variant so "mirror work" matches "mirrorwork" in titles
      const noSpace = e.replace(/\s+/g, "");
      if (noSpace !== e) parts.push(`title.ilike.%${noSpace}%`);
      return parts;
    })
    .join(",");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildProductQuery(parsed: ParsedQuery, limit = 90, enriched = false): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbQuery: any = supabase.from("products").select("*");

  // Price range filters (strict — always applied when present)
  if (parsed.max_price != null) {
    dbQuery = dbQuery.lte("price", parsed.max_price);
  }
  if (parsed.min_price != null) {
    dbQuery = dbQuery.gte("price", parsed.min_price);
  }

  // Garment/keyword filter — OR across garment_type column AND title text
  if (parsed.garment_types.length > 0) {
    dbQuery = dbQuery.or(garmentOrParts(parsed.garment_types));
  } else if (parsed.keywords.length > 0) {
    // When Gemini fails, keywords[0] is the full occasion phrase (e.g. "wedding guest outfit").
    // An ILIKE on a multi-word phrase won't match any product title.
    // Try each word against our hardcoded occasion→garment map first; otherwise
    // fall back to an ILIKE on the first word so at least one meaningful word matches.
    const kwWords = parsed.keywords[0].toLowerCase().split(/\s+/);
    const fallbackGarments = [...new Set(kwWords.flatMap(w => OCCASION_GARMENTS[w] ?? []))];
    if (fallbackGarments.length > 0) {
      dbQuery = dbQuery.or(garmentOrParts(fallbackGarments));
    } else {
      dbQuery = dbQuery.ilike("title", `%${kwWords[0]}%`);
    }
  }
  // If neither — occasion was mapped to nothing useful — return broad results
  // filtered only by price/color/fabric and gender (handled post-fetch)

  // Color filter — match the title-derived color column OR the AI-verified
  // image colors. Products with NEITHER classified still pass (SQL IN never
  // matches NULL and hard-excluding them would gut recall); ranking
  // de-prioritises them.
  if (parsed.colors.length > 0) {
    const quoted = parsed.colors.map(c => `"${c}"`).join(",");
    dbQuery = dbQuery.or(
      enriched
        ? `color.in.(${quoted}),ai_colors.ov.{${quoted}},and(color.is.null,ai_colors.is.null)`
        : `color.in.(${quoted}),color.is.null`
    );
  }

  // Fabric filter — also include null-fabric products (scraper didn't classify them).
  if (parsed.fabrics.length > 0) {
    dbQuery = dbQuery.or(`fabric.in.(${parsed.fabrics.join(",")}),fabric.is.null`);
  }

  // Embellishments filter — OR: tagged in embellishments column OR appears in title
  // (catches products where the scraper extracted the tag AND ones where it's only in the title)
  if (parsed.embellishments.length > 0) {
    dbQuery = dbQuery.or(embellishmentOrParts(parsed.embellishments));
  }

  return dbQuery.limit(limit);
}

// ── Pipeline ───────────────────────────────────────────────────────────

export interface PipelineParams {
  parsed: ParsedQuery;
  /** Text used for style-register occasion matching (the raw search, or the refinement text). */
  occasion: string;
  /** Constraints the user literally typed — enforced strictly, never relaxed. */
  explicit: ExplicitFlags;
  /** Explicit profile gender, falling back to parsed.gender_hint upstream. */
  effectiveUserGender?: string;
  /** Supabase user id — enables taste boosts when present. */
  userId?: string;
  /** Uppercased top/bottom size, e.g. "M" — filters + prioritises sized products. */
  userSize?: string;
  /** Stylist pass: LLM re-rank of the top candidates (default true; fail-open). */
  rerank?: boolean;
}

export interface PipelineResult {
  cards: (OutfitCard & { fill?: boolean })[];
  total: number;
}

/** Sort products with the user's size explicitly listed first, drop known-unavailable. */
function applySizeFilter(products: Product[], userSize: string | undefined): Product[] {
  if (!userSize) return products;
  return products
    .filter((p) =>
      !p.available_sizes?.length ||
      p.available_sizes.map((s: string) => s.toUpperCase()).includes(userSize)
    )
    .sort((a, b) => {
      const aHas = a.available_sizes?.map((s: string) => s.toUpperCase()).includes(userSize) ? 0 : 1;
      const bHas = b.available_sizes?.map((s: string) => s.toUpperCase()).includes(userSize) ? 0 : 1;
      return aHas - bHas;
    });
}

export async function runSearchPipeline(params: PipelineParams): Promise<PipelineResult> {
  const { occasion, explicit, effectiveUserGender, userId, userSize } = params;

  // Explicitly-named garments are exclusive: "mirror work lehenga" means
  // lehengas ONLY — not the anarkalis/shararas Gemini adds for the occasion.
  const parsed: ParsedQuery = explicit.garments.length > 0
    ? { ...params.parsed, garment_types: explicit.garments }
    : params.parsed;

  // ── Gender filter (post-fetch, using classifier) ─────────────────
  const passesGender = (p: Product): boolean => {
    const { gender: classified, exclude } = classifyProduct(p);
    if (exclude) return false;
    // DB gender is authoritative (set by scraper for known-gender sources).
    // Fall back to runtime classifier, then "unknown" as last resort.
    const dbGender = (p.gender && p.gender !== "unknown") ? p.gender : null;
    const resolvedGender: string = dbGender ?? (classified !== "unknown" ? classified : "unknown");
    if (effectiveUserGender === "male")
      return resolvedGender === "male" || resolvedGender === "unisex" || resolvedGender === "unknown";
    if (effectiveUserGender === "female")
      return resolvedGender === "female" || resolvedGender === "unisex" || resolvedGender === "unknown";
    return true;
  };

  // Gender + word-boundary garment check, applied to every fetch
  const cleanBatch = (rows: Product[] | null): Product[] =>
    postFilterGarment((rows ?? []).filter(passesGender), parsed.garment_types);

  // ── Stage 0: all filters, taste profile fetched in parallel ───────
  const enriched = await enrichmentAvailable();
  const [{ data, error }, tasteData] = await Promise.all([
    buildProductQuery(parsed, 90, enriched),
    userId ? fetchTasteCards(userId) : Promise.resolve({ liked: [], disliked: [] }),
  ]);
  if (error) throw new Error(error.message);

  let pool = deduplicateProducts(cleanBatch(data as Product[]));
  const stageCounts = [pool.length];

  const mergeBatch = (rows: Product[] | null) => {
    const existingIds = new Set(pool.map(p => p.id));
    const additional = cleanBatch(rows).filter(p => !existingIds.has(p.id));
    pool = deduplicateProducts([...pool, ...additional]);
  };

  // ── Cascade: staged relaxation of INFERRED constraints only ───────
  // Never dropped: price, explicit garments, explicit embellishments.
  // Stage 1 (<20 results): drop inferred colors + all fabrics — recovers
  // products with undetected or non-matching color/fabric metadata.
  const explicitColorSet = new Set(expandColors(explicit.colors));
  const stage1: ParsedQuery = {
    ...parsed,
    colors: parsed.colors.filter(c => explicitColorSet.has(c)),
    fabrics: [],
  };
  const stage1Differs = stage1.colors.length !== parsed.colors.length || parsed.fabrics.length > 0;
  if (pool.length < 20 && stage1Differs) {
    const { data: s1 } = await buildProductQuery(stage1, 60, enriched);
    mergeBatch(s1 as Product[]);
  }
  stageCounts.push(pool.length);

  // Stage 2 (<10 results): additionally drop inferred embellishments.
  const stage2: ParsedQuery = {
    ...stage1,
    embellishments: parsed.embellishments.filter(e => explicit.embellishments.includes(e)),
  };
  if (pool.length < 10 && stage2.embellishments.length !== parsed.embellishments.length) {
    const { data: s2 } = await buildProductQuery(stage2, 60, enriched);
    mergeBatch(s2 as Product[]);
  }
  stageCounts.push(pool.length);

  // ── Score & sort (always against the ORIGINAL parsed query — relaxation
  // affects recall only; ranking still rewards the full vibe) ─────────
  const searchTerms = expandSearchTerms([...parsed.embellishments, ...parsed.keywords]);
  const ctx: ScoreContext = {
    parsed,
    searchTerms,
    occasion,
    likedVector: buildTasteVector(tasteData.liked),
    dislikedVector: buildTasteVector(tasteData.disliked),
  };
  const byScore = (a: Product, b: Product) => scoreProduct(b, ctx) - scoreProduct(a, ctx);
  const finalScore = new Map(pool.map(p => [p.id, scoreProduct(p, ctx)]));
  pool.sort((a, b) => finalScore.get(b.id)! - finalScore.get(a.id)!);

  // ── Stylist pass: LLM re-rank of the top candidates ────────────────
  // Blended at 15× (0–1,500) so the LLM's occasion/vibe judgment dominates
  // while the heuristic score still separates ties and hedges LLM noise.
  // Items beyond the re-ranked head can't leapfrog it: they were already
  // below on heuristic score and the blend only adds points.
  let rerankStatus = "off";
  if (params.rerank !== false && pool.length > 1) {
    const llmScores = await rerankCandidates(occasion, pool.slice(0, 60));
    if (llmScores) {
      rerankStatus = "ok";
      for (const [id, s] of llmScores) {
        finalScore.set(id, (finalScore.get(id) ?? 0) + 15 * s);
      }
      pool.sort((a, b) => finalScore.get(b.id)! - finalScore.get(a.id)!);
    } else {
      rerankStatus = "failed";
    }
  }

  // ── Labeled fill: explicit craft ran short → append near-matches ──
  // Same garment + price + palette, embellishment constraint dropped. Fill
  // items always sort after every exact match and are flagged for the client.
  let fillPool: Product[] = [];
  if (explicit.embellishments.length > 0 && pool.length < 20) {
    const fillParsed: ParsedQuery = { ...parsed, embellishments: [] };
    const { data: fillData } = await buildProductQuery(fillParsed, 60, enriched);
    const poolIds = new Set(pool.map(p => p.id));
    fillPool = deduplicateProducts(cleanBatch(fillData as Product[]).filter(p => !poolIds.has(p.id)))
      .sort(byScore);
  }

  // ── Diversity guard + size filter, exact and fill kept separate ───
  const exact = applySizeFilter(diversify(pool), userSize);
  const fill  = applySizeFilter(diversify(fillPool), userSize);

  const cards = [
    ...exact.map(p => toOutfitCard(p)),
    ...fill.map(p => ({ ...toOutfitCard(p), fill: true })),
  ];

  console.log("[search-core]", JSON.stringify({
    occasion,
    garments: parsed.garment_types,
    embellishments: parsed.embellishments,
    colors: parsed.colors.length,
    max_price: parsed.max_price,
    explicit,
    stageCounts,
    rerankStatus,
    fillCount: fill.length,
    top5: exact.slice(0, 5).map(p => `${p.source}:${p.title.slice(0, 50)}`),
  }));

  return { cards, total: cards.length };
}
