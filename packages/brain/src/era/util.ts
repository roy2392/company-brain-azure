import type { AccountMatcher } from "../brain/entities.ts";
import type { EraClient } from "./client.ts";

/** Shared context every connector receives. */
export interface PullContext {
  log: (msg: string) => void;
  /** Customer accounts to pull deep context for (Slack channels, calls, tickets, cases). */
  focus: Array<{ id: string; name: string; sfId?: string; aliases: string[] }>;
  /** All known account names → ids, for mention matching in free text. */
  matcher: AccountMatcher;
  /** Brain "now" (Era environments can be moved in time) and how far back to read. */
  now: Date;
  sinceDays: number;
}

export type Connector = (era: EraClient, ctx: PullContext) => Promise<import("../brain/types.ts").ConnectorOutput>;

export const since = (ctx: PullContext, days = ctx.sinceDays) => new Date(ctx.now.getTime() - days * 86_400_000);

/** HTML / Confluence storage format → readable text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Atlassian Document Format → text. */
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map(adfToText).join(node.type === "paragraph" || node.type === "heading" ? "" : "\n");
  if (node.type === "listItem") return `• ${inner}`;
  if (["paragraph", "heading", "blockquote", "codeBlock"].includes(node.type)) return `${inner}\n`;
  return inner;
}

export const asDate = (v: unknown, fallback = new Date(0)): Date => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Number.NaN;
  const d = Number.isNaN(n) ? new Date(String(v)) : new Date(n);
  return Number.isNaN(d.getTime()) ? fallback : d;
};

/** Slack-style ts "1735689600.000200" → Date. */
export const slackTs = (ts: string) => new Date(Number(ts.split(".")[0]) * 1000);

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Turns arbitrary vendor JSON into a raw-collection document keyed by source id. */
export const rawDoc = (id: string | number, obj: Record<string, unknown>) => ({ ...obj, _id: String(id), _brain: { fetchedAt: new Date() } });
