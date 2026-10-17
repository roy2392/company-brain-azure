import { cfg } from "../config.ts";

export interface Ref {
  id: string;
  type: string;
  name?: string;
  fullyQualifiedName?: string;
}

export class OMError extends Error {
  constructor(public status: number, message: string) {
    super(`[openmetadata] ${status} ${message}`);
  }
}

/** Thin OpenMetadata REST client (PUT = create-or-update, so every setup step is idempotent). */
export class OM {
  readonly ui = cfg.om.url;

  /** No token: logs in as the admin. With a token: acts as that user or bot. */
  constructor(private token?: string) {}

  async login(): Promise<this> {
    if (this.token) return this;
    const res = await fetch(`${cfg.om.url}/api/v1/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cfg.om.adminEmail, password: Buffer.from(cfg.om.adminPassword).toString("base64") }),
    });
    if (!res.ok) throw new OMError(res.status, `login failed: ${(await res.text()).slice(0, 200)}`);
    this.token = ((await res.json()) as { accessToken: string }).accessToken;
    return this;
  }

  async req<T = any>(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
    await this.login();
    const res = await fetch(`${cfg.om.url}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": contentType, Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new OMError(res.status, `${method} ${path}: ${(await res.text()).slice(0, 400)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  put<T = any>(path: string, body: unknown) {
    return this.req<T>("PUT", path, body);
  }
  get<T = any>(path: string) {
    return this.req<T>("GET", path);
  }
  patch<T = any>(path: string, ops: unknown[]) {
    return this.req<T>("PATCH", path, ops, "application/json-patch+json");
  }

  /** GET /{entity}/name/{fqn} → null when missing. */
  async byName<T = any>(entity: string, fqn: string, fields?: string): Promise<T | null> {
    try {
      const q = fields ? `?fields=${fields}` : "";
      return await this.get<T>(`/${entity}/name/${encodeURIComponent(fqn)}${q}`);
    } catch (e) {
      if (e instanceof OMError && e.status === 404) return null;
      throw e;
    }
  }

  async search(q: string, index = "all", size = 10) {
    return this.get<any>(`/search/query?q=${encodeURIComponent(q)}&index=${index}&from=0&size=${size}`);
  }

  async lineage(type: string, fqn: string, up = 2, down = 2) {
    return this.get<any>(`/lineage/${type}/name/${encodeURIComponent(fqn)}?upstreamDepth=${up}&downstreamDepth=${down}`);
  }

  async addLineage(from: Ref, to: Ref, description?: string, pipeline?: Ref) {
    return this.put("/lineage", {
      edge: {
        fromEntity: { id: from.id, type: from.type },
        toEntity: { id: to.id, type: to.type },
        lineageDetails: {
          description,
          source: "Manual",
          ...(pipeline ? { pipeline: { id: pipeline.id, type: pipeline.type } } : {}),
        },
      },
    });
  }

  /** JWT of the ingestion-bot, used by one-off `metadata ingest` runs. */
  async botToken(): Promise<string> {
    const bot = await this.get<any>("/bots/name/ingestion-bot");
    const auth = await this.get<any>(`/users/auth-mechanism/${bot.botUser.id}`);
    return auth.config.JWTToken;
  }

  /** Link to an asset in the OpenMetadata UI. */
  url(type: string, fqn: string) {
    const path: Record<string, string> = {
      table: "table",
      glossaryTerm: "glossary",
      pipeline: "pipeline",
      mlmodel: "mlmodel",
      domain: "domain",
      dataProduct: "dataProduct",
    };
    return `${this.ui}/${path[type] ?? type}/${encodeURIComponent(fqn)}`;
  }
}

export const ref = (e: { id: string; fullyQualifiedName?: string; name?: string }, type: string): Ref => ({
  id: e.id,
  type,
  name: e.name,
  fullyQualifiedName: e.fullyQualifiedName,
});
