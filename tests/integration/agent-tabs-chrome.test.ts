import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";

const HOME_HTML = `<!doctype html><html><head><title>Home</title></head><body style="margin:0">
<a id="pop" href="/other" target="_blank" style="display:block;width:200px;height:40px">open other</a>
<button id="win" style="display:block;width:200px;height:40px" onclick="window.open('/other?via=script')">script popup</button>
<a id="dl" href="/file" style="display:block;width:200px;height:40px">download</a>
<script>document.cookie = "sid=shared-login; path=/";</script>
</body></html>`;
const OTHER_HTML = `<!doctype html><html><head><title>Other</title></head><body>
<button id="bye" onclick="window.close()" style="width:200px;height:40px">close me</button></body></html>`;

describe.skipIf(!chromePath)("session tabs against a real Chrome", () => {
  let chrome: RealChrome;
  let downloads: string;

  beforeAll(async () => {
    downloads = await mkdtemp(join(tmpdir(), "bg-downloads-"));
    chrome = await startRealChrome({
      "/home": HOME_HTML,
      "/other": OTHER_HTML,
      "/other?via=script": OTHER_HTML,
      "/file": { body: "hello file", headers: { "content-type": "text/plain", "content-disposition": "attachment; filename=hello.txt" } },
    });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
    await rm(downloads, { recursive: true, force: true });
  });

  it("lists a tab the page opens, sharing the first tab's login, and keeps the opener active", async () => {
    const { session, dispose } = await chrome.connect({ isolateTabs: false, adoptPopups: true });
    try {
      await session.navigate(`${chrome.baseUrl}/home`);
      await session.clickAt({ x: 50, y: 20 });
      await session.clickAt({ x: 50, y: 60 });
      await new Promise((r) => setTimeout(r, 500));
      const tabs = await session.tabInventory();
      expect(tabs).toHaveLength(3);
      expect(tabs[0]).toMatchObject({ title: "Home", active: true });
      expect(tabs.slice(1).map((t) => t.url).sort()).toEqual([`${chrome.baseUrl}/other`, `${chrome.baseUrl}/other?via=script`]);
      const cookie = await session.evaluate<string>("document.cookie", tabs[1]!.tabId);
      expect(cookie).toContain("sid=shared-login");
    } finally {
      await dispose();
    }
  });

  it("switches to a tab, drops one that closed itself, and refuses to close the last tab", async () => {
    const { session, dispose } = await chrome.connect({ isolateTabs: false, adoptPopups: true, keepLastTab: true });
    try {
      await session.navigate(`${chrome.baseUrl}/home`);
      await session.clickAt({ x: 50, y: 20 });
      await new Promise((r) => setTimeout(r, 500));
      const popup = (await session.tabInventory())[1]!;
      await session.activateTab(popup.tabId);
      expect((await session.tabInventory()).find((t) => t.active)?.tabId).toBe(popup.tabId);
      await session.clickAt({ x: 50, y: 20 }, {}, popup.tabId);
      await new Promise((r) => setTimeout(r, 500));
      const left = await session.tabInventory();
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ title: "Home", active: true });
      await expect(session.closeTab(left[0]!.tabId)).rejects.toThrow(/only tab/);
    } finally {
      await dispose();
    }
  });

  it("follows a download from start to finish when downloads are allowed", async () => {
    const { session, dispose } = await chrome.connect({ isolateTabs: false, downloadPath: downloads });
    try {
      await session.navigate(`${chrome.baseUrl}/home`);
      await session.clickAt({ x: 50, y: 100 });
      for (let i = 0; i < 40 && session.observed().downloads[0]?.state !== "completed"; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(session.observed().downloads[0]).toMatchObject({ fileName: "hello.txt", state: "completed" });
      expect(session.observed().downloads[0]?.id).toBeTruthy();
      expect(await readdir(downloads)).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it("reports pop-up tabs to a session that keeps tabs isolated, without taking them over", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/home`);
      await session.clickAt({ x: 50, y: 20 });
      await new Promise((r) => setTimeout(r, 500));
      expect(session.observed().newTabUrls).toEqual([`${chrome.baseUrl}/other`]);
      expect(session.tabIds).toHaveLength(1);
    } finally {
      await dispose();
    }
  });
});
