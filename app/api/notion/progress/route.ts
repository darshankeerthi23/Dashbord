import { NextRequest } from "next/server";
import { getProgressData } from "@/lib/notion";
import { z } from "zod";

export const dynamic = "force-dynamic"; // no caching (always latest)
const QuerySchema = z.object({
  // optionally allow overriding databaseId via ?db=
  db: z.string().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const parsed = QuerySchema.safeParse({ db: searchParams.get("db") ?? undefined });
    if (!parsed.success) {
      return Response.json({ success: false, error: { code: "BAD_QUERY", message: "Invalid query params" } }, { status: 400 });
    }

    const dbOverride = parsed.data.db;
    const { data } = await getProgressData(dbOverride);
    return Response.json({ success: true, data }, { status: 200 });
  } catch (err: any) {
    console.error("notion.progress.api.error", { err: String(err) });
    return Response.json({ success: false, error: { code: "SERVER_ERROR", message: "Failed to fetch Notion data" } }, { status: 500 });
  }
}
