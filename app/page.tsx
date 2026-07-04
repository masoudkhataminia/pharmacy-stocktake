"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type ScriptRec = {
  scriptNumber: string;
  dispenseDate: string;
  patient: string;
  medicine: string;
  quantity: string;
  medicare?: string;
};

type Scan = {
  value: string;
  savedAt: string;
  status: "matched" | "unmatched";
  record?: ScriptRec;
  documentType?: DocumentType;
};

type DocumentType = "DISPENSED_LABEL" | "REPEAT_AUTHORISATION" | "PRESCRIPTION_COPY" | "ORIGINAL_PRESCRIPTION" | "UNKNOWN_DOCUMENT";
type ScanMode = "dispensed_copy" | "original_script";
type TableMode = "matched" | "unmatchedDispensed" | "unmatchedOriginals";
type ScannerControls = { stop: () => void };
type RawRow = Record<string, string>;
type ReviewRow = Record<string, string>;

type OriginalEntry = {
  id: string;
  savedAt: string;
  source: "manual" | "fred-search" | "scanner";
  scriptNumber?: string;
  patient: string;
  address?: string;
  date: string;
  medicine: string;
  medicare: string;
  quantity?: string;
  repeats?: string;
  directions?: string;
  documentType?: DocumentType;
  warning?: string;
  itemIndex?: number;
};

type Batch = { fileName: string; uploadedAt: string; from: string; to: string; imported: number; updated: number; total: number };
type ManualOriginal = { patient: string; date: string; medicine: string; medicare: string };
type AiMedicine = { medicine?: string; labelNumber?: string; quantity?: string; repeats?: string; directions?: string; confidence?: number };
type RecentItem = { kind: "Dispensed" | "Original"; title: string; subtitle: string; time: string };
type ServerState = { scripts: ScriptRec[]; scans: Scan[]; originals: OriginalEntry[]; batches: Batch[] };

