/* Capture App Store screenshots from the REAL app, at exact required sizes.

     npm i -D puppeteer-core        # drives the installed Google Chrome
     node store/capture-screenshots.mjs

   Why this exists: the previous screenshots were hand-drawn PIL reconstructions
   of the UI, which drift from the app the moment any copy changes — and did.
   These are real renders of www/index.html, so they cannot show wording the app
   does not have.

   Sizes (Apple, iPhone-only app):
     iPhone 6.9"  1290 x 2796   (430 x 932 @3x)   — required
     iPhone 6.5"  1284 x 2778   (428 x 926 @3x)   — required

   No iPad: the app ships iPhone-only (see codemagic.yaml, Guideline 4). */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { SCENES, buildScene } from "./make-scene.mjs";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = path.join(ROOT, "store", "screenshots");

const DEVICES = {
  iphone69: { w: 430, h: 932, s: 3 },
  iphone65: { w: 428, h: 926, s: 3 },
};
/* Numbered so App Store Connect keeps the order. */
const ORDER = ["welcome", "program", "consent", "checkins", "pairchoose"];
const NAME = { welcome: "welcome", program: "program", consent: "consent", checkins: "checkins", pairchoose: "pairing-choice" };

if (!fs.existsSync(CHROME)) { console.error("Chrome not found at " + CHROME + " — set CHROME_PATH"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const files = Object.fromEntries(ORDER.map((s) => [s, buildScene(s)]));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--hide-scrollbars"] });
const problems = [];

for (const [dev, d] of Object.entries(DEVICES)) {
  for (let i = 0; i < ORDER.length; i++) {
    const scene = ORDER[i];
    const page = await browser.newPage();
    await page.setViewport({ width: d.w, height: d.h, deviceScaleFactor: d.s, isMobile: true, hasTouch: true });
    await page.goto("file://" + files[scene], { waitUntil: "networkidle0", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));   // webfonts settle
    const m = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }));
    if (m.scroll > m.inner) problems.push(`${dev}/${scene}: horizontal overflow (${m.scroll} > ${m.inner})`);
    /* A capture that shows a file:// or localhost URL is an artefact of how we
       render, not something a user would ever see. Refuse to ship one. */
    const body = await page.evaluate(() => document.body.innerText);
    if (/file:\/\/|localhost:/.test(body)) problems.push(`${dev}/${scene}: capture leaks a local URL into the frame`);
    const out = path.join(OUT, `${dev}_0${i + 1}_${NAME[scene]}.png`);
    await page.screenshot({ path: out });
    await page.close();
  }
  console.log(dev, "captured", ORDER.length, "screens");
}
await browser.close();

/* Record which build these came from, so the Apple audit can tell whether the
   screenshots still match the shipping copy. */
let head = "unknown";
try { head = execSync("git log -1 --format=%h -- www/index.html", { cwd: ROOT }).toString().trim(); } catch (e) {}
fs.writeFileSync(path.join(OUT, "MANIFEST.txt"),
  `Slow Burn — App Store screenshots
captured from www/index.html at commit: ${head}
source: www/index.html rendered in Chrome at the exact required pixel sizes
devices: iPhone 6.9" (1290x2796), iPhone 6.5" (1284x2778) — iPhone-only app, no iPad
screens: ${ORDER.map((s, i) => `${i + 1}. ${NAME[s]}`).join("  ")}

Regenerate with:  node store/capture-screenshots.mjs
`);

if (problems.length) { console.error("\nPROBLEMS:\n  " + problems.join("\n  ")); process.exit(1); }
console.log("\nAll screenshots captured cleanly. Manifest written for commit " + head + ".");
