// Render animated title cards frame by frame: seek every CSS animation to t, screenshot, encode with ffmpeg.
//   bun render.mjs <outDir> [card ...]   (default: all cards; PREVIEW=t renders one still per card at t seconds; CHROME=path)
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const out = process.argv[2];
const ALL = ["IDENT", "OPEN", "SCATTER", "Q1", "Q2", "Q3", "P1", "P2", "P3", "P4", "ONEMEM", "TRACE", "MEMGOV", "COLUMN", "METRIC", "PRODUCT", "PII", "VOCAB", "RECEIPTS", "S1", "S2", "S3", "S4", "S5", "RECAP", "BUTTON", "ONEBRAIN", "TITLE", "DATE"];
const ids = process.argv.slice(3).length ? process.argv.slice(3) : ALL;
const FPS = 30;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const id of ids) {
  await page.goto(`file://${import.meta.dir}/cards.html?card=${id}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)));
  });
  const { dur, overlay } = await page.evaluate(() => ({ dur: window.CARD.dur, overlay: !!window.CARD.overlay }));
  const seek = (t) => page.evaluate((ms) => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; }), t * 1000);
  if (process.env.PREVIEW) {
    await seek(Number(process.env.PREVIEW));
    await page.screenshot({ path: join(out, `still-${id}.png`), omitBackground: overlay });
    console.log(`still ${id} @${process.env.PREVIEW}s`);
    continue;
  }
  const dir = join(out, `f-${id}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const n = Math.round(dur * FPS);
  for (let f = 0; f < n; f++) {
    await seek(f / FPS);
    // overlay cards keep their transparency (PNG, alpha); full cards are opaque JPEG
    await page.screenshot(overlay ? { path: join(dir, `${String(f).padStart(5, "0")}.png`), omitBackground: true } : { path: join(dir, `${String(f).padStart(5, "0")}.jpg`), type: "jpeg", quality: 94 });
  }
  const enc = overlay ? ["-i", join(dir, "%05d.png"), "-c:v", "png", "-pix_fmt", "rgba", join(out, `card-${id}.mov`)] : ["-i", join(dir, "%05d.jpg"), "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", join(out, `card-${id}.mp4`)];
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), ...enc]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`card ${id}: ${n} frames (${dur}s)`);
}
await browser.close();
