import type { Express } from "express";
import { createServer, type Server } from "http";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import https from "https";

const execAsync = promisify(exec);

// Works locally (workspace) and in Docker/Railway (app root)
const SCRIPT_PATH = fs.existsSync("/home/user/workspace/pa_jail_lookup.py")
  ? "/home/user/workspace/pa_jail_lookup.py"
  : path.resolve(process.cwd(), "pa_jail_lookup.py");
// /data is a Railway persistent volume mount; falls back to local workspace or cwd
const SNAPSHOTS_DIR = fs.existsSync("/home/user/workspace/jail-dashboard/snapshots")
  ? "/home/user/workspace/jail-dashboard/snapshots"
  : fs.existsSync("/data")
  ? "/data/snapshots"
  : path.resolve(process.cwd(), "snapshots");
const MAX_SNAPSHOTS = 52; // keep up to ~1 year of weekly snapshots

// Ensure snapshots directory exists
if (!fs.existsSync(SNAPSHOTS_DIR)) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

// ─── Snapshot helpers ────────────────────────────────────────────────────────

interface Snapshot {
  facility: string;
  timestamp: string; // ISO string
  count: number;
  inmates: any[];
}

function snapshotFile(facility: string): string {
  return path.join(SNAPSHOTS_DIR, `${facility}.json`);
}

function loadSnapshots(facility: string): Snapshot[] {
  const f = snapshotFile(facility);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as Snapshot[];
  } catch {
    return [];
  }
}

function saveSnapshots(facility: string, snapshots: Snapshot[]): void {
  fs.writeFileSync(snapshotFile(facility), JSON.stringify(snapshots, null, 2));
}

function addSnapshot(facility: string, inmates: any[]): Snapshot {
  const snapshots = loadSnapshots(facility);
  const snap: Snapshot = {
    facility,
    timestamp: new Date().toISOString(),
    count: inmates.length,
    inmates,
  };
  snapshots.push(snap);
  // Keep only the most recent MAX_SNAPSHOTS
  if (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
  }
  saveSnapshots(facility, snapshots);
  return snap;
}

// ─── Delta computation ───────────────────────────────────────────────────────

// Unique key for an inmate — prefer booking number, fall back to name+dob
function inmateKey(inmate: any): string {
  if (inmate.bookingNumber && inmate.bookingNumber.trim()) {
    return `bk:${inmate.bookingNumber.trim()}`;
  }
  return `nm:${inmate.name.trim().toLowerCase()}|${(inmate.ageDob || "").trim()}`;
}

interface DeltaResult {
  facility: string;
  snapshotA: { timestamp: string; count: number };
  snapshotB: { timestamp: string; count: number };
  added: any[];    // in B but not A
  released: any[]; // in A but not B
  stayed: number;  // still present in both
}

function computeDelta(snapA: Snapshot, snapB: Snapshot): DeltaResult {
  const keysA = new Map<string, any>();
  const keysB = new Map<string, any>();

  for (const inmate of snapA.inmates) keysA.set(inmateKey(inmate), inmate);
  for (const inmate of snapB.inmates) keysB.set(inmateKey(inmate), inmate);

  const added: any[] = [];
  const released: any[] = [];

  for (const [k, inmate] of keysB) {
    if (!keysA.has(k)) added.push(inmate);
  }
  for (const [k, inmate] of keysA) {
    if (!keysB.has(k)) released.push(inmate);
  }

  const stayed = snapB.inmates.length - added.length;

  return {
    facility: snapB.facility,
    snapshotA: { timestamp: snapA.timestamp, count: snapA.count },
    snapshotB: { timestamp: snapB.timestamp, count: snapB.count },
    added,
    released,
    stayed,
  };
}

// ─── Roster cache ────────────────────────────────────────────────────────────

const PADOC_CACHE_FILE = fs.existsSync("/home/user/workspace/jail-dashboard/padoc_cache.json")
  ? "/home/user/workspace/jail-dashboard/padoc_cache.json"
  : fs.existsSync("/app/padoc_cache.json")
  ? "/app/padoc_cache.json"
  : fs.existsSync("/data")
  ? "/data/padoc_cache.json"
  : path.resolve(process.cwd(), "padoc_cache.json");
const PADOC_CACHE_TTL = 60 * 60 * 1000; // 60 minutes
const CACHE_TTL       =  5 * 60 * 1000; //  5 minutes (county jails)

const cache: Record<string, { data: any[]; ts: number }> = {};

// Track whether a background PADOC fetch is already running
let padocFetchInProgress = false;

