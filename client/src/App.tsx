import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import PerplexityAttribution from "@/components/PerplexityAttribution";
import {
  Search, RefreshCw, Download, ChevronUp, ChevronDown,
  ChevronsUpDown, AlertCircle, Users, Building2,
  Camera, GitCompare, UserPlus, UserMinus, ArrowLeftRight,
  Clock, ChevronLeft, ChevronRight
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Inmate {
  id: number;
  name: string;
  lastName: string;
  firstName: string;
  ageDob: string;
  gender: string;
  bookingNumber: string;
  facility: string;
}

interface RosterResponse {
  facility: string;
  count: number;
  inmates: Inmate[];
  cached: boolean;
  fetching?: boolean; // true when PA DOC background fetch is running
}

interface SnapshotMeta {
  index: number;
  timestamp: string;
  count: number;
}

interface SnapshotsResponse {
  facility: string;
  snapshots: SnapshotMeta[];
}

interface DeltaResult {
  facility: string;
  insufficient?: boolean;
  message?: string;
  snapshotCount?: number;
  snapshotA?: { timestamp: string; count: number };
  snapshotB?: { timestamp: string; count: number };
  added?: Inmate[];
  released?: Inmate[];
  stayed?: number;
}

type SortKey = "name" | "ageDob" | "gender" | "bookingNumber";
type SortDir = "asc" | "desc";
type ActiveView = "roster" | "delta";

// ─── GettingOut facility type ─────────────────────────────────────────────────
interface GoFacility {
  key:   string;
  label: string;
  count: number;
  id:    number;
}

// Letter bucket ranges for collapsible GettingOut nav
const GO_BUCKETS: { label: string; start: string; end: string }[] = [
  { label: "A – F", start: "a", end: "f" },
  { label: "G – L", start: "g", end: "l" },
  { label: "M – R", start: "m", end: "r" },
  { label: "S – Z", start: "s", end: "z" },
];

function bucketFor(label: string): string {
  const ch = (label[0] || "?").toLowerCase();
  for (const b of GO_BUCKETS) {
    if (ch >= b.start && ch <= b.end) return b.label;
  }
  return "Other";
}

// ─── Facility config ──────────────────────────────────────────────────────────

const FACILITIES = [
  { key: "monroe",       label: "Monroe County",         short: "Monroe",      slowFetch: false, comingSoon: false, searchOnly: false, gettingOut: false, yorkGo: false },
  { key: "erie",         label: "Erie County",            short: "Erie",        slowFetch: false, comingSoon: false, searchOnly: false, gettingOut: false, yorkGo: false },
  { key: "cumberland",    label: "Cumberland County",     short: "Cumberland",  slowFetch: false, comingSoon: false, searchOnly: false, gettingOut: false, yorkGo: false },
  { key: "dauphin",       label: "Dauphin County",        short: "Dauphin",     slowFetch: false, comingSoon: false, searchOnly: false, gettingOut: false, yorkGo: false },
  { key: "lancaster",     label: "Lancaster County",      short: "Lancaster",   slowFetch: false, comingSoon: false, searchOnly: false, gettingOut: false, yorkGo: false },
  { key: "mercer",        label: "Mercer County",         short: "Mercer",      slowFetch: false, comingSoon: false, searchOnly: false, gettingOut: false, yorkGo: false },
  { key: "philadelphia",  label: "Philadelphia County",   short: "Philadelphia",slowFetch: false, comingSoon: false, searchOnly: true,  gettingOut: false, yorkGo: false },
  { key: "westmoreland",  label: "Westmoreland County",   short: "Westmoreland",slowFetch: false, comingSoon: false, searchOnly: false, gettingOut: false, yorkGo: false },
  { key: "york-prison",   label: "York County Prison",    short: "York Prison", slowFetch: false, comingSoon: true,  searchOnly: false, gettingOut: false, yorkGo: false },
  { key: "padoc",         label: "PA State Prisons",      short: "PA DOC",      slowFetch: true,  comingSoon: false, searchOnly: false, gettingOut: false, yorkGo: false },
  { key: "gettingout",       label: "GettingOut Contacts",      short: "GettingOut",  slowFetch: false, comingSoon: false, searchOnly: false, gettingOut: true,  yorkGo: false },
  { key: "york-gettingout",  label: "York Prison (GettingOut)", short: "York GO",     slowFetch: false, comingSoon: false, searchOnly: false, gettingOut: false, yorkGo: false },
];

// ─── Logo ─────────────────────────────────────────────────────────────────────

function Logo() {
  return (
    <svg
      aria-label="PA Jail Roster"
      viewBox="0 0 32 32"
      fill="none"
      className="w-7 h-7 shrink-0"
    >
      <path
        d="M16 3L4 8v9c0 6.627 5.373 12 12 12s12-5.373 12-12V8L16 3z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        className="text-primary"
      />
      <line x1="10" y1="13" x2="22" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-primary" />
      <line x1="10" y1="17" x2="22" y2="17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-primary" />
      <line x1="10" y1="21" x2="18" y2="21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-primary" />
    </svg>
  );
}

// ─── Sort header ──────────────────────────────────────────────────────────────

function SortHeader({
  label, sortKey, currentKey, dir, onSort
}: {
  label: string; sortKey: SortKey; currentKey: SortKey; dir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = currentKey === sortKey;
  return (
    <button
      onClick={() => onSort(sortKey)}
      className={`flex items-center gap-1 text-left uppercase tracking-wider text-[11px] font-semibold transition-colors ${
        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
      data-testid={`sort-${sortKey}`}
    >
      {label}
      <span className="ml-0.5">
        {active ? (dir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-40" />}
      </span>
    </button>
  );
}

// ─── Roster table ─────────────────────────────────────────────────────────────

function RosterTable({
  inmates, sortKey, sortDir, onSort, query, facilityKey
}: {
  inmates: Inmate[]; sortKey: SortKey; sortDir: SortDir;
  onSort: (k: SortKey) => void; query: string; facilityKey?: string;
}) {
  const highlight = (text: string) => {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-primary/25 text-primary rounded-sm px-0">{text.slice(idx, idx + query.length)}</mark>
        {text.slice(idx + query.length)}
      </>
    );
  };

  if (inmates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <Search className="w-8 h-8 opacity-30" />
        <p className="text-sm">No results match your search.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border">
            <th className="pl-4 pr-2 py-3 w-14 text-left">
              <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">#</span>
            </th>
            <th className="px-3 py-3">
              <SortHeader label="Name" sortKey="name" currentKey={sortKey} dir={sortDir} onSort={onSort} />
            </th>
            <th className="px-3 py-3 w-36">
              <SortHeader label="DOB / Age" sortKey="ageDob" currentKey={sortKey} dir={sortDir} onSort={onSort} />
            </th>
            <th className="px-3 py-3 w-16">
              <SortHeader label="Sex" sortKey="gender" currentKey={sortKey} dir={sortDir} onSort={onSort} />
            </th>
            <th className="px-3 py-3 w-44">
              <SortHeader label="Booking #" sortKey="bookingNumber" currentKey={sortKey} dir={sortDir} onSort={onSort} />
            </th>
            <th className="pr-4 px-3 py-3">
              <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Facility</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {inmates.map((inmate, i) => (
            <tr
              key={`${inmate.bookingNumber || inmate.name}-${i}`}
              className="border-b border-border/40 hover:bg-secondary/50 transition-colors row-animate"
              style={{ animationDelay: `${Math.min(i * 8, 200)}ms` }}
              data-testid={`row-inmate-${i}`}
            >
              <td className="pl-4 pr-2 py-2.5 text-muted-foreground tabular text-xs">{inmate.id}</td>
              <td className="px-3 py-2.5 font-medium">{highlight(inmate.name)}</td>
              <td className="px-3 py-2.5 text-muted-foreground tabular text-xs">{inmate.ageDob || "—"}</td>
              <td className="px-3 py-2.5 text-muted-foreground tabular text-xs">{inmate.gender || "—"}</td>
              <td className="px-3 py-2.5 tabular text-xs">
                {inmate.bookingNumber ? (
                  <span className="text-primary/80 font-mono">{inmate.bookingNumber}</span>
                ) : "—"}
              </td>
              <td className="pr-4 px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[180px]">{inmate.facility}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Delta mini-table ─────────────────────────────────────────────────────────

function DeltaMiniTable({ inmates, variant }: { inmates: Inmate[]; variant: "added" | "released" }) {
  const color = variant === "added"
    ? "text-emerald-400"
    : "text-rose-400";
  const bgRow = variant === "added"
    ? "hover:bg-emerald-950/30"
    : "hover:bg-rose-950/30";

  if (inmates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center">None</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left">
              <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Name</span>
            </th>
            <th className="px-3 py-2 w-28 text-left">
              <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">DOB</span>
            </th>
            <th className="px-3 py-2 w-14 text-left">
              <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Sex</span>
            </th>
            <th className="px-3 py-2 w-40 text-left">
              <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Booking #</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {inmates.map((inmate, i) => (
            <tr
              key={`${inmate.bookingNumber || inmate.name}-${i}`}
              className={`border-b border-border/30 transition-colors ${bgRow}`}
              data-testid={`delta-row-${variant}-${i}`}
            >
              <td className={`px-3 py-2 font-medium text-sm ${color}`}>{inmate.name}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground tabular">{inmate.ageDob || "—"}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground tabular">{inmate.gender || "—"}</td>
              <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{inmate.bookingNumber || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Delta panel ──────────────────────────────────────────────────────────────

function DeltaPanel({ facility }: { facility: string }) {
  const queryClient = useQueryClient();
  const [selectedA, setSelectedA] = useState<number | null>(null);
  const [selectedB, setSelectedB] = useState<number | null>(null);
  const [activeSection, setActiveSection] = useState<"added" | "released">("added");

  const { data: snapshotsData, isLoading: snapsLoading } = useQuery<SnapshotsResponse>({
    queryKey: ["/api/snapshots", facility],
    queryFn: () => apiRequest("GET", `/api/snapshots/${facility}`).then(r => r.json()),
    staleTime: 30 * 1000,
  });

  const snapshots = snapshotsData?.snapshots ?? [];
  const total = snapshots.length;

  // Default: compare last two
  const idxA = selectedA !== null ? selectedA : (total >= 2 ? total - 2 : 0);
  const idxB = selectedB !== null ? selectedB : (total >= 1 ? total - 1 : 0);

  const { data: deltaData, isLoading: deltaLoading } = useQuery<DeltaResult>({
    queryKey: ["/api/delta", facility, idxA, idxB],
    queryFn: () => apiRequest("GET", `/api/delta/${facility}?a=${idxA}&b=${idxB}`).then(r => r.json()),
    enabled: total >= 2,
    staleTime: 60 * 1000,
  });

  const snapshotMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/snapshot/${facility}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/snapshots", facility] });
      queryClient.invalidateQueries({ queryKey: ["/api/delta", facility] });
    },
  });

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* ── Controls bar ── */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <GitCompare className="w-4 h-4 text-primary" />
          <span className="font-semibold text-foreground">Weekly Delta</span>
          {total > 0 && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-primary/15 text-primary border-0">
              {total} snapshot{total !== 1 ? "s" : ""} saved
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => snapshotMutation.mutate()}
          disabled={snapshotMutation.isPending || snapsLoading}
          data-testid="button-save-snapshot"
          className="text-xs gap-1.5 h-8"
        >
          <Camera className={`w-3.5 h-3.5 ${snapshotMutation.isPending ? "animate-pulse" : ""}`} />
          {snapshotMutation.isPending ? "Saving…" : "Save Snapshot"}
        </Button>
      </div>

      {/* ── Snapshot selector (shown when ≥2 snapshots) ── */}
      {total >= 2 && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border bg-background text-xs text-muted-foreground flex-wrap">
          <span className="font-medium text-foreground">Compare:</span>
          <div className="flex items-center gap-1.5">
            <Clock className="w-3 h-3" />
            <select
              className="bg-card border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
              value={idxA}
              onChange={e => setSelectedA(parseInt(e.target.value))}
              data-testid="select-snapshot-a"
            >
              {snapshots.map((s, i) => (
                <option key={i} value={i}>
                  {fmtDate(s.timestamp)} ({s.count} inmates)
                </option>
              ))}
            </select>
            <ArrowLeftRight className="w-3.5 h-3.5 mx-1 opacity-50" />
            <select
              className="bg-card border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
              value={idxB}
              onChange={e => setSelectedB(parseInt(e.target.value))}
              data-testid="select-snapshot-b"
            >
              {snapshots.map((s, i) => (
                <option key={i} value={i}>
                  {fmtDate(s.timestamp)} ({s.count} inmates)
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* ── Content ── */}
      <div className="flex-1 p-4">

        {/* No snapshots yet */}
        {!snapsLoading && total === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
            <Camera className="w-10 h-10 opacity-25" />
            <div className="text-center">
              <p className="font-semibold text-foreground">No snapshots yet</p>
              <p className="text-sm mt-1 max-w-xs text-center leading-relaxed">
                Click <strong>Save Snapshot</strong> to capture today's roster. Save another next week to see who's new and who's been released.
              </p>
            </div>
          </div>
        )}

        {/* One snapshot — need a second */}
        {!snapsLoading && total === 1 && (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
            <Clock className="w-10 h-10 opacity-25" />
            <div className="text-center">
              <p className="font-semibold text-foreground">First snapshot saved</p>
              <p className="text-sm mt-1 max-w-xs text-center leading-relaxed">
                Saved on <span className="text-foreground font-medium">{fmtDate(snapshots[0].timestamp)}</span> ({snapshots[0].count} inmates).
                Come back next week and save another snapshot to see the delta.
              </p>
            </div>
          </div>
        )}

        {/* Delta results */}
        {total >= 2 && (
          <>
            {deltaLoading && (
              <div className="space-y-3">
                <Skeleton className="h-20 w-full bg-muted/30" />
                <Skeleton className="h-40 w-full bg-muted/30" />
              </div>
            )}

            {!deltaLoading && deltaData && !deltaData.insufficient && (
              <div className="space-y-5">

                {/* KPI row */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-3 text-center">
                    <div className="flex items-center justify-center gap-1.5 mb-1">
                      <UserPlus className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-[11px] uppercase tracking-wider font-semibold text-emerald-400">New</span>
                    </div>
                    <p className="text-2xl font-bold text-emerald-400" data-testid="delta-added-count">{deltaData.added?.length ?? 0}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">added since prior snapshot</p>
                  </div>
                  <div className="rounded-lg border border-rose-500/20 bg-rose-950/20 p-3 text-center">
                    <div className="flex items-center justify-center gap-1.5 mb-1">
                      <UserMinus className="w-3.5 h-3.5 text-rose-400" />
                      <span className="text-[11px] uppercase tracking-wider font-semibold text-rose-400">Released</span>
                    </div>
                    <p className="text-2xl font-bold text-rose-400" data-testid="delta-released-count">{deltaData.released?.length ?? 0}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">no longer on roster</p>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3 text-center">
                    <div className="flex items-center justify-center gap-1.5 mb-1">
                      <Users className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Stayed</span>
                    </div>
                    <p className="text-2xl font-bold text-foreground" data-testid="delta-stayed-count">{deltaData.stayed ?? 0}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">still on roster</p>
                  </div>
                </div>

                {/* Period label */}
                <p className="text-xs text-muted-foreground text-center">
                  <span className="text-foreground font-medium">{fmtDate(deltaData.snapshotA!.timestamp)}</span>
                  <span className="mx-2 opacity-50">→</span>
                  <span className="text-foreground font-medium">{fmtDate(deltaData.snapshotB!.timestamp)}</span>
                </p>

                {/* Tab toggle for added / released */}
                <div className="flex items-center justify-between border-b border-border">
                  <div className="flex">
                    <button
                      onClick={() => setActiveSection("added")}
                      data-testid="delta-tab-added"
                      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                        activeSection === "added"
                          ? "border-emerald-500 text-emerald-400"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <UserPlus className="w-3.5 h-3.5" />
                        New Inmates
                        <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-emerald-900/40 text-emerald-400 border-0">
                          {deltaData.added?.length ?? 0}
                        </Badge>
                      </span>
                    </button>
                    <button
                      onClick={() => setActiveSection("released")}
                      data-testid="delta-tab-released"
                      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                        activeSection === "released"
                          ? "border-rose-500 text-rose-400"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <UserMinus className="w-3.5 h-3.5" />
                        Released
                        <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-rose-900/40 text-rose-400 border-0">
                          {deltaData.released?.length ?? 0}
                        </Badge>
                      </span>
                    </button>
                  </div>
                  {/* Download button for whichever tab is active */}
                  <button
                    onClick={() => exportDeltaCSV(
                      activeSection === "added" ? (deltaData.added ?? []) : (deltaData.released ?? []),
                      activeSection,
                      facility,
                      deltaData.snapshotA!.timestamp,
                      deltaData.snapshotB!.timestamp
                    )}
                    disabled={(activeSection === "added" ? deltaData.added?.length : deltaData.released?.length) === 0}
                    data-testid="button-download-delta"
                    className="flex items-center gap-1.5 px-3 py-1.5 mb-1 mr-1 text-xs font-medium rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download CSV
                  </button>
                </div>

                {/* Detail table */}
                <DeltaMiniTable
                  inmates={activeSection === "added" ? (deltaData.added ?? []) : (deltaData.released ?? [])}
                  variant={activeSection}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Skeleton loading ──────────────────────────────────────────────────────────

function TableSkeleton({ slowFetch = false, fetching = false }: { slowFetch?: boolean; fetching?: boolean }) {
  return (
    <div className="p-4 space-y-2">
      {Array.from({ length: 15 }).map((_, i) => (
        <div key={i} className="flex gap-4 items-center">
          <Skeleton className="w-8 h-4 bg-muted/40" />
          <Skeleton className="flex-1 h-4 bg-muted/40" />
          <Skeleton className="w-24 h-4 bg-muted/40" />
          <Skeleton className="w-28 h-4 bg-muted/40" />
          <Skeleton className="w-36 h-4 bg-muted/40" />
        </div>
      ))}
      <div className="text-center pt-6 space-y-1">
        <p className="text-xs text-muted-foreground">
          {fetching
            ? "Building state prison roster — querying 180+ PA DOC facilities in the background…"
            : slowFetch
            ? "Fetching PA state prison roster — this may take 3–5 minutes on first load."
            : "Fetching roster — this may take 30–60 seconds for large facilities…"}
        </p>
        {fetching && (
          <p className="text-[11px] text-muted-foreground/60">This page will refresh automatically every 15 seconds until data is ready.</p>
        )}
      </div>
    </div>
  );
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportDeltaCSV(inmates: Inmate[], variant: "added" | "released", facility: string, fromDate: string, toDate: string) {
  const label = variant === "added" ? "new-arrivals" : "released";
  const from = new Date(fromDate).toISOString().slice(0, 10);
  const to   = new Date(toDate).toISOString().slice(0, 10);
  const headers = ["Name", "DOB/Age", "Sex", "Booking Number", "Facility"];
  const rows = inmates.map(i => [
    `"${i.name}"`, i.ageDob, i.gender, i.bookingNumber, `"${i.facility}"`
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${facility}-${label}-${from}-to-${to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCSV(inmates: Inmate[], facilityKey: string) {
  const bookingHeader = "Booking Number";
  const headers = ["#", "Name", "DOB/Age", "Sex", bookingHeader, "Facility"];
  const rows = inmates.map((i, idx) => [
    idx + 1, `"${i.name}"`, i.ageDob || "", i.gender || "", i.bookingNumber || "", `"${i.facility || ""}"`
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${facilityKey}-roster-${new Date().toISOString().slice(0, 10)}-${inmates.length}inmates.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── York Prison GettingOut Panel ──────────────────────────────────────────────

interface YorkGoContact {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  facility: string;
}

function YorkGettingOutPanel() {
  const [contacts, setContacts] = useState<YorkGoContact[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState("");
  const [query, setQuery]       = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try {
      const r = await apiRequest("GET", "/api/gettingout/york");
      const data = await r.json();
      if (data.error) setError(data.error);
      else setContacts(data.contacts ?? []);
    } catch { setError("Failed to load roster."); }
    finally { setLoading(false); }
  };

  useState(() => { load(); });

  const filtered = contacts.filter(c =>
    !query.trim() ||
    c.name.toLowerCase().includes(query.toLowerCase())
  );

  const exportCSVGo = () => {
    const headers = ["#", "Name", "First Name", "Last Name", "Facility"];
    const rows = filtered.map((c, i) => [i + 1, `"${c.name}"`, `"${c.firstName}"`, `"${c.lastName}"`, `"${c.facility}"` ]);
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `york-prison-gettingout-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* Header */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">York County Prison — GettingOut Roster</span>
          {contacts.length > 0 && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-primary/15 text-primary border-0">
              {filtered.length !== contacts.length ? `${filtered.length}/` : ""}{contacts.length}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={exportCSVGo} disabled={!filtered.length} className="text-xs gap-1.5 h-8">
            <Download className="w-3.5 h-3.5" />Export CSV
          </Button>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="text-xs gap-1.5 h-8">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-card border-b border-border">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input placeholder="Search name…" value={query} onChange={e => setQuery(e.target.value)}
            className="pl-8 h-8 text-sm bg-background border-border focus:border-primary" />
          {query && <button onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">×</button>}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="w-3.5 h-3.5" />
          <span className="tabular">{loading ? "Loading…" : `${filtered.length} inmates`}</span>
        </div>
      </div>

      {/* Content */}
      {error ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <AlertCircle className="w-8 h-8 text-destructive/60" /><p className="text-sm">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <RefreshCw className="w-6 h-6 animate-spin text-primary" /><p className="text-sm">Loading roster…</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border">
                <th className="pl-4 pr-2 py-3 w-14 text-left"><span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">#</span></th>
                <th className="px-3 py-3 text-left"><span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Name</span></th>
                <th className="px-3 py-3 text-left"><span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">First Name</span></th>
                <th className="pr-4 px-3 py-3 text-left"><span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Last Name</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={`${c.name}-${i}`} className="border-b border-border/40 hover:bg-secondary/50 transition-colors">
                  <td className="pl-4 pr-2 py-2.5 text-muted-foreground tabular text-xs">{i + 1}</td>
                  <td className="px-3 py-2.5 font-medium">{c.name}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.firstName}</td>
                  <td className="pr-4 px-3 py-2.5 text-xs text-muted-foreground">{c.lastName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-auto px-5 py-3 text-[11px] text-muted-foreground/50 text-center border-t border-border">
        Data sourced from <a href="https://www.gettingout.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-muted-foreground">GettingOut.com</a> · York County Prison, PA
      </p>
    </div>
  );
}

// ─── GettingOut Panel ───────────────────────────────────────────────────────────

interface GoContact {
  id: number;
  name: string;
  facility: string;
  inmateId: string;
  status: string;
  paMatch?: string; // matched PA county roster tab key, if any
}

function GettingOutPanel() {
  const [contacts, setContacts]   = useState<GoContact[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");
  const [query, setQuery]         = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const loadContacts = async () => {
    setLoading(true);
    setError("");
    try {
      const r = await apiRequest("GET", "/api/gettingout/contacts");
      const data = await r.json();
      if (data.error) setError(data.error);
      else setContacts(data.contacts ?? []);
    } catch {
      setError("Failed to load GettingOut contacts.");
    } finally {
      setLoading(false);
    }
  };

  // Load on mount
  useState(() => { loadContacts(); });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadMsg("");
    try {
      const text = await file.text();
      const r = await apiRequest("POST", "/api/gettingout/upload", { body: text, headers: { "Content-Type": "text/plain" } });
      const data = await r.json();
      if (data.error) setUploadMsg(`Error: ${data.error}`);
      else {
        setUploadMsg(`Loaded ${data.count} contact${data.count !== 1 ? "s" : ""}`);
        loadContacts();
      }
    } catch {
      setUploadMsg("Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const filtered = contacts.filter(c =>
    !query.trim() ||
    c.name.toLowerCase().includes(query.toLowerCase()) ||
    c.facility.toLowerCase().includes(query.toLowerCase()) ||
    c.inmateId.toLowerCase().includes(query.toLowerCase())
  );

  // Lancaster and Dauphin are excluded from cross-referencing intentionally
  const PA_COUNTY_LABELS: Record<string, string> = {
    cumberland: "Cumberland County",
    mercer: "Mercer County", philadelphia: "Philadelphia County",
    westmoreland: "Westmoreland County", "york-prison": "York County Prison",
    padoc: "PA State Prisons",
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* ── Header bar ── */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">GettingOut Contacts</span>
          {contacts.length > 0 && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-primary/15 text-primary border-0">
              {contacts.length} contact{contacts.length !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm" variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="text-xs gap-1.5 h-8"
          >
            <Download className="w-3.5 h-3.5 rotate-180" />
            {uploading ? "Uploading…" : "Upload Data"}
          </Button>
          <input ref={fileRef} type="file" accept=".csv,.txt,.json" className="hidden" onChange={handleUpload} />
          <Button
            size="sm" variant="outline"
            onClick={loadContacts}
            disabled={loading}
            className="text-xs gap-1.5 h-8"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Search bar ── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-card border-b border-border">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search name, facility, or ID…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="pl-8 h-8 text-sm bg-background border-border focus:border-primary"
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">×</button>
          )}
        </div>
        {uploadMsg && (
          <span className="text-xs text-primary font-medium">{uploadMsg}</span>
        )}
      </div>

      {/* ── Content ── */}
      {error ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <AlertCircle className="w-8 h-8 text-destructive/60" />
          <p className="text-sm">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <RefreshCw className="w-6 h-6 animate-spin text-primary" />
          <p className="text-sm">Loading contacts…</p>
        </div>
      ) : contacts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
          <Users className="w-10 h-10 opacity-20" />
          <div className="text-center max-w-xs">
            <p className="font-semibold text-foreground text-sm">No contacts loaded yet</p>
            <p className="text-xs mt-2 leading-relaxed">
              Click <strong>Upload Data</strong> to import your GettingOut contact list,
              or use the browser integration to pull data directly from your account.
            </p>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border">
                <th className="pl-4 pr-2 py-3 w-14 text-left">
                  <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">#</span>
                </th>
                <th className="px-3 py-3 text-left">
                  <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Name</span>
                </th>
                <th className="px-3 py-3 text-left">
                  <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Facility</span>
                </th>
                <th className="px-3 py-3 w-36 text-left">
                  <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Inmate ID</span>
                </th>
                <th className="px-3 py-3 w-28 text-left">
                  <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">Status</span>
                </th>
                <th className="pr-4 px-3 py-3 text-left">
                  <span className="uppercase tracking-wider text-[11px] font-semibold text-muted-foreground">PA Roster Match</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr
                  key={`${c.inmateId || c.name}-${i}`}
                  className="border-b border-border/40 hover:bg-secondary/50 transition-colors"
                >
                  <td className="pl-4 pr-2 py-2.5 text-muted-foreground tabular text-xs">{c.id}</td>
                  <td className="px-3 py-2.5 font-medium">{c.name}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[180px]">{c.facility || "—"}</td>
                  <td className="px-3 py-2.5 tabular text-xs font-mono text-primary/80">{c.inmateId || "—"}</td>
                  <td className="px-3 py-2.5 text-xs">
                    {c.status ? (
                      <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary border-0">{c.status}</Badge>
                    ) : "—"}
                  </td>
                  <td className="pr-4 px-3 py-2.5 text-xs">
                    {c.paMatch ? (
                      <Badge variant="secondary" className="text-[10px] bg-emerald-500/15 text-emerald-400 border-0">
                        {PA_COUNTY_LABELS[c.paMatch] ?? c.paMatch}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground/50">No match</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Footer note ── */}
      <p className="mt-auto px-5 py-3 text-[11px] text-muted-foreground/50 text-center leading-relaxed border-t border-border">
        Data sourced from your personal{" "}
        <a href="https://www.gettingout.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-muted-foreground">GettingOut</a>
        {" "}account. Cross-referenced against PA county jail public rosters.
      </p>
    </div>
  );
}

// ─── Philadelphia Search Panel ──────────────────────────────────────────────────

interface PhilaResult {
  name: string;
  ppn: string;
  location: string;
  facilityName: string;
  lastUpdated: string;
}

function PhillySearchPanel() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName]   = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [results, setResults]     = useState<PhilaResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError]         = useState("");

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) return;
    setSearching(true);
    setError("");
    setResults(null);
    setSubmitted(true);
    try {
      const r = await apiRequest("GET", `/api/phila/search?firstName=${encodeURIComponent(firstName.trim())}&lastName=${encodeURIComponent(lastName.trim())}`);
      const data = await r.json();
      if (data.error) {
        setError(data.error);
      } else {
        setResults(data.results ?? []);
      }
    } catch {
      setError("Search failed. Please try again.");
    } finally {
      setSearching(false);
    }
  };

  const fmtDate = (iso: string) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch { return iso; }
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 max-w-2xl mx-auto w-full">
      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-1">
          <Building2 className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Philadelphia County Jails — Inmate Search</h2>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Search by name across all Philadelphia Department of Prisons facilities.
          Both first and last name are required.
        </p>
      </div>

      {/* Search form */}
      <form onSubmit={handleSearch} className="flex flex-col gap-3 mb-6">
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 block">First Name</label>
            <Input
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              placeholder="e.g. John"
              data-testid="phila-input-firstname"
              className="h-9 text-sm bg-background border-border focus:border-primary"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 block">Last Name</label>
            <Input
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              placeholder="e.g. Smith"
              data-testid="phila-input-lastname"
              className="h-9 text-sm bg-background border-border focus:border-primary"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={searching || !firstName.trim() || !lastName.trim()}
          data-testid="phila-button-search"
          className="flex items-center justify-center gap-2 px-4 py-2 rounded bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Search className={`w-4 h-4 ${searching ? "animate-spin" : ""}`} />
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {/* Results */}
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-destructive/30 bg-destructive/10 text-sm text-destructive">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {submitted && !searching && !error && results !== null && (
        results.length === 0 ? (
          <div className="flex flex-col items-center py-12 gap-3 text-muted-foreground">
            <Search className="w-8 h-8 opacity-30" />
            <p className="text-sm">No inmates found matching <strong className="text-foreground">{firstName} {lastName}</strong>.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {results.length} result{results.length !== 1 ? "s" : ""} for <strong className="text-foreground">{firstName} {lastName}</strong>
            </p>
            {results.map((r, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-2" data-testid={`phila-result-${i}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-foreground text-sm">{r.name}</p>
                  <Badge variant="secondary" className="text-[10px] bg-primary/15 text-primary border-0 shrink-0">
                    PPN: {r.ppn}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Building2 className="w-3 h-3" />
                  <span>{r.facilityName}</span>
                </div>
                {r.lastUpdated && (
                  <p className="text-[11px] text-muted-foreground/60">
                    Data as of {fmtDate(r.lastUpdated)}
                  </p>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* Footer note */}
      <p className="mt-6 text-[11px] text-muted-foreground/50 text-center leading-relaxed">
        Data provided by{" "}
        <a href="https://incarceratedperson-locator.phila.gov/#/" target="_blank" rel="noopener noreferrer" className="underline hover:text-muted-foreground">
          Philadelphia Department of Prisons
        </a>.
        For full details call 215-686-5600.
      </p>
    </div>
  );
}

// ─── SideNav ──────────────────────────────────────────────────────────────────

interface SideNavProps {
  activeFacility: string;
  onSelect: (key: string) => void;
  activeCount?: number;
  filteredCount?: number;
}

function SideNav({ activeFacility, onSelect, activeCount, filteredCount }: SideNavProps) {
  const [goOpen, setGoOpen]         = useState(true);
  const [openBuckets, setOpenBuckets] = useState<Record<string, boolean>>({});
  const [goFacilities, setGoFacilities] = useState<GoFacility[]>([]);

  // Fetch GO facilities from backend
  useEffect(() => {
    apiRequest("GET", "/api/gettingout/facilities")
      .then(r => r.json())
      .then(d => {
        if (d.facilities) setGoFacilities(d.facilities);
      })
      .catch(() => {});
  }, []);

  const toggleBucket = (label: string) =>
    setOpenBuckets(prev => ({ ...prev, [label]: !prev[label] }));

  // Group GO facilities into buckets
  const buckets = useMemo(() => {
    const map: Record<string, GoFacility[]> = {};
    for (const fac of goFacilities) {
      const b = bucketFor(fac.label);
      if (!map[b]) map[b] = [];
      map[b].push(fac);
    }
    // Sort within each bucket
    for (const b of Object.keys(map)) {
      map[b].sort((a, b) => a.label.localeCompare(b.label));
    }
    return map;
  }, [goFacilities]);

  const navBtn = (key: string, label: string, short: string, count?: number) => {
    const isActive = activeFacility === key;
    return (
      <button
        key={key}
        onClick={() => onSelect(key)}
        title={label}
        className={`w-full flex items-center justify-between px-3 py-1.5 text-xs rounded-md transition-colors text-left ${
          isActive
            ? "bg-primary/15 text-primary font-semibold"
            : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
        }`}
      >
        <span className="truncate">{label}</span>
        {isActive && activeCount !== undefined && (
          <Badge variant="secondary" className="ml-1.5 text-[9px] h-3.5 px-1 bg-primary/20 text-primary border-0 tabular shrink-0">
            {filteredCount !== activeCount ? `${filteredCount}/` : ""}{activeCount}
          </Badge>
        )}
      </button>
    );
  };

  return (
    <aside className="shrink-0 w-52 flex flex-col border-r border-border bg-card overflow-y-auto">

      {/* ── PA Counties section ── */}
      <div className="px-3 pt-3 pb-1">
        <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 px-1 mb-1">PA Counties</p>
        <div className="flex flex-col gap-0.5">
          {FACILITIES.filter(f => !f.gettingOut).map(f =>
            navBtn(f.key, f.label, f.short)
          )}
        </div>
      </div>

      <div className="mx-3 my-2 border-t border-border/60" />

      {/* ── GettingOut section ── */}
      <div className="px-3 pb-3">
        <button
          onClick={() => setGoOpen(o => !o)}
          className="w-full flex items-center justify-between px-1 mb-1 group"
        >
          <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">GettingOut</p>
          {goOpen
            ? <ChevronUp className="w-3 h-3 text-muted-foreground/40" />
            : <ChevronDown className="w-3 h-3 text-muted-foreground/40" />}
        </button>

        {goOpen && (
          <div className="flex flex-col gap-0.5">
            {/* GettingOut Contacts special tab */}
            {FACILITIES.filter(f => f.gettingOut).map(f =>
              navBtn(f.key, f.label, f.short)
            )}

            {goFacilities.length === 0 && (
              <p className="text-[11px] text-muted-foreground/40 px-2 py-2 italic">
                No facilities loaded yet.
                Run the scraper to add them.
              </p>
            )}

            {/* Letter buckets */}
            {GO_BUCKETS.map(bucket => {
              const items = buckets[bucket.label] ?? [];
              if (items.length === 0) return null;
              const isOpen = openBuckets[bucket.label] ?? false;
              return (
                <div key={bucket.label}>
                  <button
                    onClick={() => toggleBucket(bucket.label)}
                    className="w-full flex items-center justify-between px-2 py-1 mt-1 rounded hover:bg-secondary/40 transition-colors group"
                  >
                    <span className="text-[10px] font-semibold text-muted-foreground/70 group-hover:text-muted-foreground">
                      {bucket.label}
                    </span>
                    <div className="flex items-center gap-1">
                      <span className="text-[9px] text-muted-foreground/40">{items.length}</span>
                      {isOpen
                        ? <ChevronUp className="w-3 h-3 text-muted-foreground/40" />
                        : <ChevronDown className="w-3 h-3 text-muted-foreground/40" />}
                    </div>
                  </button>
                  {isOpen && (
                    <div className="flex flex-col gap-0.5 ml-2 mt-0.5">
                      {items.map(fac => navBtn(fac.key, fac.label, fac.label))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [activeFacility, setActiveFacility] = useState("monroe");
  const [activeView, setActiveView] = useState<ActiveView>("roster");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery<RosterResponse>({
    queryKey: ["/api/roster", activeFacility],
    queryFn: () => apiRequest("GET", `/api/roster/${activeFacility}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    // Auto-poll every 15s when PA DOC is still fetching in background
    refetchInterval: (query) => {
      const d = query.state.data as RosterResponse | undefined;
      return d?.fetching ? 15000 : false;
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/cache/${activeFacility}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/roster", activeFacility] });
    },
  });

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const filtered = useMemo(() => {
    if (!data?.inmates) return [];
    let list = [...data.inmates];
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(i =>
        i.name.toLowerCase().includes(q) ||
        i.bookingNumber.toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      const av = (a[sortKey] || "").toLowerCase();
      const bv = (b[sortKey] || "").toLowerCase();
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return list;
  }, [data, query, sortKey, sortDir]);

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const activeFac = FACILITIES.find(f => f.key === activeFacility)!
  const isComingSoon  = activeFac?.comingSoon  ?? false;
  const isSlowFetch   = activeFac?.slowFetch   ?? false;
  const isSearchOnly  = activeFac?.searchOnly  ?? false;
  const isGettingOut  = activeFac?.gettingOut  ?? false;

  return (
    <div
      className="flex flex-col"
      style={{ height: "100dvh", overflow: "hidden" }}
    >
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <h1 className="text-sm font-semibold leading-tight tracking-tight text-foreground">
              PA County Jail Roster
            </h1>
            <p className="text-[11px] text-muted-foreground leading-tight">
              Live public data · Monroe · Erie · Cumberland · Dauphin · Lancaster · Mercer · Philadelphia · Westmoreland · York · PA State · GettingOut
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {lastUpdated && activeView === "roster" && (
            <span className="hidden sm:block text-[11px] text-muted-foreground tabular">
              Updated {lastUpdated}
            </span>
          )}
          {activeView === "roster" && !isComingSoon && !isSearchOnly && !isGettingOut && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportCSV(filtered, activeFacility)}
              disabled={isLoading || !filtered.length}
              data-testid="button-export"
              className="text-xs gap-1.5 h-8"
            >
              <Download className="w-3.5 h-3.5" />
              {query ? `Export CSV (${filtered.length})` : "Export CSV"}
            </Button>
          )}
          {activeView === "roster" && !isComingSoon && !isSearchOnly && !isGettingOut && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMutation.mutate()}
              disabled={isLoading || refreshMutation.isPending}
              data-testid="button-refresh"
              className="text-xs gap-1.5 h-8"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshMutation.isPending || isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          )}
        </div>
      </header>

      {/* ── Two-section sidebar nav ──────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        <SideNav
          activeFacility={activeFacility}
          onSelect={(key) => { setActiveFacility(key); setQuery(""); setActiveView("roster"); }}
          activeCount={activeFacility && data?.count !== undefined && activeView === "roster" ? data.count : undefined}
          filteredCount={activeFacility && data?.count !== undefined && activeView === "roster" ? filtered.length : undefined}
        />

        {/* ── Right panel ── */}
        <div className="flex flex-col flex-1 overflow-hidden">

      {/* ── View toggle (Roster / Delta) — only for live roster facilities ── */}
      {!isComingSoon && !isSearchOnly && !isGettingOut && (
        <div className="shrink-0 flex border-b border-border bg-background">
          <button
            onClick={() => setActiveView("roster")}
            data-testid="view-roster"
            className={`px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
              activeView === "roster"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            Current Roster
          </button>
          <button
            onClick={() => setActiveView("delta")}
            data-testid="view-delta"
            className={`px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
              activeView === "delta"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <GitCompare className="w-3.5 h-3.5" />
            Weekly Delta
          </button>
        </div>
      )}

      {/* ── Toolbar (roster view only) ───────────────────────────────── */}
      {activeView === "roster" && !isComingSoon && !isSearchOnly && !isGettingOut && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-card border-b border-border">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              ref={searchRef}
              placeholder="Search name or booking #…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              data-testid="input-search"
              className="pl-8 h-8 text-sm bg-background border-border focus:border-primary"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="w-3.5 h-3.5" />
            <span className="tabular" data-testid="text-count">
              {isLoading ? "Loading…" : isError ? "Error" : `${filtered.length} inmates`}
            </span>
          </div>
        </div>
      )}

      {/* ── Main content ──────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto overscroll-contain bg-background">

        {/* Coming soon facilities */}
        {isGettingOut ? (
          <GettingOutPanel />

        ) : isSearchOnly ? (
          <PhillySearchPanel />

        ) : isComingSoon && activeView !== "delta" ? (
          <div className="flex flex-col items-center justify-center py-20 gap-5 text-muted-foreground">
            <svg viewBox="0 0 48 48" fill="none" className="w-12 h-12 text-primary/40" stroke="currentColor" strokeWidth="1.5">
              <rect x="8" y="16" width="32" height="26" rx="2" />
              <path d="M16 16V12a8 8 0 0 1 16 0v4" />
              <circle cx="24" cy="29" r="3" />
              <line x1="24" y1="32" x2="24" y2="36" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <div className="text-center">
              <p className="font-semibold text-foreground text-base">{activeFac?.label} — Roster Not Available</p>
              <p className="text-sm mt-2 max-w-xs text-center leading-relaxed">
                {activeFacility === "york-prison"
                  ? "York County Prison has not yet launched a public online inmate search. The county's website states it is coming soon."
                  : "Allegheny County Jail does not offer a public online inmate roster. Inmate booking information is available by phone at 412-350-2000."}
              </p>
            </div>
            <a
              href={activeFacility === "york-prison" ? "https://yorkcountypa.gov/477/Prison" : "https://www.alleghenycounty.us/Government/County-Jail/Inmate-Information"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline font-medium"
            >
              {activeFac?.label} official page →
            </a>
            {activeFacility === "york-prison" && (
              <p className="text-xs text-muted-foreground/60 max-w-xs text-center">
                You will be notified automatically when the public roster becomes available.
              </p>
            )}
          </div>

        ) : activeView === "delta" && !isComingSoon && !isSearchOnly ? (
          <DeltaPanel facility={activeFacility} />

        ) : (isLoading || (data?.fetching && data?.inmates?.length === 0)) ? (
          <TableSkeleton slowFetch={isSlowFetch} fetching={data?.fetching} />
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
            <AlertCircle className="w-10 h-10 text-destructive/60" />
            <div className="text-center">
              <p className="font-medium text-foreground">Failed to load roster</p>
              <p className="text-sm mt-1 max-w-sm text-center">
                Could not connect to the facility's public website. Try refreshing.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMutation.mutate()}
              className="mt-1"
            >
              Try Again
            </Button>
          </div>
        ) : (
          <RosterTable
            inmates={filtered}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            query={query}
            facilityKey={activeFacility}
          />
        )}
      </main>

        </div>{/* end right panel */}
      </div>{/* end flex row */}

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="shrink-0 flex items-center justify-between px-5 py-2 border-t border-border bg-card/60 text-[11px] text-muted-foreground">
        <span>Data pulled live from public PA county jail websites. For informational use only.</span>
        <a
          href="https://www.perplexity.ai/computer"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
        >
          Created with Perplexity Computer
        </a>
      </footer>
    </div>
  );
}
