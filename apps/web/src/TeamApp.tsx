import { useEffect, useMemo, useRef, useState } from "react";
import { Answer } from "./components/Answer.tsx";

/** /team: talk to each Wisteria agent (Microsoft Foundry) and watch their shared memory (agent-memory on Atlas) fill up. */

interface AgentInfo {
  name: string;
  displayName: string;
  team: string;
  role: string;
  foundryAgent: string;
}
interface TeamInfo {
  agents: AgentInfo[];
  foundry: { configured: boolean; project: string; model: string };
  memory: { db: string; space: string };
  openmetadata: { url: string; memories: string };
}
interface ToolCall {
  server: string;
  name: string;
  arguments: unknown;
  output?: string;
  error?: string;
}
interface TeamTurn {
  question: string;
  text?: string;
  tools?: ToolCall[];
  ms?: number;
  error?: string;
}
interface CatalogMemory {
  id: string;
  question: string;
  answer: string;
  author: string;
  owner?: string;
  agent?: string;
  linked: Array<{ type: string; name: string }>;
  updatedAt?: number;
}
interface Catalog {
  memories: CatalogMemory[];
  lineage: { upstream: string[]; downstream: string[] };
  table: string;
}
interface Memory {
  id: string;
  agent: string;
  agentName: string;
  content: string;
  topic?: string;
  account?: string;
  createdAt: string;
  inCatalog: boolean;
}

const COLOR: Record<string, string> = { support_lead: "#1E7A68", account_manager: "#B0446E", revops_analyst: "#9A6A1F", product_lead: "#3B4FB8" };

const PROMPTS: Record<string, string[]> = {
  support_lead: ["Novaris Holdings keeps escalating. What is breaking for them, since when, and is it getting worse? Save what the account team needs to know."],
  account_manager: ["Why did Novaris Holdings churn? Start from what the team already knows and fill the gaps."],
  revops_analyst: ["What should Finance report about Novaris Holdings at quarter close? Use our governed ARR definition.", "Who owns the ARR definition at Wisteria, and which datasets feed it?"],
  product_lead: ["Based on what the team learned about Novaris Holdings, what should product fix first?", "Which datasets with personal data feed our agents, and who owns them?"],
};

const toolLabel = (t: ToolCall) => {
  if (t.name === "recall_team_memory") return "Recalled team memory";
  if (t.name === "remember") return "Saved to team memory";
  if (t.name === "team_activity") return "Read team activity";
  return t.server === "openmetadata" ? `OpenMetadata · ${t.name}` : t.name;
};
const toolKind = (t: ToolCall) => (t.name === "remember" ? "save" : t.name === "recall_team_memory" || t.name === "team_activity" ? "recall" : t.server === "openmetadata" ? "catalog" : "brain");
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString();
};

