import { useEffect, useMemo, useRef, useState } from "react";
import { getRecord, getStatus, streamChat } from "./api.ts";
import { Answer } from "./components/Answer.tsx";
import { AccountCard, Governance, RecordDrawer, Records } from "./components/Rail.tsx";
import { SourceVine } from "./components/SourceVine.tsx";
import { SOURCE_META, TOOL_VERB, toolReach } from "./sources.ts";
import type { Citation, Source, Status, ToolCall, Turn } from "./types.ts";

const SUGGESTIONS = [
  "Is Acacia Partners at risk of churning? Show me the evidence.",
  "What changed at Wisteria this quarter?",
  "How do we define ARR, and who owns that number?",
  "Who should I talk to before the next Absolis renewal call?",
];

const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = (n: number) => n.toLocaleString("en-US");

function describeTool(t: ToolCall) {
  const i = t.input as Record<string, any>;
  if (t.name.startsWith("openmetadata:")) {
    const what = i.query ?? i.fqn ?? i.entities?.map((e: any) => e.fqn).join(", ") ?? "";
    return `Asking OpenMetadata (MCP ${t.name.slice(13)})${what ? ` for “${what}”` : ""}`;
  }
  const verb = TOOL_VERB[t.name] ?? t.name;
  if (t.name === "search_brain") {
    const where = Array.isArray(i.sources) && i.sources.length ? i.sources.map((s: Source) => SOURCE_META[s]?.label ?? s).join(", ") : "every system";
    return `${verb} ${where} for “${i.query}”${i.account ? ` at ${i.account}` : ""}`;
  }
  if (t.name === "account_360") return `${verb} for ${i.account}`;
  if (t.name === "what_changed") return `${verb}${i.account ? ` for ${i.account}` : ""}`;
  if (t.name === "explain_data") return `${verb} for “${i.term}”`;
  if (t.name === "related_entities") return `${verb} around ${i.entity}`;
  return verb;
}

