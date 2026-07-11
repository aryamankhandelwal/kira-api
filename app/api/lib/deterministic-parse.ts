// Deterministic regex parser — the safety net under the Gemini parse.
// Guarantees that constraints the user literally typed (price caps, garment
// types, colors, embellishments) survive even when the LLM parse fails or
// hallucinates, and detects which constraints were EXPLICIT in the query so
// the pipeline can enforce them strictly.
//
// SYNC: the vocabulary tables below are ported from
// shauk-scraper/src/lib/metadata.ts (GARMENT_TYPES / COLORS / FABRICS /
// EMBELLISHMENTS). If patterns change there, mirror the change here.
import { ParsedQuery } from "./gemini";

// ── Vocabulary tables (SYNC with shauk-scraper/src/lib/metadata.ts) ────

// Priority-ordered: more specific types first to avoid "kurta" matching before "anarkali kurta"
const GARMENT_TYPES: [RegExp, string][] = [
  // Compound / regional names — must come before their parent types
  [/\bchaniya[\s-]choli\b|\bchaniya\b/i, "lehenga"],
  [/\blehenga[\s-]saree\b|\blehenga[\s-]sari\b/i, "lehenga"],
  [/\bpatiala\b/i, "salwar"],
  [/\bachkan\b/i, "sherwani"],
  [/\bchurida[r]?\b/i, "kurta"],
  [/\bkaftan\b/i, "gown"],
  [/\btunic\b/i, "kurti"],
  [/\blehenga\b/i, "lehenga"],
  [/\banarkali\b/i, "anarkali"],
  [/\bsaree\b|\bsari\b/i, "saree"],
  [/\bsharara\b/i, "sharara"],
  [/\bgharara\b/i, "gharara"],
  [/\bsalwar\b/i, "salwar"],
  [/\bpalazzo\b/i, "palazzo"],
  [/\bsherwani\b/i, "sherwani"],
  [/\bbandhgala\b|\bbandh[\s-]gala\b/i, "bandhgala"],
  [/\bjodhpuri\b|\bjodhpur\s+suit\b/i, "jodhpuri"],
  [/\bbundi\b|\bbandi\b/i, "bundi"],
  [/\bpathani\b/i, "pathani"],
  [/\bnehru[\s-]jacket\b/i, "nehru jacket"],
  [/\bindo[\s-]?western\b/i, "indo-western"],
  [/\bdhoti\b/i, "dhoti"],
  [/\bdupatta\b/i, "dupatta"],
  [/\bkurti\b/i, "kurti"],
  [/\bco[\s-]ord\b/i, "co-ord"],
  [/\bgown\b/i, "gown"],
  [/\bkurta[\s-]pajama\b/i, "kurta"],
  [/\bkurta\b/i, "kurta"],
  [/\bdress\b/i, "dress"],
  [/\bsuit\b/i, "suit"],
];

