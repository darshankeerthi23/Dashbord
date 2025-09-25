"use client";

import { useEffect, useMemo, useState } from "react";
import * as d3 from "d3";

// shadcn/ui
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

// next/navigation for URL sync
import { useRouter, useSearchParams } from "next/navigation";

// ---------- Data ----------
type Item = {
  date?: string;
  status?: string;         // "Done" | "In Progress" | "Skipped" | "Not Started"
  hours?: number;
  pythonTopic?: string | null;
  llmTopic?: string | null;
  pythonPct?: number | null;   // 0|100
  llmPct?: number | null;      // 0|100
  overallPct?: number | null;  // 0|100 (both completed)
};

type TopicFocus = "both" | "python" | "llm";
type DateRangeKey = "all" | "4w" | "12w" | "ytd";

/* -------------------- Minimal helpers (NEW) -------------------- */
// A day counts as "Done" if overall 100 OR either topic is 100.
const isDoneDay = (d: Item) =>
  ((d.overallPct ?? 0) >= 100) || ((d.pythonPct ?? 0) >= 100) || ((d.llmPct ?? 0) >= 100);

// Parse Notion date strings as **UTC midnight** to avoid timezone shifts.
// Parse Notion date strings as UTC midnight, fixing year-less strings like "Mon, Jan 01".
function parseUTC(s?: string): Date | null {
  if (!s) return null;

  // ISO: "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00Z`);
  }

  // Try native parse; accept only if the year looks sensible
  const native = new Date(s);
  if (!isNaN(native.getTime()) && native.getUTCFullYear() > 2015) {
    return native;
  }

  // Handle "Mon, Jan 01" or "Jan 01" (no year). Assume current UTC year.
  const m = s.match(/^(?:[A-Za-z]{3},\s*)?([A-Za-z]{3})\s+(\d{1,2})$/);
  if (m) {
    const [, mon, day] = m;
    const y = new Date().getUTCFullYear();
    return new Date(Date.parse(`${mon} ${day}, ${y} UTC`));
  }

  // Last resort: today (UTC) to avoid 2000/2001 drift
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// UTC keys to avoid timezone shifting when bucketing
const utcDayKey  = (d: Date) => d3.utcDay.floor(d).getTime();

// ✅ ISO week (Monday-based) in UTC
const WEEK = d3.utcMonday;
const utcWeekKey = (d: Date) => WEEK.floor(d).getTime();

// Pretty local range for a given ISO-UTC week start
function formatLocalRangeFromUTCWeek(weekStartUTC: Date) {
  const startLocal = new Date(weekStartUTC.getTime());
  const endLocal = new Date(d3.utcDay.offset(WEEK.offset(weekStartUTC, 1), -1).getTime());
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", year: "numeric" });
  return `${fmt.format(startLocal)} — ${fmt.format(endLocal)}`;
}
/* -------------------------------------------------------------- */

// ---------- URL helpers ----------
function getQuery<T extends string>(sp: URLSearchParams, key: string, fallback: T): T {
  const v = sp.get(key);
  return (v as T) ?? fallback;
}
function getQueryNum(sp: URLSearchParams, key: string, fallback: number) {
  const v = Number(sp.get(key));
  return Number.isFinite(v) ? v : fallback;
}

