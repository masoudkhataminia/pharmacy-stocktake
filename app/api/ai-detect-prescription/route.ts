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
Return only valid compact JSON with these optional fields:
scriptNumber, patient, date, medicine, medicare, confidence, notes.
If text is unclear, leave the field blank and lower confidence.
Never invent values. Use dd/mm/yyyy for dates when possible.`;

function sanitize(value: unknown) {
  return String(value ?? "").slice(0, 500).trim();
}

function extractJson(text: string): ExtractedPrescription {
  const clean = text.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  const json = start >= 0 && end >= start ? clean.slice(start, end + 1) : clean;
  return JSON.parse(json || "{}");
}

function resultJson(parsed: ExtractedPrescription, model: string) {
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
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { image?: string } | null;
  const image = body?.image;
  if (!image || !image.startsWith("data:image/")) {
    return NextResponse.json({ ok: false, error: "No prescription image received" }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY is not configured in Vercel Environment Variables" }, { status: 500 });
  }

  const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-5.1";

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: `${SYSTEM_PROMPT}\n\nExtract prescription details from this image. Return JSON only.` },
              { type: "input_image", image_url: image },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ ok: false, error: `OpenAI ${response.status}: ${errorText}`, model }, { status: 502 });
    }

    const data = await response.json();
    const text = data?.output_text || data?.output?.flatMap?.((item: any) => item?.content || [])?.map?.((content: any) => content?.text || "")?.join?.("\n") || "{}";
    return resultJson(extractJson(text), model);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "AI prescription detection failed", model }, { status: 500 });
  }
}
