/* PAIRING QR / SCANNER TEST — run with `npm run test:qr`.
   -----------------------------------------------------------------
   The defect this exists to prevent: the pairing QR used to encode
   `location.origin + location.pathname + "?pair=" + code`, which inside the
   native app is `capacitor://localhost/?pair=…`. No other phone can open
   that, and no URL scheme is registered for it, so the screen said "Scan to
   join" and scanning did nothing. Only typing the code worked.

   This drives the REAL app in a real browser and asserts, end to end:

     1. the QR on the invite screen decodes to the bare pair code — no URL,
        no scheme, no origin, nothing but the ten characters
     2. pointing the app's own scanner at that QR extracts the same code and
        hands it to connectLive() as the joining side
     3. a QR that is not one of ours is ignored rather than acted on
     4. the scanner releases the camera when it is done

   It uses a canvas as a fake camera, so it tests the actual decode loop —
   getUserMedia → video → canvas → jsQR → normCode — not a mock of it. */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = new URL("..", import.meta.url).pathname;
const APP = "file://" + path.join(ROOT, "www", "index.html");

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); return c; };

if (!fs.existsSync(CHROME)) { console.error("Chrome not found at " + CHROME + " — set CHROME_PATH"); process.exit(1); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--hide-scrollbars", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

/* The app must not reach a real broker. Stub mqtt before any app code runs. */
await page.evaluateOnNewDocument(() => {
  window.mqtt = { connect() {
    const h = {};
    const c = { on(e, f) { h[e] = f; if (e === "connect") setTimeout(() => f(), 0); return c; },
      subscribe() {}, publish() {}, end() {} };
    return c;
  } };
});
await page.goto(APP, { waitUntil: "networkidle0", timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));

/* ---------- 1. What does the QR actually contain? ---------- */
const qr = await page.evaluate(async () => {
  S.ack = true;
  S.profile = { done: true,
    people: { A: { name: "Jessica", gender: "", genderCustom: "", pronouns: "she", pronounsCustom: "", orientation: "", orientationCustom: "" },
              B: { name: "Jonathan", gender: "", genderCustom: "", pronouns: "he", pronounsCustom: "", orientation: "", orientationCustom: "" } },
    structure: "mono", structureCustom: "", partnerTerm: "partner", partnerTermCustom: "", areas: "inclusive" };
  S.screen = "pairing"; S.pairPhase = "choose"; render();
  document.querySelector('[data-action="pair-create"]').click();
  await new Promise((r) => setTimeout(r, 500));

  const box = document.getElementById("qrbox");
  const el = box && (box.querySelector("canvas") || box.querySelector("img"));
  if (!el) return { error: "no QR rendered on the invite screen" };

  // Rasterise whatever qrcodejs produced, then decode it exactly as the
  // scanner would.
  const c = document.createElement("canvas");
  c.width = 320; c.height = 320;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, 320, 320);
  if (el.tagName === "IMG" && !el.complete) await new Promise((r) => { el.onload = r; });
  g.drawImage(el, 0, 0, 320, 320);
  const img = g.getImageData(0, 0, 320, 320);
  const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
  return { code: S.code, decoded: res && res.data, tag: el.tagName };
});

