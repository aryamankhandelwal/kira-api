import { NextRequest, NextResponse } from "next/server";
import { ParsedQuery, RefineItem, refineSearchQuery } from "../lib/gemini";
import { runSearchPipeline } from "../lib/search-core";

// Gemini refine + Supabase queries can exceed Vercel's default 10s function limit.
export const maxDuration = 25;

// ── POST /api/refine ────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json();
  const existingQuery: ParsedQuery | undefined = body.existingQuery;
  const refinement: string | undefined = body.refinement;
  const currentItem: RefineItem | undefined = body.currentItem;
  const userGender: string | undefined = body.gender;
  const userId: string | undefined = body.userId;

  if (!existingQuery || !refinement || !currentItem) {
    return NextResponse.json(
      { ok: false, error: "existingQuery, refinement, and currentItem are required" },
      { status: 400 }
    );
  }

  // ── Refine the ParsedQuery via Gemini ─────────────────────────────
  const parsed = await refineSearchQuery(existingQuery, refinement, currentItem, userGender);
  const effectiveUserGender = userGender ?? parsed.gender_hint ?? undefined;
  const userSize = ((body.top_size || body.bottom_size || "") as string).toUpperCase() || undefined;

  try {
    // Use the refinement text as a pseudo-occasion for style register boosting
    const { cards, total } = await runSearchPipeline({
      parsed,
      occasion: refinement,
      effectiveUserGender,
      userId,
      userSize,
    });
    return NextResponse.json({ ok: true, cards, total, _parsed: parsed });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
