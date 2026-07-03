"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type Row = Record<string, string>;
type Rec = { id: string; patient: string; date: string; medicine: string; quantity: string; sourceRow: Row };
type Scan = { value: string; savedAt: string; status: "matched" | "unmatched"; record?: Rec };
type BarcodeResult = { rawValue: string };
type Detector = { detect: (video: HTMLVideoElement) => Promise<BarcodeResult[]> };

declare global {
  interface Window {
    BarcodeDetector?: { new (options?: { formats?: string[] }): Detector };
  }
}

const STORE = "pharmacy-stocktake-scans-v2";
const ID = ["barcode", "bar code", "label", "label no", "label number", "rx", "rx no", "script", "script no", "prescription", "prescription no", "number", "token", "dispense no"];
const PATIENT = ["patient", "patient name", "name", "customer", "client", "surname", "first name", "last name"];
const DATE = ["date", "script date", "prescription date", "dispensed", "dispensed date", "date dispensed"];
const MED = ["drug", "medicine", "medication", "item", "description", "drug description", "brand", "generic", "product"];
const QTY = ["qty", "quantity", "pack", "packs", "qty supplied", "quantity supplied"];

const clean = (v: string) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/gi, "").trim();
const digits = (v: string) => String(v ?? "").replace(/\D/g, "");

function pick(row: Row, keys: string[]) {
  const entries = Object.entries(row);
  const exact = entries.find(([k]) => keys.includes(k.toLowerCase().trim()));
  if (exact?.[1]) return exact[1].trim();
  const fuzzy = entries.find(([k]) => keys.some((key) => k.toLowerCase().trim().includes(key)));
  return fuzzy?.[1]?.trim() ?? "";
}

function toRecords(rows: Row[]) {
  return rows.map((row) => {
    const patient = pick(row, PATIENT);
    const date = pick(row, DATE);
    const medicine = pick(row, MED);
    const id = pick(row, ID) || [patient, date, medicine].filter(Boolean).join("-");
    return { id, patient, date, medicine, quantity: pick(row, QTY), sourceRow: row } satisfies Rec;
  }).filter((r) => r.id || r.patient || r.medicine);
}

function delimiter(line: string) {
  return [",", "\t", ";", "|"].reduce((best, d) => line.split(d).length > line.split(best).length ? d : best, ",");
}

function splitLine(line: string, d: string) {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (c === '"') q = !q;
    else if (c === d && !q) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function parseText(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const d = delimiter(lines[0]);
  const headers = splitLine(lines[0], d);
  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line, d);
    return headers.reduce<Row>((row, h, i) => ({ ...row, [h || `Column ${i + 1}`]: cells[i] ?? "" }), {});
  });
  return toRecords(rows);
}

async function parseFile(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array", cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: "", raw: false });
    return toRecords(rows);
  }
  return parseText(await file.text());
}

function match(records: Rec[], value: string) {
  const c = clean(value);
  const d = digits(value);
  if (!c && !d) return undefined;
  return records.find((r) => {
    const raw = Object.values(r.sourceRow).join(" ");
    return clean(r.id) === c || Boolean(d && digits(r.id) === d) || Boolean(c && clean(raw).includes(c)) || Boolean(d && digits(raw).includes(d));
  });
}

