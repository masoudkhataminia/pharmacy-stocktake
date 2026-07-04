import { NextRequest, NextResponse } from "next/server";
import { updateDb } from "../../../lib/server-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const state = await updateDb({
      scripts: Array.isArray(body?.scripts) ? body.scripts : undefined,
      scans: Array.isArray(body?.scans) ? body.scans : undefined,
      originals: Array.isArray(body?.originals) ? body.originals : undefined,
      batches: Array.isArray(body?.batches) ? body.batches : undefined,
    });
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not save server database" }, { status: 500 });
  }
}
