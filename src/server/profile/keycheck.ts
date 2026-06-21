import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import {
  KeycheckSchema,
  computeKcv,
  deriveKek,
  kekFingerprint,
  newDek,
  newKdfParams,
  unwrapDek,
  wrapDek,
  type Keycheck,
  type WrappedDek,
} from "../../core/profile/index.js";

export const KEYCHECK_FILE = ".keycheck";

export class KeycheckMismatchError extends Error {
  constructor(
    public readonly storePath: string,
    public readonly storedFingerprint: string,
    public readonly providedFingerprint: string,
  ) {
    super(
      `Encryption key does not match existing profiles at ${storePath}. ` +
        `To re-wrap with the new key, run "browser-gateway profile key rewrap". ` +
        `To start fresh (DESTROYS PROFILES), delete ${join(storePath, KEYCHECK_FILE)}.`,
    );
    this.name = "KeycheckMismatchError";
  }
}

export interface OpenedStore {
  keycheck: Keycheck;
  kek: Buffer;
  dekByVersion: Map<number, Buffer>;
  currentDekVersion: number;
}

export async function readKeycheck(storePath: string): Promise<Keycheck | null> {
  const path = join(storePath, KEYCHECK_FILE);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  return KeycheckSchema.parse(parsed);
}

export async function writeKeycheck(storePath: string, kc: Keycheck): Promise<void> {
  const path = join(storePath, KEYCHECK_FILE);
  await writeFileAtomic(path, JSON.stringify(kc, null, 2), { mode: 0o600 });
}

export async function initStore(storePath: string, password: string): Promise<OpenedStore> {
  if (await readKeycheck(storePath)) {
    throw new Error(`Store at ${storePath} is already initialized. Delete ${KEYCHECK_FILE} to re-init.`);
  }
  const kdf = newKdfParams();
  const kek = deriveKek(password, kdf);
  const dek = newDek();
  const wrapped = wrapDek(kek, dek, 1);
  const now = new Date().toISOString();
  const kc: Keycheck = {
    version: 1,
    kdf,
    kekFingerprintB64: kekFingerprint(kek),
    kcvB64: computeKcv(kek).toString("base64"),
    wrappedDeks: [wrapped],
    createdAt: now,
    updatedAt: now,
  };
  await writeKeycheck(storePath, kc);
  return {
    keycheck: kc,
    kek,
    dekByVersion: new Map([[1, dek]]),
    currentDekVersion: 1,
  };
}

export async function openStore(storePath: string, password: string): Promise<OpenedStore> {
  const kc = await readKeycheck(storePath);
  if (!kc) {
    throw new Error(
      `No .keycheck at ${storePath}. Run "browser-gateway profile init" first, or set BG_PROFILE_STORE_PATH to an initialized location.`,
    );
  }
  const kek = deriveKek(password, kc.kdf);
  const providedFp = kekFingerprint(kek);
  const expectedKcv = Buffer.from(kc.kcvB64, "base64");
  const actualKcv = computeKcv(kek);

  if (providedFp !== kc.kekFingerprintB64 || !expectedKcv.equals(actualKcv)) {
    throw new KeycheckMismatchError(storePath, kc.kekFingerprintB64, providedFp);
  }

  const dekByVersion = new Map<number, Buffer>();
  for (const w of kc.wrappedDeks) {
    dekByVersion.set(w.version, unwrapDek(kek, w));
  }
  const currentDekVersion = Math.max(...kc.wrappedDeks.map((w) => w.version));

  return { keycheck: kc, kek, dekByVersion, currentDekVersion };
}

export async function rewrapKeycheck(
  storePath: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const opened = await openStore(storePath, oldPassword);
  const newKdf = newKdfParams();
  const newKek = deriveKek(newPassword, newKdf);
  const newWrapped: WrappedDek[] = [];
  for (const [version, dek] of opened.dekByVersion) {
    newWrapped.push(wrapDek(newKek, dek, version));
  }
  const updated: Keycheck = {
    ...opened.keycheck,
    kdf: newKdf,
    kekFingerprintB64: kekFingerprint(newKek),
    kcvB64: computeKcv(newKek).toString("base64"),
    wrappedDeks: newWrapped,
    updatedAt: new Date().toISOString(),
  };
  await writeKeycheck(storePath, updated);
}
