import { Fragment, type ReactNode } from "react";
import { SOURCE_META, sourceOfId } from "../sources.ts";
import type { Citation } from "../types.ts";

interface Props {
  text: string;
  citations: Citation[];
  order: string[]; // citation ids in order of first mention → reference numbers
  activeId?: string;
  onCite: (id: string) => void;
  onHover: (id?: string) => void;
}

const INLINE = /(\[\[[^\]]+\]\]|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:[^)]+\))/g;

function Inline({ text, ...p }: Props & { text: string }) {
  const parts = text.split(INLINE);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("[[") && part.endsWith("]]")) {
          const id = part.slice(2, -2).trim();
          const c = p.citations.find((x) => x.id === id);
          const src = c?.source ?? sourceOfId(id);
          const meta = SOURCE_META[src] ?? { label: "Computed by the brain", short: "Brain", color: "#6E4FA3" };
          const n = p.order.indexOf(id) + 1;
          return (
            <button
              key={i}
              type="button"
              className={`cite${p.activeId === id ? " is-active" : ""}`}
              style={{ "--src": meta.color } as React.CSSProperties}
              title={c ? `${meta.label}: ${c.title}` : id}
              onClick={() => p.onCite(id)}
              onMouseEnter={() => p.onHover(id)}
              onMouseLeave={() => p.onHover(undefined)}
            >
              <span className="cite-dot" aria-hidden />
              {meta.short}
              <span className="cite-n">{n || ""}</span>
            </button>
          );
        }
        if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
        if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
        const link = part.match(/^\[([^\]]+)\]\((https?:[^)]+)\)$/);
        if (link)
          return (
            <a key={i} href={link[2]} target="_blank" rel="noreferrer">
              {link[1]}
            </a>
          );
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

/** Small, predictable markdown subset: headings, bullet and numbered lists, paragraphs, bold, code, links, citations. */
export function Answer(props: Props) {
  const lines = props.text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let rows: string[][] | null = null;
  const flushTable = () => {
    if (!rows?.length) return (rows = null);
    const [head, ...body] = rows;
    blocks.push(
      <div className="answer-table" key={blocks.length}>
        <table>
          <thead>
            <tr>{head.map((h, i) => <th key={i}><Inline {...props} text={h} /></th>)}</tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j}><Inline {...props} text={c} /></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    rows = null;
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}><Inline {...props} text={para.join(" ")} /></p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={blocks.length}>
        {list.items.map((it, i) => (
          <li key={i}>
            <Inline {...props} text={it} />
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of lines) {
    const l = raw.trim();
    const bullet = l.match(/^[-*•]\s+(.*)$/);
    const num = l.match(/^\d+[.)]\s+(.*)$/);
    const head = l.match(/^#{1,4}\s+(.*)$/);
    if (l.startsWith("|") && l.endsWith("|")) {
      flushPara();
      flushList();
      if (!/^\|[\s:|-]+\|$/.test(l)) (rows ??= []).push(l.slice(1, -1).split("|").map((c) => c.trim()));
      continue;
    }
    flushTable();
    if (!l) {
      flushPara();
      flushList();
    } else if (head) {
      flushPara();
      flushList();
      blocks.push(<h3 key={blocks.length}><Inline {...props} text={head[1].replace(/\*\*/g, "")} /></h3>);
    } else if (bullet || num) {
      flushPara();
      const ordered = !!num;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? num)![1]);
    } else if (list && /^\s{2,}/.test(raw)) {
      list.items[list.items.length - 1] += ` ${l}`;
    } else {
      flushList();
      para.push(l);
    }
  }
  flushPara();
  flushList();
  flushTable();
  return <div className="answer">{blocks}</div>;
}