export default function ProgressDashboard() {
  const router = useRouter();
  const sp = useSearchParams();

  const [data, setData] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);

  // Filters / goals (initialized from URL)
  const [dateRange, setDateRange] = useState<DateRangeKey>(() => getQuery<DateRangeKey>(sp, "range", "all"));
  const [topicFocus, setTopicFocus] = useState<TopicFocus>(() => getQuery<TopicFocus>(sp, "focus", "both"));
  const [goalPerWeek, setGoalPerWeek] = useState<number>(() => getQueryNum(sp, "goal", 3));

  // Details dialog state (weekly)
  const [openDialog, setOpenDialog] = useState(false);
  const [selectedWeekStart, setSelectedWeekStart] = useState<Date | null>(null); // store UTC ISO week start
  const [selectedWeekRows, setSelectedWeekRows] = useState<Item[]>([]);

  // Sync URL whenever controls change
  useEffect(() => {
    const q = new URLSearchParams(sp);
    q.set("range", dateRange);
    q.set("focus", topicFocus);
    q.set("goal", String(goalPerWeek));
    router.replace(`?${q.toString()}`, { scroll: false });
  }, [dateRange, topicFocus, goalPerWeek]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/notion/progress?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json.data ?? []);
      setLastLoaded(new Date());
    } catch (e: any) {
      setError(e?.message || "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(); // once on visit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------- Filtering helpers -------------
  const filtered = useMemo(() => {
    if (!data.length) return data;

    const now = new Date();
    const start = (() => {
      if (dateRange === "all") return undefined;
      if (dateRange === "4w") return d3.timeWeek.offset(d3.timeWeek.floor(now), -4);
      if (dateRange === "12w") return d3.timeWeek.offset(d3.timeWeek.floor(now), -12);
      if (dateRange === "ytd") return new Date(now.getFullYear(), 0, 1);
      return undefined;
    })();

    let base = data;
    if (start) {
      base = base.filter((d) => (d.date ? (parseUTC(d.date)! >= start) : false));
    }
    return base;
  }, [data, dateRange]);

  // ------------- KPIs (includes streak) -------------
  const kpis = useMemo(() => {
    const total = filtered.length;

    // Completed days (any topic or overall 100)
    const doneRows = filtered.filter(isDoneDay);
    const done = doneRows.length;
    const open = total - done;
    const completion = total ? Math.round((done / total) * 100) : 0;

    // Streak: build UTC day map and count back from latest done day
    const doneDayKeys = Array.from(
      d3.rollup(
        doneRows.filter((r) => r.date),
        () => true,
        (r) => utcDayKey(parseUTC(r.date!)!)
      ).keys()
    ).sort((a, b) => a - b);

    let streak = 0;
    if (doneDayKeys.length) {
      const doneSet = new Set(doneDayKeys);
      let cursor = new Date(doneDayKeys[doneDayKeys.length - 1]!); // latest done day (UTC)
      while (doneSet.has(utcDayKey(cursor))) {
        streak += 1;
        cursor = d3.utcDay.offset(cursor, -1);
      }
    }

    return { total, done, open, completion, streak };
  }, [filtered]);

  // ---------- Select a week (from chart click) ----------
  // ---------- Select a week (from chart click) ----------
const handleSelectWeek = (weekStartUTC: Date) => {
  setSelectedWeekStart(weekStartUTC); // store UTC ISO week start

  // rows that fall within this ISO-UTC week
  const start = WEEK.floor(weekStartUTC);
  const end   = WEEK.offset(start, 1);

  const rows = filtered.filter((r) => {
    if (!r.date) return false;
    const dt = parseUTC(r.date);
    if (!dt) return false;
    return dt >= start && dt < end; // clean half-open interval on real dates
  });

  setSelectedWeekRows(
    rows.sort((a, b) => +(parseUTC(a.date!) ?? 0) - +(parseUTC(b.date!) ?? 0))
  );
  setOpenDialog(true);
};


  return (
    <TooltipProvider>
      <div className="mx-auto max-w-6xl p-6 text-slate-200">
        <Header />

        <ControlsBar
          dateRange={dateRange}
          onDateRange={setDateRange}
          topicFocus={topicFocus}
          onTopicFocus={setTopicFocus}
          goalPerWeek={goalPerWeek}
          onGoalPerWeek={setGoalPerWeek}
          onRefresh={load}
          lastLoaded={lastLoaded}
        />

        {loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorMsg message={error} onRetry={load} />
        ) : (
          <>
            <KPIs {...kpis} />
            <Separator className="my-4 bg-slate-800" />

            <Tabs defaultValue="overview" className="w-full">
              <TabsList className="bg-slate-900/70 backdrop-blur border border-slate-800">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="topics">Topics</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="mt-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <ChartCard title="Status Breakdown">
                    <StatusDonut data={filtered} />
                  </ChartCard>

                  <ChartCard title="Weekly Velocity (Done/Week)">
                    <WeeklyVelocity data={filtered} goalPerWeek={goalPerWeek} onSelectWeek={handleSelectWeek} />
                  </ChartCard>

                  <ChartCard title="Cumulative Burn-up">
                    <CumulativeBurnup data={filtered} />
                  </ChartCard>

                  <ChartCard title="Topic-wise Progress">
                    <TopicWiseBars data={filtered} topicFocus={topicFocus} />
                  </ChartCard>
                </div>
              </TabsContent>

              <TabsContent value="topics" className="mt-4">
                <ChartCard title="Topic Timeline">
                  <TopicTimeline data={filtered} topicFocus={topicFocus} />
                </ChartCard>
              </TabsContent>
            </Tabs>

            <Footer />
          </>
        )}

        {/* Details dialog */}
        <Dialog open={openDialog} onOpenChange={setOpenDialog}>
          <DialogContent className="max-w-xl border-slate-800 bg-slate-900/90 text-slate-200 backdrop-blur">
            <DialogHeader>
              <DialogTitle>
                {selectedWeekStart
                  ? `Week details (${formatLocalRangeFromUTCWeek(selectedWeekStart)})`
                  : "Week details"}
              </DialogTitle>
            </DialogHeader>
            <ScrollArea className="max-h-[60vh] pr-2">
              {!selectedWeekRows.length ? (
                <div className="py-4 text-sm text-slate-400">No rows for this week.</div>
              ) : (
                <div className="space-y-2">
                  {selectedWeekRows.map((r, i) => (
                    <Card key={i} className="border-slate-800 bg-slate-900/60">
                      <CardContent className="p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">
                            {r.date ? d3.timeFormat("%a, %b %d")(parseUTC(r.date)!) : "—"}
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className="border-slate-700 bg-slate-800">
                              {(r.status ?? "—")}
                            </Badge>
                            {isDoneDay(r) && (
                              <Badge className="bg-emerald-500 text-slate-900">Done</Badge>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-slate-300 md:grid-cols-2">
                          <div>Python: {r.pythonTopic ?? "—"} {r.pythonPct != null ? `(${r.pythonPct}%)` : ""}</div>
                          <div>LLM: {r.llmTopic ?? "—"} {r.llmPct != null ? `(${r.llmPct}%)` : ""}</div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </ScrollArea>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

// ---------- Header ----------
function Header() {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h1 className="text-xl font-semibold tracking-tight">Bird’s-Eye Progress Dashboard</h1>
      <Badge variant="secondary" className="border border-slate-700 bg-slate-900/60">
        On-demand • Notion-backed
      </Badge>
    </div>
  );
}

// ---------- Controls / Filters ----------
function ControlsBar(props: {
  dateRange: DateRangeKey;
  onDateRange: (v: DateRangeKey) => void;
  topicFocus: TopicFocus;
  onTopicFocus: (v: TopicFocus) => void;
  goalPerWeek: number;
  onGoalPerWeek: (n: number) => void;
  onRefresh: () => void;
  lastLoaded: Date | null;
}) {
  const { dateRange, onDateRange, topicFocus, onTopicFocus, goalPerWeek, onGoalPerWeek, onRefresh, lastLoaded } = props;

  return (
    <Card className="mb-4 border-slate-800 bg-slate-900/50 backdrop-blur">
      <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          {/* Date range */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Range</span>
            <Select value={dateRange} onValueChange={(v) => onDateRange(v as DateRangeKey)}>
              <SelectTrigger className="w-[140px] border-slate-800 bg-slate-900/70">
                <SelectValue placeholder="All time" />
              </SelectTrigger>
              <SelectContent className="border-slate-800 bg-slate-900">
                <SelectItem value="all">All time</SelectItem>
                <SelectItem value="4w">Last 4 weeks</SelectItem>
                <SelectItem value="12w">Last 12 weeks</SelectItem>
                <SelectItem value="ytd">YTD</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Topic focus */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Focus</span>
            <div className="flex rounded-md border border-slate-800 bg-slate-900/60">
              {(["both", "python", "llm"] as TopicFocus[]).map((k) => (
                <Button
                  key={k}
                  variant={topicFocus === k ? "default" : "secondary"}
                  className={`h-8 rounded-none border-0 ${
                    topicFocus === k ? "bg-slate-200 text-slate-900" : "bg-transparent text-slate-300 hover:bg-slate-800"
                  }`}
                  onClick={() => onTopicFocus(k)}
                >
                  {k === "both" ? "Both" : k.toUpperCase()}
                </Button>
              ))}
            </div>
          </div>

          {/* Goal/week */}
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs text-slate-400">Goal/wk</span>
              </TooltipTrigger>
              <TooltipContent>Target number of “Done” days per week (horizontal line).</TooltipContent>
            </Tooltip>
            <input
              type="number"
              min={0}
              max={14}
              value={goalPerWeek}
              onChange={(e) => onGoalPerWeek(Number(e.target.value || 0))}
              className="h-8 w-16 rounded-md border border-slate-800 bg-slate-900/70 px-2 text-sm outline-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={onRefresh} className="bg-emerald-500 text-slate-900 hover:bg-emerald-400">
            Refresh
          </Button>
          <span className="text-xs text-slate-400">{lastLoaded ? `Last loaded: ${lastLoaded.toLocaleString()}` : "—"}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Loading / Error ----------
function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="border-slate-800 bg-slate-900/50 backdrop-blur">
          <CardHeader>
            <Skeleton className="h-5 w-52 bg-slate-800" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-56 w-full bg-slate-800" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ErrorMsg({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="border-red-900/40 bg-red-950/30">
      <CardHeader>
        <CardTitle className="text-red-300">Failed to load</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-red-200">
        {message}
        <div className="mt-3">
          <Button onClick={onRetry} variant="secondary" className="bg-red-300 text-red-900 hover:bg-red-200">
            Retry
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- KPIs (with Streak) ----------
function KPIs({ total, done, open, completion, streak }: { total: number; done: number; open: number; completion: number; streak: number }) {
  const Box = ({ value, label }: { value: string | number; label: string }) => (
    <Card className="border-slate-800 bg-slate-900/50 backdrop-blur">
      <CardContent className="p-5 text-center">
        <div className="text-3xl font-bold">{value}</div>
        <div className="mt-1 text-xs text-slate-400">{label}</div>
      </CardContent>
    </Card>
  );
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
      <Box value={total} label="Total" />
      <Box value={done} label="Completed" />
      <Box value={open} label="Open" />
      <Box value={`${completion}%`} label="Completion" />
      <Box value={streak} label="Streak (days)" />
    </div>
  );
}

function Footer() {
  return <div className="mt-6 text-center text-xs text-slate-400">Tip: Close overdue items first, then push weekly velocity ↑ for compound gains.</div>;
}

// ---------- Chart wrapper ----------
function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="border-slate-800 bg-slate-900/50 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-slate-200">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ---------- D3 hook ----------
function useD3(draw: (el: SVGSVGElement) => void, deps: any[]) {
  const [ref, setRef] = useState<SVGSVGElement | null>(null);
  useEffect(() => {
    if (ref) draw(ref);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);
  return setRef;
}

// ---------- Charts ----------
function StatusDonut({ data }: { data: Item[] }) {
  const draw = (el: SVGSVGElement) => {
    const w = el.clientWidth || 600, h = 280, r = Math.min(w, h) / 2 - 10;

    d3.select(el).selectAll("*").remove();
    const svg = d3.select(el).attr("viewBox", `0 0 ${w} ${h}`);
    const g = svg.append("g").attr("transform", `translate(${w / 2},${h / 2})`);

    const statuses = d3.rollups(data, (v) => v.length, (d) => d.status ?? "Unknown");
    const pie = d3.pie<any>().value((d) => d[1])(statuses);
    const arc = d3.arc<any>().innerRadius(r * 0.6).outerRadius(r);

    g.selectAll("path")
      .data(pie)
      .join("path")
      .attr("d", arc as any)
      .attr("fill", (_, i) => d3.schemeTableau10[i % 10] ?? "#888")
      .append("title")
      .text((d) => `${d.data[0]}: ${d.data[1]}`);

    const legend = svg.append("g").attr("transform", `translate(${w / 2 - 140}, 16)`);
    legend
      .selectAll("g")
      .data(pie)
      .join("g")
      .attr("transform", (_, i) => `translate(0,${i * 18})`)
      .call((gp) => gp.append("rect").attr("width", 12).attr("height", 12).attr("fill", (_, i) => d3.schemeTableau10[i % 10] ?? "#888"))
      .call((gp) =>
        gp.append("text").attr("x", 18).attr("y", 10).text((d) => `${d.data[0]} (${d.data[1]})`).attr("fill", "#e5e7eb").attr("font-size", 12)
      );
  };

  const setRef = useD3(draw, [data]);
  return <svg ref={setRef} className="w-full" />;
}

function WeeklyVelocity({ data, goalPerWeek, onSelectWeek }: { data: Item[]; goalPerWeek: number; onSelectWeek: (weekStart: Date) => void }) {
  const draw = (el: SVGSVGElement) => {
    // ✅ Group by ISO-UTC week and count using isDoneDay; only real dates
    const weekly = d3
      .rollups(
        data.filter((r) => r.date && isDoneDay(r)),
        (v) => v.length,
        (d) => utcWeekKey(parseUTC(d.date!)!)
      )
      //.map(([k, v]) => ({ week: new Date(+k), count: v })) // ISO-UTC week start
      .map(([k, v]) => ({ week: new Date(Number(k)), count: v }))
      .sort((a, b) => a.week.getTime() - b.week.getTime());

    // 3-week moving average
    const ma = weekly.map((d, i, arr) => {
      const start = Math.max(0, i - 2);
      const slice = arr.slice(start, i + 1);
      return { week: d.week, avg: d3.mean(slice, (x) => x.count) ?? 0 };
    });

    const w = el.clientWidth || 600, h = 280, m = { t: 10, r: 20, b: 30, l: 36 };

    d3.select(el).selectAll("*").remove();
    const svg = d3.select(el).attr("viewBox", `0 0 ${w} ${h}`);

    const x = d3.scaleUtc().domain(d3.extent(weekly, (d) => d.week) as [Date, Date]).range([m.l, w - m.r]);
    const maxY = Math.max(goalPerWeek || 0, d3.max(weekly, (d) => d.count) ?? 1, d3.max(ma, (d) => d.avg) ?? 1);
    const y = d3.scaleLinear().domain([0, maxY]).nice().range([h - m.b, m.t]);

    // axes
    svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).ticks(6)).selectAll("text").attr("fill", "#9ca3af");
    svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5)).selectAll("text").attr("fill", "#9ca3af");

    // main line
    const line = d3.line<{ week: Date; count: number }>().x((d) => x(d.week)).y((d) => y(d.count));
    svg.append("path").datum(weekly).attr("fill", "none").attr("stroke", "#60a5fa").attr("stroke-width", 2).attr("d", line as any);
    svg.selectAll("circle").data(weekly).join("circle").attr("cx", (d) => x(d.week)).attr("cy", (d) => y(d.count)).attr("r", 3).attr("fill", "#60a5fa");

    // moving average line
    const maLine = d3.line<{ week: Date; avg: number }>().x((d) => x(d.week)).y((d) => y(d.avg));
    svg.append("path").datum(ma).attr("fill", "none").attr("stroke", "#94a3b8").attr("stroke-width", 2).attr("stroke-dasharray", "4,4").attr("d", maLine as any);
    svg.append("text").attr("x", w - m.r - 4).attr("y", m.t + 14).attr("text-anchor", "end").attr("fill", "#94a3b8").attr("font-size", 12).text("3-week MA");

    // Goal line
    if (goalPerWeek > 0) {
      svg
        .append("line")
        .attr("x1", m.l)
        .attr("x2", w - m.r)
        .attr("y1", y(goalPerWeek))
        .attr("y2", y(goalPerWeek))
        .attr("stroke", "#22c55e")
        .attr("stroke-dasharray", "6,6")
        .attr("stroke-width", 2);

      svg
        .append("text")
        .attr("x", w - m.r - 4)
        .attr("y", y(goalPerWeek) - 6)
        .attr("text-anchor", "end")
        .attr("fill", "#22c55e")
        .attr("font-size", 12)
        .text(`Goal: ${goalPerWeek}/wk`);
    }

    // Click-to-inspect: choose nearest week on click (passes ISO-UTC week start)
    svg
      .append("rect")
      .attr("x", m.l)
      .attr("y", m.t)
      .attr("width", w - m.l - m.r)
      .attr("height", h - m.t - m.b)
      .attr("fill", "transparent")
      .style("cursor", "pointer")
      .on("click", function (event) {
        if (!weekly.length) return;
        const [mx] = d3.pointer(event as any, this as any);
        const xDate = x.invert(mx);
        const bis = d3.bisector<{ week: Date }, Date>((d) => d.week).center;
        const idx = bis(weekly, xDate);
        const nearest = weekly[Math.max(0, Math.min(idx, weekly.length - 1))];
        if (nearest) {
          onSelectWeek(nearest.week); // ISO-UTC week start
        }
      });
  };

  const setRef = useD3(draw, [data, goalPerWeek]);
  return <svg ref={setRef} className="w-full" />;
}

function CumulativeBurnup({ data }: { data: Item[] }) {
  const draw = (el: SVGSVGElement) => {
    // ✅ UTC day bucketing + use isDoneDay
    const daily = d3
      .rollups(
        data.filter((r) => r.date),
        (v) => ({
          added: v.length,
          done: v.filter(isDoneDay).length,
        }),
        (d) => utcDayKey(parseUTC(d.date!)!)
      )
      .map(([k, v]) => ({ day: new Date(+k), added: v.added, done: v.done }))
      .sort((a, b) => a.day.getTime() - b.day.getTime());

    let cumTotal = 0, cumDone = 0;
    const series = daily.map((d) => {
      cumTotal += d.added;
      cumDone += d.done;
      return { day: d.day, total: cumTotal, done: cumDone };
    });

    const w = el.clientWidth || 600, h = 300, m = { t: 10, r: 20, b: 30, l: 40 };

    d3.select(el).selectAll("*").remove();
    const svg = d3.select(el).attr("viewBox", `0 0 ${w} ${h}`);

    const x = d3.scaleUtc().domain(d3.extent(series, (d) => d.day) as [Date, Date]).range([m.l, w - m.r]);
    const y = d3.scaleLinear().domain([0, d3.max(series, (d) => Math.max(d.total, d.done)) ?? 1]).nice().range([h - m.b, m.t]);

    svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).ticks(6)).selectAll("text").attr("fill", "#9ca3af");
    svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5)).selectAll("text").attr("fill", "#9ca3af");

    const line = d3.line<{ day: Date; total: number; done: number }>().x((d) => x(d.day)).y((d) => y(d.total));
    const line2 = d3.line<{ day: Date; total: number; done: number }>().x((d) => x(d.day)).y((d) => y(d.done));

    svg.append("path").datum(series).attr("fill", "none").attr("stroke", "#22c55e").attr("stroke-width", 2).attr("d", line as any);
    svg.append("path").datum(series).attr("fill", "none").attr("stroke", "#a78bfa").attr("stroke-width", 2).attr("d", line2 as any);

    svg.append("text").attr("x", w - m.r - 90).attr("y", m.t + 14).text("Total").attr("fill", "#22c55e").attr("font-size", 12);
    svg.append("text").attr("x", w - m.r - 90).attr("y", m.t + 32).text("Done").attr("fill", "#a78bfa").attr("font-size", 12);
  };

  const setRef = useD3(draw, [data]);
  return <svg ref={setRef} className="w-full" />;
}

function TopicWiseBars({ data, topicFocus }: { data: Item[]; topicFocus: TopicFocus }) {
  const draw = (el: SVGSVGElement) => {
    const rows =
      topicFocus === "both"
        ? [
            { topic: "Python", pct: avgPct(data.map((d) => d.pythonPct)) },
            { topic: "LLM", pct: avgPct(data.map((d) => d.llmPct)) },
            { topic: "Overall", pct: avgPct(data.map((d) => d.overallPct)) },
          ]
        : topicFocus === "python"
        ? [{ topic: "Python", pct: avgPct(data.map((d) => d.pythonPct)) }]
        : [{ topic: "LLM", pct: avgPct(data.map((d) => d.llmPct)) }];

    const w = el.clientWidth || 600, h = 220, m = { t: 10, r: 20, b: 30, l: 70 };

    d3.select(el).selectAll("*").remove();
    const svg = d3.select(el).attr("viewBox", `0 0 ${w} ${h}`);

    const x = d3.scaleLinear().domain([0, 100]).range([m.l, w - m.r]);
    const y = d3.scaleBand().domain(rows.map((r) => r.topic)).range([m.t, h - m.b]).padding(0.2);

    svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat((d) => `${d}%` as any)).selectAll("text").attr("fill", "#9ca3af");
    svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y)).selectAll("text").attr("fill", "#9ca3af");

    svg.selectAll("rect")
      .data(rows)
      .join("rect")
      .attr("x", x(0))
      .attr("y", (d) => y(d.topic)!)
      .attr("width", (d) => x(d.pct) - x(0))
      .attr("height", y.bandwidth())
      .attr("fill", "#38bdf8");

    svg.selectAll("text.label")
      .data(rows)
      .join("text")
      .attr("class", "label")
      .attr("x", (d) => x(d.pct) + 6)
      .attr("y", (d) => y(d.topic)! + y.bandwidth() / 2 + 4)
      .text((d) => `${d.pct.toFixed(0)}%`)
      .attr("fill", "#e5e7eb")
      .attr("font-size", 12);
  };

  const setRef = useD3(draw, [data, topicFocus]);
  return <svg ref={setRef} className="w-full" />;
}

