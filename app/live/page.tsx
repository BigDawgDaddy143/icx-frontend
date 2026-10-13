"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ReferenceLine,
} from "recharts";
import {
  TrendingUp, TrendingDown, Zap, AlertTriangle,
  RefreshCw, ChevronDown, ChevronUp, Wifi, WifiOff, Settings,
} from "lucide-react";
import type { Metadata } from "next";

// ============================================================
// Config
// ============================================================
const API = process.env.NEXT_PUBLIC_ICX_API_URL || "https://icx-api-production.up.railway.app";
const REFRESH_MS = 5 * 60 * 1000;

const TIER_MAP: Record<string, string> = {
  AWS: "hyperscaler", "Google Cloud": "hyperscaler", Azure: "hyperscaler",
  "Lambda Labs": "specialist", "Lambda 1CC": "specialist", CoreWeave: "specialist",
  RunPod: "specialist", "Genesis Cloud": "specialist", DataCrunch: "specialist",
  Nebius: "specialist", Hyperstack: "specialist",
  "Vast.ai": "marketplace",
  "Thunder Compute": "budget", JarvisLabs: "budget",
};
const TC: Record<string, string> = { hyperscaler: "#f59e0b", specialist: "#06b6d4", marketplace: "#a78bfa", budget: "#34d399" };
const TL: Record<string, string> = { hyperscaler: "Hyperscaler", specialist: "Specialist", marketplace: "Marketplace", budget: "Budget" };

// ============================================================
// Types
// ============================================================
interface HistPoint { date: string; label: string; index: number; low: number; high: number; spread: number; providers: number }
interface Provider { name: string; price: number; prev: number; tier: string; region: string; gpu_model: string }
interface ProvHistPoint { date: string; label: string; price: number }

// ============================================================
// API Client
// ============================================================
async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// ============================================================
// Demo fallback data
// ============================================================
function demoProv(): any[] {
  return [
    { provider: "Vast.ai", price_per_gpu_hr: 1.87, gpu_model: "H100", region: "Global" },
    { provider: "Hyperstack", price_per_gpu_hr: 1.90, gpu_model: "H100", region: "US/EU" },
    { provider: "RunPod", price_per_gpu_hr: 1.99, gpu_model: "H100 SXM", region: "US" },
    { provider: "Nebius", price_per_gpu_hr: 2.10, gpu_model: "H100", region: "EU" },
    { provider: "Thunder Compute", price_per_gpu_hr: 0.99, gpu_model: "H100", region: "US" },
    { provider: "Lambda Labs", price_per_gpu_hr: 3.44, gpu_model: "H100 SXM", region: "US" },
    { provider: "DataCrunch", price_per_gpu_hr: 2.20, gpu_model: "H100 SXM", region: "EU" },
    { provider: "JarvisLabs", price_per_gpu_hr: 2.99, gpu_model: "H100", region: "US" },
    { provider: "Google Cloud", price_per_gpu_hr: 3.00, gpu_model: "H100 (a3-highgpu)", region: "us-central1" },
    { provider: "Genesis Cloud", price_per_gpu_hr: 2.65, gpu_model: "H100 SXM", region: "EU/US" },
    { provider: "CoreWeave", price_per_gpu_hr: 4.25, gpu_model: "H100 PCIe", region: "US" },
    { provider: "AWS", price_per_gpu_hr: 3.93, gpu_model: "H100 SXM (p5.48xl)", region: "us-east-1" },
    { provider: "Azure", price_per_gpu_hr: 6.98, gpu_model: "H100 (NC v5)", region: "eastus" },
  ];
}

function demoHist(days: number): any[] {
  const b = 3.2, d: any[] = [];
  for (let i = days; i >= 0; i--) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    const n = Math.sin(i * .08) * .35 + Math.cos(i * .03) * .2 + (Math.random() - .5) * .15;
    const v = Math.max(1.8, b + (-i * .003) + n);
    const lo = Math.max(.9, v - .3 - Math.random() * .5), hi = v + 1.5 + Math.random() * 1.2;
    d.push({ computed_at: dt.toISOString(), index_value: +v.toFixed(4), low_price: +lo.toFixed(2), high_price: +hi.toFixed(2), spread: +(hi - lo).toFixed(2), providers_count: 12 + Math.floor(Math.random() * 3) });
  }
  return d;
}

