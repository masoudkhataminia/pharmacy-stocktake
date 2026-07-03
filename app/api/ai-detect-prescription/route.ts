import { NextRequest, NextResponse } from "next/server";

type ExtractedPrescription = {
  scriptNumber?: string;
  patient?: string;
  date?: string;
  medicine?: string;
  medicare?: string;
  confidence?: number;
  notes?: string;
};

const SYSTEM_PROMPT = `You are extracting information from an Australian pharmacy prescription image.
Return only compact JSON with these optional fields:
scriptNumber, patient, date, medicine, medicare, confidence, notes.
If text is unclear, leave the field blank and lower confidence.
Never invent values. Use dd/mm/yyyy for dates when possible.`;

function sanitize(value: unknown) {
  return String(value ?? "").slice(0, 500).trim();
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { image?: string } | null;
  const image = body?.image;
  if (!image || !image.startsWith("data:image/")) {
    return NextResponse.json({ ok: false, error: "No prescription image received" }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY is not configured" }, { status: 500 });
  }

  try {
    const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-5.1";
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract prescription details from this image. Return JSON only." },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      return NextResponse.json({ ok: false, error: await response.text(), model }, { status: 502 });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(text) as ExtractedPrescription;
    return NextResponse.json({
      ok: true,
      model,
      result: {
        scriptNumber: sanitize(parsed.scriptNumber),
        patient: sanitize(parsed.patient),
        date: sanitize(parsed.date),
        medicine: sanitize(parsed.medicine),
        medicare: sanitize(parsed.medicare),
        confidence: Number(parsed.confidence || 0),
        notes: sanitize(parsed.notes),
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "AI prescription detection failed" }, { status: 500 });
  }
}
