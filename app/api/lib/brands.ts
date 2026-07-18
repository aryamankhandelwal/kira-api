// Designer / retailer brand registry.
//
// Maps the brand names users actually type ("manish malhotra", "masaba",
// "pernia's") onto catalog source keys, so a named designer becomes a HARD
// filter: only that designer's own listings, plus multi-designer curators
// whose product title credits the designer, are allowed through.
//
// SYNC: keys must match the `source` values written by shauk-scraper
// (see registry.ts there and SOURCE_TIER in search-core.ts).

export interface BrandEntry {
  /** Catalog source key (or a pseudo-key for designers we don't scrape directly). */
  key: string;
  /** Matches the brand in free text (queries and product titles). */
  re: RegExp;
  /** ILIKE patterns for the DB-side title match on curator sources. */
  like: string[];
}

export const BRANDS: BrandEntry[] = [
  // ── Couture / luxury designers ─────────────────────────────────────
  { key: "manish_malhotra",       re: /\bmanish\s+malhotra\b/i,                          like: ["%manish malhotra%"] },
  { key: "falguni_shane_peacock", re: /\bfalguni\b|\bshane\s+peacock\b/i,                like: ["%falguni%", "%shane peacock%"] },
  { key: "tarun_tahiliani",       re: /\btarun\s+tahiliani\b|\btahiliani\b/i,            like: ["%tahiliani%"] },
  { key: "gaurav_gupta",          re: /\bgaurav\s+gupta\b/i,                             like: ["%gaurav gupta%"] },
  { key: "anamika_khanna",        re: /\banamika\s+khanna\b/i,                           like: ["%anamika khanna%"] },
  { key: "rohit_bal",             re: /\brohit\s+bal\b/i,                                like: ["%rohit bal%"] },
  { key: "punit_balana",          re: /\bpunit\s+balana\b/i,                             like: ["%punit balana%"] },
  { key: "jayanti_reddy",         re: /\bjayanti\s+reddy\b/i,                            like: ["%jayanti reddy%"] },
  // ── Contemporary / bridge designers ────────────────────────────────
  { key: "anita_dongre",          re: /\banita\s+dongre\b|\bdongre\b/i,                  like: ["%anita dongre%"] },
  { key: "raw_mango",             re: /\braw\s+mango\b/i,                                like: ["%raw mango%"] },
  { key: "torani",                re: /\btorani\b/i,                                     like: ["%torani%"] },
  { key: "house_of_masaba",       re: /\bmasaba\b/i,                                     like: ["%masaba%"] },
  { key: "payal_singhal",         re: /\bpayal\s+singhal\b/i,                            like: ["%payal singhal%"] },
  { key: "ridhi_mehra",           re: /\bridhi\s+mehra\b/i,                              like: ["%ridhi mehra%"] },
  { key: "aisha_rao",             re: /\baisha\s+rao\b/i,                                like: ["%aisha rao%"] },
  { key: "mishru",                re: /\bmishru\b/i,                                     like: ["%mishru%"] },
  { key: "sheetal_batra",         re: /\bsheetal\s+batra\b/i,                            like: ["%sheetal batra%"] },
  { key: "suruchi_parakh",        re: /\bsuruchi\s+parakh\b/i,                           like: ["%suruchi parakh%"] },
  { key: "studio_bagechaa",       re: /\bbagechaa?\b/i,                                  like: ["%bagecha%"] },
  { key: "devnaagri",             re: /\bdevn?aagri\b|\bdevnagri\b/i,                    like: ["%devnaagri%", "%devnagri%"] },
  { key: "old_marigold",          re: /\bold\s+marigold\b/i,                             like: ["%old marigold%"] },
  { key: "ritu_kumar",            re: /\britu\s+kumar\b/i,                               like: ["%ritu kumar%"] },
  { key: "saaksha_kinni",         re: /\bsaaksha\b/i,                                    like: ["%saaksha%"] },
  { key: "taali",                 re: /\btaali\b/i,                                      like: ["%taali%"] },
  { key: "basanti_ke_kapde",      re: /\bbasanti\b/i,                                    like: ["%basanti%"] },
  { key: "varunbahl",             re: /\bvarun\s+bahl\b/i,                               like: ["%varun bahl%"] },
  { key: "rimple_harpreet",       re: /\brimple\b/i,                                     like: ["%rimple%"] },
  // ── Multi-designer curators (searchable as destinations themselves) ─
  { key: "perniaspopupshop",      re: /\bpernia'?s?\b/i,                                 like: ["%pernia%"] },
  { key: "azafashions",           re: /\baza(\s+fashions?)?\b/i,                         like: ["%aza %"] },
  { key: "ogaan",                 re: /\bogaan\b/i,                                      like: ["%ogaan%"] },
  { key: "aashni",                re: /\baashni\b/i,                                     like: ["%aashni%"] },
  { key: "kalkifashion",          re: /\bkalki\b/i,                                      like: ["%kalki%"] },
  { key: "benzer",                re: /\bbenzer\b/i,                                     like: ["%benzer%"] },
  // NOTE: no plain-word entry for "ensemble" — it's a common noun in outfit
  // queries ("an elegant ensemble"); only the qualified store name matches.
  { key: "ensemble",              re: /\bensemble\s+(india|store|mumbai)\b/i,            like: ["%ensemble%"] },
  // ── Retailers / affordable labels ──────────────────────────────────
  { key: "manyavar",              re: /\bmanyavar\b/i,                                   like: ["%manyavar%"] },
  { key: "tasva",                 re: /\btasva\b/i,                                      like: ["%tasva%"] },
  { key: "jade_blue",             re: /\bjade\s+blue\b/i,                                like: ["%jade blue%"] },
  { key: "meena_bazaar",          re: /\bmeena\s+bazaa?r\b/i,                            like: ["%meena bazaar%"] },
  { key: "nalli",                 re: /\bnalli\b/i,                                      like: ["%nalli%"] },
  { key: "kankatala",             re: /\bkankatala\b/i,                                  like: ["%kankatala%"] },
  { key: "pothys",                re: /\bpothys\b/i,                                     like: ["%pothys%"] },
  { key: "sundarisilks",          re: /\bsundari\s*silks?\b/i,                           like: ["%sundari silk%"] },
  { key: "weaverstory",           re: /\bweaver'?s?\s*story\b/i,                         like: ["%weaverstory%", "%weaver story%"] },
  { key: "suta",                  re: /\bsuta\b/i,                                       like: ["%suta%"] },
  { key: "fashor",                re: /\bfashor\b/i,                                     like: ["%fashor%"] },
  { key: "libas",                 re: /\blibas\b/i,                                      like: ["%libas%"] },
  { key: "soch",                  re: /\bsoch\b/i,                                       like: ["%soch%"] },
  { key: "w_for_woman",           re: /\bw\s+for\s+woman\b/i,                            like: ["%w for woman%"] },
  { key: "the_loom",              re: /\bthe\s+loom\b/i,                                 like: ["%the loom%"] },
  { key: "tjori",                 re: /\btjori\b/i,                                      like: ["%tjori%"] },
  { key: "bunaai",                re: /\bbunaai\b/i,                                     like: ["%bunaai%"] },
  { key: "indethnic",             re: /\bindethnic\b/i,                                  like: ["%indethnic%"] },
  { key: "vastramay",             re: /\bvastramay\b/i,                                  like: ["%vastramay%"] },
  { key: "vasansi",               re: /\bvasansi\b/i,                                    like: ["%vasansi%"] },
  { key: "jaipurkurti",           re: /\bjaipur\s*kurti\b/i,                             like: ["%jaipur kurti%"] },
  { key: "sojanya",               re: /\bsojanya\b/i,                                    like: ["%sojanya%"] },
  { key: "shreeman",              re: /\bshreeman\b/i,                                   like: ["%shreeman%"] },
  { key: "clothsvilla",           re: /\bcloths?villa\b/i,                               like: ["%clothsvilla%"] },
  { key: "karaj_jaipur",          re: /\bkaraj\b/i,                                      like: ["%karaj%"] },
  { key: "gyans",                 re: /\bgyans\b/i,                                      like: ["%gyans%"] },
  { key: "pratap_sons",           re: /\bpratap\s+sons\b/i,                              like: ["%pratap sons%"] },
  { key: "ahi_clothing",          re: /\bahi\s+clothing\b/i,                             like: ["%ahi clothing%"] },
  { key: "ridhiiee_suuri",        re: /\bridhii?e+\s+su+ri\b/i,                          like: ["%ridhiiee%"] },
  // ── Marketplaces ───────────────────────────────────────────────────
  { key: "nykaa",                 re: /\bnykaa\b/i,                                      like: ["%nykaa%"] },
  { key: "myntra",                re: /\bmyntra\b/i,                                     like: ["%myntra%"] },
  { key: "ajio",                  re: /\bajio\b/i,                                       like: ["%ajio%"] },
  { key: "tatacliq",              re: /\btata\s*cliq\b/i,                                like: ["%tatacliq%"] },
  { key: "fabindia",              re: /\bfab\s*india\b/i,                                like: ["%fabindia%", "%fab india%"] },
  // ── Famous designers we don't scrape directly (curator titles only) ─
  { key: "sabyasachi",            re: /\bsabya(sachi)?\b/i,                              like: ["%sabyasachi%"] },
  { key: "abu_jani",              re: /\babu\s+jani\b|\bsandeep\s+khosla\b/i,            like: ["%abu jani%", "%sandeep khosla%"] },
  { key: "manish_arora",          re: /\bmanish\s+arora\b/i,                             like: ["%manish arora%"] },
];

const BY_KEY = new Map(BRANDS.map(b => [b.key, b]));
export const VALID_BRAND_KEYS = new Set(BRANDS.map(b => b.key));

/**
 * Sources that stock many designers — a title crediting the requested
 * designer on one of these counts as that designer's listing.
 * A title mention anywhere else ("Manish Malhotra inspired") does NOT.
 */
export const MULTI_BRAND_SOURCES = new Set([
  "perniaspopupshop", "azafashions", "ogaan", "ensemble", "aashni",
  "kalkifashion", "benzer", "nykaa", "ajio", "myntra", "tatacliq", "fabindia",
]);

/** Brand keys mentioned in free text (longest-name entries win automatically — keys dedupe). */
export function detectBrands(text: string): string[] {
  return BRANDS.filter(b => b.re.test(text)).map(b => b.key);
}

/**
 * Remove brand mentions from a query before vocabulary parsing, so brand
 * names never leak into other filters ("Jade Blue" → color blue,
 * "Old Marigold" → color marigold, "Raw Mango kurta" → keyword mango).
 */
export function stripBrands(text: string): string {
  let out = text;
  for (const b of BRANDS) {
    out = out.replace(new RegExp(b.re.source, b.re.flags.includes("g") ? b.re.flags : b.re.flags + "g"), " ");
  }
  return out;
}

/** Does this product title credit the brand (under any alias)? */
export function brandMatchesTitle(title: string, key: string): boolean {
  const b = BY_KEY.get(key);
  return b ? b.re.test(title) : false;
}

/** ILIKE patterns for the DB-side or-clause across the requested brands. */
export function brandLikePatterns(keys: string[]): string[] {
  return [...new Set(keys.flatMap(k => BY_KEY.get(k)?.like ?? []))];
}
