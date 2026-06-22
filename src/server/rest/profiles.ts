import { Hono } from "hono";
import type { Logger } from "pino";
import { resolve } from "node:path";
import {
  decodeBlob,
  decodeBlobHeader,
  encodeBlob,
  PROFILE_ID_REGEX,
  PROFILE_VERSION,
} from "../../core/profile/index.js";
import type { FilesystemProfileStore } from "../profile/filesystem-store.js";
import { loadedConfigPath } from "../config/loader.js";
import { enableProfilesFlow } from "../setup/profiles-setup.js";

export interface ProfileRestDeps {
  store: FilesystemProfileStore;
  dekByVersion: ReadonlyMap<number, Buffer>;
  logger: Logger;
}

const DISABLED_REASON =
  "Profiles are not enabled on this gateway. Set `profiles.enabled: true` in gateway.yml and configure BG_ENCRYPTION_KEY (any 32+ character secret), then restart.";

/**
 * Profile routes that respond gracefully when the profiles feature is OFF.
 *
 *   GET /profiles               → 200 { enabled: false, count: 0, profiles: [] }
 *   GET /profiles/:id           → 404
 *   DELETE /profiles/:id        → 400 with disabled reason
 *   GET /profiles/:id/export    → 400 with disabled reason
 *   POST /profiles/import       → 400 with disabled reason
 *
 * The list endpoint returns 200 (not 503) so dashboards can render an empty
 * state with a "feature disabled" banner instead of throwing an error.
 */
