import { NextRequest, NextResponse } from "next/server";
import { clearDb } from "../../../lib/server-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_KEYS = ["scripts", "scans", "originals", "batches"] as const;
type DbKey = typeof VALID_KEYS[number];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const requested = Array.isArray(body?.keys) ? body.keys : VALID_KEYS;
    const keys = requested.filter((key: unknown): key is DbKey => VALID_KEYS.includes(key as DbKey));
    const state = await clearDb(keys.length ? keys : [...VALID_KEYS]);
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not clear server database" }, { status: 500 });
  }
}
