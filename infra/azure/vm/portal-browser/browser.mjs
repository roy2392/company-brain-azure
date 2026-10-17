// Headed Chromium with a persistent profile; CDP on 127.0.0.1:9222 for the demo driver (docker exec).
import { chromium } from "playwright";
const ctx = await chromium.launchPersistentContext("/profile", {
  headless: false,
  viewport: null,
  // no "Chrome is being controlled by automated test software" bar in the recording
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--remote-debugging-port=9222", "--window-position=0,0", "--window-size=1920,1080", "--no-first-run", "--disable-features=Translate", "--force-device-scale-factor=1"],
});
const first = ctx.pages()[0] ?? (await ctx.newPage());
await first.goto("https://ai.azure.com").catch(() => undefined);
if (process.env.OM_URL) await (await ctx.newPage()).goto(process.env.OM_URL).catch(() => undefined);
await first.bringToFront();
console.log("portal browser ready (noVNC on :6080)");
await new Promise(() => undefined);
