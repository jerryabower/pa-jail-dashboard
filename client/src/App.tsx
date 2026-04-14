import { useState, useMemo, useRef } from "react";
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

// ─── Facility config ──────────────────────────────────────────────────────────

const FACILITIES = [
  { key: "crawford",      label: "Crawford County",       short: "Crawford",    slowFetch: false, comingSoon: false },
  { key: "cumberland",    label: "Cumberland County",     short: "Cumberland",  slowFetch: false, comingSoon: false },
  { key: "dauphin",       label: "Dauphin County",        short: "Dauphin",     slowFetch: false, comingSoon: false },
  { key: "lancaster",     label: "Lancaster County",      short: "Lancaster",   slowFetch: false, comingSoon: false },
  { key: "luzerne",       label: "Luzerne County",        short: "Luzerne",     slowFetch: false, comingSoon: false },
  { key: "westmoreland",  label: "Westmoreland County",   short: "Westmoreland",slowFetch: false, comingSoon: false },
  { key: "york-prison",   label: "York County Prison",    short: "York Prison", slowFetch: false, comingSoon: true  },
  { key: "padoc",         label: "PA State Prisons",      short: "PA DOC",      slowFetch: true,  comingSoon: false },
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
              <SortHeader label={facilityKey === "crawford" ? "Booking Date" : "Booking #"} sortKey="bookingNumber" currentKey={sortKey} dir={sortDir} onSort={onSort} />
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
  const headers = ["#", "Name", "DOB/Age", "Sex", "Booking Number", "Facility"];
  const rows = inmates.map(i => [
    i.id, `"${i.name}"`, i.ageDob, i.gender, i.bookingNumber, `"${i.facility}"`
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${facilityKey}-roster-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [activeFacility, setActiveFacility] = useState("crawford");
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
  const isComingSoon = activeFac?.comingSoon ?? false;
  const isSlowFetch = activeFac?.slowFetch ?? false;

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
              Live public data · Crawford · Cumberland · Dauphin · Lancaster · Luzerne · Westmoreland · York · PA State
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {lastUpdated && activeView === "roster" && (
            <span className="hidden sm:block text-[11px] text-muted-foreground tabular">
              Updated {lastUpdated}
            </span>
          )}
          {activeView === "roster" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportCSV(filtered, activeFacility)}
              disabled={isLoading || !data?.inmates?.length || isComingSoon}
              data-testid="button-export"
              className="text-xs gap-1.5 h-8"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </Button>
          )}
          {activeView === "roster" && !isComingSoon && (
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

      {/* ── Facility tabs ────────────────────────────────────────────── */}
      <nav className="shrink-0 flex items-center gap-1 px-4 pt-3 pb-0 border-b border-border bg-background">
        {FACILITIES.map(fac => (
          <button
            key={fac.key}
            onClick={() => { setActiveFacility(fac.key); setQuery(""); setActiveView("roster"); }}
            data-testid={`tab-${fac.key}`}
            className={`relative px-4 py-2 text-sm font-medium rounded-t-md transition-colors border-b-2 -mb-px ${
              activeFacility === fac.key
                ? "border-primary text-primary bg-card"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            <span className="hidden sm:inline">{fac.label}</span>
            <span className="sm:hidden">{fac.short}</span>
            {activeFacility === fac.key && data?.count !== undefined && activeView === "roster" && (
              <Badge
                variant="secondary"
                className="ml-2 text-[10px] h-4 px-1.5 bg-primary/15 text-primary border-0 tabular"
              >
                {filtered.length !== data.count ? `${filtered.length}/` : ""}{data.count}
              </Badge>
            )}
          </button>
        ))}
      </nav>

      {/* ── View toggle (Roster / Delta) — only for live facilities ── */}
      {!isComingSoon && (
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
      {activeView === "roster" && !isComingSoon && (
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
        {isComingSoon && activeView !== "delta" ? (
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

        ) : activeView === "delta" && !isComingSoon ? (
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
