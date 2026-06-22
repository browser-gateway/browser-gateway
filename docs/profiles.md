# Profiles

Profiles let you reuse browser state — cookies, `localStorage`, `sessionStorage`, `IndexedDB` — between sessions, encrypted at rest with a key you control.

## When To Use Them

Anything where you'd otherwise log in again every run:

- Scraping behind a login wall — log in once, run for weeks
- AI agents that crash mid-task — resume cleanly without redoing the auth flow
- Automated checkout testing — start from "already signed in" state
- Multi-account workflows — one profile per account, no cross-contamination

## How They Work — In One Paragraph

You connect to the gateway with `?profile=acme-prod` on the WebSocket URL. The first time you connect with that id, it's just a normal session — but when you disconnect, the gateway snapshots the browser's cookies and per-origin storage and writes them to disk, encrypted. Next time anyone connects with `?profile=acme-prod`, the gateway restores that snapshot before handing you the browser. You're already logged in.

```ts
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://localhost:9500/v1/connect?profile=acme-prod&token=YOUR_BG_TOKEN",
});
const page = await browser.newPage();
await page.goto("https://your-app.example.com/dashboard"); // already authenticated
await browser.disconnect();
```

## Quickstart — Enabling The Feature

Profiles are off by default. To turn them on you need two things: a `gateway.yml` block and an encryption key.

### Option A — Dashboard (recommended)

1. Start the gateway: `browser-gateway serve`
2. Open the dashboard at `http://localhost:9500/web`
3. Click **Profiles** → **Enable Profiles**
4. Click **Apply automatically** — the dashboard generates a strong key in your browser and writes it to `.env` + `gateway.yml`
5. Stop the gateway (Ctrl+C) and start it again with the same command

### Option B — Manual

```yaml
# gateway.yml
profiles:
  enabled: true
  filesystem:
    path: ./profiles            # where encrypted blobs live
  encryption:
    keyEnv: BG_ENCRYPTION_KEY   # env var name to read the key from
```

```bash
export BG_ENCRYPTION_KEY=$(openssl rand -base64 32)
browser-gateway serve
```

Once enabled, any `?profile=<id>` connection auto-creates a profile on first disconnect.

## What Gets Captured

When the session ends, the gateway captures:

