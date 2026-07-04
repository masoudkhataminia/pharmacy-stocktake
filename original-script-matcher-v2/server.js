import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 8080);

const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 });
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024 } });

async function ensureDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(DB_FILE); }
  catch { await fs.writeFile(DB_FILE, JSON.stringify({ fred: [], targets: [], matches: [], audit: [] }, null, 2)); }
}
async function readDb() { await ensureDb(); return JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
async function writeDb(db) { await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2)); }
function audit(db, action, details = {}) { db.audit.push({ action, details, at: new Date().toISOString() }); }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function digits(s) { return String(s || '').replace(/\D+/g, ''); }
function pick(row, names) {
  const keys = Object.keys(row || {});
  for (const name of names) {
    const nk = norm(name);
    const key = keys.find(k => norm(k) === nk || norm(k).includes(nk));
    if (key) return row[key];
  }
  return '';
}
function parseFredRows(rows) {
  return rows.map((r, i) => {
    const first = pick(r, ['Patient First Name', 'First Name', 'First']);
    const last = pick(r, ['Patient Last Name', 'Last Name', 'Surname']);
    const patient = pick(r, ['Patient Name', 'Name']) || `${first || ''} ${last || ''}`.trim();
    return {
      id: `${Date.now()}-${i}`,
      scriptNumber: String(pick(r, ['Script Number', 'Script No', 'Rx Number', 'Rx No', 'Script'])).trim(),
      patientName: String(patient || '').trim(),
      drugDescription: String(pick(r, ['Drug Description', 'Medicine', 'Medication', 'Drug', 'Brand', 'Generic'])).trim(),
      dispenseDate: String(pick(r, ['Dispense Date', 'Date'])).trim(),
      prescribedDate: String(pick(r, ['Prescribed Date', 'Prescription Date', 'Date Written'])).trim(),
      prescriber: String(pick(r, ['Prescriber', 'Doctor', 'Prescriber Number'])).trim(),
      price: String(pick(r, ['Patient Price', 'Price', 'Cost'])).trim(),
      quantity: String(pick(r, ['Quantity', 'Qty'])).trim(),
      repeats: String(pick(r, ['Repeats', 'Repeat', 'Supply Number'])).trim(),
      raw: r
    };
  }).filter(r => r.scriptNumber || r.patientName || r.drugDescription);
}
function tokenize(s) { return norm(s).split(' ').filter(x => x.length > 1); }
function similarity(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach(x => { if (B.has(x) || [...B].some(y => y.includes(x) || x.includes(y))) hit++; });
  return hit / Math.max(A.size, B.size);
}
function dateScore(a, b) {
  const da = digits(a), db = digits(b);
  if (!da || !db) return 0;
  if (da === db) return 1;
  if (da.slice(0, 4) === db.slice(0, 4) || da.slice(-4) === db.slice(-4)) return 0.55;
  return 0;
}
function rankMatches(fields, records) {
  return records.map(record => {
    const directHit = digits(record.scriptNumber) && digits(record.scriptNumber) === digits(fields.scriptNumber || fields.fredScriptNumber || fields.supplyNumber || fields.prescriptionNumber || '');
    const patient = similarity(fields.patientName, record.patientName);
    const medicine = similarity(fields.medicine, record.drugDescription);
    const date = Math.max(dateScore(fields.prescriptionDate, record.prescribedDate), dateScore(fields.prescriptionDate, record.dispenseDate));
    const prescriber = similarity(fields.prescriber, record.prescriber);
    const score = directHit ? 100 : Math.round(patient * 38 + medicine * 42 + date * 16 + prescriber * 4);
    const reasons = [];
    if (directHit) reasons.push('script number');
    if (patient > 0.6) reasons.push('patient');
    if (medicine > 0.45) reasons.push('medicine');
    if (date > 0.5) reasons.push('date');
    if (prescriber > 0.5) reasons.push('prescriber');
    return { record, score, reasons };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
}

const DOCUMENT_TYPES = ['DISPENSED_LABEL','REPEAT_AUTHORISATION','PRESCRIPTION_COPY','ORIGINAL_PRESCRIPTION','UNKNOWN_DOCUMENT'];
function safeDocType(value) {
  const v = String(value || '').trim().toUpperCase();
  return DOCUMENT_TYPES.includes(v) ? v : 'UNKNOWN_DOCUMENT';
}
function wrongModeWarning(mode, documentType) {
  if (mode === 'dispensed_copy' && documentType === 'ORIGINAL_PRESCRIPTION') return 'This looks like an original prescription. Confirm only if this is the dispensed/patient copy you want to save as a target.';
  if (mode === 'original_script' && ['REPEAT_AUTHORISATION','DISPENSED_LABEL','PRESCRIPTION_COPY'].includes(documentType)) return 'This looks like a dispensed copy/repeat/label, not the original script. Use Scan Dispensed Copy if you are building the target list.';
  return '';
}

async function openAiExtract(imageBase64, mode = 'original_script') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { documentType: 'UNKNOWN_DOCUMENT', needsManualEntry: true, error: 'OPENAI_API_KEY is not configured. Use manual entry or configure AI extraction.' };
  const modeInstruction = mode === 'dispensed_copy'
    ? 'The user is scanning a document that may represent a previously dispensed script: Fred dispensing label, repeat authorisation form, prescription copy, no-barcode label, or sometimes an original prescription scanned in the wrong mode.'
    : 'The user is scanning the original paper prescription received later. It must be matched against previously saved targets.';
  const prompt = `You are extracting Australian pharmacy prescription matching fields. ${modeInstruction}
Return STRICT JSON only. Do not include markdown.
Classify documentType as exactly one of: DISPENSED_LABEL, REPEAT_AUTHORISATION, PRESCRIPTION_COPY, ORIGINAL_PRESCRIPTION, UNKNOWN_DOCUMENT.
Important: Repeat authorisation forms often contain words like Repeat Authorisation, PBS/RPBS, No., Prescription no. this supply, Original prescription details, Repeats left, Date, Patient, Medicine, Prescriber.
Extract only what is visible. Do not invent values. For poor handwriting, leave unclear fields blank and lower confidence.
JSON keys: documentType, scriptNumber, patientName, medicine, prescriptionDate, dob, prescriber, repeatsInfo, confidence, notes.`;
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` }
      ] }],
      text: { format: { type: 'json_object' } }
    })
  });
  if (!res.ok) throw new Error(`AI extraction failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.output_text || data.output?.flatMap(o => o.content || []).find(c => c.type === 'output_text')?.text || '{}';
  try { const parsed = JSON.parse(text); return { ...parsed, documentType: safeDocType(parsed.documentType) }; }
  catch { return { documentType: 'UNKNOWN_DOCUMENT', needsManualEntry: true, raw: text, error: 'AI returned non-JSON response.' }; }
}

app.get('/api/health', async () => ({ ok: true, service: 'owing-script-matcher-v2' }));
app.get('/api/state', async () => {
  const db = await readDb();
  return { fredCount: db.fred.length, targetCount: db.targets.length, matchCount: db.matches.length, targets: db.targets, matches: db.matches };
});
app.post('/api/import-fred', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'No file uploaded.' });
  const buffer = await file.toBuffer();
  const wb = XLSX.read(buffer);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const fred = parseFredRows(rows);
  const db = await readDb();
  db.fred = fred;
  audit(db, 'IMPORT_FRED', { filename: file.filename, count: fred.length });
  await writeDb(db);
  return { imported: fred.length };
});
app.post('/api/demo', async () => {
  const db = await readDb();
  db.fred = parseFredRows([
    { 'Script Number': '50676193', 'Patient First Name': 'Nali', 'Patient Last Name': 'Smith', 'Drug Description': 'Mometasone Lotion 0.1% 30mL', 'Dispense Date': '01/07/2026', 'Prescribed Date': '01/07/2026', 'Prescriber': 'Dr Philip Glynatsis' },
    { 'Script Number': '90000001', 'Patient First Name': 'Demo', 'Patient Last Name': 'Patient One', 'Drug Description': 'Demo Medicine A 10mg', 'Dispense Date': '03/07/2026', 'Prescribed Date': '03/07/2026' },
    { 'Script Number': '90000002', 'Patient First Name': 'Demo', 'Patient Last Name': 'Patient Two', 'Drug Description': 'Demo Medicine B 3mg', 'Dispense Date': '25/06/2026', 'Prescribed Date': '25/06/2026' }
  ]);
  audit(db, 'LOAD_DEMO', { count: db.fred.length });
  await writeDb(db);
  return { imported: db.fred.length };
});
app.post('/api/lookup-label', async (req, reply) => {
  const { scriptNumber } = req.body || {};
  const db = await readDb();
  const record = db.fred.find(r => digits(r.scriptNumber) === digits(scriptNumber));
  if (!record) return reply.code(404).send({ found: false, scriptNumber });
  return { found: true, record };
});
app.post('/api/save-target', async (req) => {
  const { scriptNumber } = req.body || {};
  const db = await readDb();
  const record = db.fred.find(r => digits(r.scriptNumber) === digits(scriptNumber));
  if (!record) throw new Error('Script not found in Fred records.');
  if (!db.targets.some(t => digits(t.scriptNumber) === digits(record.scriptNumber))) db.targets.push({ ...record, savedAt: new Date().toISOString() });
  audit(db, 'SAVE_TARGET', { scriptNumber: record.scriptNumber });
  await writeDb(db);
  return { saved: true, record };
});
async function extractDocumentFromRequest(req, modeDefault = 'original_script') {
  const { imageBase64, mode = modeDefault } = req.body || {};
  if (!imageBase64) throw new Error('imageBase64 is required.');
  const extracted = await openAiExtract(imageBase64.replace(/^data:image\/\w+;base64,/, ''), mode);
  const db = await readDb();
  const pool = mode === 'dispensed_copy' ? db.fred : (db.targets.length ? db.targets : db.fred);
  const candidates = rankMatches({ scriptNumber: extracted.scriptNumber || '', patientName: extracted.patientName || '', medicine: extracted.medicine || '', prescriptionDate: extracted.prescriptionDate || '', prescriber: extracted.prescriber || '' }, pool);
  const warning = wrongModeWarning(mode, extracted.documentType);
  audit(db, 'EXTRACT_DOCUMENT', { mode, documentType: extracted.documentType, topScore: candidates[0]?.score || 0, warning: Boolean(warning) });
  await writeDb(db);
  return { mode, extracted, candidates, warning };
}
app.post('/api/extract-document', async (req) => extractDocumentFromRequest(req));
app.post('/api/extract-script', async (req) => extractDocumentFromRequest(req, 'original_script'));
app.post('/api/manual-match', async (req) => {
  const fields = req.body || {};
  const db = await readDb();
  const candidates = rankMatches(fields, fields.mode === 'dispensed_copy' ? db.fred : (db.targets.length ? db.targets : db.fred));
  audit(db, 'MANUAL_MATCH', { fields, topScore: candidates[0]?.score || 0 });
  await writeDb(db);
  return { candidates };
});
app.post('/api/confirm-match', async (req) => {
  const { scriptNumber, confidence = 0, source = 'unknown' } = req.body || {};
  const db = await readDb();
  const record = db.fred.find(r => digits(r.scriptNumber) === digits(scriptNumber));
  if (!record) throw new Error('Script not found.');
  const match = { id: Date.now().toString(), scriptNumber: record.scriptNumber, patientName: record.patientName, medicine: record.drugDescription, date: record.prescribedDate || record.dispenseDate, confidence, source, confirmedAt: new Date().toISOString() };
  db.matches.push(match);
  audit(db, 'CONFIRM_MATCH', match);
  await writeDb(db);
  return { confirmed: true, match };
});
app.get('/api/export-matches.csv', async (_req, reply) => {
  const db = await readDb();
  const cols = ['scriptNumber','patientName','medicine','date','confidence','source','confirmedAt'];
  const csv = [cols.join(','), ...db.matches.map(r => cols.map(c => `"${String(r[c] || '').replace(/"/g, '""')}"`).join(','))].join('\n');
  reply.header('Content-Type', 'text/csv').header('Content-Disposition', 'attachment; filename="confirmed-matches.csv"').send(csv);
});

app.get('/', async (_req, reply) => reply.type('text/html').send(await fs.readFile(path.join(__dirname, 'public/index.html'), 'utf8')));
app.get('/app.js', async (_req, reply) => reply.type('application/javascript').send(await fs.readFile(path.join(__dirname, 'public/app.js'), 'utf8')));
app.get('/styles.css', async (_req, reply) => reply.type('text/css').send(await fs.readFile(path.join(__dirname, 'public/styles.css'), 'utf8')));

await app.listen({ port: PORT, host: '0.0.0.0' });
