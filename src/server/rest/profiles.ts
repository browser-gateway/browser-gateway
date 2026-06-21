import { Hono } from "hono";
import type { Logger } from "pino";
import {
  decodeBlob,
  decodeBlobHeader,
  PROFILE_ID_REGEX,
} from "../../core/profile/index.js";
import type { FilesystemProfileStore } from "../profile/filesystem-store.js";

export interface ProfileRestDeps {
  store: FilesystemProfileStore;
  dekByVersion: ReadonlyMap<number, Buffer>;
  logger: Logger;
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
    return c.json({ count: profiles.length, profiles });
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