function parsePythonOutput(stdout: string): any[] {
  const inmates: any[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(\d+)\s{2,}(.+?),\s+(.+?)\s{2,}(.{0,12})\s+([MF]?)\s+(.{0,20}?)\s{2,}(.*)$/);
    if (m) {
      inmates.push({
        id: parseInt(m[1]),
        name: `${m[2].trim()}, ${m[3].trim()}`,
        lastName: m[2].trim(),
        firstName: m[3].trim(),
        ageDob: m[4].trim(),
        gender: m[5].trim(),
        bookingNumber: m[6].trim(),
        facility: m[7].trim(),
      });
    }
  }
  return inmates;
}

function normalizePadocInmate(rec: any, idx: number): any {
  // Cache stores Python-dict keys (dob, booking_number, gender)
  // Frontend expects the same shape as county jails (ageDob, bookingNumber, etc.)
  if (rec.ageDob !== undefined) return rec; // already normalized
  const nameParts = (rec.name || "").split(", ");
  return {
    id: idx + 1,
    name: rec.name || "",
    lastName: nameParts[0]?.trim() || "",
    firstName: nameParts[1]?.trim() || "",
    ageDob: rec.dob || "",
    gender: rec.gender || "",
    bookingNumber: rec.booking_number || "",
    facility: rec.facility || "",
  };
}

