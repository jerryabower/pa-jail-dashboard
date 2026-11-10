import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";

const file = path.join(fs.existsSync("/data") ? "/data" : process.cwd(), "dauphin-roster.json");
type Roster = { inmates: any[]; fetchedAt: string };
let saved: Roster | null = null;
try {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.version === 1 && raw.completed === 676 && Array.isArray(raw.inmates) &&
      raw.inmates.every((r: any) => r.releaseDate === "")) saved = raw;
} catch { /* No verified, completed Dauphin roster yet. */ }

let running = false;
let attempted = false;
let error: string | null = null;
let retryAt = 0;
let progress = { completed: 0, total: 676, prefix: "", found: 0, releasedExcluded: 0 };

function retryDeadline(value: unknown) {
  const seconds = Number(value);
  return typeof value === "string"
    ? Math.max(Date.now() + 5 * 60_000, Number.isFinite(seconds)
      ? Date.now() + seconds * 1000 : (Date.parse(value) || 0))
    : Date.now() + 5 * 60_000;
}

function start() {
  if (running || attempted || Date.now() < retryAt) return;
  running = true;
  attempted = true;
  error = null;
  progress = { completed: 0, total: 676, prefix: "", found: 0, releasedExcluded: 0 };
  const child = spawn("python3", ["-u", path.resolve("dauphin_collector.py")],
    { stdio: ["ignore", "pipe", "pipe"] });
  let candidate: Roster | null = null;
  let failed = false;
  const timer = setTimeout(() => {
    failed = true;
    error = "Dauphin collection exceeded two hours. Previous completed roster retained.";
    child.kill("SIGTERM");
  }, 2 * 60 * 60_000);
  child.stderr.on("data", () => { /* Do not log names or traceback content. */ });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "progress") {
        progress = { completed: event.completed, total: event.total, prefix: event.prefix,
          found: event.found, releasedExcluded: event.releasedExcluded };
      } else if (event.type === "error") {
        failed = true;
        error = String(event.message);
        retryAt = retryDeadline(event.retryAfter);
      } else if (event.type === "complete") {
        if (progress.completed !== 676 || progress.total !== 676 ||
            !Array.isArray(event.records) ||
            event.records.some((r: any) => r.release_date !== "")) {
          throw new Error("Incomplete or released records");
        }
        const keys = new Set<string>();
        const inmates = event.records.map((r: any, i: number) => {
          if (!r.name || !r.booking_number || keys.has(r.booking_number)) throw new Error("Invalid record");
          keys.add(r.booking_number);
          const comma = r.name.indexOf(",");
          return { id: i + 1, name: r.name, lastName: r.name.slice(0, comma).trim(),
            firstName: r.name.slice(comma + 1).trim(), ageDob: r.dob || "",
            gender: "", bookingNumber: r.booking_number, facility: "Dauphin County Prison",
            releaseDate: "" };
        });
        candidate = { inmates, fetchedAt: new Date().toISOString() };
      }
    } catch {
      failed = true;
      error = "Dauphin returned invalid collector output; previous completed roster retained.";
      child.kill("SIGTERM");
    }
  });
  child.on("error", () => {
    failed = true;
    error = "Dauphin collector could not start. Previous completed roster retained.";
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (!failed && code === 0 && candidate) {
      try {
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, completed: 676, ...candidate }));
        fs.renameSync(`${file}.tmp`, file);
        saved = candidate;
      } catch {
        error = "Could not save the completed Dauphin roster; previous roster retained.";
      }
    } else if (!error) {
      error = "Dauphin collection stopped before completion; previous roster retained.";
    }
    if (error) retryAt = Math.max(retryAt, Date.now() + 5 * 60_000);
    running = false;
  });
}

export function dauphinRoster(startIfNeeded = true) {
  // No timer, startup fetch, or automatic retry. Only the selected-tab request starts work.
  if (startIfNeeded && !saved && !attempted) start();
  return { facility: "dauphin", inmates: saved?.inmates ?? [], count: saved?.inmates.length ?? 0,
    cached: !!saved, fetchedAt: saved?.fetchedAt ?? null, fetching: running, progress,
    collectionError: error, retryAt: retryAt || null };
}

export function refreshDauphin() {
  if (running) return { ok: true, fetching: true };
  if (Date.now() < retryAt) return { ok: false, retryAt, error: "Dauphin cooldown is active. Try Refresh after the displayed time." };
  attempted = false;
  start();
  return { ok: true, fetching: running };
}

export function completedDauphin() {
  if (!saved || running || error) throw new Error("Complete a successful Dauphin refresh before saving a snapshot.");
  return saved.inmates;
}
