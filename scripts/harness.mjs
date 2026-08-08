/* Shared test harness: boot www/index.html in jsdom as a "phone", with a
   recording MQTT client wired to an in-process broker.

   The broker here is deliberately dumb and deliberately hostile-capable: it
   records EVERY byte published, exactly as the real public relay would see
   it. Tests assert against that recording, not against what the app says it
   sends. */
import fs from "node:fs";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

const HTML = new URL("../www/index.html", import.meta.url).pathname;

/* An in-process MQTT broker. Same routing rules as the real one (topic
   filters with a trailing "+"), and it keeps a transcript of everything. */
export function makeBroker() {
  const clients = [];
  const wire = []; // every publish, in order, exactly as the relay sees it
  function matches(filter, topic) {
    const f = filter.split("/"), t = topic.split("/");
    if (f.length !== t.length) return false;
    return f.every((seg, i) => seg === "+" || seg === t[i]);
  }
  const broker = {
    wire,
    clients,
    /* Cut over to what a passive observer of the whole namespace collects. */
    payloadsOn(kind) { return wire.filter((m) => m.topic.split("/")[2] === kind); },
    deliver(msg) {
      wire.push(msg);
      for (const c of clients) {
        if (c.__ended) continue;
        for (const f of c.__subs) {
          if (matches(f, msg.topic)) { c.__deliver(msg.topic, msg.payload); break; }
        }
      }
    },
  };
  return broker;
}

/* mqtt.js-shaped client bound to the broker above. */
function makeClientFactory(broker, label) {
  return function connect(url, opts) {
    const handlers = {};
    const c = {
      __url: url, __will: opts.will, __subs: [], __ended: false, __label: label,
      on(ev, fn) { handlers[ev] = fn; if (ev === "connect") setTimeout(() => fn(), 0); return c; },
      subscribe(t) { c.__subs.push(t); },
      publish(topic, payload, o) {
        if (c.__ended) return;
        broker.deliver({ topic, payload: String(payload), retain: !!(o && o.retain), from: label });
      },
      end() {
        if (c.__ended) return;
        c.__ended = true;
        // A real broker fires the last will when the client drops uncleanly.
        if (c.__will) broker.deliver({ topic: c.__will.topic, payload: String(c.__will.payload), retain: !!c.__will.retain, from: label + ":will" });
      },
      __deliver(t, p) { handlers.message && handlers.message(t, Buffer.from(p)); },
    };
    broker.clients.push(c);
    return c;
  };
}

/* One phone.
   opts.noSubtle simulates a webview without WebCrypto — the app must refuse
   to pair rather than fall back to plaintext. */
export function bootPhone(broker, label, opts = {}) {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.invalid/app/", pretendToBeVisual: true });
  const w = dom.window;
  /* jsdom ships no SubtleCrypto. A real WKWebView does; the app requires one
     and refuses to pair without it (see the noSubtle case). */
  const cryptoObj = opts.noSubtle
    ? { getRandomValues: (a) => webcrypto.getRandomValues(a) }
    : webcrypto;
  Object.defineProperty(w, "crypto", { value: cryptoObj, configurable: true });
  w.mqtt = { connect: makeClientFactory(broker, label) };
  /* Anything that must exist BEFORE the app script runs — window.Capacitor,
     a stubbed StoreKit bridge — goes in here. The app decides "am I native?"
     at parse time, so setting it afterwards would be testing a different app. */
  if (typeof opts.preload === "function") opts.preload(w);

  const src = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)[1];
  w.eval(src + `
;window.__api={get S(){return S},set S(v){S=v},render,activeRole,partnerRole,publishProgress,publishState,
  pairBase,sessionId,maxUnlocked,matchFor,canMatch,myDebrief,theirDebrief,E2E,GOOD,MORE,CHIPS_FP,
  connectLive,leaveLive,onWire,stateEnvelope,PROTO_V,TOPIC_ROOT,myStagePointer,hasNewMatch,
  DECKS,PRACTICES,THEMES,STARTER,goodChips,moreChips,decksOpen,
  practicesOpen,themesOpen,applyTheme,journalAdd,setJournalOn,loadJournal};`);

  const api = w.__api;
  return {
    w, api, label,
    get S() { return api.S; },
    click(sel) { const el = w.document.querySelector(sel); if (!el) throw new Error(label + ": missing " + sel); el.click(); },
    byId(id) { return w.document.getElementById(id); },
  };
}

export const tick = (ms = 12) => new Promise((r) => setTimeout(r, ms));
/* Let the promise-driven handshake settle. */
export async function settle(n = 24) { for (let i = 0; i < n; i++) await tick(6); }

/* Wait for a CONDITION rather than a duration. The handshake is several
   promise hops plus WebCrypto, so a fixed sleep that is comfortable on an idle
   machine goes flaky the moment the box is busy — which is exactly when the
   full suite runs. Fails loudly on timeout instead of leaving a later
   assertion to report something misleading. */
export async function waitFor(cond, what, ms = 8000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (cond()) return true;
    await tick(6);
  }
  throw new Error("timed out after " + ms + "ms waiting for: " + what);
}

/* A realistic, deliberately identifying profile — if any of this reaches the
   wire in readable form, the tests must fail. */
export function seedProfile(p, self, partner) {
  const S = p.S;
  S.ack = true;
  S.profile = {
    done: true,
    people: {
      A: { name: self.name, gender: self.gender, genderCustom: "", pronouns: self.pronouns, pronounsCustom: "", orientation: self.orientation, orientationCustom: "" },
      B: { name: partner.name, gender: partner.gender, genderCustom: "", pronouns: partner.pronouns, pronounsCustom: "", orientation: partner.orientation, orientationCustom: "" },
    },
    structure: "monogamous", structureCustom: "", partnerTerm: "partner", partnerTermCustom: "", areas: "inclusive",
  };
}

/* Record a reflection the way the UI does, then let the app sync it. */
export function reflect(p, stage, good, more, note) {
  const S = p.S, role = p.api.activeRole();
  S.data[role].debrief[stage] = { good: [...good], more: [...more], note };
  S.data[role].sessions[stage] = (S.data[role].sessions[stage] || 0) + 1;
  p.api.publishState();
}

export function ok(fails, cond, msg) { if (!cond) fails.push(msg); return cond; }
/* The app keeps a 1s interval running, so an explicit exit is what ends the
   process — never leave it to jsdom to go quiet. */
export function report(name, fails) {
  if (fails.length) {
    console.log(`\n*** ${name}: FAIL ***`);
    for (const f of fails) console.log("  - " + f);
    process.exit(1);
  }
  console.log(`\n${name}: all assertions passed.`);
  process.exit(0);
}
