"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type ScriptRec = { scriptNumber: string; dispenseDate: string; patient: string; medicine: string; quantity: string; medicare?: string };
type Scan = { value: string; savedAt: string; status: "matched" | "unmatched"; record?: ScriptRec };
type Batch = { fileName: string; uploadedAt: string; from: string; to: string; imported: number; updated: number; total: number };
type UploadState = { active: boolean; percent: number; label: string };
type BarcodeResult = { rawValue: string };
type Detector = { detect: (video: HTMLVideoElement) => Promise<BarcodeResult[]> };
type RawRow = Record<string, string>;
type RxManual = { patient: string; date: string; medicine: string; medicare: string };
type TableMode = "matched" | "unmatchedLabels" | "unmatchedScripts";

declare global { interface Window { BarcodeDetector?: { new (options?: { formats?: string[] }): Detector } } }

const DB = "pharmacy-verification-db";
const SCRIPT_KEY = "fred-master-scripts-v3";
const SCAN_KEY = "fred-label-scans-v3";
const BATCH_KEY = "fred-upload-batches-v3";
const SCRIPT_COLS = ["script number", "script no", "rx", "rx no", "prescription no", "prescription number", "label", "label no"];
const DATE_COLS = ["dispense date", "dispensed date", "date dispensed", "script date", "prescribed date", "date"];
const LAST_COLS = ["patient last name", "last name", "surname"];
const FIRST_COLS = ["patient first name", "first name", "given name"];
const PATIENT_COLS = ["patient", "patient name", "name", "customer", "client"];
const MED_COLS = ["drug description", "drug", "medicine", "medication", "brand name", "generic name", "description", "product"];
const QTY_COLS = ["quantity", "qty", "qty supplied", "quantity supplied"];
const MEDICARE_COLS = ["patient medicare", "medicare", "medicare number", "medicare no"];

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/gi, "").trim();
const dig = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const frame = () => new Promise((resolve) => window.setTimeout(resolve, 40));

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet<T>(key: string, fallback: T): Promise<T> {
  const db = await openDb();
  return new Promise((resolve) => {
    const req = db.transaction("kv", "readonly").objectStore("kv").get(key);
    req.onsuccess = () => resolve((req.result as T) ?? fallback);
    req.onerror = () => resolve(fallback);
  });
}
async function idbSet<T>(key: string, value: T) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const req = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function idbDel(key: string) {
  const db = await openDb();
  return new Promise<void>((resolve) => {
    const req = db.transaction("kv", "readwrite").objectStore("kv").delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
}

function pick(row: RawRow, keys: string[]) {
  const entries = Object.entries(row);
  const exact = entries.find(([k]) => keys.includes(k.toLowerCase().trim()));
  if (exact?.[1]) return String(exact[1]).trim();
  const fuzzy = entries.find(([k]) => keys.some((key) => k.toLowerCase().trim().includes(key)));
  return String(fuzzy?.[1] ?? "").trim();
}
function auDate(raw: string) {
  if (!raw) return "";
  const m = String(raw).match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3].length === 2 ? `20${m[3]}` : m[3]}`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : new Intl.DateTimeFormat("en-AU").format(d);
}
function dateValue(raw: string) {
  const m = String(raw).match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) return new Date(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}
function findHeaderIndex(rows: unknown[][]) {
  const idx = rows.findIndex((row) => {
    const text = row.map((c) => String(c ?? "").toLowerCase()).join(" | ");
    return text.includes("script number") && (text.includes("patient") || text.includes("drug description"));
  });
  return idx >= 0 ? idx : 0;
}
function rowsToScripts(rows: RawRow[]) {
  return rows.map((row) => {
    const first = pick(row, FIRST_COLS);
    const last = pick(row, LAST_COLS);
    return {
      scriptNumber: pick(row, SCRIPT_COLS),
      dispenseDate: pick(row, DATE_COLS),
      patient: [first, last].filter(Boolean).join(" ") || pick(row, PATIENT_COLS),
      medicine: pick(row, MED_COLS),
      quantity: pick(row, QTY_COLS),
      medicare: pick(row, MEDICARE_COLS),
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
  const c = norm(value);
  const d = dig(value);
  if (!c && !d) return undefined;
  return records.find((r) => {
    const sd = dig(r.scriptNumber);
    return norm(r.scriptNumber) === c || Boolean(d && sd && (sd === d || d.includes(sd) || sd.includes(d)));
  });
}
function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function downloadCsv(fileName: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
const fmt = (v: string) => new Intl.DateTimeFormat("en-AU", { dateStyle: "short", timeStyle: "short" }).format(new Date(v));

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rxVideoRef = useRef<HTMLVideoElement | null>(null);
  const rxStreamRef = useRef<MediaStream | null>(null);
  const [scripts, setScripts] = useState<ScriptRec[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [manual, setManual] = useState("");
  const [detected, setDetected] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [rxCameraOn, setRxCameraOn] = useState(false);
  const [last, setLast] = useState<Scan | null>(null);
  const [message, setMessage] = useState("Stage 1: scan label barcode. Stage 2: live prescription scanner.");
  const [uploadState, setUploadState] = useState<UploadState>({ active: false, percent: 0, label: "" });
  const [rxMessage, setRxMessage] = useState("Open the live prescription scanner and move from script to script. AI/OCR extraction will run from this live feed in the next update.");
  const [rxManual, setRxManual] = useState<RxManual>({ patient: "", date: "", medicine: "", medicare: "" });
  const [tableMode, setTableMode] = useState<TableMode>("matched");

  useEffect(() => {
    void (async () => {
      const s = await idbGet<ScriptRec[]>(SCRIPT_KEY, []);
      const sc = await idbGet<Scan[]>(SCAN_KEY, []);
      const b = await idbGet<Batch[]>(BATCH_KEY, []);
      setScripts(s); setScans(sc); setBatches(b); setLast(sc[0] ?? null);
    })();
  }, []);
  useEffect(() => { void idbSet(SCRIPT_KEY, scripts); }, [scripts]);
  useEffect(() => { void idbSet(SCAN_KEY, scans); }, [scans]);
  useEffect(() => { void idbSet(BATCH_KEY, batches); }, [batches]);
  useEffect(() => {
    if (!cameraOn || !videoRef.current || !window.BarcodeDetector) return;
    let off = false;
    const detector = new window.BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "qr_code"] });
    const loop = async () => {
      if (off || !videoRef.current) return;
      try {
        const val = (await detector.detect(videoRef.current))[0]?.rawValue?.trim();
        if (val && val !== detected) { setDetected(val); setManual(""); setMessage(`Label scanned: ${val}. Confirm if correct.`); }
      } catch { setMessage("Camera open, but barcode reading is not reliable in this browser. Use Chrome/Edge or manual fallback."); }
      setTimeout(loop, 300);
    };
    void loop();
    return () => { off = true; };
  }, [cameraOn, detected]);

  const value = detected || manual;
  const current = useMemo(() => findScript(scripts, value), [scripts, value]);
  const matchedScans = useMemo(() => scans.filter((s) => s.status === "matched"), [scans]);
  const unmatchedScans = useMemo(() => scans.filter((s) => s.status === "unmatched"), [scans]);
  const scannedScriptNumbers = useMemo(() => new Set(matchedScans.map((s) => s.record?.scriptNumber).filter(Boolean)), [matchedScans]);
  const unmatchedScripts = useMemo(() => scripts.filter((script) => script.scriptNumber && !scannedScriptNumbers.has(script.scriptNumber)), [scripts, scannedScriptNumbers]);
  const masterRange = rangeLabel(scripts);
  const preview: Scan | null = value ? { value, savedAt: new Date().toISOString(), status: current ? "matched" : "unmatched", record: current } : last;
  const rxSuggestions = useMemo(() => {
    const p = norm(rxManual.patient);
    const m = norm(rxManual.medicine);
    const mc = dig(rxManual.medicare);
    const dt = dig(rxManual.date);
    if (!p && !m && !mc && !dt) return [];
    return scripts.filter((script) => {
      const patientOk = !p || norm(script.patient).includes(p);
      const medOk = !m || norm(script.medicine).includes(m);
      const medicareOk = !mc || dig(script.medicare).includes(mc);
      const dateOk = !dt || dig(auDate(script.dispenseDate)).includes(dt) || dig(script.dispenseDate).includes(dt);
      return patientOk && medOk && medicareOk && dateOk;
    }).slice(0, 12);
  }, [scripts, rxManual]);

  const tableRows = useMemo(() => {
    if (tableMode === "matched") return matchedScans.map((scan) => ({ Status: "MATCHED", Label: scan.value, Script: scan.record?.scriptNumber || "", Patient: scan.record?.patient || "", Date: auDate(scan.record?.dispenseDate || ""), Medicine: scan.record?.medicine || "", Medicare: scan.record?.medicare || "", Time: fmt(scan.savedAt) }));
    if (tableMode === "unmatchedLabels") return unmatchedScans.map((scan) => ({ Status: "UNMATCHED_LABEL", Label: scan.value, Script: "", Patient: "", Date: "", Medicine: "", Medicare: "", Time: fmt(scan.savedAt) }));
    return unmatchedScripts.map((script) => ({ Status: "SCRIPT_WITHOUT_LABEL", Label: "", Script: script.scriptNumber, Patient: script.patient, Date: auDate(script.dispenseDate), Medicine: script.medicine, Medicare: script.medicare || "", Time: "" }));
  }, [tableMode, matchedScans, unmatchedScans, unmatchedScripts]);

  async function upload(file: File) {
    setUploadState({ active: true, percent: 5, label: `Selected ${file.name}` });
    await frame();
    try {
      setUploadState({ active: true, percent: 25, label: "Reading FRED Excel..." });
      const incoming = await parseFredFile(file);
      await frame();
      if (incoming.length === 0) { setUploadState({ active: false, percent: 0, label: "" }); setMessage("No script rows found. This must be the FRED List of Scripts export with Script Number."); return; }
      setUploadState({ active: true, percent: 60, label: `Found ${incoming.length} scripts. Merging...` });
      await frame();
      const map = new Map(scripts.map((r) => [r.scriptNumber, r]));
      let updated = 0;
      for (const rec of incoming) { if (!rec.scriptNumber) continue; if (map.has(rec.scriptNumber)) updated += 1; map.set(rec.scriptNumber, rec); }
      const merged = [...map.values()].sort((a, b) => dateValue(a.dispenseDate) - dateValue(b.dispenseDate));
      const fileRange = rangeLabel(incoming);
      const batch = { fileName: file.name, uploadedAt: new Date().toISOString(), from: fileRange.from, to: fileRange.to, imported: incoming.length, updated, total: merged.length };
      setUploadState({ active: true, percent: 90, label: "Saving to IndexedDB..." });
      await idbSet(SCRIPT_KEY, merged);
      await idbSet(BATCH_KEY, [batch, ...batches]);
      setScripts(merged); setBatches((old) => [batch, ...old]);
      setMessage(`Scripts from ${fileRange.from || "?"} to ${fileRange.to || "?"} uploaded. Master total: ${merged.length}.`);
      setUploadState({ active: true, percent: 100, label: `Uploaded. Master total ${merged.length}.` });
      window.setTimeout(() => setUploadState({ active: false, percent: 0, label: "" }), 1800);
    } catch (e) {
      setUploadState({ active: false, percent: 0, label: "" });
      setMessage(e instanceof Error ? `Upload failed: ${e.message}` : "Upload failed.");
    }
  }
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOn(true);
      setMessage(window.BarcodeDetector ? "Label camera ready. Put only the barcode inside the rectangle." : "Camera on, but BarcodeDetector unavailable. Use manual fallback.");
    } catch { setMessage("Camera permission denied or no camera found."); }
  }
  async function startPrescriptionScanner() {
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      rxStreamRef.current = stream;
      if (rxVideoRef.current) rxVideoRef.current.srcObject = stream;
      setRxCameraOn(true);
      setRxMessage("Live prescription scanner is running. Show the whole prescription page, then move to the next one. AI/OCR live extraction will use this feed next.");
    } catch { setRxMessage("Prescription scanner camera permission denied or no camera found."); }
  }
  function stopCamera() { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCameraOn(false); }
  function stopPrescriptionScanner() { rxStreamRef.current?.getTracks().forEach((t) => t.stop()); rxStreamRef.current = null; setRxCameraOn(false); setRxMessage("Prescription scanner stopped."); }
  function confirm() {
    const v = value.trim(); if (!v) return;
    const rec = findScript(scripts, v);
    const scan: Scan = { value: v, savedAt: new Date().toISOString(), status: rec ? "matched" : "unmatched", record: rec };
    setScans((old) => [scan, ...old.filter((s) => norm(s.value) !== norm(v))]);
    setLast(scan); setManual(""); setDetected(""); setMessage(rec ? `${v} confirmed. Continue labels or open Stage 2 prescription scanner.` : `${v} saved as unmatched.`);
  }
  function clearScans() { setScans([]); setLast(null); void idbDel(SCAN_KEY); }
  function clearMaster() { setScripts([]); setBatches([]); void idbDel(SCRIPT_KEY); void idbDel(BATCH_KEY); setMessage("FRED master cleared."); }
  function selectPrescription(script: ScriptRec) {
    setRxManual({ patient: script.patient, date: auDate(script.dispenseDate), medicine: script.medicine, medicare: script.medicare || "" });
    setRxMessage(`Selected script ${script.scriptNumber} for ${script.patient}.`);
  }

  return <main className="min-h-screen bg-slate-950 px-4 py-4 text-slate-100 sm:px-6 lg:px-8"><section className="mx-auto flex max-w-7xl flex-col gap-4">
    <header className="rounded-3xl border border-white/10 bg-white/10 p-5 shadow-2xl"><p className="text-xs font-bold uppercase tracking-[0.3em] text-emerald-300">Pharmacy Verification</p><h1 className="mt-2 text-2xl font-black text-white sm:text-4xl">Label scan + prescription verification</h1><p className="mt-3 text-sm leading-7 text-slate-300">Master file: {scripts.length ? `Scripts from ${masterRange.from} to ${masterRange.to}` : "no FRED file uploaded yet"}</p></header>
    <section className="grid gap-3 sm:grid-cols-4"><button onClick={() => setTableMode("unmatchedScripts")} className="rounded-2xl bg-white p-4 text-left text-slate-950"><p className="text-2xl font-black">{scripts.length}</p><p className="text-xs text-slate-500">Master scripts</p></button><button onClick={() => setTableMode("matched")} className="rounded-2xl bg-emerald-100 p-4 text-left text-emerald-950"><p className="text-2xl font-black">{matchedScans.length}</p><p className="text-xs">Matched labels</p></button><button onClick={() => setTableMode("unmatchedLabels")} className="rounded-2xl bg-amber-100 p-4 text-left text-amber-950"><p className="text-2xl font-black">{unmatchedScans.length}</p><p className="text-xs">Unmatched labels</p></button><button onClick={() => setTableMode("unmatchedScripts")} className="rounded-2xl bg-white/10 p-4 text-left text-white"><p className="truncate text-sm font-black">{batches[0]?.fileName || "No upload"}</p><p className="text-xs text-slate-400">Last file</p></button></section>
    <section className="rounded-3xl bg-emerald-50 p-4 text-slate-950 shadow-xl ring-4 ring-emerald-300/40"><h2 className="mb-3 text-xl font-black">Stage 1 — Label barcode scan</h2><div className="grid gap-4 lg:grid-cols-[280px_1fr]"><div><div className="relative overflow-hidden rounded-2xl border-4 border-emerald-500 bg-black"><video ref={videoRef} className="h-36 w-full object-cover sm:h-44" autoPlay muted playsInline /><div className="pointer-events-none absolute inset-x-8 top-1/2 h-14 -translate-y-1/2 rounded-xl border-4 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]" /></div><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={startCamera} className="rounded-2xl bg-emerald-600 px-4 py-3 font-black text-white">Start label camera</button><button onClick={stopCamera} className="rounded-2xl border bg-white px-4 py-3 font-bold">Stop</button></div></div><div className="flex flex-col gap-3"><div className="rounded-3xl bg-white p-4"><p className="text-xs font-bold uppercase tracking-widest text-slate-500">Scanned label / script number</p><p className="mt-2 min-h-10 break-all text-3xl font-black">{value || "Waiting for label barcode..."}</p></div><div className="rounded-3xl bg-white p-4"><h2 className="text-xl font-black">{value ? "Current FRED match" : "Last confirmed label"}</h2>{preview?.record ? <div className="mt-3 space-y-2 text-sm"><p className="rounded-2xl bg-emerald-100 p-3 font-black text-emerald-900">{value ? "Matched preview" : "Matched and saved"}</p><p><strong>Patient:</strong> {preview.record.patient || "-"}</p><p><strong>Date:</strong> {auDate(preview.record.dispenseDate) || "-"}</p><p><strong>Medicine:</strong> {preview.record.medicine || "-"}</p><p><strong>Script:</strong> {preview.record.scriptNumber || "-"}</p></div> : preview ? <p className="mt-3 rounded-2xl bg-rose-100 p-3 text-sm font-bold text-rose-900">No matching script in FRED master.</p> : <p className="mt-3 rounded-2xl bg-slate-100 p-3 text-sm font-bold text-slate-600">Scan a label.</p>}</div><button onClick={confirm} disabled={!value.trim()} className="rounded-3xl bg-emerald-600 px-8 py-4 text-xl font-black text-white disabled:opacity-40">Confirm label</button></div></div></section>
    <details className="rounded-3xl bg-white p-4 text-slate-950 shadow-xl"><summary className="cursor-pointer text-lg font-black">Manual label fallback</summary><div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]"><input value={manual} onChange={(e) => { setManual(e.target.value); setDetected(""); }} onKeyDown={(e) => { if (e.key === "Enter") confirm(); }} placeholder="Type script / label number manually" className="rounded-2xl border-2 px-4 py-4 text-xl font-black" /><button onClick={confirm} disabled={!value.trim()} className="rounded-2xl bg-slate-950 px-6 py-4 font-black text-white disabled:opacity-40">Confirm</button></div></details>
    <section className="rounded-3xl bg-white p-4 text-slate-950 shadow-xl"><h2 className="text-xl font-black">Stage 2 — Live prescription scanner</h2><p className="mt-2 text-sm text-slate-600">This is for the full original prescription, not barcode. Keep the camera running and move from prescription to prescription.</p><div className="mt-4 grid gap-4 lg:grid-cols-[280px_1fr]"><div><div className="overflow-hidden rounded-2xl border-4 border-slate-950 bg-black"><video ref={rxVideoRef} className="h-36 w-full object-contain sm:h-44" autoPlay muted playsInline /></div><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={startPrescriptionScanner} className="rounded-2xl bg-slate-950 px-4 py-3 font-black text-white">Start prescription</button><button onClick={stopPrescriptionScanner} disabled={!rxCameraOn} className="rounded-2xl border px-4 py-3 font-black disabled:opacity-40">Stop</button></div></div><div className="rounded-3xl bg-slate-100 p-4 text-sm font-bold text-slate-700">{rxMessage}</div></div></section>
    <details className="rounded-3xl bg-white p-4 text-slate-950 shadow-xl" open><summary className="cursor-pointer text-lg font-black">Manual prescription entry</summary><div className="relative mt-4 grid gap-3 sm:grid-cols-4"><input value={rxManual.patient} onChange={(e) => setRxManual({ ...rxManual, patient: e.target.value })} placeholder="Patient name" className="rounded-2xl border-2 px-4 py-3 font-bold" /><input value={rxManual.date} onChange={(e) => setRxManual({ ...rxManual, date: e.target.value })} placeholder="Prescription date" className="rounded-2xl border-2 px-4 py-3 font-bold" /><input value={rxManual.medicine} onChange={(e) => setRxManual({ ...rxManual, medicine: e.target.value })} placeholder="Medicine" className="rounded-2xl border-2 px-4 py-3 font-bold" /><input value={rxManual.medicare} onChange={(e) => setRxManual({ ...rxManual, medicare: e.target.value })} placeholder="Medicare number" className="rounded-2xl border-2 px-4 py-3 font-bold" /></div>{rxSuggestions.length > 0 && <div className="mt-3 max-h-80 overflow-auto rounded-3xl border bg-white p-3 shadow-xl"><p className="mb-2 text-sm font-black text-slate-600">Live matches from FRED — choose the matching label/script</p>{rxSuggestions.map((script) => <button key={script.scriptNumber} onClick={() => selectPrescription(script)} className="mb-2 block w-full rounded-2xl border p-3 text-left hover:bg-emerald-50"><div className="flex flex-wrap items-center justify-between gap-2"><strong>Script {script.scriptNumber}</strong><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black">{auDate(script.dispenseDate)}</span></div><p className="mt-1 text-sm"><strong>{script.patient}</strong> | {script.medicine}</p>{script.medicare && <p className="mt-1 text-xs text-slate-500">Medicare: {script.medicare}</p>}</button>)}</div>}<p className="mt-3 rounded-2xl bg-slate-100 p-3 text-sm font-bold text-slate-700">Start typing patient name, medicine, date, or Medicare. Matching FRED scripts appear live with script/label numbers.</p></details>
    <section className="rounded-3xl bg-white p-5 text-slate-950 shadow-xl"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-2xl font-black">Review table</h2><p className="text-sm text-slate-600">Current view: {tableMode === "matched" ? "matched labels" : tableMode === "unmatchedLabels" ? "unmatched label scans" : "FRED scripts without matched label"}</p></div><button onClick={() => downloadCsv(`${tableMode}-pharmacy-verification.csv`, tableRows)} disabled={tableRows.length === 0} className="rounded-full bg-slate-950 px-5 py-3 text-sm font-black text-white disabled:opacity-40">Export table to Excel CSV</button></div><div className="mt-4 flex flex-wrap gap-2"><button onClick={() => setTableMode("matched")} className="rounded-full border px-4 py-2 text-sm font-black">Matched</button><button onClick={() => setTableMode("unmatchedLabels")} className="rounded-full border px-4 py-2 text-sm font-black">Unmatched labels</button><button onClick={() => setTableMode("unmatchedScripts")} className="rounded-full border px-4 py-2 text-sm font-black">Scripts without label</button></div><div className="mt-4 max-h-[520px] overflow-auto rounded-2xl border"><table className="w-full min-w-[900px] text-left text-sm"><thead className="sticky top-0 bg-slate-100"><tr>{["Status", "Label", "Script", "Patient", "Date", "Medicine", "Medicare", "Time"].map((h) => <th key={h} className="p-3 font-black">{h}</th>)}</tr></thead><tbody>{tableRows.length === 0 ? <tr><td colSpan={8} className="p-5 text-center text-slate-500">No rows in this view.</td></tr> : tableRows.map((row, index) => <tr key={index} className="border-t"><td className="p-3 font-black">{row.Status}</td><td className="p-3">{row.Label}</td><td className="p-3">{row.Script}</td><td className="p-3">{row.Patient}</td><td className="p-3">{row.Date}</td><td className="p-3">{row.Medicine}</td><td className="p-3">{row.Medicare}</td><td className="p-3">{row.Time}</td></tr>)}</tbody></table></div><div className="mt-4 flex justify-end"><button onClick={clearScans} className="rounded-full border border-rose-200 px-4 py-2 text-sm font-bold text-rose-700">Clear scans</button></div></section>
    <footer className="rounded-3xl bg-white/10 p-4 text-center"><input type="file" accept=".xlsx,.xls,.csv,.tsv,.txt" disabled={uploadState.active} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.currentTarget.value = ""; }} className="block w-full rounded-2xl bg-white p-4 text-sm font-black text-slate-950 file:mr-4 file:rounded-full file:border-0 file:bg-emerald-600 file:px-5 file:py-3 file:font-black file:text-white disabled:opacity-50" />{uploadState.active && <div className="mt-4 rounded-2xl bg-white p-4 text-left text-slate-950"><div className="flex items-center justify-between text-sm font-black"><span>{uploadState.label}</span><span>{uploadState.percent}%</span></div><div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${uploadState.percent}%` }} /></div></div>}{batches.length > 0 && <p className="mt-3 text-sm text-slate-300">Last upload: Scripts from {batches[0].from} to {batches[0].to} uploaded. Master total: {batches[0].total}</p>}<div>{batches.length > 0 && <button onClick={clearMaster} className="mt-3 text-xs font-bold text-rose-300">Clear uploaded FRED master</button>}</div></footer>
  </section></main>;
}
