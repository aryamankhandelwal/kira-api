// Search relevance regression harness.
//
//   npx tsx scripts/eval-search.ts             — against http://localhost:3000
//   BASE_URL=https://… npx tsx scripts/eval-search.ts
//
// POSTs a fixed query set to /api/search, prints the top results per query,
// and runs assertions on ordering/filter behavior. Exits 1 if any assertion
// fails. Run before every deploy.

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

interface Card {
  id: string;
  brand: string;
  name: string;
  price_numeric: number | null;
  garment_type: string | null;
  color: string | null;
  fabric: string | null;
  embellishments: string[];
  tags: string[];
  fill?: boolean;
}

interface QueryCase {
  label: string;
  occasion: string;
  gender?: string;
  assertions: (cards: Card[], exact: Card[]) => string[];
}

const WARM = new Set(["terracotta", "rust", "coral", "amber", "saffron", "peach", "gold", "marigold", "orange", "yellow", "mustard", "ochre", "copper", "bronze", "pink", "blush", "rose gold", "dusty rose"]);
const NEUTRAL = new Set(["ivory", "champagne", "camel", "taupe", "ecru", "off-white", "cream", "beige", "white", "nude", "fawn", "gold"]);

// Zero tolerance: the catalog is clothing-only — any of these words in a
// result name means the ingest gate has regressed.
const NON_CLOTHING_RE = /\bnecklace|\bearring|\bjhumk|\bbangle|\bkada\b|\bbracelet|\banklet|\bmaang\s?tikka|\bchoker|\bpendant|\bjewell?ery|\bjutti|\bmojari|\bfootwear|\bshoe\b|\bheels\b|\bclutch\b|\bpotli\b|\bhandbag|\bcushion|\bbedsheet|\bdohar\b|\bcandle\b|\bunstitched|\bdress\s?material|\bblouse\s?piece|\bpetticoat/i;

function nonClothingFails(cards: Card[]): string[] {
  const bad = cards.filter(c => NON_CLOTHING_RE.test(c.name));
  return bad.length ? [`${bad.length} NON-CLOTHING result(s) in feed (e.g. ${bad[0].name})`] : [];
}

const mentionsMirror = (c: Card) =>
  c.embellishments.includes("mirror work") ||
  /\bmirror[\s-]?work\b|\bshish[ae]?\b|\babla\b|\bsitara\b|mirrorwork/i.test(c.name);

const isGarment = (c: Card, g: string, titleRe: RegExp) =>
  c.garment_type === g || titleRe.test(c.name);

// Only the head of the feed can be kept diverse — when one source dominates
// the pool, its surplus necessarily runs together at the tail.
function maxSourceRun(allCards: Card[], head = 30): number {
  const cards = allCards.slice(0, head);
  let max = 0, run = 0, prev = "";
  for (const c of cards) {
    const s = c.tags[0] ?? c.brand;
    run = s === prev ? run + 1 : 1;
    prev = s;
    max = Math.max(max, run);
  }
  return max;
}

