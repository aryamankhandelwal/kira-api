import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_req: NextRequest) {
  return NextResponse.json({ ok: false, error: "Not implemented" }, { status: 501 });
}
