"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { TrendingUp, TrendingDown, RefreshCw, ChevronDown, ChevronRight, ChevronUp, AlertTriangle, WifiOff } from "lucide-react";

// ============================================================
// Config
// ============================================================
const API = process.env.NEXT_PUBLIC_ICX_API_URL || "https://icx-api-production.up.railway.app";
const REFRESH_MS = 5 * 60 * 1000;
const HISTORY_DAYS = 90;
const CACHE_KEY = "icx:dashboard:v1";
const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

// Tier colors: one step darker than the brand tints so they pass the
// dark-surface lightness and colour-blindness checks. Text never wears these.
const TIER_COLOR: Record<string, string> = {
  hyperscaler: "#d97706", specialist: "#0891b2", marketplace: "#7c3aed", budget: "#059669",
};
const INDEX_COLOR = "#22d3ee";

// ============================================================
// Types (shape of GET /api/dashboard)
// ============================================================
interface ApiIndex {
  value: number; change: number | null; change_pct: number | null;
  change_7d: number | null; change_7d_pct: number | null;
  low: number; high: number; spread: number; providers_count: number; computed_at: string;
}
interface ApiHist { index_value: number; low_price: number; high_price: number; spread: number; providers_count: number; computed_at: string }
interface ApiProvider {
  provider: string; gpu_model: string; price_per_gpu_hr: number; variant: string; region: string;
  source_url: string; scraped_at: string; prev_price: number | null; change: number | null; change_pct: number | null;
  tier: string; weight: number;
}
interface ApiMover { provider: string; current_price: number; prev_price: number; change: number; change_pct: number; tier: string }
interface ApiTier { id: string; label: string; share: number }
interface Dash {
  as_of: string; generated_at: string; index: ApiIndex; history: ApiHist[]; providers: ApiProvider[];
  movers: ApiMover[]; methodology: { description: string; tiers: ApiTier[] }; schedule: string;
}
interface HistPoint { ts: number; label: string; index: number; low: number; high: number; band: [number, number] }
interface ProvPoint { ts: number; label: string; price: number }
type Status = "loading" | "live" | "stale" | "error";
type SortKey = "price" | "name" | "change";

// ============================================================
// Helpers
// ============================================================
const usd = (v: number | null | undefined, d = 2) => (v == null ? "—" : `$${v.toFixed(d)}`);
const shortDate = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
function ago(d: Date | null) {
  if (!d) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

function readCache(): { savedAt: string; data: Dash } | null {
  try { const raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeCache(data: Dash) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data })); } catch { /* private mode etc. */ }
}

function normHist(raw: ApiHist[]): HistPoint[] {
  return raw.map(r => {
    const ts = new Date(r.computed_at).getTime();
    return { ts, label: shortDate(ts), index: +r.index_value, low: +r.low_price, high: +r.high_price, band: [+r.low_price, +r.high_price] };
  });
}

// ============================================================
// Small components
// ============================================================
function Pill({ val, size = "sm" }: { val: number | null | undefined; size?: "sm" | "md" }) {
  if (val == null) return <span className="text-xs text-gray-600">—</span>;
  const up = val >= 0;
  const cls = size === "md" ? "text-sm px-2 py-1" : "text-xs px-1.5 py-0.5";
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-medium rounded-md ${cls} ${up ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}
      aria-label={`${up ? "up" : "down"} ${Math.abs(val).toFixed(2)} percent`}
    >
      {up ? <TrendingUp size={size === "md" ? 14 : 11} aria-hidden /> : <TrendingDown size={size === "md" ? 14 : 11} aria-hidden />}
      {up ? "+" : ""}{val.toFixed(2)}%
    </span>
  );
}

