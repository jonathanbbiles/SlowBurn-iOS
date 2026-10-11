/* Big-screen layout check — every screen at every size Slow Burn now runs at.

     npm run test:layout                     # needs Chrome (CHROME_PATH) + puppeteer-core
     LAYOUT_OUT=/some/dir npm run test:layout   # also keep a PNG of every render

   Since 1.2 Slow Burn is a universal app: iPhone, iPhone Duo (closed and open,
   upright and sideways) and iPad in both orientations. This serves www/ over
   http (the way the WebView loads it, not file://), drives the SHIPPING app
   into each scene from store/make-scene.mjs, and fails on:

     - horizontal overflow (anything wider than the window);
     - a last control that cannot be scrolled clear of the tab bar / the bottom
       edge (it must be reachable by a thumb, not hidden under fixed chrome);
     - a tab bar that does not span the whole window;
     - a missing big-screen layout: at >= 860px wide every main screen must
       actually use two or more columns (not a phone column with margins);
     - the word "phone" anywhere on screen at an iPad size (rendered with an
       iPad user agent — see deviceWords() in www/index.html).

   Not part of `npm test`: that runs on the Codemagic lane, which has no
   Chrome. Run it before shipping a layout change, like `npm run test:qr`. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { SCENES, PROFILE } from "../store/make-scene.mjs";
import { routeThroughCurl } from "./lib/curl-fetch.mjs";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = new URL("..", import.meta.url).pathname;
const WWW = path.join(ROOT, "www");
const OUT = process.env.LAYOUT_OUT || "";

/* iPhone 13-16 · Duo closed · Duo open upright/sideways · iPad Air 11" · iPad Pro 13" · iPhone sideways */
const SIZES = [[390, 844], [466, 678], [669, 951], [951, 669], [820, 1180], [1180, 820], [1024, 1366], [1366, 1024], [844, 390]];

/* Screens the App Store set does not cover, so the check reaches every tab. */
const EXTRA = {
  talkdecks: `setProfile();S.mode="live";S.screen="app";S.tab="talk";S.pairSecure=true;S.partnerOnline=true;S.code="RTT77MH4JN";
    S.tg.talk.fav=["deeptalk:2"];render();`,
  us: `setProfile();S.mode="live";S.screen="app";S.tab="partner";S.pairSecure=true;S.pairSafety="X4A-RTW";S.partnerOnline=true;S.code="RTT77MH4JN";render();`,
  hobby: `setProfile();S.mode="live";S.screen="hobby";S.hobbyOpen="stargazing";S.pairSecure=true;S.partnerOnline=true;S.code="RTT77MH4JN";render();`,
  trylist: `setProfile();S.mode="live";S.screen="trylist";S.tg.picks.A.yes=["sourdough"];render();`,
  saved: `setProfile();S.mode="live";S.screen="saved";S.tg.talk.fav=["deeptalk:2","warmup:1","flirty:0"];render();`,
  disclaimer: `S.screen="disclaimer";render();`,
  setup: `S.ack=true;S.screen="setup";render();`,
  session: `setProfile();S.mode="shared";S.session={stageId:1,startedAt:Date.now(),phase:"guide"};S.screen="session";render();`,
  reflect: `setProfile();S.mode="shared";S.session={stageId:1,startedAt:Date.now(),phase:"debrief"};S.screen="session";render();`,
  practices: `setProfile();S.mode="solo";S.screen="practices";render();`,
  clinicians: `setProfile();S.screen="clinicians";render();`,
  join: `setProfile();S.mode="live";S.screen="pairing";S.pairPhase="join";render();`,
  solohome: `S.ack=true;S.profile={done:true,people:{A:{name:"Rowan",gender:"nonbinary",genderCustom:"",pronouns:"they",pronounsCustom:"",orientation:"queer",orientationCustom:""}},
    structure:"solo",structureCustom:"",partnerTerm:"partner",partnerTermCustom:"",areas:"inclusive"};S.mode="solo";S.screen="app";S.tab="today";render();`,
};
const ALL = { ...SCENES, ...EXTRA };
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
delete ALL.support;   // the IAP review scene stubs StoreKit; it is not a screen of its own
/* At >= 860px wide each of these must be laid out in two or more columns (grid or CSS columns). */
const TWO_COL = { home: ".lay-home", solohome: ".lay-home", talk: ".lay-talk", together: ".lay-try", match: ".lay-try",
  hobby: ".lay-hobby", consent: ".lay-stage", invite: ".lay-invite", pairchoose: ".opts", talkdecks: ".decks",
  program: ".stages", checkins: ".jtop", settings: ".set-cols", us: ".us-cards", trylist: ".trylist", saved: ".saved-list" };