- **All cookies** for every origin the session touched (`document.cookie` + HttpOnly cookies)
- **`localStorage`** and **`sessionStorage`** for every origin
- **`IndexedDB`** databases (with full record contents)
- **Service worker registrations and Cache API entries** (where supported by the provider's CDP build)

What's **NOT** captured:

- The browser's history, downloads, or bookmarks (irrelevant for automation)
- File system contents outside browser storage (out of scope)
- Open tabs / window layout (each new session starts fresh on `about:blank`)
- In-memory JavaScript state (the page has unloaded by the time we capture)

## What Each Profile Id Does

| Action | What happens |
|---|---|
| First connect with `?profile=acme` | Normal blank session. Disconnect captures a new blob. |
| Subsequent connect with `?profile=acme` | Gateway decrypts the blob and replays cookies + storage before you start. |
| Concurrent connects with `?profile=acme` | The first acquires the lock; the second gets HTTP 409 with `LOCK_HELD`. One session per profile at a time. |
| Concurrent connects with **different** profile ids | Run fully in parallel. No contention. |
| Connect with no `?profile=` | No persistence. Cookies/storage live only for the session. |

## Security Model

- **Encryption.** AES-256-GCM with envelope encryption — every profile has a unique 256-bit Data Encryption Key (DEK) wrapped with the global Key Encryption Key (KEK) derived from `BG_ENCRYPTION_KEY` via scrypt. The DEK rotates per profile, the KEK rotates when you change the env var.
- **Anti-swap.** The profile id is bound into the encryption (Additional Authenticated Data). Renaming the blob on disk makes it undecryptable, by design. This prevents an attacker from substituting one profile for another even if they have file system access.
- **Key check.** Each profile carries a Key Check Value (KCV) that's verified before decryption. If you set the wrong `BG_ENCRYPTION_KEY` after rotating, the gateway tells you "wrong key for profile X" instead of silently producing garbage.
- **Auth.** The REST endpoints under `/v1/profiles/*` use the same `BG_TOKEN` auth as every other route. The dashboard uses an HttpOnly cookie signed against the token.
- **What you must do.** Store the encryption key like any other production secret (1Password, Doppler, AWS Secrets Manager, etc.). If you lose it, every stored profile becomes permanently unreadable — there is no recovery.

## Profile Lifecycle

```
   client                gateway                disk
     │                      │                    │
     │  WS upgrade          │                    │
     │ ?profile=acme        │                    │
     │─────────────────────▶│                    │
     │                      │  read & decrypt    │
     │                      │  acme.bgp blob    ◀│
     │                      │                    │
     │                      │  inject cookies    │
     │                      │  + storage via CDP │
     │                      │                    │
     │  CDP traffic         │                    │
     │◀────────────────────▶│                    │
     │                      │                    │
     │  close               │                    │
     │─────────────────────▶│                    │
     │                      │  capture cookies   │
     │                      │  + storage via CDP │
     │                      │                    │
     │                      │  encrypt + write  ▶│
     │                      │  acme.bgp blob     │
```

## Limitations & Edge Cases

### One session per profile at a time

The gateway acquires a per-profile lock when you connect. A second connection to the same `?profile=acme` while the first is active gets a clean HTTP 409 (`LOCK_HELD`). This is by design — concurrent writers would corrupt the blob.

Workaround: use a different id per concurrent runner (`acme-worker-1`, `acme-worker-2`, …) and accept that each gets its own state.

### No renaming yet

The id is the anti-swap binding, so you can't rename a profile in place. To rename:

1. Export `old-name` from the dashboard (downloads `old-name.bgp`)
2. Import it under the new id
3. Delete the old one

### Encryption key rotation

Profiles are encrypted with a Data Encryption Key (DEK) that's itself wrapped with your `BG_ENCRYPTION_KEY`. To rotate the master key:

1. Decrypt and re-wrap each profile with the new key (a future `browser-gateway profiles rekey` command will automate this)
2. Until then, decrypt-then-re-import is the manual path

### Provider compatibility

Profile replay relies on the provider's CDP implementation honoring `Network.setCookies`, `Storage.setStorageItem`, and friends. All major providers (raw Chrome, Browserless, Steel, Browserbase, Hyperbrowser) support this, but a few CDP-incompatible servers may not.

### Size cap

Profile blobs are uncompressed JSON wrapped in an encrypted envelope. Typical sizes:
- Empty profile: ~600 bytes
- 1 site with a few cookies: ~1–2 KB
- Heavy IndexedDB (e.g. an email client's offline cache): can reach 50 MB+

The gateway streams capture/inject so memory pressure is bounded, but very large blobs slow down session startup. Keep one profile per logical account/site if possible.

## REST API

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/profiles` | GET | List profile metadata (no payloads) |
| `/v1/profiles/:id` | GET | Single profile metadata |
| `/v1/profiles/:id` | DELETE | Permanent delete (refuses while locked) |
| `/v1/profiles/:id/export` | GET | Download the encrypted `.bgp` blob |
| `/v1/profiles/import` | POST | Upload a `.bgp` blob (id is taken from the blob's encryption AAD) |
| `/v1/profiles/setup` | POST | One-click enable — writes `BG_ENCRYPTION_KEY` to `.env` + profiles block to `gateway.yml` |

All endpoints use the gateway's standard `BG_TOKEN` auth.

## Dashboard

The **Profiles** page in the dashboard at `http://localhost:9500/web/profiles/`:

- Lists every profile with last-updated, size, and DEK version
- **+ New Profile** generates a `?profile=<id>` URL you can paste into your code
- Per-row **Copy WS URL** copies the full connect URL with the profile id baked in
- Per-row **Export** downloads the encrypted blob for backup or transfer
- Per-row **Delete** removes the blob (refuses if a session currently holds the lock)
- **Enable Profiles** wizard (shown when the feature is off) generates a key and applies the config

## Comparison To Adjacent Approaches

| Approach | Tradeoff |
|---|---|
| **Browser profiles in the client** (Puppeteer's `userDataDir`) | Tied to the client's local disk. Doesn't work when the browser runs on a different machine (which is the whole point of this gateway). |
| **Provider-side persistent sessions** (some cloud browser products) | Locks you into one provider. Breaks when you fail over to another. |
| **Your own cookie-jar code** | Possible but boring infrastructure — you reinvent encryption, locking, and storage every time. |
| **browser-gateway profiles** | Provider-agnostic. The blob is portable across providers because it's standard CDP state. |

## Troubleshooting

**"Profile not found" on a connect that just worked.**
The id is case-sensitive. `acme-prod` and `Acme-Prod` are different profiles.

**409 with `LOCK_HELD`.**
Another session is using the profile. Wait for it to disconnect, or use a different id for the new session.

**"Wrong encryption key" / decryption fails.**
The `BG_ENCRYPTION_KEY` env var was changed. Either restore the old key or delete the affected blobs (they're unreadable without the original key).

**Dashboard shows "Profiles API error: 503" or 401.**
The gateway can't reach the profile store. Check `profiles.filesystem.path` is writable and the gateway has been restarted since you enabled the feature.

**The session restores cookies but the site still asks me to log in.**
The site uses session storage (which we DO capture) plus an auth cookie marked as `__Host-` that some CDP versions don't restore correctly. Open an issue with the provider's CDP version.

## Roadmap

- `browser-gateway profiles rekey` — encryption key rotation
- Profile rename via export-import in a single dashboard action
- Optional compression (zstd) to shrink large blobs
- Per-profile retention policies (auto-delete after N days idle)
- Profile sharing — read-only multi-reader access for distributed workers