function TopicTimeline({ data, topicFocus }: { data: Item[]; topicFocus: TopicFocus }) {
  const draw = (el: SVGSVGElement) => {
    const rows = data
      .map((d) => ({
        date: parseUTC(d.date),
        python: d.pythonTopic ?? null,
        llm: d.llmTopic ?? null,
      }))
      .filter((r) => !!r.date) as { date: Date; python: string | null; llm: string | null }[];

    const meltedAll = [
      ...rows.filter((r) => r.python).map((r) => ({ date: r.date, topic: "Python", value: r.python! })),
      ...rows.filter((r) => r.llm).map((r) => ({ date: r.date, topic: "LLM", value: r.llm! })),
    ];

    const melted =
      topicFocus === "both"
        ? meltedAll
        : topicFocus === "python"
        ? meltedAll.filter((d) => d.topic === "Python")
        : meltedAll.filter((d) => d.topic === "LLM");

    melted.sort((a, b) => a.date.getTime() - b.date.getTime());

    const w = el.clientWidth || 600, h = 300, m = { t: 10, r: 20, b: 30, l: 60 };

    d3.select(el).selectAll("*").remove();
    const svg = d3.select(el).attr("viewBox", `0 0 ${w} ${h}`);

    const x = d3.scaleUtc().domain(d3.extent(melted, (d) => d.date) as [Date, Date]).range([m.l, w - m.r]);
    const topics = topicFocus === "both" ? ["Python", "LLM"] : [topicFocus.toUpperCase()];
    const y = d3.scaleBand().domain(topics).range([m.t, h - m.b]).padding(0.4);

    svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).ticks(6)).selectAll("text").attr("fill", "#9ca3af");
    svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y)).selectAll("text").attr("fill", "#9ca3af");

    svg
      .selectAll("circle")
      .data(melted)
      .join("circle")
      .attr("cx", (d) => x(d.date))
      .attr("cy", (d) => y(d.topic)! + y.bandwidth() / 2)
      .attr("r", 5)
      .attr("fill", (d) => (d.topic === "Python" ? "#f59e0b" : "#a78bfa"))
      .append("title")
      .text((d) => `${d.topic}: ${d.value} (${d.date.toDateString()})`);
  };

  const setRef = useD3(draw, [data, topicFocus]);
  return <svg ref={setRef} className="w-full" />;
}

// ---------- Utils ----------
function avgPct(arr: Array<number | null | undefined>) {
  const vals = arr.map(Number).filter((v) => Number.isFinite(v)) as number[];
  if (!vals.length) return 0;
  return d3.mean(vals) ?? 0;
}
