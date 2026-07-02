// LLM re-rank — the "stylist pass". Scores the retrieved candidates against
// the raw occasion text so soft vibe (palette, modern styling, occasion fit)
// shapes the final order in ways structured metadata can't. Strictly
// fail-open: any timeout/quota/parse problem returns null and the caller
// keeps the heuristic order.
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Product } from "./search-core";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const RERANK_SYSTEM = `You are a personal stylist for a young, fashion-forward Indian shopper. You will receive a shopping request and a numbered list of garments (title, brand, price, garment type, color, fabric, embellishments). Score EVERY item 0-100 for how well it satisfies the request.

Rubric:
- Wrong garment type for the request → 0-10.
- Missing a craft/embellishment the request explicitly names (e.g. request says "mirror work", item has none) → at most 20.
- Right garment + right craft but colors clash with the requested mood/setting → 40-60.
- Right garment + right craft + palette and styling that match the mood (e.g. sunset → warm terracotta/coral/gold; cocktail → sleek, shimmering; modern/Gen-Z → clean contemporary cuts) → 70-100.
- Judge only from the data given. Do NOT reward famous brands or high prices — a well-matched affordable piece beats an off-brief designer piece.

Return ONLY JSON, no explanation: {"scores":[{"i":0,"s":85},{"i":1,"s":40},...]} covering every index exactly once.`;

// gemini-2.5-flash-lite: non-thinking → fast (~1-2s for 60 items); plain
// 2.5-flash thinks by default and the 0.24 SDK can't disable it.
const RERANK_MODEL = "gemini-2.5-flash-lite";

function candidateLine(p: Product, i: number): string {
  const price = p.price != null ? `₹${p.price.toLocaleString("en-IN")}` : "?";
  const emb = (p.embellishments ?? []).join(", ") || "none";
  return `${i} | ${p.title} | ${p.source.replace(/_/g, " ")} | ${price} | ${p.garment_type ?? "?"} | ${p.color ?? "?"} | ${p.fabric ?? "?"} | ${emb}`;
}

/**
 * Returns productId → 0-100 score, or null when the re-rank should be
 * skipped (error, timeout, or insufficient coverage). Never throws.
 */
export async function rerankCandidates(
  occasion: string,
  candidates: Product[],
  timeoutMs = 6000
): Promise<Map<string, number> | null> {
  if (candidates.length === 0) return null;
  const started = Date.now();
  try {
    const model = genAI.getGenerativeModel({
      model: RERANK_MODEL,
      systemInstruction: RERANK_SYSTEM,
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    });

    const prompt = `Request: "${occasion}"

Items:
${candidates.map(candidateLine).join("\n")}`;

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(result.response.text()) as any;
    const scores = new Map<string, number>();
    for (const entry of parsed.scores ?? []) {
      const i = Number(entry.i);
      const s = Number(entry.s);
      if (Number.isInteger(i) && i >= 0 && i < candidates.length && isFinite(s)) {
        scores.set(candidates[i].id, Math.max(0, Math.min(100, s)));
      }
    }

    // Partial coverage means the model lost the plot — don't trust it
    if (scores.size < candidates.length * 0.8) {
      console.warn(`[rerank] insufficient coverage ${scores.size}/${candidates.length} — skipping`);
      return null;
    }
    console.log(`[rerank] ok: ${scores.size} scores in ${Date.now() - started}ms`);
    return scores;
  } catch (e) {
    console.warn(`[rerank] failed after ${Date.now() - started}ms:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}