const CASES: QueryCase[] = [
  {
    label: "THE query (mirror work / sunset / budget)",
    occasion: "Mirror work lehenga for sunset engagement party under INR 50,000",
    gender: "female",
    assertions: (cards, exact) => {
      const fails: string[] = [];
      const over = cards.filter(c => c.price_numeric != null && c.price_numeric > 50000);
      if (over.length) fails.push(`${over.length} results over ₹50,000 (e.g. ${over[0].name} ₹${over[0].price_numeric})`);
      const nonLehenga = cards.filter(c => !isGarment(c, "lehenga", /\blehenga\b|\bchaniya\b/i));
      if (nonLehenga.length) fails.push(`${nonLehenga.length} non-lehengas (e.g. ${nonLehenga[0].name})`);
      const top10 = exact.slice(0, 10);
      const nonMirror = top10.filter(c => !mentionsMirror(c));
      if (nonMirror.length) fails.push(`${nonMirror.length}/10 top exact results are not mirror work (e.g. ${nonMirror[0]?.name})`);
      const withColor = top10.filter(c => c.color != null);
      const warm = withColor.filter(c => WARM.has(c.color!));
      if (withColor.length >= 4 && warm.length < withColor.length / 2)
        fails.push(`only ${warm.length}/${withColor.length} color-known top-10 results are warm-palette`);
      // ≤3: curator-heavy catalog means Aza/Pernia dominate craft pools — the
      // diversifier caps runs at 2 but surplus from a dominant source
      // necessarily clusters near the tail of the head window.
      if (maxSourceRun(exact) > 3) fails.push(`source run of ${maxSourceRun(exact)} in exact results`);
      return fails;
    },
  },
  {
    label: "chikankari kurta / office / low budget",
    occasion: "chikankari kurta for office under 3k",
    gender: "female",
    assertions: (cards) => {
      const fails: string[] = [];
      const over = cards.filter(c => c.price_numeric != null && c.price_numeric > 3000);
      if (over.length) fails.push(`${over.length} results over ₹3,000`);
      const nonKurta = cards.filter(c => !isGarment(c, "kurta", /\bkurta\b|\bkurti\b|\btunic\b/i) && c.garment_type !== "kurti");
      if (nonKurta.length > cards.length / 4) fails.push(`${nonKurta.length}/${cards.length} results are not kurtas`);
      return fails;
    },
  },
  {
    label: "black sequin gown / palette conflict demotion",
    occasion: "black sequin gown for cocktail night",
    gender: "female",
    assertions: (_cards, exact) => {
      const fails: string[] = [];
      const top10 = exact.slice(0, 10).filter(c => c.color != null);
      const offPalette = top10.filter(c => !["black", "navy", "plum", "burgundy", "charcoal", "silver", "gold", "grey"].includes(c.color!));
      if (top10.length >= 4 && offPalette.length > top10.length / 2)
        fails.push(`${offPalette.length}/${top10.length} color-known top results are off-palette (expected dark/metallic)`);
      return fails;
    },
  },
  {
    label: "kundan saree / craft alias + garment strictness",
    occasion: "kundan work saree for reception",
    gender: "female",
    assertions: (cards) => {
      const fails: string[] = [];
      const nonSaree = cards.filter(c => !c.fill && !isGarment(c, "saree", /\bsaree\b|\bsari\b/i));
      if (nonSaree.length) fails.push(`${nonSaree.length} exact results are not sarees (e.g. ${nonSaree[0]?.name})`);
      return fails;
    },
  },
  {
    label: "bridal lehenga / designers may lead via tiebreak",
    occasion: "bridal lehenga",
    gender: "female",
    assertions: (cards) => {
      const fails: string[] = [];
      const nonLehenga = cards.filter(c => !isGarment(c, "lehenga", /\blehenga\b|\bchaniya\b/i));
      if (nonLehenga.length) fails.push(`${nonLehenga.length} non-lehengas`);
      if (maxSourceRun(cards) > 2) fails.push(`source run of ${maxSourceRun(cards)}`);
      return fails;
    },
  },
  {
    label: "vague query / cascade behavior",
    occasion: "wedding guest outfit",
    gender: "female",
    assertions: (cards) => (cards.length < 10 ? [`only ${cards.length} results for a broad query`] : []),
  },
  {
    label: "haldi / budget",
    occasion: "haldi outfit under 5000",
    gender: "female",
    assertions: (cards) => {
      const over = cards.filter(c => c.price_numeric != null && c.price_numeric > 5000);
      return over.length ? [`${over.length} results over ₹5,000`] : [];
    },
  },
  {
    label: "sunset cocktail / vibe→palette without explicit color",
    occasion: "sunset cocktail outfit",
    gender: "female",
    assertions: (_cards, exact) => {
      const fails: string[] = [];
      const withColor = exact.slice(0, 10).filter(c => c.color != null);
      const onPalette = withColor.filter(c => WARM.has(c.color!) || ["silver", "champagne"].includes(c.color!));
      if (withColor.length >= 4 && onPalette.length < withColor.length / 2)
        fails.push(`only ${onPalette.length}/${withColor.length} color-known top-10 are warm/metallic for a sunset query`);
      return fails;
    },
  },
  {
    label: "old money sangeet / understated palette",
    occasion: "old money sangeet look",
    gender: "female",
    assertions: (_cards, exact) => {
      const fails: string[] = [];
      const withColor = exact.slice(0, 10).filter(c => c.color != null);
      const onPalette = withColor.filter(c => NEUTRAL.has(c.color!));
      if (withColor.length >= 4 && onPalette.length < withColor.length / 2)
        fails.push(`only ${onPalette.length}/${withColor.length} color-known top-10 are neutral/understated`);
      return fails;
    },
  },
];

async function run() {
  let failures = 0;
  for (const q of CASES) {
    const started = Date.now();
    const res = await fetch(`${BASE_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ occasion: q.occasion, gender: q.gender }),
    });
    const json = await res.json();
    const ms = Date.now() - started;

    console.log(`\n━━━ ${q.label}`);
    console.log(`    "${q.occasion}"  →  ${json.total ?? 0} results in ${ms}ms`);
    if (!json.ok) {
      console.log(`    ✗ API error: ${json.error}`);
      failures++;
      continue;
    }
    const cards: Card[] = json.cards ?? [];
    const exact = cards.filter(c => !c.fill);
    const parsed = json._parsed;
    console.log(`    parsed: garments=[${parsed.garment_types}] emb=[${parsed.embellishments}] colors=${parsed.colors.length} max=₹${parsed.max_price ?? "—"} | exact=${exact.length} fill=${cards.length - exact.length}`);

    for (const [i, c] of cards.slice(0, 15).entries()) {
      const price = c.price_numeric != null ? `₹${c.price_numeric.toLocaleString("en-IN")}` : "     ?";
      console.log(`    ${String(i + 1).padStart(2)}. ${price.padStart(10)}  ${(c.tags[0] ?? "").padEnd(18)} ${(c.garment_type ?? "?").padEnd(9)} ${(c.color ?? "?").padEnd(10)} [${c.embellishments.join(",")}]${c.fill ? " FILL" : ""}  ${c.name.slice(0, 60)}`);
    }

    const fails = [...nonClothingFails(cards), ...q.assertions(cards, exact)];
    if (fails.length) {
      failures += fails.length;
      for (const f of fails) console.log(`    ✗ ${f}`);
    } else {
      console.log("    ✓ all assertions passed");
    }
  }
  console.log(`\n${failures === 0 ? "✓ ALL PASSED" : `✗ ${failures} assertion failure(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
