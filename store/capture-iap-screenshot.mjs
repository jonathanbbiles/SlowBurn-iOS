/* Capture the App Review screenshot App Store Connect requires for the
   "Small Tip" in-app purchase.

     node store/capture-iap-screenshot.mjs

   THIS IS NOT AN APP STORE SCREENSHOT. It never goes near the listing and it
   is never added to ORDER in capture-screenshots.mjs — Apple attaches it to
   the PRODUCT, and its only job is to show a reviewer where the purchase is
   and what it does. It is a real render of the shipping www/index.html with a
   stubbed StoreKit bridge (see the `support` scene in make-scene.mjs), so it
   cannot show a Support card the app does not have.

   The wait is on the tip BUTTON existing, not on a timer: if the real
   Monetize module ever stops rendering a button for a loaded product, this
   fails loudly rather than shipping Apple a screenshot of an empty card and
   collecting a "we could not locate the in-app purchase" rejection. */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { buildScene } from "./make-scene.mjs";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = path.join(ROOT, "store", "iap");
const FILE = path.join(OUT, "small-tip-review.png");

if (!fs.existsSync(CHROME)) { console.error("Chrome not found at " + CHROME + " — set CHROME_PATH"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const scene = buildScene("support");
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--hide-scrollbars"] });
const page = await browser.newPage();
/* 430x932 @3x = 1290x2796, an size Apple accepts for a review screenshot. */
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await page.goto("file://" + scene, { waitUntil: "networkidle0", timeout: 30000 });

const problems = [];
try {
  await page.waitForSelector('[data-action="tip"]', { timeout: 10000 });
} catch (e) {
  problems.push('the tip button never rendered — the app would show Apple an empty Support card');
}

/* Put the Support card in frame. It sits at the bottom of the "Us"/"You" tab,
   so an unscrolled capture would show the top of the tab and no purchase. */
await page.evaluate(() => {
  const btn = document.querySelector('[data-action="tip"]');
  const card = btn && btn.closest(".card");
  if (card) card.scrollIntoView({ block: "center" });
});
await new Promise((r) => setTimeout(r, 900));   // webfonts + scroll settle

const seen = await page.evaluate(() => {
  const btn = document.querySelector('[data-action="tip"]');
  return { label: btn ? btn.textContent.trim() : null, body: document.body.innerText };
});
if (seen.label && !/\$/.test(seen.label)) problems.push(`the tip button shows no price: "${seen.label}"`);
if (!/Support Slow Burn/.test(seen.body)) problems.push("the Support card is not on screen");
if (/file:\/\/|localhost:/.test(seen.body)) problems.push("the capture leaks a local URL into the frame");

await page.screenshot({ path: FILE });
await browser.close();

if (problems.length) { console.error("\nPROBLEMS:\n  " + problems.join("\n  ")); process.exit(1); }
const kb = Math.round(fs.statSync(FILE).size / 1024);
console.log(`captured ${path.relative(ROOT, FILE)} (1290x2796, ${kb} KB) — button reads "${seen.label}"`);
