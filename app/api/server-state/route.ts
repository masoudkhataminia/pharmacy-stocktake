import { NextResponse } from "next/server";
import { readDb } from "../../../lib/server-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await readDb();
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not read server database" }, { status: 500 });
  }
}