const COLORS: [RegExp, string][] = [
  // Multi-word / compound colors — must come before their single-word roots
  [/\bdusty\s+rose\b/i,    "dusty rose"],
  [/\brose\s+gold\b/i,     "rose gold"],
  [/\boff[\s-]white\b/i,   "off-white"],
  [/\bolive\s+green\b/i,   "olive green"],
  [/\bsage\s+green\b/i,    "sage green"],
  [/\bpowder\s+blue\b/i,   "powder blue"],
  [/\bsky\s+blue\b/i,      "sky blue"],
  [/\broyal\s+blue\b/i,    "royal blue"],
  [/\bfawn\b/i,            "fawn"],
  [/\bchampagne\b/i,       "champagne"],
  [/\becru\b/i,            "ecru"],
  [/\blilac\b/i,           "lilac"],
  [/\bwine\b/i,            "wine"],
  [/\bburgundy\b/i,        "burgundy"],
  [/\bindigo\b/i,          "indigo"],
  [/\baqua\b/i,            "aqua"],
  [/\bturquoise\b/i,       "turquoise"],
  [/\bamber\b/i,           "amber"],
  [/\bsage\b/i,            "sage"],
  [/\bolive\b/i,           "olive"],
  [/\bterracotta\b/i,      "terracotta"],
  [/\bmarigold\b/i,        "marigold"],
  [/\bsaffron\b/i,         "saffron"],
  [/\bochre\b/i,           "ochre"],
  [/\bcopper\b/i,          "copper"],
  [/\bbronze\b/i,          "bronze"],
  [/\btaupe\b/i,           "taupe"],
  [/\bcamel\b/i,           "camel"],
  [/\bplum\b/i,            "plum"],
  [/\bmagenta\b/i,         "magenta"],
  [/\bfuchsia\b/i,         "fuchsia"],
  [/\bcharcoal\b/i,        "charcoal"],
  [/\bcobalt\b/i,          "cobalt"],
  [/\bkhaki\b/i,           "khaki"],
  [/\bivory\b/i, "ivory"],
  [/\bcream\b/i, "cream"],
  [/\bmauve\b/i, "mauve"],
  [/\bmaroon\b/i, "maroon"],
  [/\brust\b/i, "rust"],
  [/\bcoral\b/i, "coral"],
  [/\bblush\b/i, "blush"],
  [/\bpeach\b/i, "peach"],
  [/\bmustard\b/i, "mustard"],
  [/\blavender\b/i, "lavender"],
  [/\bviolet\b/i, "violet"],
  [/\bmint\b/i, "mint"],
  [/\bteal\b/i, "teal"],
  [/\bnavy\b/i, "navy"],
  [/\bbeige\b/i, "beige"],
  [/\bnude\b/i, "nude"],
  [/\bpink\b/i, "pink"],
  [/\bred\b/i, "red"],
  [/\byellow\b/i, "yellow"],
  [/\borange\b/i, "orange"],
  [/\bgreen\b/i, "green"],
  [/\bblue\b/i, "blue"],
  [/\bpurple\b/i, "purple"],
  [/\bblack\b/i, "black"],
  [/\bgrey\b|\bgray\b/i, "grey"],
  [/\bgold\b/i, "gold"],
  [/\bsilver\b/i, "silver"],
  [/\bwhite\b/i, "white"],
];

const FABRICS: [RegExp, string][] = [
  [/\bgeorgette\b/i, "georgette"],
  [/\bchiffon\b/i, "chiffon"],
  [/\bchanderi\b/i, "chanderi"],
  [/\borganza\b/i, "organza"],
  [/\bbrocade\b/i, "brocade"],
  [/\bvelvet\b/i, "velvet"],
  [/\bsatin\b/i, "satin"],
  [/\bkhadi\b/i, "khadi"],
  [/\bcrepe\b/i, "crepe"],
  [/\blinen\b/i, "linen"],
  [/\btussar\b|\btusser\b|\btasar\b/i, "tussar silk"],
  [/\bdupion[i]?\b/i, "dupion silk"],
  [/\btissue\b/i, "tissue"],
  [/\bart[\s-]silk\b/i, "art silk"],
  [/\bkanjivaram\b|\bkanjeevaram\b|\bkanchipuram\b/i, "silk"],
  [/\bviscose\b/i, "viscose"],
  [/\bpashmina\b/i, "pashmina"],
  [/\bmul[\s-]?mul\b|\bmuslin\b/i, "cotton"],
  [/\bcotton\b/i, "cotton"],
  [/\bnet\b/i, "net"],
  [/\bsilk\b/i, "silk"],
];

