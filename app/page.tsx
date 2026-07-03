"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type ScriptRec = { scriptNumber: string; dispenseDate: string; patient: string; medicine: string; quantity: string };
type Scan = { value: string; savedAt: string; status: "matched" | "unmatched"; record?: ScriptRec };
type Batch = { fileName: string; uploadedAt: string; from: string; to: string; imported: number; updated: number; total: number };
type BarcodeResult = { rawValue: string };
type Detector = { detect: (video: HTMLVideoElement) => Promise<BarcodeResult[]> };

declare global { interface Window { BarcodeDetector?: { new (options?: { formats?: string[] }): Detector } } }

const SCRIPT_STORE = "fred-master-scripts-v2";
const SCAN_STORE = "fred-label-scans-v2";
const BATCH_STORE = "fred-upload-batches-v2";
const SCRIPT_COLS = ["script number", "script no", "rx", "rx no", "prescription no", "prescription number", "label", "label no"];
const DATE_COLS = ["dispense date", "dispensed date", "date dispensed", "script date", "prescribed date", "date"];
const LAST_COLS = ["patient last name", "last name", "surname"];
const FIRST_COLS = ["patient first name", "first name", "given name"];
const PATIENT_COLS = ["patient", "patient name", "name", "customer", "client"];
const MED_COLS = ["drug description", "drug", "medicine", "medication", "brand name", "generic name", "description", "product"];
const QTY_COLS = ["quantity", "qty", "qty supplied", "quantity supplied"];

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/gi, "").trim();
const dig = (v: unknown) => String(v ?? "").replace(/\D/g, "");

type RawRow = Record<string, string>;

function pick(row: RawRow, keys: string[]) {
  const entries = Object.entries(row);
  const exact = entries.find(([k]) => keys.includes(k.toLowerCase().trim()));
  if (exact?.[1]) return String(exact[1]).trim();
  const fuzzy = entries.find(([k]) => keys.some((key) => k.toLowerCase().trim().includes(key)));
  return String(fuzzy?.[1] ?? "").trim();
}

function auDate(raw: string) {
  if (!raw) return "";
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return new Intl.DateTimeFormat("en-AU").format(d);
  const m = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  return m ? `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3].length === 2 ? `20${m[3]}` : m[3]}` : raw;
}

function dateValue(raw: string) {
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  const m = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!m) return 0;
  const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  return new Date(y, Number(m[2]) - 1, Number(m[1])).getTime();
}

function findHeaderIndex(rows: unknown[][]) {
  const index = rows.findIndex((row) => {
    const text = row.map((c) => String(c ?? "").toLowerCase()).join(" | ");
    return text.includes("script number") && (text.includes("patient") || text.includes("drug description"));
  });
  return index >= 0 ? index : 0;
}

function rowsToScripts(rows: RawRow[]) {
  return rows.map((row) => {
    const first = pick(row, FIRST_COLS);
    const last = pick(row, LAST_COLS);
    const patient = [first, last].filter(Boolean).join(" ") || pick(row, PATIENT_COLS);
    return {
      scriptNumber: pick(row, SCRIPT_COLS),
      dispenseDate: pick(row, DATE_COLS),
      patient,
      medicine: pick(row, MED_COLS),
      quantity: pick(row, QTY_COLS),
    } satisfies ScriptRec;
  }).filter((r) => r.scriptNumber || r.patient || r.medicine);
}

function splitCsvLine(line: string, delim: string) {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"' && quote && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (c === '"') quote = !quote;
    else if (c === delim && !quote) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function parseText(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const delim = [",", "\t", ";", "|"].reduce((best, d) => lines[0].split(d).length > lines[0].split(best).length ? d : best, ",");
  const headers = splitCsvLine(lines[0], delim);
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line, delim);
    return headers.reduce<RawRow>((row, h, i) => { row[h || `Column ${i + 1}`] = cells[i] ?? ""; return row; }, {});
  });
  return rowsToScripts(rows);
}