function demoProvHist(prov: string, days: number): any[] {
  const p = demoProv().find(x => x.provider === prov);
  const b = p?.price_per_gpu_hr || 3, d: any[] = [];
  for (let i = days; i >= 0; i--) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    d.push({ scraped_at: dt.toISOString(), price_per_gpu_hr: +Math.max(.5, b + (-i * .002) + Math.sin(i * .1 + b) * .15 + (Math.random() - .5) * .08).toFixed(2), provider: prov });
  }
  return d;
}

// ============================================================
// Normalizers
// ============================================================
function normHist(raw: any[]): HistPoint[] {
  return raw.map(r => {
    const dt = new Date(r.computed_at);
    return { date: dt.toISOString().slice(0, 10), label: dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }), index: +r.index_value, low: +r.low_price, high: +r.high_price, spread: +(r.spread || 0), providers: r.providers_count || 0 };
  });
}

function normProv(raw: any[], prev: Record<string, number>): Provider[] {
  return raw.map(r => {
    const nm = r.provider, pr = +r.price_per_gpu_hr;
    return { name: nm, price: pr, prev: prev[nm] ?? pr, tier: TIER_MAP[nm] || "specialist", region: r.region || "", gpu_model: r.gpu_model || "H100" };
  });
}

function normProvHist(raw: any[]): ProvHistPoint[] {
  return raw.map(r => {
    const dt = new Date(r.scraped_at);
    return { date: dt.toISOString().slice(0, 10), label: dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }), price: +r.price_per_gpu_hr };
  });
}

// ============================================================
// Small components
// ============================================================
function Pill({ val, sfx = "%" }: { val: number; sfx?: string }) {
  const p = val >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded ${p ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
      {p ? <TrendingUp size={10} /> : <TrendingDown size={10} />}{p ? "+" : ""}{val.toFixed(2)}{sfx}
    </span>
  );
}

function Stat({ label, value, sub, pill }: { label: string; value: string; sub?: string; pill?: number }) {
  return (
    <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
      <span className="text-2xl font-bold text-white">{value}</span>
      <div className="flex items-center gap-2">
        {pill != null && <Pill val={pill} />}
        {sub && <span className="text-xs text-gray-500">{sub}</span>}
      </div>
    </div>
  );
}

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-gray-400 mb-1">{label}</p>
      {payload.map((e: any, i: number) => (
        <p key={i} style={{ color: e.color || e.stroke }} className="font-medium">
          {e.name}: {typeof e.value === "number" ? `$${e.value.toFixed(2)}` : e.value}
        </p>
      ))}
    </div>
  );
}

