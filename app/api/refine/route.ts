import { NextRequest, NextResponse } from "next/server";
import { detectExplicit, deterministicParse, mergeParsed } from "../lib/deterministic-parse";
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
  // Merge with the regex parse of the refinement text so constraints the
  // user literally typed survive even if the Gemini refine call fails.
  const parsed = mergeParsed(
    await refineSearchQuery(existingQuery, refinement, currentItem, userGender),
    deterministicParse(refinement)
  );
  const effectiveUserGender = userGender ?? parsed.gender_hint ?? undefined;
  const userSize = ((body.top_size || body.bottom_size || "") as string).toUpperCase() || undefined;

  try {
    // Use the refinement text as a pseudo-occasion for style register boosting.
    // Explicitness spans the original occasion (when the client sends it) plus
    // the refinement — "mirror work lehenga" must stay strict through
    // "show me cheaper options".
    const originalOccasion: string | undefined = body.occasion;
    const { cards, total } = await runSearchPipeline({
      parsed,
      occasion: refinement,
      explicit: detectExplicit([originalOccasion, refinement].filter(Boolean).join(". ")),
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
