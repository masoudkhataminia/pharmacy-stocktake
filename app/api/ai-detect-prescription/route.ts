import { NextRequest, NextResponse } from "next/server";

type ExtractedMedicine = {
  medicine?: string;
  labelNumber?: string;
  quantity?: string;
  repeats?: string;
  directions?: string;
  confidence?: number;
};

type ExtractedPrescription = {
  scriptNumber?: string;
  patient?: string;
  address?: string;
  date?: string;
  medicine?: string;
  medicines?: ExtractedMedicine[];
  medicare?: string;
  confidence?: number;
  notes?: string;
};

const SYSTEM_PROMPT = `You are extracting information from an Australian pharmacy prescription image, including printed and handwritten prescriptions.
Return only valid compact JSON with these optional fields:
scriptNumber, patient, address, date, medicare, confidence, notes, medicines.
medicines must be an array. Each medicine item may contain: medicine, labelNumber, quantity, repeats, directions, confidence.
Critical rules:
- Do NOT put address text in patient. Patient must be a person name only.
- If address is visible, put it in address only.
- If the prescription has multiple medicines/items, return one object per medicine in medicines.
- Each medicine item may later match one separate label/barcode, so do not merge multiple medicines into one string unless you cannot separate them.
- For handwritten prescriptions, read carefully. If a word or number is unclear, leave that field blank and lower confidence.
- Never invent values. Use dd/mm/yyyy for dates when possible.`;

function sanitize(value: unknown) {
  return String(value ?? "").slice(0, 500).trim();
}

function sanitizeMedicine(item: ExtractedMedicine) {
  return {
    medicine: sanitize(item?.medicine),
    labelNumber: sanitize(item?.labelNumber),
    quantity: sanitize(item?.quantity),
    repeats: sanitize(item?.repeats),
    directions: sanitize(item?.directions),
    confidence: Number(item?.confidence || 0),
  };
}

function extractJson(text: string): ExtractedPrescription {
  const clean = text.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  const json = start >= 0 && end >= start ? clean.slice(start, end + 1) : clean;
  return JSON.parse(json || "{}");
}

function resultJson(parsed: ExtractedPrescription, model: string) {
  const medicines = Array.isArray(parsed.medicines) && parsed.medicines.length > 0
    ? parsed.medicines.map(sanitizeMedicine).filter((m) => m.medicine || m.labelNumber || m.directions)
    : sanitize(parsed.medicine)
      ? [{ medicine: sanitize(parsed.medicine), labelNumber: "", quantity: "", repeats: "", directions: "", confidence: Number(parsed.confidence || 0) }]
      : [];

  return NextResponse.json({
    ok: true,
    model,
    result: {
      scriptNumber: sanitize(parsed.scriptNumber),
      patient: sanitize(parsed.patient),
      address: sanitize(parsed.address),
      date: sanitize(parsed.date),
      medicine: medicines.map((m) => m.medicine).filter(Boolean).join("; "),
      medicines,
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
