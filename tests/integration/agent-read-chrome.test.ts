import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";

const PAGE_HTML = `<!doctype html><html><head><title>Read</title></head><body style="margin:0">
<h1>Account settings</h1>
<p>Your plan renews on the first of the month.</p>
<div role="listbox" aria-label="Plan">
  <div role="option" aria-selected="true">Free</div><div role="option">Pro</div>
</div>
<form><label for="email">Email</label><input id="email" value="a@b.test">
<button type="button" onclick="document.getElementById('out').textContent='saved'">Save changes</button></form>
<p id="out"></p>
<div style="height:3000px"></div>
<button type="button" onclick="document.getElementById('out').textContent='deleted'">Delete account</button>
<script>fetch("/api/data?token=secret123").catch(() => {});</script>
</body></html>`;

describe.skipIf(!chromePath)("page outline, find and logs against a real Chrome", () => {
  let chrome: RealChrome;

  beforeAll(async () => {
    chrome = await startRealChrome({
      "/read": PAGE_HTML,
      "/api/data?token=secret123": { body: "{}", headers: { "content-type": "application/json" } },
    });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
  });

  it("reads what is on screen as an outline with text, headings and refs", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/read`);
      const { text } = await session.readPage();
      expect(text).toContain('heading "Account settings"');
      expect(text).toContain('text "Your plan renews on the first of the month."');
      expect(text).toMatch(/button "Save changes" \[e\d+\]/);
      expect(text).toMatch(/listbox "Plan" \[e\d+\]\n\s+option "Free"/);
      expect(text).not.toContain("Delete account");
      const all = await session.readPage({ filter: "all" });
      expect(all.text).toContain("Delete account");
      const controls = await session.readPage({ filter: "interactive" });
      expect(controls.text).not.toContain("text ");
    } finally {
      await dispose();
    }
  });

  it("keeps refs stable between reads and lets actions use them", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/read`);
      const ref = /button "Save changes" \[(e\d+)\]/.exec((await session.readPage()).text)?.[1];
      expect(ref).toBeTruthy();
      expect((await session.readPage()).text).toContain(`[${ref}]`);
      await session.act([{ type: "click", ref: ref! }], { settleMs: 100 });
      expect(await session.evaluate<string>("document.getElementById('out').textContent")).toBe("saved");
      const below = /button "Delete account" \[(e\d+)\]/.exec((await session.readPage({ filter: "all" })).text)?.[1];
      await session.act([{ type: "click", ref: below! }], { settleMs: 100 });
      expect(await session.evaluate<string>("document.getElementById('out').textContent")).toBe("deleted");
    } finally {
      await dispose();
    }
  });

  it("reads only part of the page when given a ref, and says when the outline was cut", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/read`);
      const listRef = /listbox "Plan" \[(e\d+)\]/.exec((await session.readPage()).text)?.[1];
      const part = await session.readPage({ ref: listRef });
      expect(part.text.split("\n")).toHaveLength(3);
      const cut = await session.readPage({ maxChars: 60 });
      expect(cut.truncated).toBe(true);
      expect(cut.text).toMatch(/cut at 60 characters/);
      await expect(session.readPage({ ref: "e999" })).rejects.toThrow(/no longer on the page/);
    } finally {
      await dispose();
    }
  });

  it("finds elements by description without any model", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/read`);
      const matches = await session.find("the save changes button");
      expect(matches[0]).toMatchObject({ role: "button", name: "Save changes" });
      expect((await session.find("delete account"))[0]?.name).toBe("Delete account");
      expect(await session.find("zzz nothing")).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("logs network requests without query strings, and only new ones on the next read", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/read`);
      await new Promise((r) => setTimeout(r, 300));
      const first = session.readLogs();
      const api = first.requests.find((r) => r.url.includes("/api/data"));
      expect(api).toMatchObject({ method: "GET", url: `${chrome.baseUrl}/api/data?...`, status: 200 });
      expect(JSON.stringify(first.requests)).not.toContain("secret123");
      expect(session.readLogs(first.cursor).requests).toEqual([]);
    } finally {
      await dispose();
    }
  });
});