const EMBELLISHMENTS: [RegExp, string][] = [
  // Mirror work — all regional/craft vocabulary
  [/\bmirror[\s-]?work\b/i, "mirror work"],
  [/\bshish[ae]?\b/i, "mirror work"],
  [/\babla\b/i, "mirror work"],
  [/\bsitara\b/i, "mirror work"],
  // Zardozi
  [/\bzardozi\b|\bzardosi\b/i, "zardozi"],
  [/\bzari[\s-]work\b/i, "zardozi"],
  [/\btilla\b/i, "zardozi"],
  // Gota patti
  [/\bgota[\s-]?patti\b|\bgota[\s-]?work\b|\bgotta[\s-]?patti\b|\bgota\b/i, "gota patti"],
  // Thread work
  [/\bthread[\s-]?work\b/i, "thread work"],
  [/\bphulkari\b|\bkantha\b|\bkasuti\b|\bnakshi\b/i, "thread work"],
  [/\bmukaish\b|\bbadla\b|\bkamdani\b/i, "thread work"],
  // Embroidery
  [/\bchikankari\b|\bchikan\b|\blucknowi\b/i, "embroidery"],
  [/\bcutwork\b|\bcut[\s-]work\b|\bappliq[uü]e?\b|\bschiffli\b|\bshadow[\s-]work\b/i, "embroidery"],
  [/\bhand[\s-]?work\b|\bpatchwork\b|\bsozni\b|\bkashida\b/i, "embroidery"],
  [/\bembroid\w+/i, "embroidery"],
  // Sequins (incl. common "sequence" misspelling)
  [/\bsequen[cs]es?\b|\bsequin/i, "sequins"],
  [/\bglitter\w*\b|\bshimmer\w*\b/i, "sequins"],
  // Printed / regional resist-dye and folk prints
  [/\bbandhani\b|\bbandhej\b|\bikat\b|\blaheriya\b|\blehriya\b/i, "printed"],
  [/\bmadhubani\b|\bwarli\b|\bpichwai\b|\btie[\s-]dye\b/i, "printed"],
  [/\bprinted\b|\bdigital[\s-]?print\b/i, "printed"],
  // Block print
  [/\bblock[\s-]?print/i, "block print"],
  [/\bajrakh\b|\bdabu\b|\bbagru\b|\bkalamkari\b|\bbatik\b/i, "block print"],
  // Stone work
  [/\bstone[\s-]?work\b|\bkundan\b|\bpolki\b|\bmeenakari\b/i, "stone work"],
  // Crystals / beads
  [/\bcrystal\b|\bswarovski\b|\brhinestone\b/i, "crystals"],
  [/\bbeaded?\b|\bmoti\b|\bpearl[\s-]?work\b|\bcutdana\b|\bcuttdana\b/i, "beads"],
  // Resham
  [/\bresham\b/i, "resham"],
  // Surface patterns
  [/\bfloral\b/i, "floral"],
  [/\bstriped?\b/i, "striped"],
];

// Occasion/mood words → aesthetic tags (values ⊂ gemini.ts VIBE_TAGS, which
// products carry in aesthetic_tags). Lets vibe scoring work even when the
// Gemini parse is unavailable.
const VIBE_PATTERNS: [RegExp, string][] = [
  [/\bsunset\b|\bgolden\s+hour\b|\bdusk\b/i, "sunset-warm"],
  [/\bcocktail\b|\bshimmer\w*\b|\bsparkl\w*\b/i, "cocktail-shimmer"],
  [/\bpastel\w*\b|\bdreamy\b|\bwhimsical\b|\bsoft\s+tones?\b/i, "pastel-dreamy"],
  [/\bbridal\b|\bbride\b/i, "heavy-bridal"],
  [/\bmodern\b|\bgen[\s-]?z\b|\bminimal\w*\b|\bcontemporary\b|\bchic\b/i, "minimal-modern"],
  [/\bboho\b|\bbohemian\b|\bearthy\b|\brustic\b|\bfolk\b/i, "boho-earthy"],
  [/\broyal\b|\bregal\b|\bmajestic\b/i, "regal-traditional"],
  [/\bindo[\s-]?western\b|\bfusion\b/i, "indo-western-fusion"],
  [/\bmetallic\b|\bdisco\b|\by2k\b|\bneon\b/i, "metallic-glam"],
  [/\bfloral\b|\bgarden\s+party\b|\bspring\b|\bromantic\b/i, "floral-romantic"],
  [/\bfestive\b|\bdiwali\b|\bhaldi\b|\bmeh[ae]ndi\b|\bnavratri\b/i, "festive-bright"],
  [/\bold\s+money\b|\bquiet\s+luxury\b|\bunderstated\b/i, "understated-luxury"],
  [/\bbeach\b|\bresort\b|\bcoastal\b|\btropical\b/i, "beach-resort"],
  [/\bmidnight\b|\bnight\b|\bevening\b/i, "midnight-noir"],
  [/\bjewel[\s-]tones?\b/i, "jewel-tone"],
  [/\bmonochrome\b/i, "monochrome-chic"],
];