const fmt = (v: string) => new Intl.DateTimeFormat("en-AU", { dateStyle: "short", timeStyle: "short" }).format(new Date(v));

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [records, setRecords] = useState<Rec[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [manual, setManual] = useState("");
  const [detected, setDetected] = useState("");
  const [fileName, setFileName] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [last, setLast] = useState<Scan | null>(null);
  const [message, setMessage] = useState("Import the FRED Excel file, then scan labels with the phone camera.");

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || "[]") as Scan[];
      setScans(saved);
      setLast(saved[0] ?? null);
    } catch { setScans([]); }
  }, []);

  useEffect(() => { localStorage.setItem(STORE, JSON.stringify(scans)); }, [scans]);

  useEffect(() => {
    if (!cameraOn || !videoRef.current || !window.BarcodeDetector) return;
    let off = false;
    const detector = new window.BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code"] });
    const loop = async () => {
      if (off || !videoRef.current) return;
      try {
        const value = (await detector.detect(videoRef.current))[0]?.rawValue?.trim();
        if (value && value !== detected) { setDetected(value); setManual(""); setMessage(`Scanned ${value}. Confirm if correct.`); }
      } catch { setMessage("Camera opened, but this browser cannot read barcode reliably. Use Chrome/Edge or manual fallback."); }
      setTimeout(loop, 300);
    };
    void loop();
    return () => { off = true; };
  }, [cameraOn, detected]);

  const value = detected || manual;
  const current = useMemo(() => match(records, value), [records, value]);
  const duplicate = useMemo(() => scans.find((s) => clean(s.value) === clean(value)), [scans, value]);
  const preview: Scan | null = value ? { value, savedAt: new Date().toISOString(), status: current ? "matched" : "unmatched", record: current } : last;
  const matched = scans.filter((s) => s.status === "matched").length;

  async function upload(file: File) {
    setMessage(`Reading ${file.name}...`);
    try {
      const parsed = await parseFile(file);
      setRecords(parsed);
      setFileName(file.name);
      setMessage(`${parsed.length} rows imported. Start camera and scan the first label.`);
    } catch { setMessage("Could not read file. Use .xlsx/.xls from FRED or CSV/TSV/TXT."); }
  }

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOn(true);
      setMessage(window.BarcodeDetector ? "Camera ready. Put the barcode inside the small scan box." : "Camera is on, but this browser has no BarcodeDetector. Use manual fallback.");
    } catch { setMessage("Camera permission denied or no camera found."); }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
    setMessage("Camera stopped.");
  }

  function confirm() {
    const v = value.trim();
    if (!v) return;
    const record = match(records, v);
    const scan: Scan = { value: v, savedAt: new Date().toISOString(), status: record ? "matched" : "unmatched", record };
    setScans((old) => [scan, ...old.filter((s) => clean(s.value) !== clean(v))]);
    setLast(scan);
    setManual("");
    setDetected("");
    setMessage(record ? `${v} confirmed. Ready for next barcode.` : `${v} saved as unmatched. Ready for next barcode.`);
  }

  function demo() {
    const data = `Label No,Patient Name,Prescription Date,Drug Description,Quantity\nRX10021,Sample Patient One,03/07/2026,Atorvastatin 40 mg tablets,30\nRX10022,Sample Patient Two,03/07/2026,Metformin XR 500 mg tablets,120\nRX10023,Sample Patient Three,03/07/2026,Sertraline 50 mg tablets,60`;
    setRecords(parseText(data));
    setFileName("demo-stocktake.csv");
    setMessage("Demo loaded. Use camera or manual fallback: RX10021.");
  }

  function clearAll() {
    setScans([]); setLast(null); localStorage.removeItem(STORE); setMessage("Session cleared.");
  }

  return <main className="min-h-screen bg-slate-950 px-4 py-4 text-slate-100 sm:px-6 lg:px-8">
    <section className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="rounded-3xl border border-white/10 bg-white/10 p-5 shadow-2xl">
        <p className="text-xs font-bold uppercase tracking-[0.3em] text-emerald-300">Pharmacy Stocktake</p>
        <h1 className="mt-2 text-2xl font-black text-white sm:text-4xl">Phone camera stocktake scanner</h1>
        <p className="mt-3 text-sm leading-7 text-slate-300">Import FRED Excel, scan each label, review match, then Confirm.</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-2xl bg-white p-4 text-slate-950"><p className="text-2xl font-black">{records.length}</p><p className="text-xs text-slate-500">Imported rows</p></div>
        <div className="rounded-2xl bg-emerald-100 p-4 text-emerald-950"><p className="text-2xl font-black">{matched}</p><p className="text-xs">Matched</p></div>
        <div className="rounded-2xl bg-amber-100 p-4 text-amber-950"><p className="text-2xl font-black">{scans.length - matched}</p><p className="text-xs">Unmatched</p></div>
        <div className="rounded-2xl bg-white/10 p-4 text-white"><p className="truncate text-sm font-black">{fileName || "No file"}</p><p className="text-xs text-slate-400">Current file</p></div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.75fr_1.25fr]">
        <div className="rounded-3xl bg-white p-5 text-slate-950 shadow-xl">
          <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-black">1. Import FRED export</h2><button onClick={demo} className="rounded-full border px-4 py-2 text-sm font-bold">Load demo</button></div>
          <p className="mt-1 text-sm text-slate-600">Supports .xlsx, .xls, .csv, .tsv, .txt.</p>
          <label className="mt-4 flex cursor-pointer flex-col items-center rounded-3xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center hover:border-emerald-500">
            <input className="sr-only" type="file" accept=".xlsx,.xls,.csv,.tsv,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
            <span className="font-black">Choose FRED Excel / export file</span>
            <span className="mt-2 text-xs text-slate-500">Auto-detects label/Rx, patient, date, medicine, quantity.</span>
          </label>
          <p className="mt-4 rounded-2xl bg-slate-100 p-3 text-sm font-semibold text-slate-700">{message}</p>
        </div>

        <div className="rounded-3xl bg-emerald-50 p-5 text-slate-950 shadow-xl ring-4 ring-emerald-300/40">
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            <div>
              <div className="relative overflow-hidden rounded-3xl border-4 border-emerald-500 bg-black">
                <video ref={videoRef} className="h-56 w-full object-cover sm:h-64" autoPlay muted playsInline />
                <div className="pointer-events-none absolute inset-x-8 top-1/2 h-20 -translate-y-1/2 rounded-2xl border-4 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]" />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2"><button onClick={startCamera} className="rounded-2xl bg-emerald-600 px-4 py-3 font-black text-white">Start camera</button><button onClick={stopCamera} className="rounded-2xl border bg-white px-4 py-3 font-bold">Stop</button></div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="rounded-3xl bg-white p-4"><p className="text-xs font-bold uppercase tracking-widest text-slate-500">Scanned label</p><p className="mt-2 min-h-10 break-all text-3xl font-black">{value || "Waiting for camera..."}</p>{duplicate && <p className="mt-3 rounded-2xl bg-amber-100 p-3 text-sm font-bold text-amber-900">Duplicate: {fmt(duplicate.savedAt)}</p>}</div>
              <div className="rounded-3xl bg-white p-4"><h2 className="text-xl font-black">{value ? "Current match" : "Last confirmed"}</h2>{preview?.record ? <div className="mt-3 space-y-2 text-sm"><p className="rounded-2xl bg-emerald-100 p-3 font-black text-emerald-900">{value ? "Matched preview" : "Matched and saved"}</p><p><strong>Patient:</strong> {preview.record.patient || "-"}</p><p><strong>Date:</strong> {preview.record.date || "-"}</p><p><strong>Medicine:</strong> {preview.record.medicine || "-"}</p><p><strong>Quantity:</strong> {preview.record.quantity || "-"}</p></div> : preview ? <p className="mt-3 rounded-2xl bg-rose-100 p-3 text-sm font-bold text-rose-900">{value ? "No match found." : "Saved as unmatched."}</p> : <p className="mt-3 rounded-2xl bg-slate-100 p-3 text-sm font-bold text-slate-600">Scan a label.</p>}</div>
              <button onClick={confirm} disabled={!value.trim()} className="rounded-3xl bg-emerald-600 px-8 py-5 text-2xl font-black text-white disabled:opacity-40">Confirm scan</button>
            </div>
          </div>
        </div>
      </section>

      <details className="rounded-3xl bg-white p-4 text-slate-950 shadow-xl"><summary className="cursor-pointer text-lg font-black">Manual fallback</summary><div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]"><input value={manual} onChange={(e) => { setManual(e.target.value); setDetected(""); }} onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} placeholder="Type label / Rx number manually" className="rounded-2xl border-2 px-4 py-4 text-xl font-black" /><button onClick={confirm} disabled={!value.trim()} className="rounded-2xl bg-slate-950 px-6 py-4 font-black text-white disabled:opacity-40">Confirm</button></div></details>

      <section className="rounded-3xl bg-white p-5 text-slate-950 shadow-xl"><div className="flex items-center justify-between"><div><h2 className="text-2xl font-black">Confirmed scans</h2><p className="text-sm text-slate-600">Saved only after Confirm.</p></div><button onClick={clearAll} className="rounded-full border border-rose-200 px-4 py-2 text-sm font-bold text-rose-700">Clear session</button></div><div className="mt-5 grid gap-3 lg:grid-cols-2">{scans.length === 0 && <p className="rounded-2xl bg-slate-100 p-5 text-center text-sm text-slate-500 lg:col-span-2">Nothing confirmed yet.</p>}{scans.map((s) => <article key={`${s.value}-${s.savedAt}`} className="rounded-2xl border p-4"><div className="flex items-center justify-between gap-2"><p className="text-xl font-black">{s.value}</p><span className={s.status === "matched" ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-800" : "rounded-full bg-rose-100 px-3 py-1 text-xs font-black text-rose-800"}>{s.status.toUpperCase()}</span></div><p className="mt-1 text-xs text-slate-500">{fmt(s.savedAt)}</p>{s.record && <p className="mt-2 text-sm text-slate-700">{s.record.patient || "-"} | {s.record.date || "-"} | {s.record.medicine || "-"}</p>}</article>)}</div></section>
    </section>
  </main>;
}