if (qr.error) { fails.push(qr.error); }
else {
  ok(!!qr.decoded, "the QR on the invite screen could not be decoded at all");
  ok(qr.decoded === qr.code, `QR does not contain the bare pair code — got ${JSON.stringify(qr.decoded)}, expected ${JSON.stringify(qr.code)}`);
  ok(!/:\/\//.test(qr.decoded || ""), `QR still encodes a URL: ${qr.decoded}`);
  ok(!/capacitor|localhost|file:|\?pair=/i.test(qr.decoded || ""), `QR encodes an un-openable app origin: ${qr.decoded}`);
  console.log(`1  QR encodes exactly the pair code: ${JSON.stringify(qr.decoded)} (rendered as <${qr.tag.toLowerCase()}>)`);
}

/* ---------- 2. Does the app's own scanner read it and pair? ---------- */
const scan = await page.evaluate(async (realCode) => {
  /* A canvas showing the QR, captured as a MediaStream, standing in for the
     camera. Everything downstream — video element, frame grab, jsQR,
     normCode — is the app's real code path. */
  function fakeCamera(text) {
    const c = document.createElement("canvas");
    c.width = 640; c.height = 640;
    const g = c.getContext("2d");
    const holder = document.createElement("div");
    document.body.appendChild(holder);
    new QRCode(holder, { text, width: 480, height: 480, correctLevel: QRCode.CorrectLevel.M });
    const el = holder.querySelector("canvas") || holder.querySelector("img");
    const paint = () => { g.fillStyle = "#fff"; g.fillRect(0, 0, 640, 640); g.drawImage(el, 80, 80, 480, 480); };
    paint(); setInterval(paint, 100);            // keep the stream alive
    holder.style.display = "none";
    return c.captureStream(30);
  }

  let served = null;
  navigator.mediaDevices.getUserMedia = async () => served;

  const spy = { calls: [] };
  const origConnect = connectLive;
  connectLive = function (...a) { spy.calls.push(a); };   // don't actually dial out

  /* --- 2a. QRs that are not ours must be ignored ---
     Each of these is short enough to decode almost instantly, so a pass here
     means the decode really happened and the payload was rejected — not that
     the QR was simply too dense to read in time. "HTTPSEXAMP" is the exact
     string that used to slip through: normCode() turned an https URL into it
     by stripping punctuation and truncating to ten characters. */
  const foreign = ["HTTPSEXAMP", "BBBBBBBBBB", "0123456789", "RTT77MH4J"];
  const foreignResults = [];
  for (const f of foreign) {
    served = fakeCamera(f);
    S.screen = "pairing"; S.pairPhase = "join"; render();
    openScan();
    /* Prove the frame really was readable, so "ignored" cannot be a false
       negative caused by the video simply not having painted yet. Poll the
       same stream the scanner is watching until it decodes. */
    let seen = null, tries = 0;
    while (seen === null && tries < 40) {
      await new Promise((r) => setTimeout(r, 100)); tries++;
      const v = document.getElementById("scanvideo");
      if (!v || !v.videoWidth) continue;
      const c = document.createElement("canvas"); c.width = 640; c.height = 640;
      const g = c.getContext("2d");
      g.drawImage(v, 0, 0, 640, 640);
      const d = g.getImageData(0, 0, 640, 640);
      const r = window.jsQR(d.data, d.width, d.height, { inversionAttempts: "dontInvert" });
      seen = (r && r.data) || null;
    }
    await new Promise((r) => setTimeout(r, 300));   // give the app every chance to act on it
    foreignResults.push({ payload: f, decoded: seen, acted: spy.calls.length > 0, stillOpen: S.scanning });
    closeScan();
    await new Promise((r) => setTimeout(r, 100));
  }
  const ignoredForeign = foreignResults.every((r) => !r.acted && r.decoded === r.payload && r.stillOpen);

  // --- 2b. our QR must pair ---
  served = fakeCamera(realCode);
  S.screen = "pairing"; S.pairPhase = "join"; render();
  openScan();
  let waited = 0;
  while (spy.calls.length === 0 && waited < 6000) { await new Promise((r) => setTimeout(r, 100)); waited += 100; }

  const liveTracks = served.getTracks().filter((t) => t.readyState === "live").length;
  connectLive = origConnect;
  return { ignoredForeign, foreignResults, calls: spy.calls, scanning: S.scanning,
           fieldValue: (document.getElementById("joincode") || {}).value || "", waited, liveTracks };
}, qr.code);

ok(scan.ignoredForeign, "a foreign QR was decoded but not rejected: " + JSON.stringify(scan.foreignResults));
console.log("2  foreign QRs decoded and rejected: " + scan.foreignResults.map(r=>r.payload).join(", "));

ok(scan.calls.length === 1, `scanning our QR called connectLive ${scan.calls.length} time(s), expected 1`);
if (scan.calls.length) {
  const [side, , code] = scan.calls[0];
  ok(side === "g", `scanner joined as side "${side}", expected "g" (the joining phone)`);
  ok(code === qr.code, `scanner passed the wrong code: ${code} vs ${qr.code}`);
  console.log(`3  scanned our QR in ${scan.waited}ms -> connectLive("${side}", …, "${code}")`);
}
ok(!scan.scanning, "the scan sheet stayed open after a successful scan");
ok(scan.fieldValue.replace(/\s/g, "") === (qr.code || ""), `the code field was not filled in (got "${scan.fieldValue}")`);

/* ---------- 4. Camera released ---------- */
ok(scan.liveTracks === 0, `${scan.liveTracks} camera track(s) still live after a successful scan — the camera was not released`);
console.log("4  camera released after the scan (0 live tracks)");

/* ---------- 5. No dead button when there is no camera ---------- */
const noCam = await page.evaluate(() => {
  const saved = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = undefined;
  S.screen = "pairing"; S.pairPhase = "join"; render();
  const shown = !!document.querySelector('[data-action="scan-open"]');
  navigator.mediaDevices.getUserMedia = saved;
  S.pairPhase = "join"; render();
  const shownAgain = !!document.querySelector('[data-action="scan-open"]');
  return { shown, shownAgain };
});
ok(!noCam.shown, "the Scan button is offered on a device with no camera API — that is a dead button");
ok(noCam.shownAgain, "the Scan button is missing even when the camera API is present");
console.log("5  Scan button appears only when the device can actually scan");

await browser.close();
if (fails.length) {
  console.log("\n*** pairing QR test: FAIL ***");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log("\npairing QR test: all assertions passed.");
process.exit(0);
