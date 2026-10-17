import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cfg } from "../config.ts";
import { ATLAS_SERVICE } from "./catalog.ts";
import type { OM } from "./client.ts";

const IMAGE = "docker.getcollate.io/openmetadata/ingestion:2.0.5";

/**
 * Run OpenMetadata's native MongoDB connector against Atlas (one-off container on the compose network),
 * so the catalog shows collections/fields exactly as OpenMetadata discovers them: the brain database and agent-memory's.
 * Only works for the local Atlas container; for Atlas cloud, set the service connection in the OM UI.
 */
export async function ingestAtlasNative(om: OM, log = console.log): Promise<boolean> {
  if (!/localhost|127\.0\.0\.1|atlas/.test(cfg.mongo.uri)) {
    log("  – native MongoDB ingestion skipped (MONGODB_URI is not the local Atlas container)");
    return false;
  }
  const dir = path.join(cfg.cacheDir, "om");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "mongodb-ingest.json");
  const workflow = {
    source: {
      type: "mongodb",
      serviceName: ATLAS_SERVICE,
      serviceConnection: {
        config: { type: "MongoDB", scheme: "mongodb", hostPort: "atlas:27017", connectionOptions: { directConnection: "true" } },
      },
      sourceConfig: { config: { type: "DatabaseMetadata", schemaFilterPattern: { includes: [`^${cfg.mongo.db}$`, `^${cfg.memory.db}$`] } } },
    },
    sink: { type: "metadata-rest", config: {} },
    workflowConfig: {
      loggerLevel: "INFO",
      openMetadataServerConfig: {
        hostPort: "http://openmetadata-server:8585/api",
        authProvider: "openmetadata",
        securityConfig: { jwtToken: await om.botToken() },
      },
    },
  };
  writeFileSync(file, JSON.stringify(workflow), { mode: 0o600 });
  try {
    log("  … running OpenMetadata MongoDB connector (docker)");
    const r = spawnSync(
      "docker",
      ["run", "--rm", "--network", "brain_net", "-v", `${dir}:/cfg:ro`, "--entrypoint", "metadata", IMAGE, "ingest", "-c", "/cfg/mongodb-ingest.json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-12).join("\n");
    if (r.status !== 0) {
      log(`  ✗ native ingestion failed (exit ${r.status}):\n${tail}`);
      return false;
    }
    log(`  ✓ native MongoDB ingestion finished`);
    return true;
  } finally {
    rmSync(file, { force: true }); // contains the bot JWT
  }
}
