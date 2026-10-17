import { SOURCE_META, VINE_ORDER } from "../sources.ts";
import type { Citation, Source, Status } from "../types.ts";

const money = (n?: number | null) =>
  n ? (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`) : "—";
const date = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function AccountCard({ data }: { data: any }) {
  const a = data.account ?? {};
  const facts = [
    ["Status", data.commercial?.churnedAt ? `Churn recorded ${data.commercial.churnedAt}` : a.type],
    ["Industry", a.industry],
    ["Owner", a.owner],
    ["Renewal", data.commercial?.renewalDate],
    ["Seats", data.commercial?.seats],
    ["Region", a.region],
  ].filter(([, v]) => v);
  const activity = VINE_ORDER.filter((s) => s !== "openmetadata")
    .map((s) => [s, data.activity?.[s]?.last90 ?? 0] as const)
    .filter(([, n]) => n > 0);
  const max = Math.max(1, ...activity.map(([, n]) => n));
  return (
    <section className="panel account" aria-labelledby="acct-name">
      <h2 id="acct-name">{a.name}</h2>
      {facts.length > 0 && (
        <dl className="facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="figures">
        <div>
          <strong>{money(data.commercial?.arr)}</strong>
          <span>ARR</span>
        </div>
        <div>
          <strong>{money(data.commercial?.openPipeline)}</strong>
          <span>Open pipeline</span>
        </div>
        <div>
          <strong>{data.support?.open ?? 0}</strong>
          <span>Open tickets</span>
        </div>
        <div className={data.support?.escalations ? "is-alert" : ""}>
          <strong>{data.support?.escalations ?? 0}</strong>
          <span>Escalations, 90 days</span>
        </div>
      </div>
      {activity.length > 0 && (
        <div className="activity">
          <h3>Last 90 days</h3>
          {activity.map(([s, n]) => (
            <div className="bar" key={s} style={{ "--src": SOURCE_META[s].color } as React.CSSProperties}>
              <span>{SOURCE_META[s].label}</span>
              <i style={{ width: `${(n / max) * 100}%` }} />
              <b>{n}</b>
            </div>
          ))}
        </div>
      )}
      {data.people?.length > 0 && (
        <div className="people">
          <h3>People</h3>
          <ul>
            {data.people.slice(0, 6).map((p: any) => (
              <li key={p.id}>
                {p.name}
                {p.title && <span>{p.title}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function Records({ citations, activeId, onOpen, onHover }: { citations: Citation[]; activeId?: string; onOpen: (c: Citation) => void; onHover: (id?: string) => void }) {
  const docs = citations.filter((c) => c.source !== "openmetadata");
  if (!docs.length) return null;
  const groups = VINE_ORDER.map((s) => [s, docs.filter((c) => c.source === s)] as const).filter(([, l]) => l.length);
  return (
    <section className="panel records" aria-label="Cited records">
      <h2>Sources</h2>
      {groups.map(([s, list]) => (
        <div key={s} className="record-group" style={{ "--src": SOURCE_META[s].color } as React.CSSProperties}>
          <h3>
            <span className="cite-dot" aria-hidden />
            {SOURCE_META[s].label}
            <span className="count">{list.length}</span>
          </h3>
          <ul>
            {list.slice(0, 8).map((c) => (
              <li key={c.id} className={activeId === c.id ? "is-active" : ""} onMouseEnter={() => onHover(c.id)} onMouseLeave={() => onHover(undefined)}>
                <button type="button" onClick={() => onOpen(c)}>
                  <span className="record-title">{c.title}</span>
                  <span className="record-meta">
                    {c.kind}, {date(c.ts)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** Where this answer's data came from, as OpenMetadata knows it. */
export function Governance({ citations, status }: { citations: Citation[]; status?: Status }) {
  const om = citations.filter((c) => c.source === "openmetadata");
  const used = [...new Set(citations.map((c) => c.source).filter((s) => s !== "openmetadata"))] as Source[];
  if (!om.length && !used.length) return null;
  const omUrl = status?.om.url ?? "http://localhost:8585";
  return (
    <section className="panel governance" aria-label="Governance">
      <h2>Governed by OpenMetadata</h2>
      {om.length > 0 && (
        <ul className="om-assets">
          {om.map((c) => (
            <li key={c.id}>
              <a href={c.url} target="_blank" rel="noreferrer">
                {c.title}
              </a>
              <span>{c.kind}</span>
            </li>
          ))}
        </ul>
      )}
      {used.length > 0 && (
        <ol className="lineage" aria-label="Lineage of this answer">
          <li className="lineage-sources">
            {used.map((s) => (
              <span key={s} style={{ "--src": SOURCE_META[s].color } as React.CSSProperties}>
                <i className="cite-dot" aria-hidden />
                {SOURCE_META[s].label}
              </span>
            ))}
          </li>
          <li>Atlas raw collections</li>
          <li>Docs, chunks and entity graph</li>
          <li>Company brain agent</li>
        </ol>
      )}
      <a className="om-link" href={`${omUrl}/table/wisteria_atlas.default.wisteria_brain.docs/lineage?fullscreen=true`} target="_blank" rel="noreferrer">
        Open full lineage in OpenMetadata
      </a>
    </section>
  );
}

export function RecordDrawer({ record, citation, onClose }: { record: any; citation: Citation; onClose: () => void }) {
  const meta = SOURCE_META[citation.source];
  const fields = record?.meta ? Object.entries(record.meta).filter(([, v]) => v !== null && v !== "" && typeof v !== "object") : [];
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onClick={(e) => e.stopPropagation()} style={{ "--src": meta.color } as React.CSSProperties}>
        <header>
          <p className="drawer-source">
            <span className="cite-dot" aria-hidden />
            {meta.label} {citation.kind}, {date(citation.ts)}
          </p>
          <h2 id="drawer-title">{citation.title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} autoFocus>
            Close
          </button>
        </header>
        {fields.length > 0 && (
          <dl className="facts">
            {fields.slice(0, 12).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="drawer-body">{record ? record.text : citation.snippet ?? "Loading…"}</div>
        <p className="drawer-id">
          Stored in MongoDB Atlas as <code>{citation.id}</code>
        </p>
      </aside>
    </div>
  );
}