export function createDisabledProfileRoutes(): Hono {
  const app = new Hono();
  app.get("/profiles", (c) =>
    c.json({ enabled: false, count: 0, profiles: [], reason: DISABLED_REASON }),
  );
  app.get("/profiles/:id", (c) =>
    c.json({ error: "Profile not found", reason: DISABLED_REASON }, 404),
  );
  app.delete("/profiles/:id", (c) =>
    c.json({ error: "Profiles disabled", reason: DISABLED_REASON }, 400),
  );
  app.get("/profiles/:id/export", (c) =>
    c.json({ error: "Profiles disabled", reason: DISABLED_REASON }, 400),
  );
  app.post("/profiles/import", (c) =>
    c.json({ error: "Profiles disabled", reason: DISABLED_REASON }, 400),
  );
  app.post("/profiles/create", (c) =>
    c.json({ error: "Profiles disabled", reason: DISABLED_REASON }, 400),
  );

  /**
   * Enable-Profiles wizard — writes BG_ENCRYPTION_KEY to .env and appends a
   * profiles block to gateway.yml. The gateway still needs a manual restart
   * after this (it can't relaunch itself).
   */
  app.post("/profiles/setup", async (c) => {
    let body: { encryptionKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be valid JSON" }, 400);
    }
    const key = body.encryptionKey;
    if (typeof key !== "string") {
      return c.json({ error: "encryptionKey (string) is required" }, 400);
    }
    try {
      const result = enableProfilesFlow({
        encryptionKey: key,
        configPath: loadedConfigPath ?? resolve(process.cwd(), "gateway.yml"),
        envPath: resolve(process.cwd(), ".env"),
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Setup failed";
      return c.json({ error: message }, 400);
    }
  });

  return app;
}

/**
 * Profile management REST routes.
 *
 *  GET    /profiles              → list metadata (no payload)
 *  GET    /profiles/:id          → single profile metadata
 *  DELETE /profiles/:id          → delete (refuses if currently locked)
 *  GET    /profiles/:id/export   → download encrypted blob as binary
 *  POST   /profiles/import       → upload encrypted blob; id taken from blob AAD
 *
 * Mounted by the caller under /v1.
 *
 * Authentication is handled by the parent app's /v1/* middleware.
 */
export function createProfileRoutes(deps: ProfileRestDeps): Hono {
  const { store, dekByVersion, logger } = deps;
  const app = new Hono();

  app.get("/profiles", async (c) => {
    const profiles = await store.list();
    return c.json({ enabled: true, count: profiles.length, profiles });
  });

  /**
   * Explicit create — writes an empty encrypted blob with the given id so the
   * profile appears in the list immediately. Without this users were confused
   * by the implicit "first connect creates it" workflow. The blob is captured
   * with whatever real cookies/storage exist on the first session disconnect.
   */
  app.post("/profiles/create", async (c) => {
    let body: { id?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be valid JSON" }, 400);
    }
    if (typeof body.id !== "string") {
      return c.json({ error: "id (string) is required" }, 400);
    }
    if (!PROFILE_ID_REGEX.test(body.id)) {
      return c.json({ error: "Invalid profile id (letters, numbers, dots, dashes, underscores; 1–128 chars)" }, 400);
    }

    const all = await store.list();
    if (all.find((p) => p.id === body.id)) {
      return c.json({ error: "Profile already exists" }, 409);
    }

    // Pick the highest known DEK version for forward compatibility with rotation.
    const dekVersions = Array.from(dekByVersion.keys());
    if (dekVersions.length === 0) {
      return c.json({ error: "No encryption keys configured" }, 500);
    }
    const dekVersion = Math.max(...dekVersions);
    const dek = dekByVersion.get(dekVersion)!;

    const emptyState = {
      version: PROFILE_VERSION,
      capturedAt: new Date(0).toISOString(),
      cookies: [],
      storage: {},
      meta: {
        capturedOrigins: [],
        skippedOrigins: [],
        durationMs: 0,
      },
    };
    const plaintext = Buffer.from(JSON.stringify(emptyState), "utf-8");
    const encoded = encodeBlob(dek, dekVersion, plaintext, body.id);
    await store.putRaw(body.id, encoded.bytes);

    logger.info({ profileId: body.id, sizeBytes: encoded.totalLen }, "profile created via dashboard");

    const refreshed = await store.list();
    const meta = refreshed.find((p) => p.id === body.id);
    return c.json(meta ?? { id: body.id, sizeBytes: encoded.totalLen, dekVersion }, 201);
  });

  app.get("/profiles/:id", async (c) => {
    const id = c.req.param("id");
    if (!PROFILE_ID_REGEX.test(id)) {
      return c.json({ error: "Invalid profile id" }, 400);
    }
    const all = await store.list();
    const meta = all.find((p) => p.id === id);
    if (!meta) return c.json({ error: "Not found" }, 404);
    return c.json(meta);
  });

  app.delete("/profiles/:id", async (c) => {
    const id = c.req.param("id");
    if (!PROFILE_ID_REGEX.test(id)) {
      return c.json({ error: "Invalid profile id" }, 400);
    }
    // Refuse delete if the profile is currently locked by an active session.
    const token = await store.lock(id, 5_000);
    if (!token) {
      return c.json(
        { error: "Profile is in use by an active session" },
        409,
      );
    }
    try {
      await store.delete(id);
      logger.info({ profileId: id }, "profile deleted via REST");
      return c.json({ deleted: id });
    } finally {
      await store.unlock(id, token);
    }
  });

  app.get("/profiles/:id/export", async (c) => {
    const id = c.req.param("id");
    if (!PROFILE_ID_REGEX.test(id)) {
      return c.json({ error: "Invalid profile id" }, 400);
    }
    const blob = await store.getRaw(id);
    if (!blob) return c.json({ error: "Not found" }, 404);

    return new Response(new Uint8Array(blob), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${id}.bgp"`,
        "Content-Length": String(blob.length),
      },
    });
  });

  app.post("/profiles/import", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    let blob: Buffer;
    try {
      if (contentType.includes("application/octet-stream") || contentType === "") {
        const ab = await c.req.arrayBuffer();
        blob = Buffer.from(ab);
      } else {
        return c.json(
          { error: "Content-Type must be application/octet-stream" },
          415,
        );
      }
    } catch {
      return c.json({ error: "Failed to read request body" }, 400);
    }

    if (blob.length === 0) {
      return c.json({ error: "Empty upload" }, 400);
    }

    // Validate the BGP1 binary format + extract the profile id from AAD.
    let header;
    try {
      header = decodeBlobHeader(blob);
    } catch (err) {
      return c.json(
        { error: `Invalid profile blob: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }

    const profileId = header.aad.toString("utf8");
    if (!PROFILE_ID_REGEX.test(profileId)) {
      return c.json({ error: "Blob AAD contains an invalid profile id" }, 400);
    }

    // Verify we can actually decrypt this blob with one of our DEKs.
    const dek = dekByVersion.get(header.dekVersion);
    if (!dek) {
      return c.json(
        {
          error: `Blob requires DEK version ${header.dekVersion} which is not in this gateway's key ring`,
        },
        400,
      );
    }
    try {
      decodeBlob(blob, dek, profileId);
    } catch (err) {
      return c.json(
        { error: `Blob failed integrity check: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }

    // Take the lock briefly to ensure we don't overwrite an active session's state.
    const token = await store.lock(profileId, 5_000);
    if (!token) {
      return c.json(
        { error: "Profile is in use by an active session — try again later" },
        409,
      );
    }
    try {
      await store.putRaw(profileId, blob);
      logger.info(
        { profileId, bytes: blob.length, dekVersion: header.dekVersion },
        "profile imported via REST",
      );
      return c.json({ imported: profileId, bytes: blob.length });
    } finally {
      await store.unlock(profileId, token);
    }
  });

  return app;
}
