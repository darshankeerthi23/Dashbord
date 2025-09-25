import { Client } from "@notionhq/client";
import { z } from "zod";

/**
 * Your Notion schema:
 * - Python Status, LLM Status: Select/Status with values:
 *   "Not started" | "In progress" | "Completed" | "Skipped"
 * - Day (Date)  [we’ll also accept "Date" as fallback]
 * - Optional topic columns: "Python Topic", "LLM Topic" (text)
 *
 * Dashboard rules:
 * - pythonProgress = (Python Status === "Completed") ? 100 : 0
 * - llmProgress    = (LLM Status === "Completed") ? 100 : 0
 * - overallProgress = (both Completed) ? 100 : 0
 */

const FIELD = {
  // We’ll try Day first, then Date
  dateCandidates: ["Day", "Date"],
  pythonStatus: "Python Status",
  llmStatus: "LLM Status",
  pythonTopic: "Python Topic", // optional
  llmTopic: "LLM Topic",       // optional
};

const EnvSchema = z.object({
  NOTION_API_KEY: z.string().min(1),
  NOTION_DATABASE_ID: z.string().min(1),
});

const parseEnv = () => {
  const parsed = EnvSchema.safeParse({
    NOTION_API_KEY: process.env.NOTION_API_KEY,
    NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID,
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map(i => i.path.join(".")).join(", ");
    throw new Error(`Missing env vars: ${fields}`);
  }
  return parsed.data;
};

export async function getProgressData(databaseIdOverride?: string) {
  const { NOTION_API_KEY, NOTION_DATABASE_ID } = parseEnv();
  const notion = new Client({ auth: NOTION_API_KEY });

  const database_id = databaseIdOverride ?? NOTION_DATABASE_ID;

  const rows: any[] = [];
  let cursor: string | undefined = undefined;

  // Paginate through the DB in ascending date order (if present)
  while (true) {
    const res = await notion.databases.query({
      database_id,
      start_cursor: cursor,
      page_size: 100,
      // Sort by Day/Date if it exists; if not present, Notion will ignore
      sorts: [{ property: FIELD.dateCandidates[0], direction: "ascending" }],
    });

    rows.push(...res.results);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  const data = rows.map(mapPage).filter(Boolean) as ReturnType<typeof mapPage>[];
  return { data };
}

/** ----------------- Helpers ----------------- */

function getFirstExistingProp(props: any, candidates: string[]): any | null {
  for (const c of candidates) {
    if (props[c]) return props[c];
  }
  return null;
}

function asPlainText(prop: any): string | null {
  if (!prop) return null;

  if (prop.type === "formula") {
    const f = prop.formula;
    if (!f) return null;
    if (f.type === "string") return f.string ?? null;
    if (f.type === "number") return f.number != null ? String(f.number) : null;
    if (f.type === "boolean") return f.boolean != null ? String(f.boolean) : null;
    if (f.type === "date") return f.date?.start ?? null;
    return null;
  }

  if (prop.type === "title" || prop.type === "rich_text") {
    const parts = (prop[prop.type] as any[]).map((t: any) => t.plain_text ?? "").join("");
    return parts || null;
  }
  if (prop.type === "select") return prop.select?.name ?? null;
  if (prop.type === "status") return prop.status?.name ?? null;
  if (prop.type === "number") return (typeof prop.number === "number" ? String(prop.number) : null);
  if (prop.type === "date") return prop.date?.start ?? null;
  if (prop.type === "multi_select") return prop.multi_select.map((s:any)=>s.name).join(", ");
  return null;
}

function toISODate(s: string | null): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(+d)) return undefined;
  return d.toISOString();
}

/** Compute 0/100 based on your rules */
function progressFromStatus(status: string | null | undefined): 0 | 100 {
  const s = (status ?? "").trim().toLowerCase();
  return s === "completed" ? 100 : 0;
}

/** Derived overall dashboard status for charts */
function deriveOverallStatus(py: string | null | undefined, llm: string | null | undefined): "Done" | "In Progress" | "Skipped" | "Not Started" {
  const sPy = (py ?? "").toLowerCase();
  const sLlm = (llm ?? "").toLowerCase();

  const isPyDone = sPy === "completed";
  const isLlmDone = sLlm === "completed";
  const anyInProg = sPy === "in progress" || sLlm === "in progress";
  const anySkipped = (sPy === "skipped" || sLlm === "skipped") && !isPyDone && !isLlmDone;

  if (isPyDone && isLlmDone) return "Done";
  if (anyInProg) return "In Progress";
  if (anySkipped) return "Skipped";
  return "Not Started";
}

/** Map one Notion page to the normalized row our charts use */
function mapPage(page: any) {
  const props = page.properties ?? {};

  // Date: prefer "Day", fallback to "Date"
  const dayProp = getFirstExistingProp(props, FIELD.dateCandidates);
  const dateISO = toISODate(asPlainText(dayProp));

  // Statuses
  const pythonStatus = asPlainText(props[FIELD.pythonStatus]);
  const llmStatus = asPlainText(props[FIELD.llmStatus]);

  // Optional topics
  const pythonTopic = asPlainText(props[FIELD.pythonTopic]);
  const llmTopic = asPlainText(props[FIELD.llmTopic]);

  // Progress per your rules
  const pythonPct = progressFromStatus(pythonStatus);
  const llmPct = progressFromStatus(llmStatus);
  const overallPct = (pythonPct === 100 && llmPct === 100) ? 100 : 0;

  // Derived overall status (for donut/velocity/burn-up)
  const status = deriveOverallStatus(pythonStatus, llmStatus);

  return {
    date: dateISO,             // used in time charts
    status,                    // derived: Done / In Progress / Skipped / Not Started
    hours: 0,                  // not tracked in your rules; keep 0 for now
    pythonTopic: pythonTopic ?? undefined,
    llmTopic: llmTopic ?? undefined,
    pythonPct,                 // 0 | 100
    llmPct,                    // 0 | 100
    overallPct,                // 0 | 100 (both must be Completed)
  };
}
