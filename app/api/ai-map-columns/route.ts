import { NextRequest, NextResponse } from "next/server";

type ColumnMap = {
  scriptNumber?: string;
  dispenseDate?: string;
  patientFirstName?: string;
  patientLastName?: string;
  patientFullName?: string;
  medicine?: string;
  quantity?: string;
};

const SYSTEM_PROMPT = `You map pharmacy FRED report spreadsheet headers to canonical fields.
Return only compact JSON. Do not include markdown.
Canonical fields:
scriptNumber, dispenseDate, patientFirstName, patientLastName, patientFullName, medicine, quantity.
Use exact header strings from the provided headers. If uncertain, omit the field.
Never invent header names.`;

function safeFallback(headers: string[]): ColumnMap {
  const find = (needles: string[]) => headers.find((header) => {
    const clean = header.toLowerCase();
    return needles.some((needle) => clean.includes(needle));
  });

  return {
    scriptNumber: find(["script number", "script no", "rx no", "prescription no"]),
    dispenseDate: find(["dispense date", "dispensed date", "date dispensed"]),
    patientFirstName: find(["patient first name", "first name", "given name"]),
    patientLastName: find(["patient last name", "last name", "surname"]),
    patientFullName: find(["patient name", "patient", "customer", "client"]),
    medicine: find(["drug description", "drug", "medicine", "medication", "generic name", "brand"]),
    quantity: find(["quantity", "qty", "qty supplied"]),
  };
}

function cleanMap(map: ColumnMap, headers: string[]): ColumnMap {
  const allowed = new Set(headers);
  const output: ColumnMap = {};
  for (const [key, value] of Object.entries(map) as [keyof ColumnMap, string | undefined][]) {
    if (value && allowed.has(value)) output[key] = value;
  }
  return output;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { headers?: string[]; sampleRows?: Record<string, string>[] } | null;
  const headers = Array.isArray(body?.headers) ? body.headers.filter(Boolean).slice(0, 80) : [];
  const sampleRows = Array.isArray(body?.sampleRows) ? body.sampleRows.slice(0, 3) : [];

  if (headers.length === 0) {
    return NextResponse.json({ ok: false, error: "No headers provided", map: {} }, { status: 400 });
  }

  const fallback = safeFallback(headers);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: true, source: "fallback", model: "none", map: fallback });
  }

  try {
    const model = process.env.OPENAI_COLUMN_MODEL || process.env.OPENAI_MODEL || "gpt-5.1";
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ headers, sampleRows }) },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      return NextResponse.json({ ok: true, source: "fallback", model, map: fallback, aiError: await response.text() });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(text) as ColumnMap;
    const aiMap = cleanMap(parsed, headers);

    return NextResponse.json({
      ok: true,
      source: "ai",
      model,
      map: { ...fallback, ...aiMap },
    });
  } catch (error) {
    return NextResponse.json({ ok: true, source: "fallback", map: fallback, aiError: error instanceof Error ? error.message : "Unknown error" });
  }
}
