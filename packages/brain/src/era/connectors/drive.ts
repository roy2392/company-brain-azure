import { personId } from "../../brain/entities.ts";
import { docId } from "../../brain/indexer.ts";
import type { BrainDoc, ConnectorOutput } from "../../brain/types.ts";
import type { EraClient } from "../client.ts";
import { asDate, htmlToText, mapLimit, rawDoc, since, type PullContext } from "../util.ts";

const MAX_FILES = 3000;
const MAX_CONTENT = 350;

/** Drive v3: list files, read text for documents that mention focus accounts or changed recently. */
export async function pullDrive(era: EraClient, ctx: PullContext): Promise<ConnectorOutput> {
  const files: any[] = [];
  let pageToken: string | undefined;
  do {
    const r = await era.rest<any>("/drive/v3/files", {
      query: {
        pageSize: 1000,
        pageToken,
        q: "trashed = false",
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,owners(displayName,emailAddress),webViewLink,description,size)",
      },
    });
    files.push(...(r.files ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken && files.length < MAX_FILES);

  const recent = since(ctx);
  const focusIds = new Set(ctx.focus.map((f) => f.id));
  const isFolder = (f: any) => f.mimeType === "application/vnd.google-apps.folder";
  const scored = files
    .filter((f) => !isFolder(f) && !/image|video|audio|zip/.test(f.mimeType ?? ""))
    .map((f) => {
      const accts = ctx.matcher.match(f.name ?? "");
      return { f, accts, score: (accts.some((a) => focusIds.has(a)) ? 2 : 0) + (asDate(f.modifiedTime) >= recent ? 1 : 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || +asDate(b.f.modifiedTime) - +asDate(a.f.modifiedTime))
    .slice(0, MAX_CONTENT);

  const contents = new Map<string, string>();
  await mapLimit(scored, 4, async ({ f }) => {
    const google = String(f.mimeType).startsWith("application/vnd.google-apps");
    const path = google ? `/drive/v3/files/${f.id}/export` : `/drive/v3/files/${f.id}`;
    const query = google ? { mimeType: f.mimeType.endsWith("spreadsheet") ? "text/csv" : "text/plain" } : { alt: "media" };
    try {
      const body = await era.rest<string>(path, { query, text: true });
      contents.set(f.id, /<\/?[a-z][\s\S]*>/i.test(body.slice(0, 500)) ? htmlToText(body) : body);
    } catch {}
  });
  ctx.log(`   drive: ${files.length} files listed, ${contents.size} read`);

  const docs: BrainDoc[] = scored.map(({ f, accts }) => {
    const body = contents.get(f.id) ?? "";
    return {
      _id: docId("drive", "file", f.id),
      source: "drive",
      kind: /presentation|pptx|powerpoint/i.test(f.mimeType + f.name) ? "deck" : /sheet|csv|xlsx/i.test(f.mimeType + f.name) ? "sheet" : "doc",
      sourceId: f.id,
      title: f.name,
      text: `${f.name}${f.description ? ` — ${f.description}` : ""}\nOwner: ${(f.owners ?? []).map((o: any) => o.displayName).join(", ")}. Modified ${String(f.modifiedTime).slice(0, 10)}.\n\n${body.slice(0, 60_000)}`,
      url: f.webViewLink,
      ts: asDate(f.modifiedTime ?? f.createdTime, ctx.now),
      accountIds: [...new Set([...accts, ...ctx.matcher.match(body.slice(0, 20_000))])],
      personIds: (f.owners ?? []).filter((o: any) => o.emailAddress).map((o: any) => personId(o.emailAddress)),
      meta: { mimeType: f.mimeType, hasContent: contents.has(f.id) },
    };
  });
  return {
    raw: [{ collection: "raw_drive_files", source: "drive", object: "files", description: "Google Drive file metadata (decks, docs, sheets).", docs: files.map((f) => rawDoc(f.id, { ...f, contentRead: contents.has(f.id) })) }],
    docs,
    entities: [],
  };
}
