/* PRIVACY REGRESSION TEST — run with `npm run audit:privacy`.
   -----------------------------------------------------------------
   Slow Burn's in-app copy promises that nothing personal leaves the phone.
   This test is what keeps that promise honest: it loads the real www/index.html
   in jsdom, swaps in a recording MQTT client, walks a full pairing + session +
   reflection + readiness flow with deliberately identifying data, and then
   asserts that NONE of it appears in any publish, that no publish (or the
   last-will) sets retain, that every payload is a single digit, and that the
   pair code never appears in a topic.

   It also asserts the consent gate still opens, so a future "just don't send
   anything" regression can't pass by breaking the feature.

   If you add a field to the pairing protocol, this test should fail. That is
   the point. Fix the protocol, not the test. */
import fs from "node:fs";
import { JSDOM } from "jsdom";

const HTML = new URL("../www/index.html", import.meta.url).pathname;
const html = fs.readFileSync(HTML, "utf8").replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, "");

const sent = [];
const subs = [];

const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.invalid/app/", pretendToBeVisual: true });
const w = dom.window;

w.mqtt = {
  connect(url, opts) {
    const handlers = {};
    const c = {
      __url: url, __will: opts.will,
      on(ev, fn) { handlers[ev] = fn; if (ev === "connect") setTimeout(() => fn(), 0); return c; },
      subscribe(t) { subs.push(t); },
      publish(topic, payload, o) { sent.push({ topic, payload: String(payload), retain: !!(o && o.retain) }); },
      end() {},
      __emit(t, p) { handlers.message && handlers.message(t, Buffer.from(p)); },
    };
    w.__client = c;
    return c;
  },
};
const src = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)[1];
w.eval(src + `
;window.__api={get S(){return S},render,activeRole,publishProgress,pairBase,maxUnlocked};`);
const api = w.__api;

const S = api.S;
const click = (sel) => { const el = w.document.querySelector(sel); if (!el) throw new Error("missing " + sel); el.click(); };
const wait = () => new Promise((r) => setTimeout(r, 5));

// ---- Walk a realistic two-phone flow, entering the most sensitive data ----
S.ack = true;
S.profile = {
  done: true,
  people: {
    A: { name: "Jessica", gender: "woman", genderCustom: "", pronouns: "she", pronounsCustom: "", orientation: "queer", orientationCustom: "" },
    B: { name: "Jonathan", gender: "man", genderCustom: "", pronouns: "he", pronounsCustom: "", orientation: "straight", orientationCustom: "" },
  },
  structure: "monogamous", structureCustom: "", partnerTerm: "partner", partnerTermCustom: "", areas: "inclusive",
};
S.screen = "pairing"; S.pairPhase = "choose";
api.render();

click('[data-action="pair-create"]');   // host creates the pairing + connects
await wait();

const code = S.code;

// name typed on the invite screen
const nameField = w.document.getElementById("myname");
nameField.value = "Jessica";
click('[data-action="enter-app-host"]');
await wait();

// run a session and record a full private reflection
S.data[api.activeRole()].sessions[1] = 0;
S.session = { stageId: 1, startedAt: 1, phase: "reflect" };
S.form = { good: new Set(["Eye contact", "Feeling safe"]), more: new Set(["Softer touch"]), note: "I felt anxious at the start but it passed." };
S.screen = "session"; api.render();
const noteEl = w.document.getElementById("privnote");
noteEl.value = "I felt anxious at the start but it passed.";
click('[data-action="submit-debrief"]');
await wait();

// confirm readiness for the next stage, then un-confirm, then re-confirm
S.stageOpen = 1; S.screen = "stage"; api.render();
click('[data-action="ready"][data-id="1"]');
await wait();
S.data[api.activeRole()].ready[1] = false; api.publishProgress();
S.data[api.activeRole()].ready[1] = true; api.publishProgress();

// partner announces presence, then a stage pointer
w.__client.__emit(api.pairBase() + "/p/g", "1");
w.__client.__emit(api.pairBase() + "/u/g", "1");
await wait();

// ---- Assertions ----
const secrets = {
  "own name": "Jessica", "partner name": "Jonathan", "gender": "woman", "gender (b)": "man",
  "pronouns": "she", "pronouns (b)": "he", "orientation": "queer", "orientation (b)": "straight",
  "relationship structure": "monogamous", "reflection chip (good)": "Eye contact",
  "reflection chip (good 2)": "Feeling safe", "reflection chip (more)": "Softer touch",
  "private note": "anxious", "raw pair code": code,
};
const blob = JSON.stringify(sent);
const fails = [];
for (const [label, v] of Object.entries(secrets)) {
  if (blob.toLowerCase().includes(String(v).toLowerCase())) fails.push(`LEAK: ${label} ("${v}") found on the wire`);
}
const retained = sent.filter((m) => m.retain);
if (retained.length) fails.push(`retain:true on ${retained.length} publish(es): ${JSON.stringify(retained)}`);
if (w.__client.__will.retain) fails.push("last-will is retained");
const badPayload = sent.filter((m) => !/^[01]$|^[0-6]$/.test(m.payload));
if (badPayload.length) fails.push("payload is not a single digit: " + JSON.stringify(badPayload));
const topics = [...new Set(sent.map((m) => m.topic))];
if (topics.some((t) => t.includes(code))) fails.push("pair code appears in a topic");
if (S.partnerStage !== 1) fails.push("partner pointer not applied (got " + S.partnerStage + ")");
if (api.maxUnlocked() !== 2) fails.push("consent gate did not open with both pointers at 1 (got " + api.maxUnlocked() + ")");

console.log("pair code (never transmitted):", code);
console.log("\nEVERY publish the app made:");
for (const m of sent) console.log(`  ${m.topic}  payload=${JSON.stringify(m.payload)}  retain=${m.retain}`);
console.log("\nlast-will:", JSON.stringify(w.__client.__will));
console.log("subscriptions:", JSON.stringify(subs));
console.log("distinct topics:", JSON.stringify(topics));
console.log("\ntotal bytes of payload ever sent:", sent.reduce((n, m) => n + m.payload.length, 0));
console.log(fails.length ? "\n*** FAIL ***\n" + fails.join("\n") : "\nAll wire assertions passed.");
process.exit(fails.length ? 1 : 0);