function loadPadocFromDisk(): { data: any[]; ts: number } | null {
  try {
    if (!fs.existsSync(PADOC_CACHE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(PADOC_CACHE_FILE, "utf8"));
    // Normalize all records to frontend shape
    raw.data = raw.data.map(normalizePadocInmate);
    return raw;
  } catch {
    return null;
  }
}

function savePadocToDisk(data: any[]): void {
  const ts = Date.now();
  fs.writeFileSync(PADOC_CACHE_FILE, JSON.stringify({ data, ts }, null, 2));
  cache["padoc"] = { data, ts };
  console.log(`[padoc] cache saved: ${data.length} inmates`);
}

// Background fetch — runs without blocking HTTP responses
async function backgroundFetchPadoc(): Promise<void> {
  if (padocFetchInProgress) return;
  padocFetchInProgress = true;
  console.log("[padoc] starting background fetch...");
  try {
    const { stdout } = await execAsync(
      `python3 ${SCRIPT_PATH} --facility padoc`,
      { timeout: 600000 } // 10 min
    );
    const inmates = parsePythonOutput(stdout);
    if (inmates.length > 0) {
      const normalized = inmates.map(normalizePadocInmate);
      savePadocToDisk(normalized);
      console.log(`[padoc] background fetch complete: ${normalized.length} inmates`);
    } else {
      console.log("[padoc] background fetch returned 0 inmates — keeping old cache");
    }
  } catch (err: any) {
    console.error("[padoc] background fetch failed:", err.message);
  } finally {
    padocFetchInProgress = false;
  }
}

async function fetchFacility(facility: string): Promise<any[]> {
  const now = Date.now();

  // PA DOC: serve from disk cache, refresh in background if stale
  if (facility === "padoc") {
    // Check in-memory cache first
    if (cache["padoc"] && now - cache["padoc"].ts < PADOC_CACHE_TTL) {
      return cache["padoc"].data;
    }
    // Try disk cache
    const disk = loadPadocFromDisk();
    if (disk) {
      cache["padoc"] = disk;
      // If stale, kick off background refresh but still return cached data
      if (now - disk.ts > PADOC_CACHE_TTL) {
        backgroundFetchPadoc(); // fire and forget
      }
      return disk.data;
    }
    // No cache at all — need to fetch (first time). Run in background,
    // return empty with a "fetching" indicator so frontend shows loading.
    backgroundFetchPadoc();
    return []; // frontend will poll/refresh
  }

  // GettingOut static rosters — serve from JSON files (go-* keys)
  if (facility.startsWith("go-") || facility === "york-gettingout") {
    const goKey = facility === "york-gettingout" ? "go-york" : facility;
    if (cache[goKey] && now - cache[goKey].ts < CACHE_TTL) {
      return cache[goKey].data;
    }
    const inmates = loadGoFacilityRoster(goKey);
    cache[goKey] = { data: inmates, ts: now };
    return inmates;
  }

  // County jails — direct fetch
  if (cache[facility] && now - cache[facility].ts < CACHE_TTL) {
    return cache[facility].data;
  }
  const { stdout } = await execAsync(
    `python3 ${SCRIPT_PATH} --facility ${facility}`,
    { timeout: 180000 }
  );
  const inmates = parsePythonOutput(stdout);
  cache[facility] = { data: inmates, ts: now };
  return inmates;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ── GettingOut facility index — auto-discover all scraped GO facilities ──
  // On Railway, process.cwd() = /app and JSON files are committed to repo root (/app)
  // __dirname in dist/index.cjs = /app/dist, so we go one level up as fallback
  const GO_DATA_DIR = fs.existsSync("/data") ? "/data"
    : fs.existsSync(path.resolve(process.cwd(), "go_facilities_index.json")) ? path.resolve(process.cwd())
    : path.resolve(path.dirname(require.resolve("./routes")), "..");
  const GO_INDEX_FILE = path.join(GO_DATA_DIR, "go_facilities_index.json");

  function getGoFacilityKeys(): string[] {
    try {
      if (!fs.existsSync(GO_INDEX_FILE)) return ["york-gettingout"];
      const idx = JSON.parse(fs.readFileSync(GO_INDEX_FILE, "utf8"));
      return Object.keys(idx.facilities ?? {}).map(k => `go-${k}`);
    } catch { return ["york-gettingout"]; }
  }

  function loadGoFacilityRoster(goKey: string): any[] {
    // goKey is like "go-york" — map to file go_york.json
    const fileKey = goKey.replace(/^go-/, "");
    const filePath = path.join(GO_DATA_DIR, `go_${fileKey}.json`);
    try {
      if (!fs.existsSync(filePath)) return [];
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return (data.contacts ?? []).map((c: any, idx: number) => ({
        id: idx + 1,
        name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
        lastName: c.lastName || "",
        firstName: c.firstName || "",
        ageDob: c.dob || "",
        gender: c.gender || "",
        bookingNumber: c.bookingNumber || "",
        bookDate: c.bookDate || "",
        facility: c.facility || "",
      }));
    } catch { return []; }
  }

  const STATIC_ALLOWED = ["york", "york-prison", "dauphin", "lancaster", "crawford", "cumberland", "mercer", "westmoreland", "padoc"];
  const ALLOWED = [...STATIC_ALLOWED, ...getGoFacilityKeys()];

  // ── GettingOut contacts store ───────────────────────────────────────────────
  // Lancaster and Dauphin are intentionally excluded from cross-referencing.
  const GO_FILE = fs.existsSync("/data")
    ? "/data/gettingout_contacts.json"
    : path.resolve(process.cwd(), "gettingout_contacts.json");

  const GO_CROSS_REF = ["crawford", "cumberland", "mercer", "westmoreland", "york-prison", "padoc"];

  function loadGoContacts(): any[] {
    try {
      if (!fs.existsSync(GO_FILE)) return [];
      return JSON.parse(fs.readFileSync(GO_FILE, "utf8")) as any[];
    } catch { return []; }
  }

  function saveGoContacts(contacts: any[]): void {
    fs.writeFileSync(GO_FILE, JSON.stringify(contacts, null, 2));
  }

  // GET /api/gettingout/debug — path diagnostics
  app.get("/api/gettingout/debug", (_req, res) => {
    const cwd = process.cwd();
    const indexExists = fs.existsSync(GO_INDEX_FILE);
    const dataDir = GO_DATA_DIR;
    const files = fs.existsSync(dataDir)
      ? fs.readdirSync(dataDir).filter((f: string) => f.startsWith("go_"))
      : [];
    const sampleFile = files[0] ? path.join(dataDir, files[0]) : null;
    const sampleExists = sampleFile ? fs.existsSync(sampleFile) : false;
    res.json({
      cwd,
      dataDir,
      indexFile: GO_INDEX_FILE,
      indexExists,
      goFilesFound: files.length,
      goFiles: files.slice(0, 5),
      sampleFile,
      sampleExists,
      dirname: __dirname,
    });
  });

  // GET /api/gettingout/facilities — list all scraped GO facilities
  app.get("/api/gettingout/facilities", (_req, res) => {
    try {
      if (!fs.existsSync(GO_INDEX_FILE)) return res.json({ facilities: [] });
      const idx = JSON.parse(fs.readFileSync(GO_INDEX_FILE, "utf8"));
      const list = Object.entries(idx.facilities ?? {}).map(([key, val]: [string, any]) => ({
        key:   `go-${key}`,
        label: val.label,
        count: val.count,
        id:    val.id,
      }));
      res.json({ facilities: list, lastUpdated: idx.lastUpdated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/gettingout/york — legacy endpoint (kept for compatibility)
  // GET /api/roster/york-gettingout — served via standard fetchFacility below
  const YORK_GO_FILE = fs.existsSync("/data/york_gettingout.json")
    ? "/data/york_gettingout.json"
    : path.resolve(GO_DATA_DIR, "york_gettingout.json");

  function loadYorkGoRoster(): any[] {
    try {
      if (!fs.existsSync(YORK_GO_FILE)) return [];
      const data = JSON.parse(fs.readFileSync(YORK_GO_FILE, "utf8"));
      const contacts = data.contacts ?? [];
      // Normalize to standard Inmate shape
      return contacts.map((c: any, idx: number) => ({
        id: idx + 1,
        name: c.name || "",
        lastName: c.lastName || "",
        firstName: c.firstName || "",
        ageDob: c.dob || "",
        gender: c.gender || "",
        bookingNumber: c.bookingNumber || "",
        facility: c.facility || "York County Prison",
      }));
    } catch { return []; }
  }

  app.get("/api/gettingout/york", (_req, res) => {
    const inmates = loadYorkGoRoster();
    res.json({ facility: "york-gettingout", count: inmates.length, contacts: inmates });
  });

  // GET /api/gettingout/contacts
  app.get("/api/gettingout/contacts", (_req, res) => {
    const contacts = loadGoContacts();
    res.json({ contacts, count: contacts.length });
  });

  // POST /api/gettingout/upload — accepts raw text (CSV or JSON) from the client
  app.post("/api/gettingout/upload", async (req, res) => {
    try {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      await new Promise(resolve => req.on("end", resolve));

      let contacts: any[] = [];

      // Try JSON first
      try {
        const parsed = JSON.parse(body);
        contacts = Array.isArray(parsed) ? parsed : (parsed.contacts ?? []);
      } catch {
        // Fall back to CSV: expect header row with name,facility,inmateId,status
        const lines = body.split("\n").map(l => l.trim()).filter(Boolean);
        const headers = lines[0].toLowerCase().split(",").map(h => h.trim());
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",").map(c => c.replace(/^"|"$/g, "").trim());
          const row: Record<string, string> = {};
          headers.forEach((h, idx) => { row[h] = cols[idx] ?? ""; });
          contacts.push(row);
        }
      }

      // Normalize and assign IDs
      const normalized = contacts.map((c: any, idx: number) => ({
        id: idx + 1,
        name: (c.name || c.Name || "").trim(),
        facility: (c.facility || c.Facility || "").trim(),
        inmateId: (c.inmateId || c.inmate_id || c.InmateId || c["inmate id"] || "").trim(),
        status: (c.status || c.Status || "").trim(),
        paMatch: (c.paMatch || "").trim() || null,
      })).filter((c: any) => c.name);

      saveGoContacts(normalized);
      res.json({ ok: true, count: normalized.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Upload failed" });
    }
  });

  // POST /api/gettingout/crossref — re-run cross-reference against live county rosters
  // Only checks GO_CROSS_REF counties (Lancaster & Dauphin excluded)
  app.post("/api/gettingout/crossref", async (_req, res) => {
    try {
      const contacts = loadGoContacts();
      if (contacts.length === 0) return res.json({ ok: true, matched: 0 });

      // Fetch all allowed rosters in parallel
      const rosterResults = await Promise.allSettled(
        GO_CROSS_REF.map(f => fetchFacility(f).then(inmates => ({ facility: f, inmates })))
      );

      const allInmates: { facility: string; name: string }[] = [];
      for (const r of rosterResults) {
        if (r.status === "fulfilled") {
          for (const inmate of r.value.inmates) {
            allInmates.push({ facility: r.value.facility, name: (inmate.name || "").toLowerCase().trim() });
          }
        }
      }

      let matched = 0;
      const updated = contacts.map((c: any) => {
        const nameLower = (c.name || "").toLowerCase().trim();
        const hit = allInmates.find(i => i.name === nameLower);
        if (hit) matched++;
        return { ...c, paMatch: hit ? hit.facility : null };
      });

      saveGoContacts(updated);
      res.json({ ok: true, matched, total: contacts.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Cross-reference failed" });
    }
  });

  // ── Philadelphia County search passthrough ──────────────────────────────
  const PHILA_KEY = "685088e7b4ef77cffb263b1349bc6583";
  const PHILA_BASE = "https://api.phila.gov/inmate-locator";
  const PHILA_FAC: Record<string, string> = {
    PICC:  "Philadelphia Industrial Correctional Center",
    RCF:   "Riverside Correctional Facility",
    DC:    "Detention Center",
    CFCF:  "Curran-Fromhold Correctional Facility",
    ASDCU: "Alternative and Special Detention",
    OJ:    "Location Unavailable (call 215-686-5600)",
  };

  app.get("/api/phila/search", async (req, res) => {
    const { firstName, lastName } = req.query as Record<string, string>;
    if (!firstName?.trim() || !lastName?.trim()) {
      return res.status(400).json({ error: "Both first name and last name are required." });
    }
    try {
      const url = `${PHILA_BASE}/inmates/?gatekeeperKey=${PHILA_KEY}&FirstName=${encodeURIComponent(firstName.trim())}&LastName=${encodeURIComponent(lastName.trim())}`;
      const response = await fetch(url);
      if (response.status === 429) {
        return res.status(429).json({ error: "Philadelphia API rate limit reached. Please try again in a few minutes." });
      }
      if (response.status === 404) {
        return res.json({ results: [], message: "No matching inmates found." });
      }
      const data = await response.json();
      // Normalise to array
      const raw: any[] = Array.isArray(data) ? data : (data.inmates ?? []);
      const results = raw.map((r: any) => ({
        name: `${(r.lastName || "").trim()}, ${(r.firstName || "").trim()}`,
        ppn:  (r.ppn || r.PPN || "").toString(),
        location: r.location || "",
        facilityName: PHILA_FAC[r.location] ?? r.location ?? "Unknown",
        lastUpdated: r.lastUpdated || "",
      }));
      res.json({ results, count: results.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Search failed" });
    }
  });

  // GET /api/roster/:facility — live roster
  app.get("/api/roster/:facility", async (req, res) => {
    const { facility } = req.params;
    if (!ALLOWED.includes(facility)) {
      return res.status(400).json({ error: "Unknown facility" });
    }
    try {
      const inmates = await fetchFacility(facility);
      const isFetching = facility === "padoc" && inmates.length === 0 && padocFetchInProgress;
      res.json({ facility, count: inmates.length, inmates, cached: !!cache[facility], fetching: isFetching });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch roster" });
    }
  });

  // DELETE /api/cache/:facility — bust cache
  app.delete("/api/cache/:facility", (req, res) => {
    const { facility } = req.params;
    delete cache[facility];
    res.json({ ok: true });
  });

  // POST /api/snapshot/:facility — save a snapshot of the current roster
  app.post("/api/snapshot/:facility", async (req, res) => {
    const { facility } = req.params;
    if (!ALLOWED.includes(facility)) {
      return res.status(400).json({ error: "Unknown facility" });
    }
    try {
      const inmates = await fetchFacility(facility);
      const snap = addSnapshot(facility, inmates);
      res.json({ ok: true, timestamp: snap.timestamp, count: snap.count });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to save snapshot" });
    }
  });

  // GET /api/snapshots/:facility — list all snapshot metadata (no inmate arrays)
  app.get("/api/snapshots/:facility", (req, res) => {
    const { facility } = req.params;
    if (!ALLOWED.includes(facility)) {
      return res.status(400).json({ error: "Unknown facility" });
    }
    const snapshots = loadSnapshots(facility);
    // Return metadata only (strip inmate arrays for speed)
    const meta = snapshots.map((s, i) => ({
      index: i,
      timestamp: s.timestamp,
      count: s.count,
    }));
    res.json({ facility, snapshots: meta });
  });

  // GET /api/delta/:facility — delta between two snapshots
  // Query params: a=index, b=index (default: last two)
  app.get("/api/delta/:facility", (req, res) => {
    const { facility } = req.params;
    if (!ALLOWED.includes(facility)) {
      return res.status(400).json({ error: "Unknown facility" });
    }
    const snapshots = loadSnapshots(facility);
    if (snapshots.length < 2) {
      return res.json({
        facility,
        insufficient: true,
        message: snapshots.length === 0
          ? "No snapshots saved yet. Click 'Save Snapshot' to start tracking."
          : "Only one snapshot saved. Save another snapshot after a week to see the delta.",
        snapshotCount: snapshots.length,
      });
    }

    const total = snapshots.length;
    const idxA = req.query.a !== undefined ? parseInt(req.query.a as string) : total - 2;
    const idxB = req.query.b !== undefined ? parseInt(req.query.b as string) : total - 1;

    if (idxA < 0 || idxA >= total || idxB < 0 || idxB >= total) {
      return res.status(400).json({ error: "Snapshot index out of range" });
    }

    const delta = computeDelta(snapshots[idxA], snapshots[idxB]);
    res.json(delta);
  });

  return httpServer;
}