// Setting/mood words → color palettes + fabrics, mirroring the AESTHETIC &
// SETTING VOCABULARY block in the Gemini SYSTEM_PROMPT (gemini.ts). Without
// this, palette intent ("sunset engagement" → warm colors) is lost whenever
// the Gemini parse is unavailable. These expansions are INFERRED, never
// explicit — detectExplicit() only reads the literal COLORS table, so the
// recall cascade can still drop them when results run short.
const SETTING_EXPANSIONS: [RegExp, { colors: string[]; fabrics: string[] }][] = [
  [/\bsunset\b|\bgolden\s+hour\b|\bdusk\b/i,
    { colors: ["terracotta", "rust", "coral", "amber", "saffron", "peach", "gold", "marigold"],
      fabrics: ["georgette", "chiffon", "organza"] }],
  [/\bgarden\s+party\b|\bspring\b|\bbrunch\b/i,
    { colors: ["blush", "mint", "lavender", "sage", "peach", "ivory"],
      fabrics: ["organza", "chiffon", "georgette"] }],
  [/\bbeach\b|\bcoastal\b|\bresort\b|\btropical\b/i,
    { colors: ["aqua", "turquoise", "sky blue", "coral", "white", "gold"],
      fabrics: ["chiffon", "georgette", "linen"] }],
  [/\bmidnight\b|\bnight\b|\bevening\b/i,
    { colors: ["black", "navy", "plum", "burgundy", "charcoal", "silver", "gold"],
      fabrics: ["velvet", "brocade", "satin"] }],
  [/\bold\s+money\b|\bquiet\s+luxury\b|\bunderstated\b|\bminimal\w*\b/i,
    { colors: ["ivory", "champagne", "camel", "taupe", "ecru", "off-white", "cream", "beige"],
      fabrics: ["silk", "crepe", "linen"] }],
  [/\bboho\b|\bbohemian\b|\bearthy\b|\brustic\b/i,
    { colors: ["ochre", "rust", "olive", "cream", "terracotta", "mustard"],
      fabrics: ["cotton", "linen", "khadi"] }],
  [/\bdisco\b|\by2k\b|\bneon\b|\brave\b/i,
    { colors: ["fuchsia", "cobalt", "gold", "silver", "magenta"],
      fabrics: ["georgette", "crepe"] }],
  [/\bpastel\w*\b|\bdreamy\b|\bwhimsical\b/i,
    { colors: ["blush", "lavender", "mint", "powder blue", "peach", "lilac", "dusty rose"],
      fabrics: ["organza", "chiffon"] }],
  [/\broyal\b|\bregal\b|\bmajestic\b/i,
    { colors: ["royal blue", "burgundy", "maroon", "plum", "gold", "ivory"],
      fabrics: ["velvet", "brocade", "silk"] }],
  [/\bhaldi\b/i,
    { colors: ["yellow", "marigold", "mustard", "saffron", "amber"], fabrics: [] }],
  [/\bmeh[ae]ndi\b/i,
    { colors: ["green", "olive green", "sage green", "mint", "marigold"], fabrics: [] }],
  [/\bwinter\b|\bchristmas\b/i,
    { colors: ["red", "maroon", "burgundy", "wine", "gold", "green"],
      fabrics: ["velvet", "silk", "brocade"] }],
];

// Mirrors Gemini prompt rule 12 — when a user names a base color, expand to
// close shades so the recall filter doesn't over-narrow on exact color strings.
const COLOR_FAMILIES: Record<string, string[]> = {
  pink:   ["blush", "rose gold", "dusty rose", "mauve", "peach", "coral", "fuchsia", "magenta"],
  red:    ["maroon", "rust", "burgundy", "wine", "coral", "terracotta"],
  blue:   ["navy", "cobalt", "royal blue", "sky blue", "powder blue", "indigo", "teal", "aqua"],
  green:  ["olive", "sage", "mint", "teal", "olive green", "sage green", "turquoise"],
  yellow: ["mustard", "saffron", "marigold", "amber", "ochre", "gold"],
  orange: ["rust", "terracotta", "coral", "amber", "saffron", "marigold"],
  purple: ["violet", "lavender", "lilac", "plum", "mauve", "indigo"],
  white:  ["off-white", "ivory", "cream", "ecru", "champagne"],
  gold:   ["champagne", "rose gold", "copper", "bronze", "amber"],
  nude:   ["beige", "ivory", "cream", "taupe", "camel", "fawn", "ecru"],
};

// ── Canonical text matchers ────────────────────────────────────────────
// Used by ranking: does this product TITLE mention the canonical value,
// under any of its regional/craft spellings? (e.g. "shisha" → mirror work,
// "sari" → saree, "chaniya choli" → lehenga)