const DB = "pharmacy-verification-db";
const SCRIPT_KEY = "fred-master-scripts-v3";
const SCAN_KEY = "fred-label-scans-v3";
const ORIGINAL_KEY = "prescription-entries-v2";
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
const cleanLabel = (v: unknown) => String(v ?? "").trim().replace(/^[\s(]+/g, "").trim();
const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const isLikelyAddress = (v: string) => /\b(st|street|rd|road|ave|avenue|dr|drive|ct|court|unit|apt|darwin|nt|qld|nsw|vic|wa|sa|tas|act)\b/i.test(v) || /\d+\s+[a-z]/i.test(v);
const docLabel = (type?: DocumentType) => type ? type.replace(/_/g, " ") : "UNKNOWN DOCUMENT";

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
function medLooksSame(a = "", b = "") {
  const na = norm(a), nb = norm(b);
  return !na || !nb || na.includes(nb) || nb.includes(na);
}
function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function downloadCsv(fileName: string, rows: ReviewRow[]) {
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

async function loadServerState(): Promise<ServerState> {
  const response = await fetch("/api/server-state", { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "Server storage failed");
  const state = data.state || {};
  return {
    scripts: Array.isArray(state.scripts) ? state.scripts : [],
    scans: Array.isArray(state.scans) ? state.scans : [],
    originals: Array.isArray(state.originals) ? state.originals : [],
    batches: Array.isArray(state.batches) ? state.batches : [],
  };
}

async function saveServerState(patch: Partial<ServerState>) {
  const response = await fetch("/api/server-save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "Server save failed");
}
const fmt = (v: string) => new Intl.DateTimeFormat("en-AU", { dateStyle: "short", timeStyle: "short" }).format(new Date(v));

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const zxingControlsRef = useRef<ScannerControls | null>(null);
  const [scripts, setScripts] = useState<ScriptRec[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [originals, setOriginals] = useState<OriginalEntry[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [manual, setManual] = useState("");
  const [detected, setDetected] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [scannerBusy, setScannerBusy] = useState(false);
  const [last, setLast] = useState<Scan | null>(null);
  const [mode, setMode] = useState<ScanMode>("dispensed_copy");
  const [message, setMessage] = useState("Choose Scan Dispensed Copy or Scan Original Script. Do not mix the two modes.");
  const [toast, setToast] = useState("");
  const [flash, setFlash] = useState(false);
  const [uploadState, setUploadState] = useState({ active: false, percent: 0, label: "" });
  const [manualOriginal, setManualOriginal] = useState<ManualOriginal>({ patient: "", date: "", medicine: "", medicare: "" });
  const [tableMode, setTableMode] = useState<TableMode>("matched");
  const [hydrated, setHydrated] = useState(false);
  const [serverOnline, setServerOnline] = useState(false);

  function notify(text: string) {
    setToast(text);
    setMessage(text);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 850);
    window.setTimeout(() => setToast(""), 2600);
  }

  useEffect(() => { void (async () => {
    try {
      const state = await loadServerState();
      setScripts(state.scripts);
      setScans(state.scans);
      setOriginals(state.originals);
      setBatches(state.batches);
      setLast(state.scans[0] ?? null);
      setServerOnline(true);
      notify("Server storage loaded. Shared across devices.");
    } catch {
      const s = await idbGet<ScriptRec[]>(SCRIPT_KEY, []);
      const sc = await idbGet<Scan[]>(SCAN_KEY, []);
      const p = await idbGet<OriginalEntry[]>(ORIGINAL_KEY, []);
      const b = await idbGet<Batch[]>(BATCH_KEY, []);
      setScripts(s); setScans(sc); setOriginals(p); setBatches(b); setLast(sc[0] ?? null);
      setServerOnline(false);
      notify("Server storage unavailable. Using this browser backup only.");
    } finally {
      setHydrated(true);
    }
  })(); }, []);
  useEffect(() => { if (!hydrated) return; void idbSet(SCRIPT_KEY, scripts); void saveServerState({ scripts }).then(() => setServerOnline(true)).catch(() => setServerOnline(false)); }, [hydrated, scripts]);
  useEffect(() => { if (!hydrated) return; void idbSet(SCAN_KEY, scans); void saveServerState({ scans }).then(() => setServerOnline(true)).catch(() => setServerOnline(false)); }, [hydrated, scans]);
  useEffect(() => { if (!hydrated) return; void idbSet(ORIGINAL_KEY, originals); void saveServerState({ originals }).then(() => setServerOnline(true)).catch(() => setServerOnline(false)); }, [hydrated, originals]);
  useEffect(() => { if (!hydrated) return; void idbSet(BATCH_KEY, batches); void saveServerState({ batches }).then(() => setServerOnline(true)).catch(() => setServerOnline(false)); }, [hydrated, batches]);
  useEffect(() => () => { zxingControlsRef.current?.stop(); streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  const value = cleanLabel(detected || manual);
  const current = useMemo(() => findScript(scripts, value), [scripts, value]);
  const matchedPairs = useMemo(() => scans.filter((s) => s.record?.scriptNumber && originals.some((p) => p.scriptNumber === s.record?.scriptNumber && medLooksSame(p.medicine, s.record?.medicine))), [scans, originals]);
  const unmatchedDispensed = useMemo(() => scans.filter((s) => !s.record?.scriptNumber || !originals.some((p) => p.scriptNumber === s.record?.scriptNumber && medLooksSame(p.medicine, s.record?.medicine))), [scans, originals]);
  const unmatchedOriginals = useMemo(() => originals.filter((p) => !p.scriptNumber || !scans.some((s) => s.record?.scriptNumber === p.scriptNumber && medLooksSame(p.medicine, s.record?.medicine))), [originals, scans]);
  const masterRange = rangeLabel(scripts);
  const preview: Scan | null = value ? { value, savedAt: new Date().toISOString(), status: current ? "matched" : "unmatched", record: current } : last;
  const originalSuggestions = useMemo(() => {
    const p = norm(manualOriginal.patient), m = norm(manualOriginal.medicine), mc = dig(manualOriginal.medicare), dt = dig(manualOriginal.date);
    if (!p && !m && !mc && !dt) return [];
    return scripts.filter((script) => (!p || norm(script.patient).includes(p)) && (!m || norm(script.medicine).includes(m)) && (!mc || dig(script.medicare).includes(mc)) && (!dt || dig(auDate(script.dispenseDate)).includes(dt) || dig(script.dispenseDate).includes(dt))).slice(0, 12);
  }, [scripts, manualOriginal]);

  const tableRows = useMemo<ReviewRow[]>(() => {
    if (tableMode === "matched") return matchedPairs.map((scan) => {
      const rx = originals.find((p) => p.scriptNumber === scan.record?.scriptNumber && medLooksSame(p.medicine, scan.record?.medicine));
      return { Status: "MATCHED", DispensedCopy: scan.value, Script: scan.record?.scriptNumber || "", Patient: scan.record?.patient || rx?.patient || "", Address: rx?.address || "", Date: auDate(scan.record?.dispenseDate || rx?.date || ""), Medicine: scan.record?.medicine || rx?.medicine || "", DocumentType: rx?.documentType || scan.documentType || "", DispensedTime: fmt(scan.savedAt), OriginalTime: rx ? fmt(rx.savedAt) : "" };
    });
    if (tableMode === "unmatchedDispensed") return unmatchedDispensed.map((scan) => ({ Status: "UNMATCHED_DISPENSED_COPY", DispensedCopy: scan.value, Script: scan.record?.scriptNumber || "", Patient: scan.record?.patient || "", Address: "", Date: auDate(scan.record?.dispenseDate || ""), Medicine: scan.record?.medicine || "", DocumentType: scan.documentType || "", DispensedTime: fmt(scan.savedAt), OriginalTime: "" }));
    return unmatchedOriginals.map((rx) => ({ Status: "UNMATCHED_ORIGINAL_SCRIPT", DispensedCopy: "", Script: rx.scriptNumber || "", Patient: rx.patient, Address: rx.address || "", Date: auDate(rx.date), Medicine: rx.medicine, DocumentType: rx.documentType || "", DispensedTime: "", OriginalTime: fmt(rx.savedAt) }));
  }, [tableMode, matchedPairs, unmatchedDispensed, unmatchedOriginals, originals]);

  const recentItems = useMemo<RecentItem[]>(() => {
    const dispensedItems = scans.map((s) => ({ kind: "Dispensed" as const, title: s.value, subtitle: s.record ? `${s.record.patient || "-"} | ${s.record.medicine || "-"}` : "No FRED match yet", time: s.savedAt }));
    const originalItems = originals.map((p) => ({ kind: "Original" as const, title: p.scriptNumber || p.patient || "Original saved", subtitle: `${p.patient || "-"} | ${p.medicine || "-"}${p.documentType ? ` | ${docLabel(p.documentType)}` : ""}`, time: p.savedAt }));
    return [...dispensedItems, ...originalItems].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 3);
  }, [scans, originals]);

  async function upload(file: File) {
    setUploadState({ active: true, percent: 5, label: `Selected ${file.name}` });
    await sleep(40);
    try {
      setUploadState({ active: true, percent: 25, label: "Reading FRED Excel..." });
      const incoming = await parseFredFile(file);
      if (incoming.length === 0) { setUploadState({ active: false, percent: 0, label: "" }); notify("No script rows found in FRED export."); return; }
      const map = new Map(scripts.map((r) => [r.scriptNumber, r]));
      let updated = 0;
      for (const rec of incoming) { if (!rec.scriptNumber) continue; if (map.has(rec.scriptNumber)) updated += 1; map.set(rec.scriptNumber, rec); }
      const merged = [...map.values()].sort((a, b) => dateValue(a.dispenseDate) - dateValue(b.dispenseDate));
      const fileRange = rangeLabel(incoming);
      const batch = { fileName: file.name, uploadedAt: new Date().toISOString(), from: fileRange.from, to: fileRange.to, imported: incoming.length, updated, total: merged.length };
      setUploadState({ active: true, percent: 90, label: "Saving master..." });
      await idbSet(SCRIPT_KEY, merged);
      await idbSet(BATCH_KEY, [batch, ...batches]);
      setScripts(merged); setBatches((old) => [batch, ...old]);
      notify(`FRED uploaded: ${fileRange.from || "?"} to ${fileRange.to || "?"}. Total ${merged.length}.`);
      setUploadState({ active: true, percent: 100, label: `Uploaded. Master total ${merged.length}.` });
      window.setTimeout(() => setUploadState({ active: false, percent: 0, label: "" }), 1600);
    } catch (e) {
      setUploadState({ active: false, percent: 0, label: "" });
      notify(e instanceof Error ? `Upload failed: ${e.message}` : "Upload failed.");
    }
  }

  async function startScanner(nextMode?: ScanMode) {
    const selected = nextMode || mode;
    setMode(selected);
    if (!videoRef.current) return;
    stopScanner();
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.ITF, BarcodeFormat.QR_CODE]);
      const reader = new BrowserMultiFormatReader(hints);
      const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
        const raw = result?.getText?.()?.trim();
        const val = cleanLabel(raw);
        if (val) {
          setDetected((old) => { if (old !== val) setMessage(raw !== val ? `Barcode detected and cleaned: ${raw} → ${val}` : `Barcode detected: ${val}`); return val; });
          setManual("");
        }
      });
      zxingControlsRef.current = controls;
      setCameraOn(true);
      setMessage(selected === "dispensed_copy" ? "Scan Dispensed Copy mode: barcode saves label; no barcode uses AI for repeat authorisation / patient copy." : "Scan Original Script mode: use AI if this is the original prescription. Do not use repeat authorisation here.");
    } catch {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        setCameraOn(true);
        setMessage("Camera opened, but barcode decoder failed. AI scan and manual entry still work.");
      } catch {
        notify("Camera permission denied or no camera found.");
      }
    }
  }

  function stopScanner() {
    zxingControlsRef.current?.stop();
    zxingControlsRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  function saveDispensedCopy(documentType: DocumentType = "DISPENSED_LABEL", forcedValue?: string) {
    const v = cleanLabel(forcedValue ?? value);
    if (!v) return false;
    const rec = findScript(scripts, v);
    const already = scans.some((s) => norm(s.value) === norm(v));
    const scan: Scan = { value: v, savedAt: new Date().toISOString(), status: rec ? "matched" : "unmatched", record: rec, documentType };
    setScans((old) => [scan, ...old.filter((s) => norm(s.value) !== norm(v))]);
    setLast(scan);
    setManual(""); setDetected("");
    notify(already ? `Duplicate dispensed copy updated: ${v}` : rec ? `Dispensed copy saved: ${v} | ${rec.patient || "patient found"} | ${rec.medicine || "medicine"}` : `Dispensed copy saved as unmatched: ${v}`);
    return true;
  }

  function originalKey(entry: Omit<OriginalEntry, "id" | "savedAt"> | OriginalEntry) {
    return entry.scriptNumber ? `script:${entry.scriptNumber}:${norm(entry.medicine)}` : `free:${norm(entry.patient)}:${dig(entry.date)}:${norm(entry.medicine)}:${dig(entry.medicare)}`;
  }
  function saveOriginalEntries(entries: Omit<OriginalEntry, "id" | "savedAt">[]) {
    if (entries.length === 0) { notify("AI could not read a medicine item. Try closer/clearer scan."); return; }
    let duplicateCount = 0;
    const next = entries.map((entry) => ({ ...entry, id: id(), savedAt: new Date().toISOString() }));
    setOriginals((old) => {
      const incomingKeys = new Set(next.map(originalKey));
      duplicateCount = old.filter((p) => incomingKeys.has(originalKey(p))).length;
      return [...next, ...old.filter((p) => !incomingKeys.has(originalKey(p)))];
    });
    const warning = next.find((entry) => entry.warning)?.warning;
    notify(`${next.length} original script item${next.length > 1 ? "s" : ""} saved${duplicateCount ? ` (${duplicateCount} duplicate updated)` : ""}.${warning ? ` Warning: ${warning}` : ""}`);
  }
  function saveOriginalEntry(entry: Omit<OriginalEntry, "id" | "savedAt">) { saveOriginalEntries([entry]); }

  async function scanDocumentWithAi(scanMode: ScanMode) {
    if (!videoRef.current || !cameraOn) { notify("Open camera first."); return; }
    setScannerBusy(true);
    setMode(scanMode);
    setMessage(scanMode === "dispensed_copy" ? "AI is reading dispensed copy / repeat authorisation..." : "AI is reading original prescription...");
    try {
      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(video.videoWidth || 1280, 1600);
      canvas.height = Math.round(canvas.width * ((video.videoHeight || 720) / (video.videoWidth || 1280)));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Cannot capture scanner frame");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL("image/jpeg", 0.78);
      const response = await fetch("/api/ai-detect-prescription", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image, mode: scanMode }) });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "AI detection failed");
      const r = data.result || {};
      const documentType = (r.documentType || "UNKNOWN_DOCUMENT") as DocumentType;
      const warning = String(r.warning || "").trim();
      if (warning) notify(warning);
      const patientRaw = String(r.patient || "").trim();
      const patient = isLikelyAddress(patientRaw) ? "" : patientRaw;
      const address = String(r.address || (isLikelyAddress(patientRaw) ? patientRaw : "")).trim();
      const meds: AiMedicine[] = Array.isArray(r.medicines) && r.medicines.length ? r.medicines : (r.medicine ? [{ medicine: r.medicine }] : []);
      const baseScript = cleanLabel(r.scriptNumber);

      if (scanMode === "dispensed_copy") {
        const scriptFromAi = baseScript || cleanLabel(meds.find((med) => med.labelNumber)?.labelNumber);
        if (scriptFromAi) {
          setManual(scriptFromAi);
          setDetected("");
          saveDispensedCopy(documentType, scriptFromAi);
          return;
        }
        const entries = meds.map((med, index) => ({
          source: "scanner" as const,
          scriptNumber: undefined,
          patient,
          address,
          date: auDate(r.date || ""),
          medicine: String(med.medicine || ""),
          medicare: r.medicare || "",
          quantity: med.quantity || "",
          repeats: med.repeats || "",
          directions: med.directions || "",
          documentType,
          warning,
          itemIndex: index + 1,
        })).filter((e) => e.medicine || e.patient);
        saveOriginalEntries(entries);
        return;
      }

      const entries = meds.map((med, index) => {
        const labelNo = cleanLabel(med.labelNumber);
        const cleanScript = labelNo || baseScript;
        const rec = cleanScript ? findScript(scripts, cleanScript) : undefined;
        return {
          source: "scanner" as const,
          scriptNumber: rec?.scriptNumber || cleanScript || undefined,
          patient: rec?.patient || patient,
          address,
          date: auDate(rec?.dispenseDate || r.date || ""),
          medicine: rec?.medicine || String(med.medicine || ""),
          medicare: rec?.medicare || r.medicare || "",
          quantity: med.quantity || "",
          repeats: med.repeats || "",
          directions: med.directions || "",
          documentType,
          warning,
          itemIndex: index + 1,
        };
      }).filter((e) => e.medicine || e.scriptNumber || e.patient);
      if (entries[0]) setManualOriginal({ patient: entries[0].patient, date: entries[0].date, medicine: entries[0].medicine, medicare: entries[0].medicare });
      saveOriginalEntries(entries);
    } catch (e) {
      notify(e instanceof Error ? `AI scan failed: ${e.message}` : "AI scan failed.");
    } finally {
      setScannerBusy(false);
    }
  }

  function saveCurrentScan() {
    if (mode === "dispensed_copy") {
      if (value.trim()) { saveDispensedCopy("DISPENSED_LABEL", value); return; }
      void scanDocumentWithAi("dispensed_copy");
      return;
    }
    void scanDocumentWithAi("original_script");
  }

  function saveManualOriginal() {
    saveOriginalEntry({ source: "manual", patient: manualOriginal.patient.trim(), address: "", date: manualOriginal.date.trim(), medicine: manualOriginal.medicine.trim(), medicare: manualOriginal.medicare.trim(), documentType: "ORIGINAL_PRESCRIPTION" });
  }
  function selectOriginal(script: ScriptRec) {
    const entry = { source: "fred-search" as const, scriptNumber: script.scriptNumber, patient: script.patient, address: "", date: auDate(script.dispenseDate), medicine: script.medicine, medicare: script.medicare || "", documentType: "ORIGINAL_PRESCRIPTION" as DocumentType };
    setManualOriginal({ patient: entry.patient, date: entry.date, medicine: entry.medicine, medicare: entry.medicare });
    saveOriginalEntry(entry);
  }
  function clearScans() { setScans([]); setLast(null); void idbDel(SCAN_KEY); notify("Dispensed copy scans cleared."); }
  function clearOriginals() { setOriginals([]); void idbDel(ORIGINAL_KEY); notify("Original script scans cleared."); }
  function clearMaster() { setScripts([]); setBatches([]); void idbDel(SCRIPT_KEY); void idbDel(BATCH_KEY); notify("FRED master cleared."); }

  return <main className="min-h-screen bg-slate-950 px-4 py-4 text-slate-100 sm:px-6 lg:px-8"><section className="mx-auto flex max-w-7xl flex-col gap-4">
    {toast && <div className="fixed inset-x-4 top-5 z-50 mx-auto max-w-xl rounded-3xl bg-emerald-600 px-5 py-4 text-center text-lg font-black text-white shadow-2xl ring-4 ring-emerald-200">✓ {toast}</div>}
    <header className="rounded-3xl border border-white/10 bg-white/10 p-5 shadow-2xl">
      <p className="text-xs font-bold uppercase tracking-[0.3em] text-emerald-300">Owing Script Matcher</p>
      <h1 className="mt-2 text-2xl font-black text-white sm:text-4xl">Match dispensed copies to original scripts</h1>
      <p className="mt-3 text-sm leading-7 text-slate-300">{scripts.length ? `FRED scripts from ${masterRange.from} to ${masterRange.to}` : "Upload FRED file at the bottom first."}</p>
      <p className="mt-2 rounded-2xl bg-white/10 p-3 text-sm font-bold text-slate-200">{message}</p>
    </header>

    <section className="grid gap-3 sm:grid-cols-4">
      <button onClick={() => setTableMode("unmatchedDispensed")} className="rounded-2xl bg-white p-4 text-left text-slate-950"><p className="text-2xl font-black">{scans.length}</p><p className="text-xs text-slate-500">Saved dispensed copies</p></button>
      <button onClick={() => setTableMode("matched")} className="rounded-2xl bg-emerald-100 p-4 text-left text-emerald-950"><p className="text-2xl font-black">{matchedPairs.length}</p><p className="text-xs">Matched pairs</p></button>
      <button onClick={() => setTableMode("unmatchedDispensed")} className="rounded-2xl bg-amber-100 p-4 text-left text-amber-950"><p className="text-2xl font-black">{unmatchedDispensed.length + unmatchedOriginals.length}</p><p className="text-xs">Unmatched work items</p></button>
      <button onClick={() => setTableMode("unmatchedOriginals")} className="rounded-2xl bg-white/10 p-4 text-left text-white"><p className="text-2xl font-black">{originals.length}</p><p className="text-xs text-slate-400">Saved original items</p></button>
    </section>

    <section className="rounded-3xl bg-white p-4 text-slate-950 shadow-xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-xl font-black">{tableMode === "matched" ? "Matched pairs" : tableMode === "unmatchedDispensed" ? "Unmatched dispensed copies" : "Unmatched original scripts"}</h2><p className="text-sm text-slate-500">Repeat authorisations, labels, patient copies, and originals are kept as separate document types.</p></div><button onClick={() => downloadCsv(`${tableMode}-owing-script-matcher.csv`, tableRows)} disabled={tableRows.length === 0} className="rounded-full bg-slate-950 px-5 py-3 text-sm font-black text-white disabled:opacity-40">Export CSV</button></div>
      <div className="mt-4 max-h-72 overflow-auto rounded-2xl border"><table className="w-full min-w-[980px] text-left text-sm"><thead className="sticky top-0 bg-slate-100"><tr>{["Status", "DispensedCopy", "Script", "Patient", "Address", "Date", "Medicine", "DocumentType", "DispensedTime", "OriginalTime"].map((h) => <th key={h} className="p-3 font-black">{h}</th>)}</tr></thead><tbody>{tableRows.length === 0 ? <tr><td colSpan={10} className="p-5 text-center text-slate-500">No rows yet.</td></tr> : tableRows.map((row, index) => <tr key={index} className="border-t"><td className="p-3 font-black">{row.Status}</td><td className="p-3">{row.DispensedCopy}</td><td className="p-3">{row.Script}</td><td className="p-3">{row.Patient}</td><td className="p-3">{row.Address}</td><td className="p-3">{row.Date}</td><td className="p-3">{row.Medicine}</td><td className="p-3">{row.DocumentType}</td><td className="p-3">{row.DispensedTime}</td><td className="p-3">{row.OriginalTime}</td></tr>)}</tbody></table></div>
    </section>

    <section className={`rounded-3xl bg-gradient-to-br from-emerald-50 to-white p-4 text-slate-950 shadow-xl ring-2 transition-all duration-300 ${flash ? "ring-emerald-500 shadow-emerald-300/60" : "ring-emerald-200"}`}>
      <h2 className="mb-3 text-xl font-black">Scanner</h2>
      <div className="mb-3 grid gap-2 sm:grid-cols-2"><button onClick={() => startScanner("dispensed_copy")} className={`rounded-2xl px-4 py-4 font-black text-white ${mode === "dispensed_copy" ? "bg-emerald-700" : "bg-slate-700"}`}>Scan Dispensed Copy</button><button onClick={() => startScanner("original_script")} className={`rounded-2xl px-4 py-4 font-black text-white ${mode === "original_script" ? "bg-indigo-700" : "bg-slate-700"}`}>Scan Original Script</button></div>
      <p className="mb-4 rounded-2xl bg-amber-50 p-3 text-sm font-bold text-amber-900">Dispensed Copy accepts FRED label, repeat authorisation, patient copy, no-barcode label, or prescription copy. Original Script is only for the actual original prescription.</p>
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]"><div><div className={`relative overflow-hidden rounded-3xl border-2 bg-slate-100 shadow-inner transition-all ${flash ? "border-emerald-500" : "border-emerald-300"}`}><video ref={videoRef} className="h-52 w-full object-cover" autoPlay muted playsInline /><div className="pointer-events-none absolute inset-x-10 top-1/2 h-16 -translate-y-1/2 rounded-2xl border-4 border-white/80 shadow-[0_0_0_9999px_rgba(15,23,42,0.10)]" /></div><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={() => startScanner(mode)} className="rounded-2xl bg-emerald-600 px-4 py-3 font-black text-white shadow-sm">Start</button><button onClick={stopScanner} className="rounded-2xl border bg-white px-4 py-3 font-bold shadow-sm">Stop</button></div></div>
        <div className="flex flex-col gap-3"><div className="rounded-3xl bg-white p-4 shadow-sm"><p className="text-xs font-bold uppercase tracking-widest text-slate-500">Detected barcode / script number</p><p className="mt-2 min-h-10 break-all text-3xl font-black">{value || "No barcode detected"}</p></div><button onClick={saveCurrentScan} disabled={scannerBusy || (!cameraOn && !value.trim())} className="rounded-3xl bg-slate-950 px-6 py-5 text-xl font-black text-white shadow-sm disabled:opacity-40">{scannerBusy ? "Scanning..." : mode === "dispensed_copy" ? "Save / AI Scan Dispensed Copy" : "AI Scan Original Script"}</button><div className="grid gap-3 rounded-3xl bg-slate-50 p-4 shadow-sm sm:grid-cols-2"><label className="text-sm font-bold text-slate-600">Manual script/label number<input value={manual} onChange={(e) => { setManual(e.target.value); setDetected(""); }} placeholder="e.g. 50676193" className="mt-1 w-full rounded-2xl border p-3 text-lg font-black" /></label><div className="rounded-2xl border p-3"><p className="text-xs font-bold uppercase text-slate-500">Preview</p>{preview?.record ? <div><p className="font-black text-emerald-700">FRED match found</p><p>{preview.record.patient}</p><p className="text-sm text-slate-600">{preview.record.medicine}</p><p className="text-sm text-slate-600">{auDate(preview.record.dispenseDate)}</p></div> : <p className="font-bold text-amber-700">{value ? "No FRED match yet" : "Nothing to save"}</p>}</div></div></div>
      </div>
    </section>

    <section className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-3xl bg-white p-4 text-slate-950 shadow-xl"><h2 className="text-xl font-black">Manual Original Script fallback</h2><p className="mt-1 text-sm text-slate-500">Use this only when AI cannot read handwriting.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><input value={manualOriginal.patient} onChange={(e) => setManualOriginal({ ...manualOriginal, patient: e.target.value })} placeholder="Patient name" className="rounded-2xl border p-3" /><input value={manualOriginal.date} onChange={(e) => setManualOriginal({ ...manualOriginal, date: e.target.value })} placeholder="Date dd/mm/yyyy" className="rounded-2xl border p-3" /><input value={manualOriginal.medicine} onChange={(e) => setManualOriginal({ ...manualOriginal, medicine: e.target.value })} placeholder="Medicine" className="rounded-2xl border p-3" /><input value={manualOriginal.medicare} onChange={(e) => setManualOriginal({ ...manualOriginal, medicare: e.target.value })} placeholder="Medicare optional" className="rounded-2xl border p-3" /></div><button onClick={saveManualOriginal} className="mt-3 w-full rounded-2xl bg-slate-950 px-4 py-3 font-black text-white">Save manual original</button>{originalSuggestions.length > 0 && <div className="mt-4 space-y-2"><p className="text-sm font-black">Possible FRED matches</p>{originalSuggestions.map((s) => <button key={s.scriptNumber} onClick={() => selectOriginal(s)} className="block w-full rounded-2xl border p-3 text-left hover:bg-slate-50"><b>{s.scriptNumber}</b> | {s.patient}<br /><span className="text-sm text-slate-500">{s.medicine}</span></button>)}</div>}</div>
      <div className="rounded-3xl bg-white p-4 text-slate-950 shadow-xl"><h2 className="text-xl font-black">Recent activity</h2><div className="mt-3 space-y-2">{recentItems.length === 0 ? <p className="text-slate-500">Nothing saved yet.</p> : recentItems.map((item, idx) => <div key={idx} className="rounded-2xl border p-3"><p className="text-xs font-black text-slate-500">{item.kind}</p><p className="font-black">{item.title}</p><p className="text-sm text-slate-600">{item.subtitle}</p><p className="text-xs text-slate-400">{fmt(item.time)}</p></div>)}</div><div className="mt-4 grid gap-2 sm:grid-cols-3"><button onClick={clearScans} className="rounded-2xl bg-amber-100 px-3 py-3 text-sm font-black text-amber-950">Clear dispensed</button><button onClick={clearOriginals} className="rounded-2xl bg-amber-100 px-3 py-3 text-sm font-black text-amber-950">Clear originals</button><button onClick={clearMaster} className="rounded-2xl bg-red-100 px-3 py-3 text-sm font-black text-red-950">Clear FRED</button></div></div>
    </section>

    <section className="rounded-3xl border border-white/10 bg-white/10 p-4 shadow-xl"><h2 className="text-xl font-black text-white">FRED upload</h2><p className="mt-1 text-sm text-slate-300">Upload FRED Excel or CSV. Existing script numbers update; old rows stay unless replaced.</p><label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed border-emerald-300 bg-white/5 p-6 text-center"><span className="font-black text-white">Tap to upload FRED file</span><span className="text-sm text-slate-300">xlsx, xls, csv, txt</span><input type="file" accept=".xlsx,.xls,.csv,.txt" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.currentTarget.value = ""; }} /></label>{uploadState.active && <div className="mt-4"><div className="h-3 overflow-hidden rounded-full bg-white/20"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${uploadState.percent}%` }} /></div><p className="mt-2 text-sm font-bold text-emerald-200">{uploadState.label}</p></div>}<div className="mt-4 max-h-40 overflow-auto rounded-2xl bg-slate-950/60 p-3 text-sm">{batches.length === 0 ? <p className="text-slate-400">No uploads yet.</p> : batches.map((b) => <p key={b.uploadedAt} className="border-b border-white/10 py-2"><b>{b.fileName}</b> | {b.from || "?"} to {b.to || "?"} | total {b.total}</p>)}</div></section>
  </section></main>;
}
