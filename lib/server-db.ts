import fs from "node:fs/promises";
import path from "node:path";

export type OwingDb = {
  scripts: unknown[];
  scans: unknown[];
  originals: unknown[];
  batches: unknown[];
  updatedAt: string;
};

type DbKey = "scripts" | "scans" | "originals" | "batches";

const DEFAULT_DB: OwingDb = {
  scripts: [],
  scans: [],
  originals: [],
  batches: [],
  updatedAt: "",
};

export const DB_FILE = process.env.OWING_DB_FILE || path.join(process.cwd(), "data", "owing-db.json");

async function ensureDbFile() {
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await writeDb(DEFAULT_DB);
  }
}

function normaliseDb(value: Partial<OwingDb> | null | undefined): OwingDb {
  return {
    scripts: Array.isArray(value?.scripts) ? value.scripts : [],
    scans: Array.isArray(value?.scans) ? value.scans : [],
    originals: Array.isArray(value?.originals) ? value.originals : [],
    batches: Array.isArray(value?.batches) ? value.batches : [],
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : "",
  };
}

export async function readDb(): Promise<OwingDb> {
  await ensureDbFile();
  const text = await fs.readFile(DB_FILE, "utf8");
  return normaliseDb(JSON.parse(text || "{}"));
}

export async function writeDb(next: OwingDb) {
  const data: OwingDb = { ...normaliseDb(next), updatedAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, DB_FILE);
  return data;
}

export async function updateDb(patch: Partial<Record<DbKey, unknown[]>>) {
  const current = await readDb();
  const next: OwingDb = { ...current };
  for (const key of ["scripts", "scans", "originals", "batches"] as DbKey[]) {
    if (Array.isArray(patch[key])) next[key] = patch[key] as unknown[];
  }
  return writeDb(next);
}

export async function clearDb(keys: DbKey[]) {
  const current = await readDb();
  const next: OwingDb = { ...current };
  for (const key of keys) next[key] = [];
  return writeDb(next);
}