function textMatches(text: string, table: [RegExp, string][], label: string): boolean {
  return table.some(([re, l]) => l === label && re.test(text));
}

export function textMatchesGarment(text: string, garment: string): boolean {
  return textMatches(text, GARMENT_TYPES, garment);
}
export function textMatchesColor(text: string, color: string): boolean {
  return textMatches(text, COLORS, color);
}
export function textMatchesFabric(text: string, fabric: string): boolean {
  return textMatches(text, FABRICS, fabric);
}
export function textMatchesEmbellishment(text: string, embellishment: string): boolean {
  return textMatches(text, EMBELLISHMENTS, embellishment);
}

/** Expand literal colors with their close shades (mirrors Gemini prompt rule 12). */
export function expandColors(colors: string[]): string[] {
  return [...new Set(colors.flatMap(c => [c, ...(COLOR_FAMILIES[c] ?? [])]))];
}

// ── Price parsing ──────────────────────────────────────────────────────

// "50,000" / "50000" / "50k" / "1.5 lakh" — returns INR amount or null
function parseAmount(num: string, unit: string | undefined): number | null {
  const n = parseFloat(num.replace(/,/g, ""));
  if (!isFinite(n) || n <= 0) return null;
  const u = (unit ?? "").toLowerCase();
  if (u === "k" || u === "thousand") return n * 1_000;
  if (u.startsWith("lakh") || u.startsWith("lac") || u === "l") return n * 100_000;
  return n;
}

const CURRENCY = String.raw`(?:₹|rs\.?|inr)\s*`;
const NUMBER   = String.raw`([\d][\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?)?\b`;

const MAX_PRICE_RE = new RegExp(
  String.raw`\b(?:under|below|less\s+than|upto|up\s+to|max(?:imum)?|budget(?:\s+of)?|within|not\s+more\s+than)\s*(?:${CURRENCY})?${NUMBER}`,
  "i"
);
const MIN_PRICE_RE = new RegExp(
  String.raw`\b(?:above|over|more\s+than|at\s+least|min(?:imum)?|starting\s+(?:at|from)|from)\s*(?:${CURRENCY})?${NUMBER}`,
  "i"
);
// "₹20,000+" → min price
const PLUS_PRICE_RE = new RegExp(String.raw`(?:${CURRENCY})?${NUMBER}\s*\+`, "i");
// "between 5k and 20k" / "5000-20000" / "₹5,000–₹20,000"
const RANGE_PRICE_RE = new RegExp(
  String.raw`(?:between\s+)?(?:${CURRENCY})?${NUMBER}\s*(?:-|–|—|to|and)\s*(?:${CURRENCY})?${NUMBER}`,
  "i"
);
// Bare "₹50,000" (explicit currency, no qualifier) — treat as a budget cap
const BARE_PRICE_RE = new RegExp(String.raw`${CURRENCY}${NUMBER}`, "i");

export interface ParsedPrice {
  max_price: number | null;
  min_price: number | null;
}

export function parsePrice(text: string): ParsedPrice {
  let max_price: number | null = null;
  let min_price: number | null = null;

  const maxM = text.match(MAX_PRICE_RE);
  if (maxM) max_price = parseAmount(maxM[1], maxM[2]);

  const minM = text.match(MIN_PRICE_RE);
  if (minM) min_price = parseAmount(minM[1], minM[2]);

  if (max_price == null && min_price == null) {
    const rangeM = text.match(RANGE_PRICE_RE);
    if (rangeM) {
      const lo = parseAmount(rangeM[1], rangeM[2]);
      const hi = parseAmount(rangeM[3], rangeM[4]);
      // Require both ends and a sane ordering — avoids matching "2 to 3 day event"
      if (lo != null && hi != null && hi > lo && hi >= 500) {
        min_price = lo;
        max_price = hi;
      }
    }
  }

  if (max_price == null && min_price == null) {
    const plusM = text.match(PLUS_PRICE_RE);
    if (plusM) min_price = parseAmount(plusM[1], plusM[2]);
  }

  if (max_price == null && min_price == null) {
    const bareM = text.match(BARE_PRICE_RE);
    if (bareM) {
      const amt = parseAmount(bareM[1], bareM[2]);
      // Ignore tiny numbers ("₹5 off") — a real budget is at least ₹500
      if (amt != null && amt >= 500) max_price = amt;
    }
  }

  return { max_price, min_price };
}