if (!fs.existsSync(CHROME)) { console.error("Chrome not found at " + CHROME + " — set CHROME_PATH"); process.exit(1); }
if (OUT) fs.mkdirSync(OUT, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".txt": "text/plain" };
const server = http.createServer((req, res) => {
  const p = path.join(WWW, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!p.startsWith(WWW) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;

const args = ["--hide-scrollbars"];
if (process.getuid && process.getuid() === 0) args.push("--no-sandbox");   // CI containers run as root
if (process.env.HTTPS_PROXY) args.push("--proxy-server=" + process.env.HTTPS_PROXY, "--proxy-bypass-list=127.0.0.1;localhost");
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args });
const fails = [];
let checked = 0;

for (const [w, h] of SIZES) {
  for (const [name, code] of Object.entries(ALL)) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    /* iPad sizes run with an iPad user agent: on an iPad the copy must never say "phone". */
    const ipad = w >= 744 && h >= 744;
    if (ipad) await page.setUserAgent(IPAD_UA);
    await routeThroughCurl(page);
    await page.goto(BASE, { waitUntil: "networkidle0", timeout: 30000 }).catch(() => {});
    try { await page.evaluate(`${PROFILE};${code}`); }
    catch (e) { fails.push(`${w}x${h} ${name}: scene threw — ${e.message}`); await page.close(); continue; }
    await new Promise((r) => setTimeout(r, 250));
    const r = await page.evaluate((twoCol) => {
      const out = { inner: innerWidth, scroll: document.documentElement.scrollWidth, wide: [] };
      document.querySelectorAll("#root *").forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width && b.right > innerWidth + 1 && !el.closest(".hscroll")) out.wide.push(el.className || el.tagName);
      });
      const tabs = document.querySelector(".tabs");
      if (tabs) { const b = tabs.getBoundingClientRect(); out.tabs = { left: b.left, width: b.width, top: b.top }; }
      /* Scroll the view to the bottom, then find the lowest visible control. */
      /* #root is itself the scrolling .view; screens may nest another. */
      document.querySelectorAll("#root, #root .view").forEach((v) => { v.scrollTop = v.scrollHeight; });
      const ctrls = [...document.querySelectorAll("#root button, #root a, #root input, #root textarea, #root [data-action]")]
        .filter((el) => !el.closest(".tabs") && !el.closest(".match-ov") && el.getBoundingClientRect().height > 0);
      let last = null;
      for (const el of ctrls) { const b = el.getBoundingClientRect(); if (!last || b.bottom > last.bottom) last = { bottom: b.bottom, label: (el.textContent || el.className).trim().slice(0, 30) }; }
      out.last = last;
      out.limit = tabs ? tabs.getBoundingClientRect().top : innerHeight;
      out.twoCol = twoCol ? (() => {
        const el = document.querySelector(twoCol); if (!el) return "missing";
        const cs = getComputedStyle(el);
        if (cs.display === "grid") return cs.gridTemplateColumns.split(" ").filter(Boolean).length;
        return parseInt(cs.columnCount, 10) || 1;
      })() : null;
      return out;
    }, w >= 860 ? TWO_COL[name] || null : null);
    checked++;
    if (ipad) {
      const words = await page.evaluate(() => (document.body.innerText.match(/\bphones?\b/gi) || []).length);
      if (words) fails.push(`${w}x${h} ${name}: the copy says "phone" ${words}x on an iPad`);
    }
    const tag = `${w}x${h} ${name}`;
    if (r.scroll > r.inner) fails.push(`${tag}: horizontal overflow (${r.scroll} > ${r.inner})`);
    if (r.wide.length) fails.push(`${tag}: element(s) past the right edge: ${[...new Set(r.wide)].slice(0, 4).join(", ")}`);
    if (r.tabs && (Math.abs(r.tabs.left) > 0.5 || Math.abs(r.tabs.width - w) > 0.5)) fails.push(`${tag}: tab bar does not span the window (${r.tabs.left}+${r.tabs.width})`);
    if (r.last && r.last.bottom > r.limit + 0.5) fails.push(`${tag}: last control "${r.last.label}" ends at ${Math.round(r.last.bottom)}, under the fixed bar at ${Math.round(r.limit)}`);
    if (r.twoCol !== null && (r.twoCol === "missing" || r.twoCol < 2)) fails.push(`${tag}: expected a multi-column layout at this width (${r.twoCol})`);
    if (OUT) {
      await page.evaluate(() => document.querySelectorAll("#root, #root .view").forEach((v) => { v.scrollTop = 0; }));
      await page.screenshot({ path: path.join(OUT, `${w}x${h}_${name}.png`) });
    }
    await page.close();
  }
}
await browser.close();
server.close();

if (fails.length) { console.error(`\n*** layout check: FAIL (${fails.length}) ***\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`layout check: ${checked} renders (${SIZES.length} sizes x ${Object.keys(ALL).length} screens) — no overflow, every last control reachable, tab bar full width, two columns where expected.`);
