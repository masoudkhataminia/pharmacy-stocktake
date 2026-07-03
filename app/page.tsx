"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type SourceRow = Record<string, string>;

type StockRecord = {
  id: string;
  patient: string;
  date: string;
  medicine: string;
  quantity: string;
  sourceRow: SourceRow;
};

type SavedScan = {
  value: string;
  savedAt: string;
  status: "matched" | "unmatched";
  record?: StockRecord;
};

type BarcodeResult = { rawValue: string };
type BarcodeDetectorLike = { detect: (video: HTMLVideoElement) => Promise<BarcodeResult[]> };

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats?: string[] }): BarcodeDetectorLike;
    };
  }
}

const STORAGE_KEY = "pharmacy-stocktake-scans-v1";
const ID_COLUMNS = ["barcode", "bar code", "label", "label no", "label number", "rx", "rx no", "script", "script no", "prescription", "prescription no", "number", "token"];
const PATIENT_COLUMNS = ["patient", "patient name", "name", "customer", "client"];
const DATE_COLUMNS = ["date", "script date", "prescription date", "dispensed", "dispensed date"];
const MEDICINE_COLUMNS = ["drug", "medicine", "medication", "item", "description", "drug description", "brand", "generic"];
const QUANTITY_COLUMNS = ["qty", "quantity", "pack", "packs"];

function normalise(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gi, "").trim();
}

function onlyDigits(value: string) {
  return value.replace(/\D/g, "");
}

function pickColumn(row: SourceRow, candidates: string[]) {
  const entries = Object.entries(row);
  const exact = entries.find(([key]) => candidates.includes(key.toLowerCase().trim()));
  if (exact?.[1]) return exact[1].trim();

  const fuzzy = entries.find(([key]) => {
    const cleanKey = key.toLowerCase().trim();
    return candidates.some((candidate) => cleanKey.includes(candidate));
  });

  return fuzzy?.[1]?.trim() ?? "";
}

function detectDelimiter(headerLine: string) {
  const delimiters = [",", "\t", ";", "|"];
  return delimiters.reduce((best, delimiter) => (headerLine.split(delimiter).length > headerLine.split(best).length ? delimiter : best), ",");
}

