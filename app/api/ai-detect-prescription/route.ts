import { NextRequest, NextResponse } from "next/server";

type DocumentType = "DISPENSED_LABEL" | "REPEAT_AUTHORISATION" | "PRESCRIPTION_COPY" | "ORIGINAL_PRESCRIPTION" | "UNKNOWN_DOCUMENT";
type ScanMode = "dispensed_copy" | "original_script";

type ExtractedMedicine = {
  medicine?: string;
  labelNumber?: string;
  quantity?: string;
  repeats?: string;
  directions?: string;
  confidence?: number;
};

type ExtractedPrescription = {
  documentType?: DocumentType;
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

const DOCUMENT_TYPES: DocumentType[] = ["DISPENSED_LABEL", "REPEAT_AUTHORISATION", "PRESCRIPTION_COPY", "ORIGINAL_PRESCRIPTION", "UNKNOWN_DOCUMENT"];

const BASE_PROMPT = `You are extracting information from Australian pharmacy documents for an owing script workflow.
Return only valid compact JSON with these fields:
documentType, scriptNumber, patient, address, date, medicare, confidence, notes, medicines.

documentType must be exactly one of:
DISPENSED_LABEL, REPEAT_AUTHORISATION, PRESCRIPTION_COPY, ORIGINAL_PRESCRIPTION, UNKNOWN_DOCUMENT.

medicines must be an array. Each medicine item may contain: medicine, labelNumber, quantity, repeats, directions, confidence.

Critical rules:
- Do NOT put address text in patient. Patient must be a person name only.
- If address is visible, put it in address only.
- Repeat authorisation forms often say PBS/RPBS Repeat authorisation, Prescription no. this supply, Original prescription details, repeats left, prescriber, and date.
- A repeat authorisation is NOT the same as an original prescription. Classify it as REPEAT_AUTHORISATION.
- A FRED label or dispensed label is DISPENSED_LABEL.
- A patient copy or copy of a prescription used as evidence of a dispensed/owing item is PRESCRIPTION_COPY unless it is clearly the original paper prescription.
- If the prescription has multiple medicines/items, return one object per medicine in medicines.
- For dispensed copies, repeat authorisations, labels, and patient copies, do NOT stop at barcode/script/label number. Extract patient, address, Medicare/patient identifier, date, medicine, quantity, directions, and repeats whenever visible.
- scriptNumber and labelNumber are optional reference fields only. Never invent them. They are not the main matching key.
- For handwritten prescriptions, read carefully. If a word or number is unclear, leave that field blank and lower confidence.
- Never invent values. Use dd/mm/yyyy for dates when possible.`;

function sanitize(value: unknown) {
  return String(value ?? "").slice(0, 500).trim();
}

function sanitizeDocumentType(value: unknown): DocumentType {
  const docType = String(value ?? "").trim().toUpperCase() as DocumentType;
  return DOCUMENT_TYPES.includes(docType) ? docType : "UNKNOWN_DOCUMENT";
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

function wrongModeWarning(mode: ScanMode, documentType: DocumentType) {
  if (mode === "dispensed_copy" && documentType === "ORIGINAL_PRESCRIPTION") {
    return "This looks like an original prescription. Save it here only if it is the patient/dispensed copy you want to use as the owing target.";
  }
  if (mode === "original_script" && ["DISPENSED_LABEL", "REPEAT_AUTHORISATION", "PRESCRIPTION_COPY"].includes(documentType)) {
    return "This looks like a dispensed copy, repeat authorisation, or label. Use Scan Dispensed Copy for this document, not Scan Original Script.";
  }
  return "";
}

function resultJson(parsed: ExtractedPrescription, model: string, mode: ScanMode) {
  const documentType = sanitizeDocumentType(parsed.documentType);
  const medicines = Array.isArray(parsed.medicines) && parsed.medicines.length > 0
    ? parsed.medicines.map(sanitizeMedicine).filter((m) => m.medicine || m.labelNumber || m.directions)
    : sanitize(parsed.medicine)
      ? [{ medicine: sanitize(parsed.medicine), labelNumber: "", quantity: "", repeats: "", directions: "", confidence: Number(parsed.confidence || 0) }]
      : [];

  return NextResponse.json({
    ok: true,
    model,
    mode,
    result: {
      documentType,
      warning: wrongModeWarning(mode, documentType),
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
  const body = await request.json().catch(() => null) as { image?: string; mode?: ScanMode } | null;
  const image = body?.image;
  const mode: ScanMode = body?.mode === "dispensed_copy" ? "dispensed_copy" : "original_script";

  if (!image || !image.startsWith("data:image/")) {
    return NextResponse.json({ ok: false, error: "No prescription image received" }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY is not configured on this server" }, { status: 500 });
  }

  const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-5.1";
  const modePrompt = mode === "dispensed_copy"
    ? "The user is scanning the dispensed/owing side. This may be a FRED label, repeat authorisation form, no-barcode label, patient copy, prescription copy, or occasionally an original prescription scanned in the wrong mode. Classify carefully and extract all visible prescription details. The main goal is patient identity, address, Medicare/patient identifier, prescription/dispense date, medicines, quantities, and directions. Do not return only a code."
    : "The user is scanning the original paper prescription that arrived later. Classify carefully. If the image is actually a repeat authorisation, label, or patient copy, do not call it an original prescription.";

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
              { type: "input_text", text: `${BASE_PROMPT}\n\n${modePrompt}\n\nExtract document details from this image. Return JSON only.` },
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
    return resultJson(extractJson(text), model, mode);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "AI prescription detection failed", model }, { status: 500 });
  }
}
