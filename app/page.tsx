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
type ManualOriginal = { scriptNumber: string; patient: string; date: string; medicine: string; medicare: string; quantity: string; repeats: string; directions: string; notes: string };
type AiMedicine = { medicine?: string; labelNumber?: string; quantity?: string; repeats?: string; directions?: string; confidence?: number };
type RecentItem = { kind: "Dispensed" | "Original"; title: string; subtitle: string; time: string };

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
  const [manualOriginal, setManualOriginal] = useState<ManualOriginal>({ scriptNumber: "", patient: "", date: "", medicine: "", medicare: "", quantity: "", repeats: "", directions: "", notes: "" });
  const [tableMode, setTableMode] = useState<TableMode>("matched");
  const [activeSection, setActiveSection] = useState("dashboard");
  const [addMethod, setAddMethod] = useState<"smart" | "manual">("smart");
  const [exportRange, setExportRange] = useState("today");
  const [exportPreset, setExportPreset] = useState("confirmed");

  function notify(text: string) {
    setToast(text);
    setMessage(text);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 850);
    window.setTimeout(() => setToast(""), 2600);
  }

  useEffect(() => { void (async () => {
    const s = await idbGet<ScriptRec[]>(SCRIPT_KEY, []);
    const sc = await idbGet<Scan[]>(SCAN_KEY, []);
    const p = await idbGet<OriginalEntry[]>(ORIGINAL_KEY, []);
    const b = await idbGet<Batch[]>(BATCH_KEY, []);
    setScripts(s); setScans(sc); setOriginals(p); setBatches(b); setLast(sc[0] ?? null);
  })(); }, []);
  useEffect(() => { void idbSet(SCRIPT_KEY, scripts); }, [scripts]);
  useEffect(() => { void idbSet(SCAN_KEY, scans); }, [scans]);
  useEffect(() => { void idbSet(ORIGINAL_KEY, originals); }, [originals]);
  useEffect(() => { void idbSet(BATCH_KEY, batches); }, [batches]);
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

  function saveDispensedCopy(documentType: DocumentType = "DISPENSED_LABEL") {
    const v = cleanLabel(value);
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
          saveDispensedCopy(documentType);
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
      if (entries[0]) setManualOriginal({ scriptNumber: entries[0].scriptNumber || "", patient: entries[0].patient, date: entries[0].date, medicine: entries[0].medicine, medicare: entries[0].medicare, quantity: entries[0].quantity || "", repeats: entries[0].repeats || "", directions: entries[0].directions || "", notes: "" });
      saveOriginalEntries(entries);
    } catch (e) {
      notify(e instanceof Error ? `AI scan failed: ${e.message}` : "AI scan failed.");
    } finally {
      setScannerBusy(false);
    }
  }

  function saveCurrentScan() {
    if (mode === "dispensed_copy") {
      if (value.trim()) { saveDispensedCopy("DISPENSED_LABEL"); return; }
      void scanDocumentWithAi("dispensed_copy");
      return;
    }
    void scanDocumentWithAi("original_script");
  }

  function saveManualOriginal() {
    saveOriginalEntry({ source: "manual", scriptNumber: cleanLabel(manualOriginal.scriptNumber) || undefined, patient: manualOriginal.patient.trim(), address: "", date: manualOriginal.date.trim(), medicine: manualOriginal.medicine.trim(), medicare: manualOriginal.medicare.trim(), quantity: manualOriginal.quantity.trim(), repeats: manualOriginal.repeats.trim(), directions: manualOriginal.directions.trim(), warning: manualOriginal.notes.trim(), documentType: "ORIGINAL_PRESCRIPTION" });
  }
  function selectOriginal(script: ScriptRec) {
    const entry = { source: "fred-search" as const, scriptNumber: script.scriptNumber, patient: script.patient, address: "", date: auDate(script.dispenseDate), medicine: script.medicine, medicare: script.medicare || "", documentType: "ORIGINAL_PRESCRIPTION" as DocumentType };
    setManualOriginal({ scriptNumber: entry.scriptNumber, patient: entry.patient, date: entry.date, medicine: entry.medicine, medicare: entry.medicare, quantity: "", repeats: "", directions: "", notes: "" });
    saveOriginalEntry(entry);
  }
  function clearScans() { setScans([]); setLast(null); void idbDel(SCAN_KEY); notify("Dispensed copy scans cleared."); }
  function clearOriginals() { setOriginals([]); void idbDel(ORIGINAL_KEY); notify("Original script scans cleared."); }
  function clearMaster() { setScripts([]); setBatches([]); void idbDel(SCRIPT_KEY); void idbDel(BATCH_KEY); notify("FRED master cleared."); }

  const goTo = (section: string) => {
    setActiveSection(section);
    window.setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
  };
  const listTabs: { label: string; mode: TableMode }[] = [
    { label: "Matched", mode: "matched" },
    { label: "Unmatched", mode: "unmatchedDispensed" },
    { label: "Original scripts", mode: "unmatchedOriginals" },
  ];

  return <main className="luxury-shell soft-noise">
    <div className="hero-orb orb-one" /><div className="hero-orb orb-two" />
    {toast && <div className="success-pop">✓ {toast}</div>}
    <nav className="premium-nav" aria-label="Primary navigation">
      <button className="brand" onClick={() => goTo("dashboard")}><span className="brand-mark">Rx</span><span>Scriptly<small>Verification workspace</small></span></button>
      <div className="nav-links">{[["dashboard","Dashboard"],["add-script","Add Script"],["lists","Lists"],["export","Export"],["upload","Upload"],["settings","Settings"]].map(([key,label]) => <button key={key} className={`nav-pill ${activeSection === key ? "active" : ""}`} onClick={() => goTo(key)}>{label}</button>)}</div>
      <div className="storage-badge"><i /> Local mode</div>
    </nav>

    <div className="content-wrap">
      <section id="dashboard" className="hero-canvas section-transition">
        <div className="hero-copy"><p className="eyebrow">A calmer way to verify pharmacy work</p><h1>Verify labels and prescriptions with one smart workflow</h1><p className="hero-subtitle">Add scripts by camera or manual entry, review matches, and export clean pharmacy lists.</p><div className="hero-actions"><button className="premium-button" onClick={() => goTo("add-script")}>Add Script <span>↗</span></button><button className="secondary-button" onClick={() => goTo("lists")}>View Lists</button></div><div className="workspace-note"><span>✓</span><div><b>Saved to workspace</b><small>{scripts.length ? `Pharmacy records ${masterRange.from} — ${masterRange.to}` : "Upload a dispense export when you’re ready"}</small></div></div></div>
        <div className="hero-visual glass-card"><div className="visual-top"><span>Today’s workspace</span><span className="live-dot">Live</span></div><div className="visual-score"><div><small>Ready to review</small><strong>{unmatchedDispensed.length + unmatchedOriginals.length}</strong></div><div className="score-ring"><span>{matchedPairs.length}</span><small>matched</small></div></div><div className="mini-activity">{recentItems[0] ? <><span className="activity-icon">✓</span><div><b>{recentItems[0].title}</b><small>{recentItems[0].subtitle}</small></div></> : <><span className="activity-icon">＋</span><div><b>Your workspace is ready</b><small>Add the first script to begin</small></div></>}</div></div>
      </section>

      <div className="workflow-strip">{["Add Script","Confirm","Match","Review","Export"].map((step,index) => <div className="workflow-step" key={step}><span>{index + 1}</span><b>{step}</b>{index < 4 && <i>→</i>}</div>)}</div>
      <section className="kpi-grid">{[[scans.length,"Today added","All captured items"],[unmatchedDispensed.length + unmatchedOriginals.length,"Pending review","Needs a quick look"],[matchedPairs.length,"Matched","Pairs connected"],[unmatchedOriginals.length,"Needs attention","Original scripts"]].map(([number,label,sub],i) => <button key={String(label)} className={`kpi-card tone-${i}`} onClick={() => goTo("lists")}><span className="kpi-icon">{["＋","◷","✓","!"][i]}</span><strong>{number}</strong><b>{label}</b><small>{sub}</small></button>)}</section>

      <section className="section-panel section-transition" aria-labelledby="activity-title"><div className="section-heading"><div><p className="eyebrow">Overview</p><h2 id="activity-title">Recent activity</h2></div><button className="text-button" onClick={() => goTo("lists")}>Open all lists →</button></div><div className="recent-grid">{recentItems.length ? recentItems.map((item,idx) => <article className="activity-card" key={idx}><span className="source-chip">{item.kind}</span><h3>{item.title}</h3><p>{item.subtitle}</p><time>{fmt(item.time)}</time></article>) : <div className="empty-state"><span>✦</span><h3>No scripts yet</h3><p>Add your first script with Smart Add-in or Manual Add-in.</p><button className="secondary-button" onClick={() => goTo("add-script")}>Add first script</button></div>}</div></section>

      <section id="add-script" className="section-panel section-transition"><div className="section-heading"><div><p className="eyebrow">Capture</p><h2>Add Script</h2><p>Choose the quickest way to bring a prescription into your workspace.</p></div><span className="section-number">01</span></div>
        <div className="choice-grid"><button className={`liquid-card choice-card ${addMethod === "smart" ? "selected" : ""}`} onClick={() => setAddMethod("smart")}><span className="choice-icon">⌁</span><div><h3>Smart Add-in Script</h3><p>Use camera and AI to add scripts quickly.</p></div><span className="choice-arrow">↗</span></button><button className={`liquid-card choice-card ${addMethod === "manual" ? "selected" : ""}`} onClick={() => setAddMethod("manual")}><span className="choice-icon peach">✎</span><div><h3>Manual Add-in Script</h3><p>Type script details manually when scanning is not suitable.</p></div><span className="choice-arrow">↗</span></button></div>
        {addMethod === "smart" ? <div className={`scanner-shell ${flash ? "confirmed" : ""}`}><div className="scanner-heading"><div><p className="eyebrow">Smart capture</p><h3>{mode === "dispensed_copy" ? "Dispensed Script Add-in" : "Original Script Add-in"}</h3></div><div className="segmented-control"><button className={mode === "dispensed_copy" ? "active" : ""} onClick={() => { setMode("dispensed_copy"); if (cameraOn) void startScanner("dispensed_copy"); }}>Dispensed script</button><button className={mode === "original_script" ? "active" : ""} onClick={() => { setMode("original_script"); if (cameraOn) void startScanner("original_script"); }}>Original script</button></div></div>
          <div className="confirm-card"><span className="confirm-icon">{preview?.record ? "✓" : "⌁"}</span><div><small>Extracted result</small><strong>{value || (cameraOn ? "Ready to detect" : "Open camera to begin")}</strong><p>{preview?.record ? `${preview.record.patient} · ${preview.record.medicine} · ${auDate(preview.record.dispenseDate)}` : message}</p></div><span className={`status-pill ${preview?.record ? "matched" : ""}`}>{preview?.record ? "Match found" : "Waiting"}</span></div>
          <div className="scanner-grid"><div><div className="scan-frame"><video ref={videoRef} autoPlay muted playsInline />{cameraOn && <div className="scan-line" />}<div className="scan-reticle" /><span className="camera-state">{cameraOn ? "Camera active" : "Camera is off"}</span></div><div className="scanner-controls"><button className="premium-button" onClick={() => startScanner(mode)}>Start</button><button className="secondary-button" onClick={stopScanner}>Stop</button></div></div><div className="scanner-side"><label>Script or label number<input className="premium-input" value={manual} onChange={(e) => { setManual(e.target.value); setDetected(""); }} placeholder="e.g. 50676193" /></label><div className="scan-guidance"><span>✦</span><p>{mode === "dispensed_copy" ? "Barcode detection runs automatically. If no barcode is found, AI can read the document." : "AI reads patient, date, medicine, quantity, repeats and directions from the original."}</p></div><button className="premium-button wide" onClick={saveCurrentScan} disabled={scannerBusy || (!cameraOn && !value.trim())}>{scannerBusy ? "Reading prescription…" : mode === "dispensed_copy" ? "Confirm / AI scan" : "Read with AI & confirm"}</button><div className="inline-actions"><button onClick={() => { setManual(""); setDetected(""); }}>Add another</button><button onClick={() => goTo("lists")}>View in Lists</button></div></div></div>
        </div> : <div className="manual-card"><div className="form-intro"><span>✎</span><div><h3>Manual Add-in Script</h3><p>Enter what you can. Optional details can be completed later.</p></div></div><div className="premium-form">{[["Script number","scriptNumber","e.g. 50676193"],["Patient name","patient","Full patient name"],["Date","date","dd/mm/yyyy"],["Medicine","medicine","Medicine and strength"],["Quantity","quantity","Quantity"],["Repeats","repeats","Repeats"],["Directions","directions","Dosage directions"],["Medicare / identifier","medicare","Optional identifier"],["Notes","notes","Optional notes"]].map(([label,key,placeholder]) => <label key={key} className={key === "directions" || key === "notes" ? "span-two" : ""}>{label}<input className="premium-input" value={manualOriginal[key as keyof ManualOriginal]} onChange={(e) => setManualOriginal({ ...manualOriginal, [key]: e.target.value })} placeholder={placeholder} /></label>)}</div><button className="premium-button" onClick={saveManualOriginal}>Save to workspace</button>{originalSuggestions.length > 0 && <div className="suggestions"><b>Possible pharmacy record matches</b>{originalSuggestions.map((s) => <button key={s.scriptNumber} onClick={() => selectOriginal(s)}><strong>{s.scriptNumber}</strong><span>{s.patient} · {s.medicine}</span></button>)}</div>}</div>}
      </section>

      <section id="lists" className="section-panel section-transition"><div className="section-heading"><div><p className="eyebrow">Workspace</p><h2>Lists</h2><p>Review every captured script without losing the thread.</p></div><span className="section-number">02</span></div><div className="list-tabs">{listTabs.map((tab) => <button key={tab.mode} className={tableMode === tab.mode ? "active" : ""} onClick={() => setTableMode(tab.mode)}>{tab.label}<span>{tab.mode === "matched" ? matchedPairs.length : tab.mode === "unmatchedDispensed" ? unmatchedDispensed.length : unmatchedOriginals.length}</span></button>)}<button disabled>Manual entries <span>{originals.filter((o) => o.source === "manual").length}</span></button><button disabled>Needs attention</button></div><div className="table-wrap"><table className="premium-table"><thead><tr>{["Status","Source","Script","Patient","Date","Medicine","Last updated","Actions"].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{tableRows.length ? tableRows.map((row,index) => <tr key={index}><td><span className={`row-status ${row.Status === "MATCHED" ? "matched" : "attention"}`}>{row.Status === "MATCHED" ? "Matched" : "Review"}</span></td><td>{row.DocumentType || (row.DispensedCopy ? "Dispensed" : "Original")}</td><td><b>{row.Script || row.DispensedCopy || "—"}</b></td><td>{row.Patient || "—"}</td><td>{row.Date || "—"}</td><td>{row.Medicine || "—"}</td><td>{row.DispensedTime || row.OriginalTime || "—"}</td><td><div className="row-actions"><button>View</button><button disabled>Edit</button><button disabled>Match</button></div></td></tr>) : <tr><td colSpan={8}><div className="empty-state"><span>✦</span><h3>No scripts in this list</h3><p>Add your first script with Smart Add-in or Manual Add-in.</p></div></td></tr>}</tbody></table></div></section>

      <section id="export" className="section-panel section-transition"><div className="section-heading"><div><p className="eyebrow">Reports</p><h2>Export Centre</h2><p>Build a clean handoff for today, follow-up, or audit.</p></div><span className="section-number">03</span></div><div className="export-grid"><div className="export-options"><fieldset><legend>Date</legend><div className="option-row">{[["today","Today"],["yesterday","Yesterday"],["week","Last 7 days"],["custom","Custom range"]].map(([key,label]) => <button key={key} className={exportRange === key ? "active" : ""} onClick={() => setExportRange(key)}>{label}</button>)}</div></fieldset><fieldset><legend>Export preset</legend><div className="preset-grid">{[["confirmed","Today’s confirmed work"],["followup","Unmatched items needing follow-up"],["audit","Full daily audit"],["originals","AI-read original scripts"],["manual","Manual entries"],["matched","Matched pairs"]].map(([key,label]) => <button key={key} className={exportPreset === key ? "active" : ""} onClick={() => setExportPreset(key)}><span>{exportPreset === key ? "●" : "○"}</span>{label}</button>)}</div></fieldset><fieldset><legend>Format</legend><div className="format-row"><button className="active">CSV <small>Ready</small></button><button disabled>Excel <small>Coming soon</small></button><button disabled>PDF summary <small>Coming soon</small></button></div></fieldset></div><aside className="export-summary"><span className="export-icon">⇩</span><p className="eyebrow">Export preview</p><h3>{tableRows.length} rows ready</h3><dl><div><dt>Date</dt><dd>{exportRange === "week" ? "Last 7 days" : exportRange[0].toUpperCase() + exportRange.slice(1)}</dd></div><div><dt>Preset</dt><dd>{exportPreset}</dd></div><div><dt>Columns</dt><dd>Full details</dd></div><div><dt>Format</dt><dd>CSV</dd></div></dl><button className="premium-button wide" disabled={!tableRows.length} onClick={() => downloadCsv(`${exportPreset}-pharmacy-work.csv`, tableRows)}>Generate export</button></aside></div></section>

      <section id="upload" className="section-panel section-transition"><div className="section-heading"><div><p className="eyebrow">Import</p><h2>Upload pharmacy system export</h2><p>Import dispense records from your pharmacy system to improve matching.</p></div><span className="section-number">04</span></div><label className="upload-dropzone"><span className="upload-icon">↑</span><h3>Drop your dispense export here</h3><p>or click to choose a file from your computer</p><small>XLSX, XLS, CSV or TXT · Existing script numbers are safely updated</small><input type="file" accept=".xlsx,.xls,.csv,.txt" onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.currentTarget.value = ""; }} /></label>{uploadState.active && <div className="upload-progress"><div><span style={{ width: `${uploadState.percent}%` }} /></div><p>{uploadState.label}<b>{uploadState.percent}%</b></p></div>}<div className="upload-summary"><div><small>Rows imported</small><strong>{batches[0]?.imported || 0}</strong></div><div><small>Duplicates updated</small><strong>{batches[0]?.updated || 0}</strong></div><div><small>Date range</small><strong>{batches[0] ? `${batches[0].from || "?"} — ${batches[0].to || "?"}` : "—"}</strong></div><div><small>Master total</small><strong>{scripts.length}</strong></div></div>{batches[0] && <p className="last-upload">Last upload: <b>{batches[0].fileName}</b> · {fmt(batches[0].uploadedAt)}</p>}</section>

      <section id="settings" className="section-panel section-transition"><div className="section-heading"><div><p className="eyebrow">Workspace</p><h2>Settings</h2><p>Your data stays available in this browser workspace.</p></div><span className="section-number">05</span></div><div className="settings-grid"><div className="setting-card"><span>◉</span><div><h3>Local secure session</h3><p>IndexedDB workspace storage is active on this device.</p></div><b>Local mode</b></div><div className="setting-card muted"><span>↻</span><div><h3>Server sync</h3><p>Prepared for a future persistent team workspace.</p></div><b>Ready</b></div></div><div className="maintenance"><div><h3>Maintenance tools</h3><p>Clear individual data groups only when you need a fresh workspace.</p></div><div><button onClick={clearScans}>Clear labels</button><button onClick={clearOriginals}>Clear prescriptions</button><button onClick={clearMaster}>Clear uploaded master</button></div></div></section>
    </div>
    <aside className="puppy-helper"><span>🐶</span><div><b>Quick helper</b><p>Need a list? Open Lists. Need a report? Use Export. New file? Upload.</p><nav><button onClick={() => goTo("lists")}>Lists</button><button onClick={() => goTo("export")}>Export</button><button onClick={() => goTo("upload")}>Upload</button></nav></div></aside>
  </main>;
}