function TierDot({ tier, className = "" }: { tier: string; className?: string }) {
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${className}`} style={{ backgroundColor: TIER_COLOR[tier] || "#6b7280" }} aria-hidden />;
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`bg-gray-900/70 border border-gray-800 rounded-2xl p-4 sm:p-5 ${className}`}>{children}</section>;
}

function Skeleton({ className }: { className: string }) {
  return <div className={`bg-gray-800/60 rounded-2xl animate-pulse ${className}`} />;
}

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-400 mb-0.5">{label}</p>
      <p className="text-gray-100 font-semibold">{usd(payload[0].value)}</p>
    </div>
  );
}

// ============================================================
// Provider price history (shared by the desktop row and the mobile card)
// ============================================================
function ProviderDetail({ p, points, range, loading }: { p: ApiProvider; points: ProvPoint[] | undefined; range: Range; loading: boolean }) {
  const cd = useMemo(() => {
    if (!points) return [];
    const cutoff = Date.now() - range * 86400e3;
    return points.filter(x => x.ts >= cutoff);
  }, [points, range]);
  const first = cd[0], last = cd[cd.length - 1];
  const rangeChg = first && last && first.price ? ((last.price - first.price) / first.price) * 100 : null;

  return (
    <div className="pt-3 pb-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2">
        <div className="text-xs text-gray-400">
          Past {range} days {rangeChg != null && <Pill val={rangeChg} />}
        </div>
        <div className="text-xs text-gray-500 truncate">
          {p.gpu_model} · {p.variant} · {p.region || "—"} ·{" "}
          <a href={p.source_url} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">source</a>
        </div>
      </div>
      {loading || !points ? (
        <Skeleton className="h-36" />
      ) : cd.length < 2 ? (
        <p className="text-xs text-gray-500 py-6 text-center">Not enough history yet.</p>
      ) : (
        <div className="h-36">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={cd} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={40} />
              <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={v => `$${v}`} width={42} />
              <Tooltip content={<Tip />} cursor={{ stroke: "#374151" }} />
              <Line type="monotone" dataKey="price" stroke={TIER_COLOR[p.tier] || INDEX_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Main Dashboard
// ============================================================
export default function Dashboard() {
  const [range, setRange] = useState<Range>(30);
  const [sel, setSel] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("price");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [status, setStatus] = useState<Status>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [lastOk, setLastOk] = useState<Date | null>(null);
  const [data, setData] = useState<Dash | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [debug, setDebug] = useState(false);
  const [provHist, setProvHist] = useState<Record<string, ProvPoint[]>>({});
  const [provLoading, setProvLoading] = useState<string | null>(null);
  const [, tick] = useState(0); // re-render the "x ago" label

  // ---- URL state: ?range=7|30|90&provider=Name&debug=1 -------------------
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = Number(q.get("range"));
    if (RANGES.includes(r as Range)) setRange(r as Range);
    const p = q.get("provider");
    if (p) setSel(p);
    setDebug(q.get("debug") === "1");
  }, []);
  useEffect(() => {
    const u = new URL(window.location.href);
    range === 30 ? u.searchParams.delete("range") : u.searchParams.set("range", String(range));
    sel ? u.searchParams.set("provider", sel) : u.searchParams.delete("provider");
    window.history.replaceState(null, "", u.toString());
  }, [range, sel]);

  // ---- Data ------------------------------------------------------------
  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const d = await api<Dash>(`/api/dashboard?days=${HISTORY_DAYS}`);
      setData(d); writeCache(d); setStatus("live"); setLastOk(new Date());
    } catch {
      const c = readCache();
      if (c) { setData(c.data); setStatus("stale"); setLastOk(new Date(c.savedAt)); }
      else setStatus("error");
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => { load(true); }, [load]);
  useEffect(() => {
    const id = setInterval(() => load(true), REFRESH_MS);
    const t = setInterval(() => tick(x => x + 1), 30_000);
    return () => { clearInterval(id); clearInterval(t); };
  }, [load]);

  const loadProv = useCallback(async (name: string) => {
    if (provHist[name]) return;
    setProvLoading(name);
    try {
      const raw = await api<{ price_per_gpu_hr: number; scraped_at: string }[]>(`/api/prices/provider/${encodeURIComponent(name)}?days=${HISTORY_DAYS}`);
      setProvHist(h => ({ ...h, [name]: raw.map(r => { const ts = new Date(r.scraped_at).getTime(); return { ts, label: shortDate(ts), price: +r.price_per_gpu_hr }; }) }));
    } catch { setProvHist(h => ({ ...h, [name]: [] })); }
    finally { setProvLoading(null); }
  }, [provHist]);
  useEffect(() => { if (sel) loadProv(sel); }, [sel, loadProv]);

  // ---- Derived --------------------------------------------------------
  const hist = useMemo(() => (data ? normHist(data.history) : []), [data]);
  const cd = useMemo(() => {
    if (!data) return [];
    const cutoff = new Date(data.as_of).getTime() - range * 86400e3;
    return hist.filter(h => h.ts >= cutoff);
  }, [hist, data, range]);
  const shown = hover != null && cd[hover] ? cd[hover] : cd[cd.length - 1];

  const providers = data?.providers ?? [];
  const sorted = useMemo(() => {
    const m = sortDir === "asc" ? 1 : -1;
    return [...providers].sort((a, b) => {
      if (sortBy === "price") return (a.price_per_gpu_hr - b.price_per_gpu_hr) * m;
      if (sortBy === "name") return a.provider.localeCompare(b.provider) * m;
      return ((a.change_pct ?? 0) - (b.change_pct ?? 0)) * m;
    });
  }, [providers, sortBy, sortDir]);
  const maxPrice = Math.max(...providers.map(p => p.price_per_gpu_hr), 1);

  const tiers = useMemo(() => {
    if (!data) return [];
    return data.methodology.tiers.map(t => {
      const ps = providers.filter(p => p.tier === t.id);
      const avg = ps.length ? ps.reduce((s, p) => s + p.price_per_gpu_hr, 0) / ps.length : null;
      return { ...t, count: ps.length, avg };
    });
  }, [data, providers]);

  const movers = useMemo(() => (data?.movers ?? []).slice(0, 5), [data]);

  const doSort = (c: SortKey) => {
    if (sortBy === c) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(c); setSortDir(c === "name" ? "asc" : c === "change" ? "desc" : "asc"); }
  };
  const toggle = (name: string) => setSel(s => (s === name ? null : name));
  const jumpTo = (name: string) => {
    setSel(name);
    requestAnimationFrame(() => document.getElementById(`prov-${name}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  const SortIcon = ({ col }: { col: SortKey }) =>
    sortBy !== col ? <ChevronDown size={12} className="text-gray-600" aria-hidden />
      : sortDir === "asc" ? <ChevronUp size={12} className="text-cyan-400" aria-hidden /> : <ChevronDown size={12} className="text-cyan-400" aria-hidden />;

  // ---- Status chip ----------------------------------------------------
  const chip = {
    live: { dot: "bg-emerald-400", text: `Live · ${ago(lastOk)}`, cls: "border-emerald-900/60 text-emerald-300" },
    stale: { dot: "bg-amber-400", text: `Offline · cached ${ago(lastOk)}`, cls: "border-amber-900/60 text-amber-300" },
    error: { dot: "bg-red-400", text: "Offline", cls: "border-red-900/60 text-red-300" },
    loading: { dot: "bg-gray-500", text: "Loading", cls: "border-gray-800 text-gray-400" },
  }[status];

  // ============================================================
  // Render
  // ============================================================
  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
      {/* Header */}
      <header className="flex items-start justify-between gap-3 mb-4 sm:mb-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl sm:text-4xl font-black tracking-tight leading-tight">
            <span className="text-cyan-400">ICX</span> H100 Price Index
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Intelligent Compute eXchange · {providers.length || "—"} providers · updated {data?.schedule || "daily"}
          </p>
        </div>
        <button
          onClick={() => load()}
          disabled={refreshing}
          aria-label="Refresh data"
          title="Refresh"
          className={`shrink-0 flex items-center gap-2 min-h-[44px] px-3 rounded-xl bg-gray-900 border text-xs font-medium transition hover:bg-gray-800 ${chip.cls}`}
        >
          {refreshing
            ? <RefreshCw size={12} className="animate-spin" aria-hidden />
            : <span className={`w-2 h-2 rounded-full ${chip.dot} ${status === "live" ? "animate-pulse" : ""}`} aria-hidden />}
          <span className="whitespace-nowrap">{refreshing ? "Refreshing" : chip.text}</span>
        </button>
      </header>

      {debug && (
        <Card className="mb-4 text-xs text-gray-400">
          <p className="font-semibold text-gray-300 mb-1">API <span className="font-mono text-cyan-400">{API}</span></p>
          <p>Set <code className="bg-gray-800 px-1 rounded">NEXT_PUBLIC_ICX_API_URL</code> to change. Status: {status}.</p>
        </Card>
      )}

      {status === "stale" && (
        <div role="status" className="flex items-center gap-2 bg-amber-900/20 border border-amber-800/40 rounded-xl px-4 py-3 mb-4 text-xs text-amber-300">
          <WifiOff size={14} aria-hidden /> Can&apos;t reach the price feed. Showing the last data saved on this device{lastOk ? ` (${ago(lastOk)})` : ""}.
        </div>
      )}

      {/* Empty / error state */}
      {status === "error" && (
        <Card className="text-center py-12">
          <AlertTriangle size={28} className="text-amber-400 mx-auto mb-3" aria-hidden />
          <p className="text-gray-200 font-semibold mb-1">The price feed is unavailable right now.</p>
          <p className="text-sm text-gray-500 mb-5">Nothing is cached on this device yet. Try again in a moment.</p>
          <button onClick={() => load()} className="min-h-[44px] px-5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium transition">Try again</button>
        </Card>
      )}

      {/* Loading skeleton */}
      {status === "loading" && (
        <div className="space-y-4" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-11 w-full sm:w-72" />
          <Skeleton className="h-44" />
          <Skeleton className="h-72" />
          <Skeleton className="h-96" />
        </div>
      )}

      {data && status !== "loading" && (
        <>
          {/* Range control: the single control that governs every chart on the page */}
          <div role="radiogroup" aria-label="Time range" className="grid grid-cols-3 sm:inline-grid sm:w-auto gap-1 p-1 bg-gray-900 border border-gray-800 rounded-xl mb-4">
            {RANGES.map(d => (
              <button
                key={d}
                role="radio"
                aria-checked={range === d}
                onClick={() => setRange(d)}
                className={`min-h-[40px] px-5 rounded-lg text-sm font-medium transition ${range === d ? "bg-cyan-600 text-white shadow" : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"}`}
              >
                {d === 7 ? "7 days" : d === 30 ? "30 days" : "90 days"}
              </button>
            ))}
          </div>

          {/* Hero */}
          <Card className="mb-4">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider">ICX H100 Index</p>
                <div className="flex items-baseline gap-3 flex-wrap mt-1">
                  <span className="text-5xl sm:text-6xl font-black tracking-tight text-white leading-none">{usd(data.index.value)}</span>
                  <Pill val={data.index.change_pct} size="md" />
                </div>
                <p className="text-sm text-gray-500 mt-2">per GPU-hour · as of {longDate(data.index.computed_at)} · {data.index.providers_count} providers reporting</p>
              </div>
              <dl className="grid grid-cols-3 gap-3 sm:gap-6 sm:text-right">
                <div>
                  <dt className="text-[11px] text-gray-500 uppercase tracking-wider">Low</dt>
                  <dd className="text-lg sm:text-xl font-bold text-white">{usd(data.index.low)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-gray-500 uppercase tracking-wider">High</dt>
                  <dd className="text-lg sm:text-xl font-bold text-white">{usd(data.index.high)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-gray-500 uppercase tracking-wider">7 days</dt>
                  <dd className="text-lg sm:text-xl font-bold text-white flex sm:justify-end items-center gap-2 flex-wrap">
                    <span>{data.index.change_7d == null ? "—" : `${data.index.change_7d >= 0 ? "+" : "−"}${usd(Math.abs(data.index.change_7d))}`}</span>
                    <Pill val={data.index.change_7d_pct} />
                  </dd>
                </div>
              </dl>
            </div>
          </Card>

          {/* Index chart */}
          <Card className="mb-4">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h2 className="text-sm font-semibold text-gray-200">Index history</h2>
                <p className="text-xs text-gray-500">Line is the index. Shaded band is the cheapest-to-priciest provider range.</p>
              </div>
              {shown && (
                <div className="text-right shrink-0" aria-live="polite">
                  <div className="text-lg font-bold text-white leading-tight">{usd(shown.index)}</div>
                  <div className="text-[11px] text-gray-500">{shown.label} · {usd(shown.low)}–{usd(shown.high)}</div>
                </div>
              )}
            </div>
            <div className="h-56 sm:h-72 -ml-2 sm:ml-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={cd}
                  margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
                  onMouseMove={(s: any) => setHover(typeof s?.activeTooltipIndex === "number" ? s.activeTooltipIndex : null)}
                  onMouseLeave={() => setHover(null)}
                >
                  <defs>
                    <linearGradient id="ig" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={INDEX_COLOR} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={INDEX_COLOR} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={40} />
                  <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} axisLine={false} domain={[(min: number) => Math.max(0, Math.floor(min - 0.25)), (max: number) => Math.ceil(max + 0.25)]} tickFormatter={v => `$${Number(v).toFixed(0)}`} width={36} />
                  {/* Readout lives in the header above (works for touch); the cursor still marks the point. */}
                  <Tooltip content={() => null} cursor={{ stroke: "#4b5563", strokeDasharray: "3 3" }} />
                  <Area type="monotone" dataKey="band" stroke="none" fill="#a5b4fc" fillOpacity={0.08} name="Low–High" isAnimationActive={false} />
                  <Area type="monotone" dataKey="index" stroke={INDEX_COLOR} strokeWidth={2} fill="url(#ig)" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} name="ICX Index" isAnimationActive={false} />
                  {data.index.value != null && <ReferenceLine y={data.index.value} stroke={INDEX_COLOR} strokeDasharray="4 4" strokeOpacity={0.35} />}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid lg:grid-cols-3 gap-4">
            {/* Providers */}
            <Card className="lg:col-span-2">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-gray-200">Providers</h2>
                  <p className="text-xs text-gray-500">Cheapest on-demand H100, per GPU-hour. Tap a provider for its history.</p>
                </div>
                {/* Mobile sort: one select instead of tiny clickable headers */}
                <label className="sm:hidden text-xs text-gray-400 flex items-center gap-1.5">
                  <span className="sr-only">Sort by</span>
                  <select
                    value={`${sortBy}:${sortDir}`}
                    onChange={e => { const [k, d] = e.target.value.split(":"); setSortBy(k as SortKey); setSortDir(d as "asc" | "desc"); }}
                    className="min-h-[40px] bg-gray-900 border border-gray-700 rounded-lg px-2 text-xs text-gray-200"
                  >
                    <option value="price:asc">Cheapest first</option>
                    <option value="price:desc">Priciest first</option>
                    <option value="change:desc">Biggest gain</option>
                    <option value="change:asc">Biggest drop</option>
                    <option value="name:asc">Name A–Z</option>
                  </select>
                </label>
              </div>

              {/* Mobile: cards */}
              <ul className="sm:hidden divide-y divide-gray-800/70 -mx-1">
                {sorted.map(p => {
                  const open = sel === p.provider;
                  return (
                    <li key={p.provider} id={`prov-${p.provider}`} className={`px-1 ${open ? "bg-cyan-950/20 rounded-xl" : ""}`}>
                      <button onClick={() => toggle(p.provider)} aria-expanded={open} className="w-full flex items-center gap-3 py-3 text-left min-h-[56px]">
                        <TierDot tier={p.tier} />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-gray-100 truncate">{p.provider}</div>
                          <div className="text-xs text-gray-500 truncate">{p.gpu_model} · {p.region || "—"}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-base font-semibold text-white">{usd(p.price_per_gpu_hr)}</div>
                          <Pill val={p.change_pct} />
                        </div>
                        <ChevronRight size={16} className={`text-gray-600 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
                      </button>
                      {open && <ProviderDetail p={p} points={provHist[p.provider]} range={range} loading={provLoading === p.provider} />}
                    </li>
                  );
                })}
              </ul>

              {/* Desktop: table */}
              <table className="hidden sm:table w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-gray-500 uppercase tracking-wider">
                    <th scope="col" className="text-left pb-2 font-medium"><button onClick={() => doSort("name")} className="flex items-center gap-1 min-h-[32px] hover:text-gray-300">Provider <SortIcon col="name" /></button></th>
                    <th scope="col" className="text-right pb-2 font-medium"><button onClick={() => doSort("price")} className="ml-auto flex items-center gap-1 min-h-[32px] hover:text-gray-300">$/GPU-hr <SortIcon col="price" /></button></th>
                    <th scope="col" className="text-right pb-2 font-medium"><button onClick={() => doSort("change")} className="ml-auto flex items-center gap-1 min-h-[32px] hover:text-gray-300">24h <SortIcon col="change" /></button></th>
                    <th scope="col" className="text-left pb-2 pl-4 font-medium">Tier</th>
                    <th scope="col" className="text-left pb-2 font-medium">Region</th>
                    <th scope="col" className="w-6 pb-2"><span className="sr-only">Details</span></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(p => {
                    const open = sel === p.provider;
                    const tierLabel = data.methodology.tiers.find(t => t.id === p.tier)?.label ?? p.tier;
                    return [
                      <tr
                        key={p.provider}
                        id={`prov-${p.provider}`}
                        onClick={() => toggle(p.provider)}
                        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(p.provider); } }}
                        tabIndex={0}
                        aria-expanded={open}
                        className={`border-t border-gray-800/60 cursor-pointer transition outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${open ? "bg-cyan-950/25" : "hover:bg-gray-800/40"}`}
                      >
                        <td className="py-2.5"><div className="font-medium text-gray-100">{p.provider}</div><div className="text-xs text-gray-500">{p.gpu_model}{p.variant !== "on-demand" ? ` · ${p.variant}` : ""}</div></td>
                        <td className="py-2.5 text-right font-semibold text-white">{usd(p.price_per_gpu_hr)}</td>
                        <td className="py-2.5 text-right"><Pill val={p.change_pct} /></td>
                        <td className="py-2.5 pl-4"><span className="inline-flex items-center gap-1.5 text-xs text-gray-300"><TierDot tier={p.tier} />{tierLabel}</span></td>
                        <td className="py-2.5 text-xs text-gray-500">{p.region || "—"}</td>
                        <td className="py-2.5 text-right"><ChevronRight size={14} className={`text-gray-600 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden /></td>
                      </tr>,
                      open && (
                        <tr key={`${p.provider}-detail`} className="bg-cyan-950/10">
                          <td colSpan={6} className="px-2"><ProviderDetail p={p} points={provHist[p.provider]} range={range} loading={provLoading === p.provider} /></td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </Card>

            {/* Sidebar */}
            <div className="flex flex-col gap-4">
              {/* Movers */}
              <Card>
                <h2 className="text-sm font-semibold text-gray-200 mb-0.5">Biggest movers</h2>
                <p className="text-xs text-gray-500 mb-3">Past 7 days</p>
                {movers.length === 0 ? (
                  <p className="text-xs text-gray-500">Need a week of data first.</p>
                ) : (
                  <ul className="divide-y divide-gray-800/70">
                    {movers.map(m => (
                      <li key={m.provider}>
                        <button onClick={() => jumpTo(m.provider)} className="w-full flex items-center gap-2 py-2 min-h-[44px] text-left hover:text-white">
                          <TierDot tier={m.tier} />
                          <span className="flex-1 text-sm text-gray-200 truncate">{m.provider}</span>
                          <span className="text-sm text-gray-400">{usd(m.current_price)}</span>
                          <Pill val={m.change_pct} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* Price ladder */}
              <Card>
                <h2 className="text-sm font-semibold text-gray-200 mb-0.5">Price ladder</h2>
                <p className="text-xs text-gray-500 mb-3">Cheapest to priciest. Dashed line is the index.</p>
                <div className="relative">
                  <div
                    className="absolute top-0 bottom-0 border-l border-dashed border-cyan-400/60 pointer-events-none"
                    style={{ left: `calc(6.5rem + (100% - 6.5rem - 3.5rem) * ${Math.min(1, data.index.value / maxPrice)})` }}
                    aria-hidden
                  />
                  <ul className="space-y-1.5">
                    {[...providers].sort((a, b) => a.price_per_gpu_hr - b.price_per_gpu_hr).map(p => (
                      <li key={p.provider}>
                        <button onClick={() => jumpTo(p.provider)} className="w-full flex items-center gap-2 text-left group">
                          <span className="w-[6rem] shrink-0 text-xs text-gray-400 truncate group-hover:text-gray-200">{p.provider}</span>
                          <span className="flex-1 h-3 rounded-r-md overflow-hidden bg-gray-800/60">
                            <span className="block h-full rounded-r-md" style={{ width: `${(p.price_per_gpu_hr / maxPrice) * 100}%`, backgroundColor: TIER_COLOR[p.tier] || "#6b7280" }} />
                          </span>
                          <span className="w-[3rem] shrink-0 text-right text-xs text-gray-300">{usd(p.price_per_gpu_hr)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>

              {/* Tiers & weights */}
              <Card>
                <h2 className="text-sm font-semibold text-gray-200 mb-0.5">How the index is weighted</h2>
                <p className="text-xs text-gray-500 mb-3">{data.methodology.description}</p>
                <div className="flex gap-0.5 h-2.5 rounded-full overflow-hidden mb-3" aria-hidden>
                  {tiers.map(t => <div key={t.id} style={{ width: `${t.share * 100}%`, backgroundColor: TIER_COLOR[t.id] || "#6b7280" }} />)}
                </div>
                <ul className="space-y-2">
                  {tiers.map(t => (
                    <li key={t.id} className="flex items-center gap-2 text-xs">
                      <TierDot tier={t.id} />
                      <span className="text-gray-200 font-medium">{t.label}</span>
                      <span className="text-gray-500">{t.count} {t.count === 1 ? "provider" : "providers"}</span>
                      <span className="ml-auto text-gray-400">avg {usd(t.avg)}</span>
                      <span className="w-10 text-right text-gray-300 font-medium">{Math.round(t.share * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>

          {/* Footer */}
          <footer className="mt-6 pt-4 border-t border-gray-800 flex flex-col sm:flex-row justify-between gap-2 text-xs text-gray-600">
            <span>Prices scraped {data.schedule || "daily"} · page refreshes every {REFRESH_MS / 60000} min</span>
            <span>{hist.length} days of history · <a href={`${API}/api/dashboard`} target="_blank" rel="noopener noreferrer" className="text-cyan-500 hover:underline">API</a> · <a href={`${API}/api/index/methodology`} target="_blank" rel="noopener noreferrer" className="text-cyan-500 hover:underline">Methodology</a></span>
          </footer>
        </>
      )}
    </main>
  );
}
