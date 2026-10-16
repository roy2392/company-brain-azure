import type { AgentEvent, Status } from "./types.ts";

export async function* streamChat(prompt: string, sessionId?: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, sessionId }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`The brain API answered ${res.status}. Is \`npm run dev\` running?`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.replace(/^data: /, "");
      if (data) yield JSON.parse(data) as AgentEvent;
    }
  }
}

export const getStatus = async (): Promise<Status> => (await fetch("/api/status")).json();
export const getRecord = async (id: string) => {
  const r = await fetch(`/api/record?id=${encodeURIComponent(id)}`);
  return r.ok ? r.json() : null;
};
