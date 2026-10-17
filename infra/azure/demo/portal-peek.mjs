// Inspect the portal browser over CDP: tabs, URLs, titles, and a screenshot of each tab (/out/peek-<n>.png).
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const pages = browser.contexts().flatMap((c) => c.pages());
for (const [i, p] of pages.entries()) {
  console.log(`tab ${i}: ${p.url().slice(0, 140)} | ${(await p.title().catch(() => "")).slice(0, 80)}`);
  await p.screenshot({ path: `/out/peek-${i}.png` }).catch(() => undefined);
}
await browser.close().catch(() => undefined);
