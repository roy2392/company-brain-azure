import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cfg, type EraConnector } from "../config.ts";

export class EraError extends Error {
  constructor(public connector: EraConnector, public status: number, message: string) {
    super(`[era:${connector}] ${status} ${message}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One Era connector (read-only). REST calls mirror the vendor's public API and are cached on disk
 * so re-running ingestion does not spend Era calls. MCP is used for discovery and live lookups.
 */
export class EraClient {
  private mcpClient?: Promise<Client>;
  constructor(readonly connector: EraConnector, private opts: { cache?: boolean } = { cache: true }) {}

  get configured(): boolean {
    return cfg.era.token(this.connector).length > 0;
  }

  private headers(): Record<string, string> {
    const token = cfg.era.token(this.connector);
    if (!token) throw new EraError(this.connector, 401, `no token — run \`npm run era:import\``);
    return { Authorization: `Bearer ${token}`, Accept: "application/json" };
  }

  private cachePath(key: string) {
    const h = createHash("sha1").update(key).digest("hex").slice(0, 16);
    return path.join(cfg.cacheDir, "era", this.connector, `${h}.json`);
  }

  /** GET/POST against the vendor-shaped REST API. `p` may be a path or an absolute URL. */
  async rest<T = any>(p: string, init: { method?: string; body?: unknown; query?: Record<string, unknown>; text?: boolean } = {}): Promise<T> {
    const url = new URL(p.startsWith("http") ? p : cfg.era.baseUrl(this.connector) + p);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const file = this.cachePath(`${method} ${url} ${body ?? ""}`);
    if (this.opts.cache) {
      try {
        return JSON.parse(await readFile(file, "utf8")) as T;
      } catch {}
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        body,
        headers: { ...this.headers(), ...(body ? { "Content-Type": "application/json" } : {}) },
      });
      if (res.ok) {
        const data = (init.text ? await res.text() : await res.json()) as T;
        if (this.opts.cache) {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(data));
        }
        return data;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await sleep(retryAfter * 1000);
        continue;
      }
      const text = (await res.text()).slice(0, 300);
      throw new EraError(this.connector, res.status, `${method} ${url.pathname}: ${text}`);
    }
  }

  async mcp(): Promise<Client> {
    this.mcpClient ??= (async () => {
      const client = new Client({ name: "wisteria-brain", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${cfg.era.baseUrl(this.connector)}/mcp/`), {
        requestInit: { headers: this.headers() },
      });
      await client.connect(transport);
      return client;
    })();
    return this.mcpClient;
  }

  /** Call an MCP tool and return its text content parsed as JSON when possible. */
  async tool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const client = await this.mcp();
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (res.isError) throw new EraError(this.connector, 400, `tool ${name}: ${text.slice(0, 300)}`);
    if (res.structuredContent) return res.structuredContent as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async close() {
    if (this.mcpClient) await (await this.mcpClient).close();
  }
}
