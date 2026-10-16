import type { Entity, EntityLink, Source } from "./types.ts";

const SUFFIXES = /\b(inc|llc|ltd|limited|corp|corporation|co|plc|gmbh|sa|ag|group holdings)\b\.?/g;

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(SUFFIXES, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const accountId = (name: string) => `account:${slug(name)}`;
export const personId = (emailOrName: string) =>
  emailOrName.includes("@") ? `person:${emailOrName.trim().toLowerCase()}` : `person:${slug(emailOrName)}`;
export const productId = (name: string) => `product:${slug(name)}`;

export function entity(
  type: Entity["type"],
  id: string,
  name: string,
  source: Source,
  attrs: Record<string, unknown> = {},
  links: EntityLink[] = [],
  aliases: string[] = [],
): Entity {
  return { _id: id, type, name, aliases, attrs, links, sources: [source] };
}

/** Merge entity fragments coming from different systems into one record per id. */
export function mergeEntities(list: Entity[]): Entity[] {
  const byId = new Map<string, Entity>();
  for (const e of list) {
    const cur = byId.get(e._id);
    if (!cur) {
      byId.set(e._id, { ...e, aliases: [...new Set(e.aliases)], links: dedupeLinks(e.links), sources: [...new Set(e.sources)] });
      continue;
    }
    cur.attrs = { ...e.attrs, ...cur.attrs, ...pickDefined(e.attrs) };
    cur.aliases = [...new Set([...cur.aliases, ...e.aliases, ...(e.name !== cur.name ? [e.name] : [])])];
    cur.links = dedupeLinks([...cur.links, ...e.links]);
    cur.sources = [...new Set([...cur.sources, ...e.sources])];
  }
  return [...byId.values()];
}

const pickDefined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

function dedupeLinks(links: EntityLink[]): EntityLink[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = `${l.to}|${l.rel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Finds known account names inside free text (Confluence pages, Drive docs, Jira issues, call transcripts).
 * Matches whole-word n-grams (1–5 words) against normalized names and aliases.
 */
export class AccountMatcher {
  private names = new Map<string, string>(); // normalized phrase -> account id
  private maxWords = 1;

  constructor(accounts: Array<{ _id: string; name: string; aliases?: string[] }>) {
    for (const a of accounts) {
      for (const n of [a.name, ...(a.aliases ?? [])]) {
        const key = this.norm(n);
        // single generic words ("Group", "Bank") would match everywhere — require ≥ 4 chars
        if (key.length < 4) continue;
        this.names.set(key, a._id);
        this.maxWords = Math.max(this.maxWords, key.split(" ").length);
      }
    }
  }

  private norm(s: string) {
    return slug(s).replace(/-/g, " ");
  }

  match(text: string): string[] {
    const words = this.norm(text).split(" ").filter(Boolean);
    const found = new Set<string>();
    for (let i = 0; i < words.length; i++) {
      for (let n = Math.min(this.maxWords, words.length - i); n >= 1; n--) {
        const id = this.names.get(words.slice(i, i + n).join(" "));
        if (id) {
          found.add(id);
          i += n - 1;
          break;
        }
      }
    }
    return [...found];
  }
}
