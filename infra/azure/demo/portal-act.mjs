// Drive the portal browser over CDP with a list of steps, for exploring portals before scripting a demo.
// ACTIONS='[{"tab":0},{"goto":"https://..."},{"click":"text=Agents"},{"wait":3000},{"shot":"a"},{"dump":true}]'
// Screenshots go to /out/act-<name>.png ("xshot": the whole X display); "dump" prints the URL, title and visible
// buttons/links/tabs; "eval" prints the value of a JavaScript expression evaluated in the page.
import { execSync } from "node:child_process";
import { chromium } from "playwright";

const actions = JSON.parse(process.env.ACTIONS ?? "[]");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const pages = browser.contexts().flatMap((c) => c.pages());
let page = pages[0];
for (const a of actions) {
  try {
    if (a.tab !== undefined) {
      page = browser.contexts().flatMap((c) => c.pages())[a.tab];
      await page.bringToFront();
    }
    if (a.newTab) {
      page = await page.context().newPage();
      await page.goto(a.newTab, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    if (a.goto) await page.goto(a.goto, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (a.click) await page.locator(a.click).first().click({ timeout: 15_000 });
    if (a.fill) await page.locator(a.fill[0]).first().fill(a.fill[1], { timeout: 15_000 });
    if (a.press) await page.keyboard.press(a.press);
    if (a.clickAt) await page.mouse.click(a.clickAt[0], a.clickAt[1]);
    if (a.scroll) await page.mouse.wheel(0, a.scroll);
    if (a.type) await page.keyboard.type(a.type, { delay: a.delay ?? 12 });
    if (a.probe) {
      const found = await page.evaluate(() =>
        [...document.querySelectorAll('textarea, input, [contenteditable="true"], [role="textbox"]')]
          .filter((e) => e.offsetParent !== null)
          .map((e) => `${e.tagName.toLowerCase()} role=${e.getAttribute("role")} placeholder=${e.getAttribute("placeholder")} aria=${e.getAttribute("aria-label")} ce=${e.getAttribute("contenteditable")} data-testid=${e.getAttribute("data-testid")}`),
      );
      console.log("INPUTS:\n" + found.join("\n"));
    }
    if (a.wait) await page.waitForTimeout(a.wait);
    if (a.waitFor) await page.locator(a.waitFor).first().waitFor({ timeout: a.timeout ?? 60_000 });
    if (a.shot) await page.screenshot({ path: `/out/act-${a.shot}.png` });
    // the whole X display (browser chrome included), as the recorder sees it
    if (a.xshot) execSync(`ffmpeg -y -loglevel error -f x11grab -video_size 1920x1080 -i :99 -frames:v 1 /out/act-${a.xshot}.png`);
    if (a.eval) console.log("EVAL:", JSON.stringify(await page.evaluate(a.eval)));
    if (a.dump) {
      console.log("URL:", page.url());
      console.log("TITLE:", await page.title());
      const items = await page.evaluate((limit) =>
        [...document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], [role="link"], [role="treeitem"]')]
          .filter((e) => e.offsetParent !== null)
          .map((e) => `${e.tagName.toLowerCase()}${e.getAttribute("role") ? `[${e.getAttribute("role")}]` : ""}: ${(e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60)}${e.tagName === "A" ? ` -> ${e.getAttribute("href")?.slice(0, 90)}` : ""}`)
          .filter((t) => !/: $/.test(t))
          .slice(0, limit),
      a.dump === true ? 80 : a.dump);
      console.log(items.join("\n"));
    }
  } catch (e) {
    console.log("STEP FAILED", JSON.stringify(a), String(e).split("\n")[0].slice(0, 200));
  }
}
await browser.close().catch(() => undefined);