export function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [status, setStatus] = useState<Status>();
  const [selected, setSelected] = useState<string>();
  const [hovered, setHovered] = useState<string>();
  const [drawer, setDrawer] = useState<{ citation: Citation; record: any } | null>(null);
  const [draft, setDraft] = useState("");
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getStatus().then(setStatus).catch(() => {});
  }, []);

  const busy = turns.some((t) => t.status === "thinking");
  const current = turns.find((t) => t.id === selected) ?? turns[turns.length - 1];

  const patch = (id: string, fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const id = uid();
    setTurns((ts) => [...ts, { id, question: q, text: "", tools: [], citations: [], status: "thinking" }]);
    setSelected(id);
    setDraft("");
    abort.current = new AbortController();
    try {
      for await (const ev of streamChat(q, sessionId, abort.current.signal)) {
        if (ev.type === "text") patch(id, (t) => ({ ...t, text: t.text + ev.delta }));
        else if (ev.type === "tool_start") patch(id, (t) => ({ ...t, tools: [...t.tools, { id: ev.id, name: ev.name, input: ev.input, done: false }] }));
        else if (ev.type === "tool_result")
          patch(id, (t) => {
            const idx = t.tools.findIndex((x) => x.name === ev.name && !x.done);
            const tools = t.tools.map((x, i) => (i === idx ? { ...x, done: true, error: ev.error } : x));
            const seen = new Set(t.citations.map((c) => c.id));
            const citations = [...t.citations, ...ev.citations.filter((c) => !seen.has(c.id))];
            return {
              ...t,
              tools,
              citations,
              ...(ev.name === "account_360" && ev.data ? { account: ev.data } : {}),
              ...(ev.name === "what_changed" && ev.data ? { changed: ev.data } : {}),
              ...(ev.name === "related_entities" && ev.data ? { related: ev.data } : {}),
            };
          });
        else if (ev.type === "done") {
          if (ev.sessionId) setSessionId(ev.sessionId);
          patch(id, (t) => ({ ...t, status: t.status === "error" ? "error" : "done", durationMs: ev.durationMs, tools: t.tools.map((x) => ({ ...x, done: true })) }));
        } else if (ev.type === "error") patch(id, (t) => ({ ...t, status: "error", error: ev.message }));
      }
      patch(id, (t) => (t.status === "thinking" ? { ...t, status: "done" } : t));
    } catch (e: any) {
      patch(id, (t) => ({ ...t, status: abort.current?.signal.aborted ? "done" : "error", error: abort.current?.signal.aborted ? undefined : String(e.message ?? e) }));
    }
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length]);

  async function openCitation(id: string) {
    const c = current?.citations.find((x) => x.id === id) ?? turns.flatMap((t) => t.citations).find((x) => x.id === id);
    if (!c) {
      // a catalog asset the agent named from OpenMetadata MCP: om:<type>:<fqn>
      const m = id.match(/^om:([a-zA-Z]+):(.+)$/);
      if (m) window.open(`${status?.om.url ?? "http://localhost:8585"}/${m[1] === "glossaryTerm" ? "glossary" : m[1]}/${encodeURIComponent(m[2])}`, "_blank", "noreferrer");
      return;
    }
    if (c.source === "openmetadata") return void window.open(c.url, "_blank", "noreferrer");
    setDrawer({ citation: c, record: null });
    const record = await getRecord(id);
    setDrawer((d) => (d && d.citation.id === id ? { ...d, record } : d));
  }

  const counts = useMemo(() => {
    const m: Partial<Record<Source, number>> = {};
    for (const c of current?.citations ?? []) m[c.source] = (m[c.source] ?? 0) + 1;
    return m;
  }, [current]);
  const reaching = useMemo(() => new Set((current?.tools ?? []).filter((t) => !t.done).flatMap((t) => toolReach(t.name, t.input))), [current]);

  const totalDocs = status ? Object.values(status.docs).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          <span>Wisteria Group</span>
          <em>company brain</em>
        </div>
        {status && (
          <ul className="health" aria-label="System status">
            <li className={totalDocs ? "ok" : "warn"}>
              MongoDB Atlas{status.atlas.cloud ? "" : " (local)"}: {fmt(totalDocs)} records, {fmt(status.chunks)} chunks
            </li>
            <li className={status.om.ok ? "ok" : "warn"}>
              OpenMetadata: {status.om.ok ? `${fmt(status.om.tables ?? 0)} datasets, ${status.om.glossaryTerms} terms` : "offline"}
            </li>
            {totalDocs > 0 && <li>Data as of {new Date(status.now).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</li>}
          </ul>
        )}
      </header>

      <main className="stage">
        <section className="conversation" aria-live="polite">
          {turns.length === 0 && (
            <div className="intro">
              <h1>Everything Wisteria knows, in one answer.</h1>
              <p>
                Salesforce, Zendesk, Gong, Slack, Jira, Confluence and Google Drive in one memory on MongoDB Atlas. OpenMetadata holds the definitions, owners and lineage, so every answer says where it came from.
              </p>
            </div>
          )}

          {turns.map((t) => (
            <article key={t.id} className={`turn${t.id === current?.id ? " is-current" : ""}`} onClick={() => setSelected(t.id)}>
              <h2 className="question">{t.question}</h2>
              {t.tools.length > 0 && (
                <ol className="trace" aria-label="What the brain did">
                  {t.tools.map((x) => (
                    <li key={x.id} className={x.done ? (x.error ? "is-error" : "is-done") : "is-running"}>
                      {describeTool(x)}
                    </li>
                  ))}
                </ol>
              )}
              {t.text ? (
                <Answer text={t.text} citations={t.citations} order={[...new Set([...t.text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()))]} activeId={hovered} onCite={openCitation} onHover={setHovered} />
              ) : (
                t.status === "thinking" && t.tools.length === 0 && <p className="pending">Reading the question…</p>
              )}
              {t.status === "error" && <p className="error">The brain stopped: {t.error}. Check that the brain API is running and the model credentials in .env are set, then ask again.</p>}
              {t.status === "done" && t.durationMs && (
                <p className="turn-foot">
                  {t.citations.length} sources, {(t.durationMs / 1000).toFixed(1)} s
                </p>
              )}
            </article>
          ))}
          <div ref={endRef} />

          <form
            className={`composer${turns.length ? " is-docked" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              ask(draft);
            }}
          >
            <label htmlFor="q" className="sr-only">
              Ask the company brain
            </label>
            <textarea
              id="q"
              rows={turns.length ? 1 : 2}
              value={draft}
              placeholder={turns.length ? "Ask a follow-up" : "Ask about a customer, a deal, a metric or this quarter"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(draft);
                }
              }}
            />
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!draft.trim()}>
                Ask
              </button>
            )}
          </form>

          {turns.length === 0 && (
            <div className="suggestions">
              <h2>Try asking</h2>
              <ul>
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button type="button" onClick={() => ask(s)}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <aside className="rail" aria-label="Evidence">
          <SourceVine
            mode={current ? "evidence" : "memory"}
            counts={current ? counts : ((status?.docs ?? {}) as Partial<Record<Source, number>>)}
            reaching={reaching}
          />
          {current?.account && <AccountCard data={current.account} />}
          <Records citations={current?.citations ?? []} activeId={hovered} onOpen={(c) => openCitation(c.id)} onHover={setHovered} />
          <Governance citations={current?.citations ?? []} status={status} />
        </aside>
      </main>

      {drawer && <RecordDrawer citation={drawer.citation} record={drawer.record} onClose={() => setDrawer(null)} />}
    </div>
  );
}