// ============================================================
// Main Dashboard
// ============================================================
export default function LiveDashboard() {
  const [range, setRange] = useState(30);
  const [sel, setSel] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState("price");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [live, setLive] = useState(false);
  const [demo, setDemo] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const [loading, setLoading] = useState(true);

  const [hist, setHist] = useState<HistPoint[]>([]);
  const [provs, setProvs] = useState<Provider[]>([]);
  const [provHist, setProvHist] = useState<ProvHistPoint[] | null>(null);

  const prevRef = useRef<Record<string, number>>({});
  const intRef = useRef<NodeJS.Timeout>();

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [hRaw, pRaw] = await Promise.all([
        api<any[]>(`/api/index/history?days=${range}`),
        api<any[]>("/api/prices/latest"),
      ]);
      const h = normHist(hRaw), p = normProv(pRaw, prevRef.current);
      const pm: Record<string, number> = {};
      p.forEach(x => { pm[x.name] = x.price; });
      prevRef.current = pm;
      setHist(h); setProvs(p); setLive(true); setDemo(false); setLastRefresh(new Date());
    } catch {
      setLive(false); setDemo(true);
      setHist(normHist(demoHist(range)));
      setProvs(normProv(demoProv(), {}));
      setLastRefresh(new Date());
    } finally { setRefreshing(false); setLoading(false); }
  }, [range]);

  const loadProv = useCallback(async (p: string) => {
    try {
      const raw = await api<any[]>(`/api/prices/provider/${encodeURIComponent(p)}?days=${range}`);
      setProvHist(normProvHist(raw));
    } catch { setProvHist(normProvHist(demoProvHist(p, range))); }
  }, [range]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { intRef.current = setInterval(() => load(true), REFRESH_MS); return () => clearInterval(intRef.current); }, [load]);
  useEffect(() => { if (sel) loadProv(sel); else setProvHist(null); }, [sel, loadProv]);

  const cd = hist.slice(-range);
  const idx = cd[cd.length - 1];
  const prv = cd[cd.length - 2];
  const i7 = cd[Math.max(0, cd.length - 8)];
  const i30 = cd[Math.max(0, cd.length - 31)];
  const cp = idx && prv ? ((idx.index - prv.index) / prv.index) * 100 : 0;
  const c7 = idx && i7 ? ((idx.index - i7.index) / i7.index) * 100 : 0;

  const sorted = [...provs].sort((a, b) => {
    const m = sortDir === "asc" ? 1 : -1;
    if (sortBy === "price") return (a.price - b.price) * m;
    if (sortBy === "name") return a.name.localeCompare(b.name) * m;
    return (((a.price - a.prev) / (a.prev || 1)) - ((b.price - b.prev) / (b.prev || 1))) * m;
  });

  const doSort = (c: string) => { if (sortBy === c) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy(c); setSortDir("asc"); } };
  const SI = ({ col }: { col: string }) => sortBy !== col ? <ChevronDown size={12} className="text-gray-600" /> : sortDir === "asc" ? <ChevronUp size={12} className="text-cyan-400" /> : <ChevronDown size={12} className="text-cyan-400" />;

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <RefreshCw size={32} className="text-cyan-400 animate-spin mx-auto mb-3" />
        <p className="text-gray-400 text-sm">Loading ICX Index...</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4 md:p-6" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Head */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-2 h-2 rounded-full ${live ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
            <span className="text-xs text-gray-500 uppercase tracking-widest">{live ? "Live" : "Demo"}</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-black tracking-tight"><span className="text-cyan-400">ICX</span> H100 Price Index</h1>
          <p className="text-sm text-gray-500 mt-1">Intelligent Compute eXchange — {provs.length} providers tracked daily</p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs ${demo ? "bg-amber-900/30 border border-amber-800/50 text-amber-400" : live ? "bg-emerald-900/30 border border-emerald-800/50 text-emerald-400" : "bg-red-900/30 border border-red-800/50 text-red-400"}`}>
            {live ? <Wifi size={11} /> : <WifiOff size={11} />} {demo ? "Demo" : live ? "Connected" : "Offline"}
          </div>
          <button onClick={() => setShowCfg(!showCfg)} className="p-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 transition"><Settings size={14} /></button>
          <button onClick={() => load()} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-xs text-gray-300 hover:border-cyan-800 transition ${refreshing ? "animate-pulse" : ""}`}>
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {showCfg && (
        <div className="bg-gray-900/90 border border-gray-700 rounded-xl p-4 mb-6 text-xs text-gray-400">
          <p className="font-semibold text-gray-300 mb-2">API: <span className="font-mono text-cyan-400">{API}</span></p>
          <p>Set <code className="bg-gray-800 px-1 rounded">NEXT_PUBLIC_ICX_API_URL</code> in Vercel env vars to change.</p>
          <p className="mt-1">Endpoints: <code className="bg-gray-800 px-1 rounded">/api/index/history</code> · <code className="bg-gray-800 px-1 rounded">/api/prices/latest</code> · <code className="bg-gray-800 px-1 rounded">/api/prices/provider/:name</code></p>
        </div>
      )}

      {demo && !showCfg && (
        <div className="bg-amber-900/20 border border-amber-800/40 rounded-xl px-4 py-3 mb-6 flex items-center justify-between">
          <span className="flex items-center gap-2 text-xs text-amber-400"><AlertTriangle size={14} /> Demo data — API unreachable</span>
          <button onClick={() => setShowCfg(true)} className="text-xs text-amber-300 underline">Configure</button>
        </div>
      )}

      {/* Stats */}
      {idx && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Stat label="Index Value" value={`$${idx.index.toFixed(2)}`} pill={cp} sub="vs yesterday" />
          <Stat label="7-Day" value={`${c7 >= 0 ? "+" : ""}${c7.toFixed(2)}%`} pill={c7} sub={i7 ? `from $${i7.index.toFixed(2)}` : ""} />
          <Stat label="Market Low" value={`$${idx.low.toFixed(2)}`} sub="per GPU-hr" />
          <Stat label="Spread" value={`$${idx.spread.toFixed(2)}`} sub={`High: $${idx.high.toFixed(2)}`} />
        </div>
      )}

      {/* Index chart */}
      <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div><h2 className="text-sm font-semibold text-gray-300">Index History</h2><p className="text-xs text-gray-600">Weighted avg ($/GPU-hr)</p></div>
          <div className="flex gap-1">{[7, 30, 60, 90].map(d => (
            <button key={d} onClick={() => setRange(d)} className={`px-2.5 py-1 text-xs rounded-md transition ${range === d ? "bg-cyan-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>{d}D</button>
          ))}</div>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={cd} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
            <defs>
              <linearGradient id="ig" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#06b6d4" stopOpacity={.3} /><stop offset="100%" stopColor="#06b6d4" stopOpacity={0} /></linearGradient>
              <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6366f1" stopOpacity={.1} /><stop offset="100%" stopColor="#6366f1" stopOpacity={.02} /></linearGradient>
            </defs>
            <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} axisLine={false} interval={Math.max(1, Math.floor(cd.length / 8))} />
            <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={v => `$${v.toFixed(1)}`} width={45} />
            <Tooltip content={<Tip />} />
            <Area type="monotone" dataKey="high" stroke="none" fill="url(#rg)" name="High" />
            <Area type="monotone" dataKey="low" stroke="none" fill="url(#rg)" name="Low" />
            <Area type="monotone" dataKey="index" stroke="#06b6d4" strokeWidth={2} fill="url(#ig)" name="ICX Index" dot={false} />
            {idx && <ReferenceLine y={idx.index} stroke="#06b6d4" strokeDasharray="4 4" strokeOpacity={.4} />}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        {/* Provider table */}
        <div className="md:col-span-2 bg-gray-900/80 border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Provider Pricing</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left pb-2 cursor-pointer select-none" onClick={() => doSort("name")}><span className="flex items-center gap-1">Provider <SI col="name" /></span></th>
                <th className="text-right pb-2 cursor-pointer select-none" onClick={() => doSort("price")}><span className="flex items-center justify-end gap-1">$/GPU-hr <SI col="price" /></span></th>
                <th className="text-right pb-2 cursor-pointer select-none" onClick={() => doSort("change")}><span className="flex items-center justify-end gap-1">24h <SI col="change" /></span></th>
                <th className="text-left pb-2 pl-3">Tier</th>
                <th className="text-left pb-2">Region</th>
              </tr></thead>
              <tbody>{sorted.map(p => {
                const ch = p.prev ? ((p.price - p.prev) / p.prev) * 100 : 0;
                const s = sel === p.name;
                return (
                  <tr key={p.name} onClick={() => setSel(s ? null : p.name)} className={`border-t border-gray-800/50 cursor-pointer transition ${s ? "bg-cyan-950/30" : "hover:bg-gray-800/40"}`}>
                    <td className="py-2"><div className="font-medium text-gray-200">{p.name}</div><div className="text-xs text-gray-600">{p.gpu_model}</div></td>
                    <td className="py-2 text-right font-mono text-white">${p.price.toFixed(2)}</td>
                    <td className="py-2 text-right">{ch !== 0 ? <Pill val={ch} /> : <span className="text-xs text-gray-600">—</span>}</td>
                    <td className="py-2 pl-3"><span className="inline-block px-2 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: (TC[p.tier] || "#666") + "20", color: TC[p.tier] || "#999" }}>{TL[p.tier] || p.tier}</span></td>
                    <td className="py-2 text-xs text-gray-500">{p.region}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-4">
          <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-3">Avg by Tier</h2>
            {Object.keys(TL).map(t => {
              const ps = provs.filter(p => p.tier === t);
              if (!ps.length) return null;
              const avg = ps.reduce((s, p) => s + p.price, 0) / ps.length;
              const mx = Math.max(...provs.map(p => p.price), 1);
              return (<div key={t} className="mb-3"><div className="flex justify-between text-xs mb-1"><span style={{ color: TC[t] }}>{TL[t]} ({ps.length})</span><span className="text-gray-300 font-mono">${avg.toFixed(2)}</span></div><div className="w-full bg-gray-800 rounded-full h-2"><div className="h-2 rounded-full transition-all" style={{ width: `${(avg / mx) * 100}%`, backgroundColor: TC[t] }} /></div></div>);
            })}
          </div>
          <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">Index Weights</h2>
            <div className="flex gap-1 h-4 rounded-full overflow-hidden mb-2">
              <div className="bg-amber-500" style={{ width: "45%" }} /><div className="bg-cyan-500" style={{ width: "30%" }} /><div className="bg-violet-400" style={{ width: "12%" }} /><div className="bg-emerald-400" style={{ width: "13%" }} />
            </div>
            <div className="grid grid-cols-2 gap-1 text-xs">
              <span className="text-amber-500">Hyperscaler 45%</span><span className="text-cyan-400">Specialist 30%</span>
              <span className="text-violet-400">Marketplace 12%</span><span className="text-emerald-400">Budget 13%</span>
            </div>
          </div>
          <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2"><AlertTriangle size={14} className="text-amber-400" /><h2 className="text-sm font-semibold text-gray-300">Alerts</h2></div>
            <div className="space-y-2 text-xs text-gray-400">
              <div className="flex justify-between"><span>Threshold</span><span className="text-white font-mono">±5%</span></div>
              <div className="flex justify-between"><span>Channel</span><span className="text-white">Slack</span></div>
              <div className="flex justify-between"><span>Schedule</span><span className="text-white">Daily 6am PT</span></div>
              <div className="flex justify-between"><span>Status</span><span className={live ? "text-emerald-400" : "text-amber-400"}>{live ? "● Active" : "● Demo"}</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* Provider drill-down */}
      {sel && provHist && (
        <div className="bg-gray-900/80 border border-cyan-900/50 rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div><h2 className="text-sm font-semibold text-cyan-300">{sel} — Price History</h2><p className="text-xs text-gray-600">{range}d</p></div>
            <button onClick={() => setSel(null)} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded bg-gray-800">Close</button>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={provHist} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
              <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} axisLine={false} interval={Math.max(1, Math.floor(provHist.length / 8))} />
              <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={v => `$${v}`} width={40} />
              <Tooltip content={<Tip />} />
              <Line type="monotone" dataKey="price" stroke="#22d3ee" strokeWidth={2} dot={false} name="Price" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Bar chart */}
      <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-1">Price Distribution</h2>
        <p className="text-xs text-gray-600 mb-3">All providers low → high</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={[...provs].sort((a, b) => a.price - b.price)} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
            <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 9 }} tickLine={false} axisLine={false} angle={-35} textAnchor="end" height={60} interval={0} />
            <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `$${v}`} width={40} />
            <Tooltip content={<Tip />} />
            {idx && <ReferenceLine y={idx.index} stroke="#06b6d4" strokeDasharray="4 4" label={{ value: "Index", fill: "#06b6d4", fontSize: 10, position: "right" }} />}
            <Bar dataKey="price" name="Price" radius={[4, 4, 0, 0]}>
              {[...provs].sort((a, b) => a.price - b.price).map((p, i) => <Cell key={i} fill={TC[p.tier] || "#666"} fillOpacity={.7} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Footer */}
      <div className="mt-6 pt-4 border-t border-gray-800 flex flex-col md:flex-row justify-between items-center gap-2 text-xs text-gray-600">
        <span className="flex items-center gap-2"><Zap size={12} className="text-cyan-500" /> ICX · Scraped daily 06:00 PT · Auto-refreshes every {REFRESH_MS / 60000}m</span>
        <span>{provs.length} providers · {hist.length}d history · <a href={API + "/api/index/latest"} target="_blank" rel="noopener" className="text-cyan-500 font-mono hover:underline">API</a></span>
      </div>
    </div>
  );
}
