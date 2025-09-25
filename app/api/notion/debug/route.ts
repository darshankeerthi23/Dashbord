import { Client } from "@notionhq/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const token = process.env.NOTION_API_KEY;
    if (!token) {
      return Response.json({ ok: false, step: "env", error: "NOTION_API_KEY missing" }, { status: 400 });
    }
    const notion = new Client({ auth: token });

    // 1) Who am I?
    const user = await notion.users.me({}).catch(e => ({ error: String(e) }));

    // 2) What DBs can I see? (search for database objects)
    const searchResults: any[] = [];
    let cursor: string | undefined = undefined;
    for (let i = 0; i < 5; i++) {
      const res = await notion.search({ start_cursor: cursor, page_size: 25, filter: { property: "object", value: "database" } });
      searchResults.push(...res.results);
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }

    // 3) If you provided NOTION_DATABASE_ID, try a direct query too
    const dbId = process.env.NOTION_DATABASE_ID;
    let dbProbe: any = null;
    if (dbId) {
      try {
        dbProbe = await notion.databases.retrieve({ database_id: dbId });
      } catch (e: any) {
        dbProbe = { error: e?.message ?? String(e) };
      }
    }

    return Response.json({
      ok: true,
      user,
      databasesFound: searchResults.map((r: any) => ({ id: r.id, title: (r.title?.[0]?.plain_text) ?? "(untitled)" })),
      probeDatabaseId: dbId ?? null,
      probeResult: dbProbe
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
