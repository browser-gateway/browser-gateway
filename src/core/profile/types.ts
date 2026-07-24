import { z } from "zod";
import type { CdpCookie } from "./cdp.js";

export const PROFILE_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const ProfileIdSchema = z
  .string()
  .regex(PROFILE_ID_REGEX, "profile id must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/");

export type ProfileId = z.infer<typeof ProfileIdSchema>;

export const PROFILE_VERSION = 1 as const;

/**
 * Captured browser state suitable for cross-session replay.
 *
 * Storage is keyed by origin (e.g. "https://github.com"). Only origins we explicitly
 * captured appear here. Skipped origins (network errors, runtime errors) don't
 * appear at all — capture is best-effort per origin.
 */
export interface CapturedProfile {
  version: typeof PROFILE_VERSION;
  capturedAt: string;
  cookies: CdpCookie[];
  storage: Record<string, OriginStorage>;
  meta: ProfileCaptureMeta;
  /**
   * browserserve-native layer (IndexedDB + service-worker files), as an opaque
   * relative-path/base64 manifest. Only populated by browserserve providers;
   * external providers cannot carry it. Absent on older profiles.
   */
  indexeddb?: BrowserserveFile[];
}

/** One file in a browserserve native-layer manifest (relative path + base64). */
export interface BrowserserveFile {
  path: string;
  bytes: string;
}

export interface OriginStorage {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  /**
   * ISO timestamp of the most recent session that touched this origin. Used
   * to rank origins for eager inject (top-K by recency). Optional for
   * backward compatibility — older profiles default to a zero-timestamp rank.
   */
  lastVisitedAt?: string;
}

export interface ProfileCaptureMeta {
  userAgent?: string;
  capturedOrigins: string[];
  skippedOrigins: SkippedOrigin[];
  durationMs: number;
}

export interface SkippedOrigin {
  origin: string;
  reason: string;
}

export interface ProfileMeta {
  id: ProfileId;
  updatedAt: string;
  sizeBytes: number;
  dekVersion: number;
}

export interface KdfParams {
  algorithm: "scrypt";
  N: number;
  r: number;
  p: number;
  saltB64: string;
  keyLen: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
  algorithm: "scrypt",
  N: 32768,
  r: 8,
  p: 1,
  saltB64: "",
  keyLen: 32,
};

export interface WrappedDek {
  version: number;
  wrappedB64: string;
  ivB64: string;
  tagB64: string;
}

export interface Keycheck {
  version: 1;
  kdf: KdfParams;
  kekFingerprintB64: string;
  kcvB64: string;
  wrappedDeks: WrappedDek[];
  createdAt: string;
  updatedAt: string;
}

export const KeycheckSchema = z.object({
  version: z.literal(1),
  kdf: z.object({
    algorithm: z.literal("scrypt"),
    N: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    saltB64: z.string().min(1),
    keyLen: z.number().int().positive(),
  }),
  kekFingerprintB64: z.string().min(1),
  kcvB64: z.string().min(1),
  wrappedDeks: z.array(
    z.object({
      version: z.number().int().positive(),
      wrappedB64: z.string().min(1),
      ivB64: z.string().min(1),
      tagB64: z.string().min(1),
    }),
  ).min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
