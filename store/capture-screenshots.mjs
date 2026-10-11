/* Capture App Store screenshots from the REAL app, at exact required sizes.

     npm i -D puppeteer-core        # drives the installed Google Chrome
     node store/capture-screenshots.mjs

   Why this exists: the previous screenshots were hand-drawn PIL reconstructions
   of the UI, which drift from the app the moment any copy changes — and did.
   These are real renders of www/index.html, so they cannot show wording the app
   does not have.

   Sizes (Apple; a universal app since 1.2):
     iPhone 6.9"  1290 x 2796   (430 x 932 @3x)   — required
     iPhone 6.5"  1284 x 2778   (428 x 926 @3x)   — required
     iPad 13"     2752 x 2064   (1376 x 1032 @2x, landscape) — required for a universal
                  app (display type APP_IPAD_PRO_3GEN_129). Landscape on purpose: it is
                  the two-column layout an iPad actually gets. Rendered with an iPad user
                  agent, so the copy says "iPad" where it would say "phone".

   ONLY=ipad13 node store/capture-screenshots.mjs   re-captures just that device (comma-
   separated list) and leaves the other sets — and their manifest lines — untouched.
   CURL_FETCH=1 loads fonts/CDN scripts through curl (see scripts/lib/curl-fetch.mjs).

   Emoji are drawn by the capturing machine's emoji font: capture on a Mac for the
   Apple glyphs a user will see. */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { SCENES, buildScene } from "./make-scene.mjs";
import { routeThroughCurl } from "../scripts/lib/curl-fetch.mjs";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = path.join(ROOT, "store", "screenshots");

const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ALL_DEVICES = {
  iphone69: { w: 430, h: 932, s: 3, label: 'iPhone 6.9" (1290x2796)' },
  iphone65: { w: 428, h: 926, s: 3, label: 'iPhone 6.5" (1284x2778)' },
  ipad13: { w: 1376, h: 1032, s: 2, ua: IPAD_UA, label: 'iPad 13" (2752x2064, landscape)' },
};
const ONLY = (process.env.ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
for (const d of ONLY) if (!ALL_DEVICES[d]) { console.error("unknown device in ONLY: " + d); process.exit(1); }
const DEVICES = Object.fromEntries(Object.entries(ALL_DEVICES).filter(([k]) => !ONLY.length || ONLY.includes(k)));
/* Numbered so App Store Connect keeps the order. */
/* 1.1 redesign: lead with what is fun — Home, the Try game, a match, a Talk card. */
/* Welcome is left out: it credits the creators by their show names, which
   stay in the app and off the App Store page (Guideline 1.1 history). */
const ORDER = ["home", "together", "match", "talk", "settings", "program", "consent", "checkins", "pairchoose", "invite"];
const NAME = { home: "home", together: "try", match: "match", talk: "talk", settings: "settings-dark", program: "program",
  consent: "consent", checkins: "journal", pairchoose: "pairing-choice", invite: "pair-code" };

if (!fs.existsSync(CHROME)) { console.error("Chrome not found at " + CHROME + " — set CHROME_PATH"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

/* Delete every PNG already here before capturing. Without this, removing a
   scene leaves its screenshot behind for ever — which is how a paywall
   screenshot survived the removal of the paywall and stayed queued for the
   App Store. The manifest lists what SHOULD exist; the directory must match. */
for (const f of fs.readdirSync(OUT)) {
  if (f.endsWith(".png") && (!ONLY.length || ONLY.some((d) => f.startsWith(d + "_")))) fs.unlinkSync(path.join(OUT, f));
}

const files = Object.fromEntries(ORDER.map((s) => [s, buildScene(s)]));
const args = ["--hide-scrollbars"];
if (process.getuid && process.getuid() === 0) args.push("--no-sandbox");   // CI containers run as root
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args });
const problems = [];

for (const [dev, d] of Object.entries(DEVICES)) {
  for (let i = 0; i < ORDER.length; i++) {
    const scene = ORDER[i];
    const page = await browser.newPage();
    await page.setViewport({ width: d.w, height: d.h, deviceScaleFactor: d.s, isMobile: true, hasTouch: true });
    if (d.ua) await page.setUserAgent(d.ua);
    await routeThroughCurl(page);
    await page.goto("file://" + files[scene], { waitUntil: "networkidle0", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));   // webfonts settle
    const m = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }));
    if (m.scroll > m.inner) problems.push(`${dev}/${scene}: horizontal overflow (${m.scroll} > ${m.inner})`);
    /* A capture that shows a file:// or localhost URL is an artefact of how we
       render, not something a user would ever see. Refuse to ship one. */
    const body = await page.evaluate(() => document.body.innerText);
    if (/file:\/\/|localhost:/.test(body)) problems.push(`${dev}/${scene}: capture leaks a local URL into the frame`);
    if (d.ua && /\bphones?\b/i.test(body)) problems.push(`${dev}/${scene}: an iPad screenshot says "phone"`);
    /* A scene that failed to load the vendored decoder would silently render
       the "this device can't scan" copy — wrong for every real iPhone. */
    const ready = await page.evaluate(() => ({ jsQR: typeof window.jsQR === "function", qr: typeof window.QRCode === "function" }));
    if (!ready.jsQR) problems.push(`${dev}/${scene}: jsQR did not load — the scan copy would be wrong`);
    if (!ready.qr) problems.push(`${dev}/${scene}: QRCode did not load — the invite QR would be missing`);
    const out = path.join(OUT, `${dev}_${String(i + 1).padStart(2, "0")}_${NAME[scene]}.png`);
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
/* One line per device, so a partial re-capture (ONLY=…) keeps the truth about the
   sets it did not touch. A manifest from before 1.2 has one commit for everything. */
const MAN = path.join(OUT, "MANIFEST.txt");
const prev = fs.existsSync(MAN) ? fs.readFileSync(MAN, "utf8") : "";
const oldCommit = (prev.match(/captured from www\/index\.html at commit: (\S+)/) || [])[1] || "unknown";
const deviceLines = Object.keys(ALL_DEVICES).map((k) => {
  if (DEVICES[k]) return `device ${k} commit ${head}  ${ALL_DEVICES[k].label}`;
  const was = prev.match(new RegExp(`^device ${k} commit (\\S+)`, "m"));
  const commit = was ? was[1] : (k.startsWith("iphone") ? oldCommit : null);
  return commit ? `device ${k} commit ${commit}  ${ALL_DEVICES[k].label}` : null;
}).filter(Boolean);
fs.writeFileSync(MAN,
  `Slow Burn — App Store screenshots
source: www/index.html rendered in Chrome at the exact required pixel sizes
${deviceLines.join("\n")}
screens: ${ORDER.map((s, i) => `${i + 1}. ${NAME[s]}`).join("  ")}

Regenerate with:  node store/capture-screenshots.mjs        (ONLY=ipad13 for one set)
`);

if (problems.length) { console.error("\nPROBLEMS:\n  " + problems.join("\n  ")); process.exit(1); }
console.log("\nAll screenshots captured cleanly. Manifest written for commit " + head + ".");