async function parseFredFile(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
    const headerIndex = findHeaderIndex(matrix);
    const headers = matrix[headerIndex].map((h, i) => String(h || `Column ${i + 1}`).trim());
    const rows = matrix.slice(headerIndex + 1).map((line) => headers.reduce<RawRow>((row, h, i) => { row[h] = String(line[i] ?? "").trim(); return row; }, {}));
    return rowsToScripts(rows);
  }
  return parseText(await file.text());
}

function rangeLabel(records: ScriptRec[]) {
  const dates = records.map((r) => r.dispenseDate).filter(Boolean).sort((a, b) => dateValue(a) - dateValue(b));
  return { from: auDate(dates[0] || ""), to: auDate(dates[dates.length - 1] || "") };
}

function findScript(records: ScriptRec[], value: string) {
  const c = norm(value); const d = dig(value);
  if (!c && !d) return undefined;
  return records.find((r) => norm(r.scriptNumber) === c || Boolean(d && dig(r.scriptNumber) === d));
}

const fmt = (v: string) => new Intl.DateTimeFormat("en-AU", { dateStyle: "short", timeStyle: "short" }).format(new Date(v));

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [scripts, setScripts] = useState<ScriptRec[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [manual, setManual] = useState("");
  const [detected, setDetected] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [last, setLast] = useState<Scan | null>(null);
  const [message, setMessage] = useState("Scan labels with phone camera. Upload FRED file at the bottom.");

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(SCRIPT_STORE) || "[]") as ScriptRec[];
      const sc = JSON.parse(localStorage.getItem(SCAN_STORE) || "[]") as Scan[];
      const b = JSON.parse(localStorage.getItem(BATCH_STORE) || "[]") as Batch[];
      setScripts(s); setScans(sc); setBatches(b); setLast(sc[0] ?? null);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { try { localStorage.setItem(SCRIPT_STORE, JSON.stringify(scripts)); } catch { setMessage("File is too large for browser storage. Upload a smaller date range."); } }, [scripts]);
  useEffect(() => { localStorage.setItem(SCAN_STORE, JSON.stringify(scans)); }, [scans]);
  useEffect(() => { localStorage.setItem(BATCH_STORE, JSON.stringify(batches)); }, [batches]);

  useEffect(() => {
    if (!cameraOn || !videoRef.current || !window.BarcodeDetector) return;
    let off = false;
    const detector = new window.BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code"] });
    const loop = async () => {
      if (off || !videoRef.current) return;
      try {
        const val = (await detector.detect(videoRef.current))[0]?.rawValue?.trim();
        if (val && val !== detected) { setDetected(val); setManual(""); setMessage(`Scanned ${val}. Confirm if correct.`); }
      } catch { setMessage("Camera open, but barcode reading is not reliable in this browser. Use Chrome/Edge or manual fallback."); }
      setTimeout(loop, 300);
    };
    void loop();
    return () => { off = true; };
  }, [cameraOn, detected]);

  const value = detected || manual;
  const current = useMemo(() => findScript(scripts, value), [scripts, value]);
  const matched = scans.filter((s) => s.status === "matched").length;
  const masterRange = rangeLabel(scripts);
  const preview: Scan | null = value ? { value, savedAt: new Date().toISOString(), status: current ? "matched" : "unmatched", record: current } : last;

  async function upload(file: File) {
    setMessage(`Reading ${file.name}...`);
    try {
      const incoming = await parseFredFile(file);
      const map = new Map(scripts.map((r) => [r.scriptNumber, r]));
      let updated = 0;
      for (const rec of incoming) {
        if (!rec.scriptNumber) continue;
        if (map.has(rec.scriptNumber)) updated += 1;
        map.set(rec.scriptNumber, rec);
      }
      const merged = [...map.values()].sort((a, b) => dateValue(a.dispenseDate) - dateValue(b.dispenseDate));
      const fileRange = rangeLabel(incoming);
      const batch = { fileName: file.name, uploadedAt: new Date().toISOString(), from: fileRange.from, to: fileRange.to, imported: incoming.length, updated, total: merged.length };
      localStorage.setItem(SCRIPT_STORE, JSON.stringify(merged));
      localStorage.setItem(BATCH_STORE, JSON.stringify([batch, ...batches]));
      setScripts(merged);
      setBatches((old) => [batch, ...old]);
      setMessage(`Scripts from ${fileRange.from || "?"} to ${fileRange.to || "?"} uploaded.`);
    } catch {
      setMessage("Could not read or save this file. Try exporting a smaller FRED date range.");
    }
  }

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOn(true);
      setMessage(window.BarcodeDetector ? "Camera ready. Put barcode inside the scan box." : "Camera on, but BarcodeDetector unavailable. Use manual fallback.");
    } catch { setMessage("Camera permission denied or no camera found."); }
  }

  function stopCamera() { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCameraOn(false); }
  function confirm() {
    const v = value.trim(); if (!v) return;
    const rec = findScript(scripts, v);
    const scan: Scan = { value: v, savedAt: new Date().toISOString(), status: rec ? "matched" : "unmatched", record: rec };
    setScans((old) => [scan, ...old.filter((s) => norm(s.value) !== norm(v))]);
    setLast(scan); setManual(""); setDetected(""); setMessage(rec ? `${v} confirmed.` : `${v} saved as unmatched.`);
  }
  function clearScans() { setScans([]); setLast(null); localStorage.removeItem(SCAN_STORE); }
  function clearMaster() { setScripts([]); setBatches([]); localStorage.removeItem(SCRIPT_STORE); localStorage.removeItem(BATCH_STORE); setMessage("FRED master cleared."); }

  return <main className="min-h-screen bg-slate-950 px-4 py-4 text-slate-100 sm:px-6 lg:px-8"><section className="mx-auto flex max-w-7xl flex-col gap-4">
    <header className="rounded-3xl border border-white/10 bg-white/10 p-5 shadow-2xl"><p className="text-xs font-bold uppercase tracking-[0.3em] text-emerald-300">Pharmacy Verification</p><h1 className="mt-2 text-2xl font-black text-white sm:text-4xl">Scan label → match FRED script</h1><p className="mt-3 text-sm leading-7 text-slate-300">Master file: {scripts.length ? `Scripts from ${masterRange.from} to ${masterRange.to}` : "no FRED file uploaded yet"}</p></header>
    <section className="grid gap-3 sm:grid-cols-4"><div className="rounded-2xl bg-white p-4 text-slate-950"><p className="text-2xl font-black">{scripts.length}</p><p className="text-xs text-slate-500">Master scripts</p></div><div className="rounded-2xl bg-emerald-100 p-4 text-emerald-950"><p className="text-2xl font-black">{matched}</p><p className="text-xs">Matched scans</p></div><div className="rounded-2xl bg-amber-100 p-4 text-amber-950"><p className="text-2xl font-black">{scans.length - matched}</p><p className="text-xs">Unmatched</p></div><div className="rounded-2xl bg-white/10 p-4 text-white"><p className="truncate text-sm font-black">{batches[0]?.fileName || "No upload"}</p><p className="text-xs text-slate-400">Last file</p></div></section>
    <section className="rounded-3xl bg-emerald-50 p-5 text-slate-950 shadow-xl ring-4 ring-emerald-300/40"><div className="grid gap-4 lg:grid-cols-[320px_1fr]"><div><div className="relative overflow-hidden rounded-3xl border-4 border-emerald-500 bg-black"><video ref={videoRef} className="h-56 w-full object-cover sm:h-64" autoPlay muted playsInline /><div className="pointer-events-none absolute inset-x-8 top-1/2 h-20 -translate-y-1/2 rounded-2xl border-4 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]" /></div><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={startCamera} className="rounded-2xl bg-emerald-600 px-4 py-3 font-black text-white">Start camera</button><button onClick={stopCamera} className="rounded-2xl border bg-white px-4 py-3 font-bold">Stop</button></div></div><div className="flex flex-col gap-3"><div className="rounded-3xl bg-white p-4"><p className="text-xs font-bold uppercase tracking-widest text-slate-500">Scanned label</p><p className="mt-2 min-h-10 break-all text-3xl font-black">{value || "Waiting for camera..."}</p></div><div className="rounded-3xl bg-white p-4"><h2 className="text-xl font-black">{value ? "Current match" : "Last confirmed"}</h2>{preview?.record ? <div className="mt-3 space-y-2 text-sm"><p className="rounded-2xl bg-emerald-100 p-3 font-black text-emerald-900">{value ? "Matched preview" : "Matched and saved"}</p><p><strong>Patient:</strong> {preview.record.patient || "-"}</p><p><strong>Date:</strong> {auDate(preview.record.dispenseDate) || "-"}</p><p><strong>Medicine:</strong> {preview.record.medicine || "-"}</p><p><strong>Script:</strong> {preview.record.scriptNumber || "-"}</p></div> : preview ? <p className="mt-3 rounded-2xl bg-rose-100 p-3 text-sm font-bold text-rose-900">No matching script in FRED master.</p> : <p className="mt-3 rounded-2xl bg-slate-100 p-3 text-sm font-bold text-slate-600">Scan a label.</p>}</div><button onClick={confirm} disabled={!value.trim()} className="rounded-3xl bg-emerald-600 px-8 py-5 text-2xl font-black text-white disabled:opacity-40">Confirm scan</button></div></div></section>
    <details className="rounded-3xl bg-white p-4 text-slate-950 shadow-xl"><summary className="cursor-pointer text-lg font-black">Manual fallback</summary><div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]"><input value={manual} onChange={(e) => { setManual(e.target.value); setDetected(""); }} onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} placeholder="Type script / label number manually" className="rounded-2xl border-2 px-4 py-4 text-xl font-black" /><button onClick={confirm} disabled={!value.trim()} className="rounded-2xl bg-slate-950 px-6 py-4 font-black text-white disabled:opacity-40">Confirm</button></div></details>
    <section className="rounded-3xl bg-white p-5 text-slate-950 shadow-xl"><div className="flex items-center justify-between"><div><h2 className="text-2xl font-black">Confirmed scans</h2><p className="text-sm text-slate-600">Saved after Confirm.</p></div><button onClick={clearScans} className="rounded-full border border-rose-200 px-4 py-2 text-sm font-bold text-rose-700">Clear scans</button></div><div className="mt-5 grid gap-3 lg:grid-cols-2">{scans.length === 0 && <p className="rounded-2xl bg-slate-100 p-5 text-center text-sm text-slate-500 lg:col-span-2">Nothing confirmed yet.</p>}{scans.map((s) => <article key={`${s.value}-${s.savedAt}`} className="rounded-2xl border p-4"><div className="flex items-center justify-between gap-2"><p className="text-xl font-black">{s.value}</p><span className={s.status === "matched" ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-800" : "rounded-full bg-rose-100 px-3 py-1 text-xs font-black text-rose-800"}>{s.status.toUpperCase()}</span></div><p className="mt-1 text-xs text-slate-500">{fmt(s.savedAt)}</p>{s.record && <p className="mt-2 text-sm text-slate-700">{s.record.patient || "-"} | {auDate(s.record.dispenseDate) || "-"} | {s.record.medicine || "-"}</p>}</article>)}</div></section>
    <footer className="rounded-3xl bg-white/10 p-4 text-center"><input type="file" accept=".xlsx,.xls,.csv,.tsv,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.currentTarget.value = ""; }} className="block w-full rounded-2xl bg-white p-4 text-sm font-black text-slate-950 file:mr-4 file:rounded-full file:border-0 file:bg-emerald-600 file:px-5 file:py-3 file:font-black file:text-white" />{batches.length > 0 && <p className="mt-3 text-sm text-slate-300">Last upload: Scripts from {batches[0].from} to {batches[0].to} uploaded. Master total: {batches[0].total}</p>}<div>{batches.length > 0 && <button onClick={clearMaster} className="mt-3 text-xs font-bold text-rose-300">Clear uploaded FRED master</button>}</div></footer>
  </section></main>;
}
