import { SOURCE_META, VINE_ORDER } from "../sources.ts";
import type { Source } from "../types.ts";

interface Props {
  counts: Partial<Record<Source, number>>;
  reaching: Set<Source>; // systems the agent is querying right now
  /** "memory" = what the brain holds per system (before any question); "evidence" = records cited in the answer */
  mode: "memory" | "evidence";
}

const W = 420;
const H = 150;

/**
 * The brain's signature: one vine, one blossom per system. Blossoms open as the agent
 * retrieves evidence from that system; they pulse while a tool is reaching into it.
 */
export function SourceVine({ counts, reaching, mode }: Props) {
  const pts = VINE_ORDER.map((s, i) => {
    const x = 26 + (i * (W - 52)) / (VINE_ORDER.length - 1);
    const y = 54 + Math.sin(i * 1.15 + 0.4) * 16;
    return { s, x, y };
  });
  // smooth stem through the points (Catmull-Rom → cubic Bézier)
  let d = `M ${pts[0].x - 18} ${pts[0].y + 10} Q ${pts[0].x - 8} ${pts[0].y} ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    d += ` C ${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6}, ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6}, ${p2.x} ${p2.y}`;
  }
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <figure className="vine" aria-label={`Evidence by system: ${VINE_ORDER.map((s) => `${SOURCE_META[s].label} ${counts[s] ?? 0}`).join(", ")}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden>
        <path d={d} className="vine-stem" />
        {pts.map(({ s, x, y }, i) => {
          const n = counts[s] ?? 0;
          const open = n > 0;
          const r = open ? (mode === "memory" ? Math.min(5 + Math.log10(n + 1) * 2.4, 15) : Math.min(7 + Math.sqrt(n) * 2.6, 15)) : 4;
          const color = SOURCE_META[s].color;
          const hang = 14 + (i % 2) * 5;
          return (
            <g key={s} className={`blossom${open ? " is-open" : ""}${reaching.has(s) ? " is-reaching" : ""}`} style={{ "--src": color } as React.CSSProperties}>
              <path d={`M ${x} ${y} q 3 ${hang / 2} 0 ${hang}`} className="vine-stalk" />
              <g transform={`translate(${x} ${y + hang})`}>
                {reaching.has(s) && <circle r={r + 6} className="blossom-ring" />}
                <circle r={r} className="petal" />
                {open && <circle r={r * 0.62} cx={-r * 0.5} cy={r * 0.85} className="petal petal-b" />}
                {open && <circle r={r * 0.45} cx={r * 0.35} cy={r * 1.45} className="petal petal-c" />}
              </g>
              <text x={x} y={H - 22} className="blossom-label">
                {SOURCE_META[s].short}
              </text>
              <text x={x} y={H - 7} className="blossom-count">
                {open ? (n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US")) : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>
        {reaching.size && !total
          ? "Reaching into the company's systems…"
          : mode === "memory"
            ? total
              ? `In memory: ${total.toLocaleString("en-US")} records from ${Object.values(counts).filter(Boolean).length} systems. Ask a question to see which ones answer it.`
              : "The brain is empty. Run the Era ingestion to fill it."
            : `${total} records cited from ${Object.values(counts).filter(Boolean).length} systems`}
      </figcaption>
    </figure>
  );
}