// ── Vocabulary extraction ──────────────────────────────────────────────

function matchAll(text: string, table: [RegExp, string][]): string[] {
  const found: string[] = [];
  for (const [pattern, label] of table) {
    if (pattern.test(text)) found.push(label);
  }
  return [...new Set(found)];
}

/**
 * Regex-only parse of the raw occasion text. Used as:
 * 1. the fallback when the Gemini parse fails, and
 * 2. a merge partner on success, so literal constraints can never be dropped.
 */
export function deterministicParse(occasion: string): ParsedQuery {
  const { max_price, min_price } = parsePrice(occasion);
  const garment_types = matchAll(occasion, GARMENT_TYPES);
  const embellishments = matchAll(occasion, EMBELLISHMENTS);
  let fabrics = matchAll(occasion, FABRICS);

  // Expand literal colors with close shades (recall filter would over-narrow otherwise)
  let colors = expandColors(matchAll(occasion, COLORS));

  // Setting/mood words expand to palettes + fabrics (inferred — droppable by
  // the recall cascade, unlike the literal colors above)
  for (const [pattern, expansion] of SETTING_EXPANSIONS) {
    if (pattern.test(occasion)) {
      colors = [...new Set([...colors, ...expansion.colors])];
      fabrics = [...new Set([...fabrics, ...expansion.fabrics])];
    }
  }

  // Only explicit person-words set a hint — garment words (lehenga, sherwani)
  // don't imply the shopper's gender; the profile gender handles that upstream.
  const saysMale   = /\b(men|men's|mens|man|male|groom)\b/i.test(occasion);
  const saysFemale = /\b(women|women's|womens|woman|female|bride)\b/i.test(occasion);
  const gender_hint: "male" | "female" | null =
    saysMale && !saysFemale ? "male" :
    saysFemale && !saysMale ? "female" : null;

  return {
    garment_types,
    colors,
    max_price,
    min_price,
    fabrics,
    embellishments,
    keywords: [],
    gender_hint,
    vibe_tags: matchAll(occasion, VIBE_PATTERNS).slice(0, 3),
  };
}

// ── Explicitness detection ─────────────────────────────────────────────

/**
 * Which constraints did the user LITERALLY type? Explicit constraints are
 * enforced strictly by the pipeline (never relaxed by the cascade), while
 * inferred ones (added by Gemini from occasion context) stay soft.
 * Derived from the raw occasion text on every request — never persisted in
 * ParsedQuery/sessionToken, so stale tokens can't misreport explicitness.
 */
export interface ExplicitFlags {
  garments: string[];
  embellishments: string[];
  colors: string[];
  price: boolean;
}

export function detectExplicit(occasion: string): ExplicitFlags {
  const { max_price, min_price } = parsePrice(occasion);
  return {
    garments: matchAll(occasion, GARMENT_TYPES),
    embellishments: matchAll(occasion, EMBELLISHMENTS),
    colors: matchAll(occasion, COLORS),
    price: max_price != null || min_price != null,
  };
}

// ── Merge ──────────────────────────────────────────────────────────────

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Merge the Gemini parse with the deterministic parse so literal constraints
 * always survive: arrays are unioned, and the tighter price bound wins.
 */
export function mergeParsed(gemini: ParsedQuery, det: ParsedQuery): ParsedQuery {
  return {
    garment_types: union(gemini.garment_types, det.garment_types),
    colors: union(gemini.colors, det.colors),
    max_price: gemini.max_price != null && det.max_price != null
      ? Math.min(gemini.max_price, det.max_price)
      : gemini.max_price ?? det.max_price,
    min_price: gemini.min_price != null && det.min_price != null
      ? Math.max(gemini.min_price, det.min_price)
      : gemini.min_price ?? det.min_price,
    fabrics: union(gemini.fabrics, det.fabrics),
    embellishments: union(gemini.embellishments, det.embellishments),
    keywords: gemini.keywords,
    gender_hint: gemini.gender_hint ?? det.gender_hint,
    vibe_tags: union(gemini.vibe_tags ?? [], det.vibe_tags ?? []).slice(0, 4),
  };
}