function parseLine(line: string, delimiter: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

function parseExport(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseLine(lines[0], delimiter);

  return lines
    .slice(1)
    .map((line) => {
      const cells = parseLine(line, delimiter);
      const row = headers.reduce<SourceRow>((result, header, index) => {
        result[header || `Column ${index + 1}`] = cells[index] ?? "";
        return result;
      }, {});

      const patient = pickColumn(row, PATIENT_COLUMNS);
      const date = pickColumn(row, DATE_COLUMNS);
      const medicine = pickColumn(row, MEDICINE_COLUMNS);
      const pickedId = pickColumn(row, ID_COLUMNS);
      const fallbackId = [patient, date, medicine].filter(Boolean).join("-");
      const id = pickedId || fallbackId;

      return {
        id,
        patient,
        date,
        medicine,
        quantity: pickColumn(row, QUANTITY_COLUMNS),
        sourceRow: row,
      } satisfies StockRecord;
    })
    .filter((record) => record.id || record.patient || record.medicine);
}

function findRecord(records: StockRecord[], value: string) {
  const cleanValue = normalise(value);
  const digits = onlyDigits(value);
  if (!cleanValue && !digits) return undefined;

  return records.find((record) => {
    const rawValues = Object.values(record.sourceRow).join(" ");
    return (
      normalise(record.id) === cleanValue ||
      Boolean(digits && onlyDigits(record.id) === digits) ||
      Boolean(cleanValue && normalise(rawValues).includes(cleanValue)) ||
      Boolean(digits && onlyDigits(rawValues).includes(digits))
    );
  });
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [records, setRecords] = useState<StockRecord[]>([]);
  const [scans, setScans] = useState<SavedScan[]>([]);
  const [manualValue, setManualValue] = useState("");
  const [detectedValue, setDetectedValue] = useState("");
  const [fileName, setFileName] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [lastConfirmed, setLastConfirmed] = useState<SavedScan | null>(null);
  const [message, setMessage] = useState("Upload a pharmacy CSV export, then type or scan a label number.");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as SavedScan[];
        setScans(parsed);
        setLastConfirmed(parsed[0] ?? null);
      }
    } catch {
      setScans([]);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scans));
  }, [scans]);

  useEffect(() => {
    if (!cameraOn || !videoRef.current || !window.BarcodeDetector) return;
    let cancelled = false;
    const detector = new window.BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code"] });

    const scan = async () => {
      if (cancelled || !videoRef.current) return;
      try {
        const results = await detector.detect(videoRef.current);
        const value = results[0]?.rawValue?.trim();
        if (value) {
          setDetectedValue(value);
          setManualValue(value);
          setMessage(`Read ${value}. Review the match, then press Confirm.`);
        }
      } catch {
        setMessage("Camera opened, but automatic barcode detection is not stable in this browser. Manual entry still works.");
      }
      window.setTimeout(scan, 500);
    };

    void scan();
    return () => {
      cancelled = true;
    };
  }, [cameraOn]);

  const activeValue = detectedValue || manualValue;
  const currentMatch = useMemo(() => findRecord(records, activeValue), [activeValue, records]);
  const duplicate = useMemo(() => scans.find((scan) => normalise(scan.value) === normalise(activeValue)), [activeValue, scans]);
  const matchedCount = scans.filter((scan) => scan.status === "matched").length;
  const unmatchedCount = scans.length - matchedCount;
  const previewScan: SavedScan | null = activeValue
    ? { value: activeValue, savedAt: new Date().toISOString(), status: currentMatch ? "matched" : "unmatched", record: currentMatch }
    : lastConfirmed;

  async function handleUpload(file: File) {
    const text = await file.text();
    const parsed = parseExport(text);
    setRecords(parsed);
    setFileName(file.name);
    setMessage(`${parsed.length} rows imported from ${file.name}. Now type a label number below.`);
    window.setTimeout(() => inputRef.current?.focus(), 100);
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("This browser does not allow camera access. Use manual entry.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOn(true);
      setMessage(window.BarcodeDetector ? "Camera is on. Hold the label in front of the camera." : "Camera is on, but BarcodeDetector is not available. Use manual entry in this browser.");
    } catch {
      setMessage("Camera permission was denied or no camera was found.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
    setMessage("Camera stopped.");
  }

  function confirmScan() {
    const value = activeValue.trim();
    if (!value) return;

    const match = findRecord(records, value);
    const nextScan: SavedScan = { value, savedAt: new Date().toISOString(), status: match ? "matched" : "unmatched", record: match };
    setScans((previous) => [nextScan, ...previous.filter((scan) => normalise(scan.value) !== normalise(value))]);
    setLastConfirmed(nextScan);
    setManualValue("");
    setDetectedValue("");
    setMessage(match ? `${value} confirmed and matched. Ready for the next label.` : `${value} confirmed but not found in the export. Ready for the next label.`);
    window.setTimeout(() => inputRef.current?.focus(), 100);
  }

  function loadDemo() {
    const demo = `Label No,Patient Name,Prescription Date,Drug Description,Quantity\nRX10021,Sample Patient One,03/07/2026,Atorvastatin 40 mg tablets,30\nRX10022,Sample Patient Two,03/07/2026,Metformin XR 500 mg tablets,120\nRX10023,Sample Patient Three,03/07/2026,Sertraline 50 mg tablets,60`;
    setRecords(parseExport(demo));
    setFileName("demo-stocktake.csv");
    setMessage("Demo loaded. Type RX10021, RX10022, or RX10023 in the big label box.");
    window.setTimeout(() => inputRef.current?.focus(), 100);
  }

  function clearSession() {
    setScans([]);
    setLastConfirmed(null);
    window.localStorage.removeItem(STORAGE_KEY);
    setMessage("Session cleared. Imported file stays loaded.");
  }

  function handleManualChange(value: string) {
    setManualValue(value);
    setDetectedValue("");
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="rounded-3xl border border-white/10 bg-white/10 p-6 shadow-2xl">
          <p className="text-sm font-bold uppercase tracking-[0.3em] text-emerald-300">Pharmacy Stocktake</p>
          <h1 className="mt-3 max-w-5xl text-3xl font-black tracking-tight text-white sm:text-5xl">
            Scan labels, match prescriptions, confirm before saving
          </h1>
          <p className="mt-4 max-w-4xl text-base leading-8 text-slate-300">
            Import the pharmacy export, type or scan each label number, review patient/date/medicine, then save only after confirmation.
          </p>
        </header>

        <section className="grid gap-4 sm:grid-cols-4">
          <div className="rounded-2xl bg-white p-5 text-slate-950"><p className="text-3xl font-black">{records.length}</p><p className="text-sm text-slate-500">Imported rows</p></div>
          <div className="rounded-2xl bg-emerald-100 p-5 text-emerald-950"><p className="text-3xl font-black">{matchedCount}</p><p className="text-sm">Matched scans</p></div>
          <div className="rounded-2xl bg-amber-100 p-5 text-amber-950"><p className="text-3xl font-black">{unmatchedCount}</p><p className="text-sm">Unmatched scans</p></div>
          <div className="rounded-2xl bg-white/10 p-5 text-white"><p className="truncate text-lg font-black">{fileName || "No file"}</p><p className="text-sm text-slate-400">Current export</p></div>
        </section>

        <section className="rounded-3xl bg-emerald-50 p-5 text-slate-950 shadow-xl ring-4 ring-emerald-300/40">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="flex-1">
              <label htmlFor="label-entry" className="text-lg font-black text-slate-950">Type scanned label number here</label>
              <p className="mt-1 text-sm font-semibold text-slate-600">After Load demo, try RX10021. Press Enter or Confirm.</p>
              <input
                id="label-entry"
                ref={inputRef}
                value={manualValue}
                onChange={(event) => handleManualChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") confirmScan();
                }}
                placeholder="Type label / Rx number e.g. RX10021"
                className="mt-3 w-full rounded-2xl border-2 border-emerald-500 bg-white px-5 py-5 text-2xl font-black text-slate-950 outline-none ring-emerald-300 placeholder:text-slate-400 focus:ring-4"
              />
            </div>
            <button type="button" onClick={confirmScan} disabled={!activeValue.trim()} className="rounded-2xl bg-emerald-600 px-8 py-5 text-xl font-black text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">
              Confirm
            </button>
          </div>
          {duplicate && <p className="mt-4 rounded-2xl bg-amber-100 p-3 text-sm font-bold text-amber-900">Duplicate warning: confirmed at {formatDateTime(duplicate.savedAt)}. Confirming again updates it.</p>}
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-3xl bg-white p-5 text-slate-950 shadow-xl">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-2xl font-black">1. Import export file</h2>
                <p className="mt-1 text-sm text-slate-600">CSV, TSV, TXT. For Excel files, save/export as CSV first.</p>
              </div>
              <button type="button" onClick={loadDemo} className="rounded-full border border-slate-300 px-4 py-2 text-sm font-bold hover:bg-slate-100">Load demo</button>
            </div>
            <label className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed border-slate-300 bg-slate-50 p-8 text-center hover:border-emerald-500 hover:bg-emerald-50">
              <input className="sr-only" type="file" accept=".csv,.tsv,.txt" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleUpload(file); }} />
              <span className="text-lg font-black">Choose pharmacy export</span>
              <span className="mt-2 text-sm text-slate-500">Auto-detects label/Rx, patient, date, medicine, and quantity columns.</span>
            </label>
            <p className="mt-4 rounded-2xl bg-slate-100 p-4 text-sm font-semibold text-slate-700">{message}</p>
          </div>

          <div className="rounded-3xl bg-white p-5 text-slate-950 shadow-xl">
            <h2 className="text-2xl font-black">2. Optional camera scan</h2>
            <p className="mt-1 text-sm text-slate-600">Manual entry above is the reliable default. Camera scanning depends on mobile browser support.</p>
            <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200 bg-black">
              <video ref={videoRef} className="aspect-video w-full object-cover" autoPlay muted playsInline />
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" onClick={startCamera} className="rounded-full bg-emerald-500 px-5 py-3 font-black text-white hover:bg-emerald-600">Start camera</button>
              <button type="button" onClick={stopCamera} className="rounded-full border border-slate-300 px-5 py-3 font-bold hover:bg-slate-100">Stop</button>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-3xl bg-white p-5 text-slate-950 shadow-xl">
            <h2 className="text-2xl font-black">{activeValue ? "Current match" : "Last confirmed scan"}</h2>
            <div className="mt-4 rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Label</p>
              <p className="mt-2 text-3xl font-black">{previewScan?.value || "-"}</p>
              {previewScan?.record ? (
                <div className="mt-5 space-y-2 text-sm">
                  <p className="rounded-2xl bg-emerald-100 p-3 font-black text-emerald-900">{activeValue ? "Matched preview" : "Matched and saved"}</p>
                  <p><strong>Patient:</strong> {previewScan.record.patient || "-"}</p>
                  <p><strong>Date:</strong> {previewScan.record.date || "-"}</p>
                  <p><strong>Medicine:</strong> {previewScan.record.medicine || "-"}</p>
                  <p><strong>Quantity:</strong> {previewScan.record.quantity || "-"}</p>
                </div>
              ) : previewScan ? (
                <p className="mt-5 rounded-2xl bg-rose-100 p-3 text-sm font-bold text-rose-900">{activeValue ? "No match found for this label." : "Saved as unmatched."}</p>
              ) : (
                <p className="mt-5 rounded-2xl bg-slate-100 p-3 text-sm font-bold text-slate-600">No scan yet. Type a label number above.</p>
              )}
            </div>
          </div>

          <div className="rounded-3xl bg-white p-5 text-slate-950 shadow-xl">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-2xl font-black">Confirmed scans</h2>
                <p className="text-sm text-slate-600">Saved only after Confirm.</p>
              </div>
              <button type="button" onClick={clearSession} className="rounded-full border border-rose-200 px-4 py-2 text-sm font-bold text-rose-700 hover:bg-rose-50">Clear session</button>
            </div>
            <div className="mt-5 max-h-[520px] space-y-3 overflow-auto">
              {scans.length === 0 && <p className="rounded-2xl bg-slate-100 p-5 text-center text-sm text-slate-500">Nothing confirmed yet.</p>}
              {scans.map((scan) => (
                <article key={`${scan.value}-${scan.savedAt}`} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xl font-black">{scan.value}</p>
                    <span className={scan.status === "matched" ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-800" : "rounded-full bg-rose-100 px-3 py-1 text-xs font-black text-rose-800"}>{scan.status.toUpperCase()}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{formatDateTime(scan.savedAt)}</p>
                  {scan.record && <p className="mt-2 text-sm text-slate-700">{scan.record.patient || "-"} | {scan.record.date || "-"} | {scan.record.medicine || "-"}</p>}
                </article>
              ))}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