export function TeamApp() {
  const [info, setInfo] = useState<TeamInfo>();
  const [active, setActive] = useState("support_lead");
  const [threads, setThreads] = useState<Record<string, { conversationId?: string; turns: TeamTurn[] }>>({});
  const [busy, setBusy] = useState<string>();
  const [draft, setDraft] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [tab, setTab] = useState<"atlas" | "catalog">("atlas");
  const [catalog, setCatalog] = useState<Catalog>();
  const seen = useRef(new Set<string>());
  const [fresh, setFresh] = useState(new Set<string>());
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/team").then((r) => r.json()).then(setInfo).catch(() => undefined);
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await (await fetch("/api/team/memory")).json();
        if (stop) return;
        const ids: string[] = r.memories.map((m: Memory) => m.id);
        const added = seen.current.size ? ids.filter((id) => !seen.current.has(id)) : [];
        ids.forEach((id) => seen.current.add(id));
        if (added.length) setFresh(new Set(added));
        setMemories(r.memories);
      } catch {}
    };
    const tickCatalog = async () => {
      try {
        const r = await (await fetch("/api/team/catalog")).json();
        if (!stop) setCatalog(r);
      } catch {}
    };
    tick();
    tickCatalog();
    const h = setInterval(() => {
      tick();
      tickCatalog();
    }, 2500);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, []);

  const agent = info?.agents.find((a) => a.name === active);
  const thread = threads[active] ?? { turns: [] };
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [thread.turns.length, busy]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const name = active;
    setDraft("");
    setBusy(name);
    setThreads((t) => ({ ...t, [name]: { conversationId: t[name]?.conversationId, turns: [...(t[name]?.turns ?? []), { question: q }] } }));
    try {
      const r = await fetch("/api/team/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: name, message: q, conversationId: threads[name]?.conversationId }) });
      const body = await r.json();
      setThreads((t) => {
        const cur = t[name];
        const turns = [...cur.turns];
        turns[turns.length - 1] = r.ok ? { question: q, text: body.text, tools: body.tools, ms: body.ms } : { question: q, error: body.error ?? `HTTP ${r.status}` };
        return { ...t, [name]: { conversationId: r.ok ? body.conversationId : cur.conversationId, turns } };
      });
    } catch (e) {
      setThreads((t) => {
        const turns = [...t[name].turns];
        turns[turns.length - 1] = { question: q, error: String(e) };
        return { ...t, [name]: { ...t[name], turns } };
      });
    } finally {
      setBusy(undefined);
    }
  }

  const byAgent = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of memories) out[m.agent] = (out[m.agent] ?? 0) + 1;
    return out;
  }, [memories]);

  return (
    <div className="team">
      <header className="team-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden>❦</span>
          <div>
            <h1>Wisteria agent team</h1>
            <p>
              {info?.foundry.configured ? `Microsoft Foundry · ${info.foundry.project} · ${info.foundry.model}` : "Microsoft Foundry"} · shared memory in MongoDB Atlas (agent-memory) · governed in OpenMetadata
            </p>
          </div>
        </div>
        {info && (
          <a className="team-om" href={info.openmetadata.memories} target="_blank" rel="noreferrer">
            OpenMetadata memories ↗
          </a>
        )}
      </header>

      <nav className="team-agents" aria-label="Agents">
        {info?.agents.map((a) => (
          <button key={a.name} type="button" className={`team-agent${a.name === active ? " is-active" : ""}`} style={{ "--agent": COLOR[a.name] } as React.CSSProperties} onClick={() => setActive(a.name)}>
            <span className="team-dot" aria-hidden />
            <span className="team-agent-name">{a.displayName}</span>
            <span className="team-agent-meta">
              {a.team} · {byAgent[a.name] ?? 0} memories
            </span>
            {busy === a.name && <span className="team-thinking">thinking…</span>}
          </button>
        ))}
      </nav>

      <main className="team-chat" style={{ "--agent": COLOR[active] } as React.CSSProperties}>
        {agent && (
          <div className="team-chat-head">
            <h2>{agent.displayName}</h2>
            <p>{agent.role}</p>
          </div>
        )}
        <div className="team-turns">
          {thread.turns.length === 0 && <p className="team-empty">Ask {agent?.displayName ?? "an agent"} something, or pick a suggestion below.</p>}
          {thread.turns.map((t, i) => (
            <article key={i} className="team-turn">
              <p className="team-q">{t.question}</p>
              {t.tools && t.tools.length > 0 && (
                <ul className="team-tools">
                  {t.tools.map((c, j) => (
                    <li key={j} className={`team-tool kind-${toolKind(c)}${c.error ? " has-error" : ""}`} title={JSON.stringify(c.arguments)}>
                      {toolLabel(c)}
                    </li>
                  ))}
                </ul>
              )}
              {t.text && (
                <div className="team-a">
                  <Answer text={t.text} citations={[]} order={[...t.text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()).filter((v, k, arr) => arr.indexOf(v) === k)} onCite={() => undefined} onHover={() => undefined} />
                </div>
              )}
              {t.error && <p className="team-error">{t.error}</p>}
              {t.ms && <p className="team-ms">{(t.ms / 1000).toFixed(1)} s · {t.tools?.length ?? 0} tool calls</p>}
            </article>
          ))}
          {busy === active && <p className="team-wait">{agent?.displayName} is working: recalling team memory, reading the brain and the catalog…</p>}
          <div ref={endRef} />
        </div>
        <div className="team-suggest">
          {(PROMPTS[active] ?? []).map((p) => (
            <button key={p} type="button" disabled={!!busy} onClick={() => send(p)}>
              {p}
            </button>
          ))}
        </div>
        <form
          className="team-compose"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${agent?.displayName ?? ""}`} disabled={!!busy} />
          <button type="submit" disabled={!!busy || !draft.trim()}>
            Send
          </button>
        </form>
      </main>

      <aside className="team-memory" aria-label="Shared memory">
        <div className="team-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "atlas"} className={tab === "atlas" ? "is-on" : ""} onClick={() => setTab("atlas")}>
            Shared memory <span>{memories.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "catalog"} className={tab === "catalog" ? "is-on" : ""} onClick={() => setTab("catalog")}>
            In OpenMetadata <span>{catalog?.memories.length ?? 0}</span>
          </button>
        </div>
        {tab === "atlas" ? (
          <>
            <div className="team-memory-head">
              <h2>Shared memory</h2>
              <p>
                agent-memory on MongoDB Atlas · <code>{info?.memory.db ?? "agent_memory"}.memories</code> · space <code>{info?.memory.space}</code>
              </p>
            </div>
            <ol>
              {memories.map((m) => (
                <li key={m.id} className={`team-mem${fresh.has(m.id) ? " is-fresh" : ""}`} style={{ "--agent": COLOR[m.agent] } as React.CSSProperties}>
                  <div className="team-mem-top">
                    <span className="team-mem-agent">{m.agentName}</span>
                    <span className="team-mem-time">{ago(m.createdAt)}</span>
                  </div>
                  <p>{m.content}</p>
                  <div className="team-mem-tags">
                    {m.topic && <span>{m.topic}</span>}
                    {m.account && <span>{m.account}</span>}
                    <span className={m.inCatalog ? "is-om" : "is-pending"}>{m.inCatalog ? "in OpenMetadata ✓" : "mirroring…"}</span>
                  </div>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            <div className="team-memory-head">
              <h2>In OpenMetadata</h2>
              <p>Context Center memories, each authored by the agent's own bot and linked to the Atlas table</p>
              {catalog && (
                <p className="team-lineage">
                  <b>Lineage of</b> <code>{catalog.table.split(".").slice(-2).join(".")}</code>: {catalog.lineage.upstream.join(", ") || "—"} → memories → {catalog.lineage.downstream.join(", ") || "—"}
                </p>
              )}
            </div>
            <ol>
              {catalog?.memories.map((m) => {
                const agentKey = Object.keys(COLOR).find((k) => m.author?.startsWith(k.replace(/_/g, "-"))) ?? "";
                return (
                  <li key={m.id} className={`team-mem${fresh.has(m.id) ? " is-fresh" : ""}`} style={{ "--agent": COLOR[agentKey] } as React.CSSProperties}>
                    <div className="team-mem-top">
                      <span className="team-mem-agent">{m.question}</span>
                    </div>
                    <p>{m.answer}</p>
                    <div className="team-mem-tags">
                      <span className="is-om">author {m.author}</span>
                      {m.owner && <span>owner {m.owner}</span>}
                      {m.linked.map((l) => (
                        <span key={l.type + l.name}>{l.type === "table" ? `table ${l.name}` : l.name}</span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </aside>
    </div>
  );
}
