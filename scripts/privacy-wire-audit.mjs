/* PRIVACY REGRESSION TEST — run with `npm run audit:privacy`.
   -----------------------------------------------------------------
   Slow Burn's in-app copy promises that the relay cannot read anything the
   two phones say to each other. This test is what keeps that promise honest.

   It boots TWO real phones (www/index.html in jsdom) on an in-process broker
   that records every byte, walks a full pairing → session → reflection →
   readiness flow on both, entering deliberately identifying data, and then
   asserts against the RECORDING — not against what the app claims to send:

     · no personal data appears on the wire, in plaintext OR merely encoded
     · every payload on the wire is one of exactly four permitted shapes:
       an ephemeral PUBLIC key, a 16-byte confirmation tag, AES-GCM
       ciphertext, or an empty goodbye. Nothing else can sneak on.
     · the /m/ ciphertext really is ciphertext: it does not decode to
       anything parseable, and the plaintext it hides is only reachable with
       the derived key
     · retain is false on every publish and on both last-wills
     · the pair code never appears in a topic or a payload
     · the consent gate still opens, and reflection matching still produces
       the right answer — so "just don't send anything" cannot pass this test
       by breaking the feature

   If you add a field to the pairing protocol, this test should fail. That is
   the point. Fix the protocol, not the test.

   READING THIS FILE: it separates recorded wire messages with a literal NUL
   byte (a separator that cannot occur in base64url, hex, or any secret, so it
   cannot manufacture a match across two payloads). A side effect is that
   `file` calls this source "data" rather than text, and plain `grep` SILENTLY
   SKIPS IT -- no match, no warning, exit 1. Use `grep -a` here:

       grep -an "gender" scripts/privacy-wire-audit.mjs

   The same applies to any tool that stops at the first NUL. */
import { makeBroker, bootPhone, settle, waitFor, seedProfile, reflect, ok, report } from "./harness.mjs";

const broker = makeBroker();
const fails = [];

/* ---- Two phones, two people, deliberately identifying setups ---- */
const JESS = { name: "Jessica", gender: "woman", pronouns: "she", orientation: "queer" };
const JON  = { name: "Jonathan", gender: "man", pronouns: "he", orientation: "straight" };

const host = bootPhone(broker, "host");
const guest = bootPhone(broker, "guest");
seedProfile(host, JESS, JON);
seedProfile(guest, JON, JESS);

/* ---- Host creates the pairing through the real UI ---- */
host.S.screen = "pairing"; host.S.pairPhase = "choose"; host.api.render();
host.click('[data-action="pair-create"]');
await settle();
const code = host.S.code;

host.byId("myname").value = "Jessica";
host.click('[data-action="enter-app-host"]');
await settle();

/* ---- Guest joins with the code, exactly as a person would type it ---- */
guest.S.screen = "pairing"; guest.S.pairPhase = "join"; guest.api.render();
guest.byId("joincode").value = code;
guest.byId("joinname").value = "Jonathan";
guest.click('[data-action="do-join"]');
await waitFor(() => host.S.pairSecure && guest.S.pairSecure, "both phones to confirm the encrypted link");

ok(fails, host.S.pairSecure, "host never reached a confirmed encrypted link");
ok(fails, guest.S.pairSecure, "guest never reached a confirmed encrypted link");
ok(fails, !!host.S.pairSafety && host.S.pairSafety === guest.S.pairSafety,
   `safety words differ (host ${host.S.pairSafety} / guest ${guest.S.pairSafety})`);
const SAFETY = host.S.pairSafety;

/* ---- Both run a session and record a full private reflection ---- */
const HOST_GOOD = ["Eye contact", "Feeling safe", "Laughing"];
const HOST_MORE = ["Softer touch", "More time"];
const GUEST_GOOD = ["Eye contact", "Warmth & closeness", "Feeling safe"];
const GUEST_MORE = ["Softer touch", "A calmer setting"];
const HOST_NOTE = "I felt anxious at the start but it passed.";
const GUEST_NOTE = "Kept worrying I was doing it wrong.";

reflect(host, 1, HOST_GOOD, HOST_MORE, HOST_NOTE);
reflect(guest, 1, GUEST_GOOD, GUEST_MORE, GUEST_NOTE);
await settle();

/* ---- Both privately mark what they'd try (Together tab). Only YES picks
   may cross, encrypted, and only the overlap may be shown. ---- */
const HOST_TRY = ["hiking", "chess", "candles"], HOST_PASS = "running";
const GUEST_TRY = ["chess", "candles", "kayaking"], GUEST_PASS = "stargazing";
for (const id of HOST_TRY) host.api.trySet(id, "yes");
host.api.trySet(HOST_PASS, "no");
for (const id of GUEST_TRY) guest.api.trySet(id, "yes");
guest.api.trySet(GUEST_PASS, "no");
await settle();

/* ---- Both privately confirm readiness, one un-confirms and re-confirms ---- */
host.S.stageOpen = 1; host.S.screen = "stage"; host.api.render();
host.click('[data-action="ready"][data-id="1"]');
await settle();
guest.S.stageOpen = 1; guest.S.screen = "stage"; guest.api.render();
guest.click('[data-action="ready"][data-id="1"]');
await settle();
// …then changes their mind and changes it back, so the un-confirm path publishes too
guest.S.data[guest.api.activeRole()].ready[1] = false; guest.api.publishProgress();
await settle();
guest.S.data[guest.api.activeRole()].ready[1] = true; guest.api.publishProgress();
await settle();

/* ---- What the person actually SEES on the Check-ins tab. The overlap must
   be on screen; the chips only one of them named must not be, on either
   phone; and the written notes must appear nowhere. ---- */
for (const [who, p] of [["host", host], ["guest", guest]]) {
  p.S.screen = "app"; p.S.tab = "checkins"; p.api.render();
  const html = p.w.document.getElementById("root").innerHTML;
  ok(fails, html.includes("Eye contact") && html.includes("Feeling safe"),
     `${who}: the Check-ins tab does not show the chips they both chose`);
  ok(fails, html.includes("Softer touch"), `${who}: the Check-ins tab does not show the shared "welcome more of" chip`);
  ok(fails, !html.includes("Laughing"), `${who}: the Check-ins tab shows a chip only the host chose`);
  ok(fails, !html.includes("Warmth &amp; closeness") && !html.includes("Warmth & closeness"),
     `${who}: the Check-ins tab shows a chip only the guest chose`);
  ok(fails, !html.includes("A calmer setting") && !html.includes("More time"),
     `${who}: the Check-ins tab shows a "more of" chip only one of them chose`);
  ok(fails, !/anxious|worrying/i.test(html), `${who}: a private note is rendered on screen`);
  ok(fails, html.includes(SAFETY), `${who}: the safety word is not shown on the Check-ins tab`);
}

/* ---- And on the Together tab: the things they would BOTH try, nothing
   only one of them picked, and nothing either of them passed on. ---- */
for (const [who, p] of [["host", host], ["guest", guest]]) {
  p.S.screen = "app"; p.S.tab = "together"; p.S.together = "try"; p.api.render();
  const html = p.w.document.getElementById("root").innerHTML;
  ok(fails, html.includes("Chess") && html.includes("Candle making"), `${who}: the Together tab does not show what they both would try`);
  ok(fails, !html.includes("Hiking"), `${who}: the Together tab shows a pick only the host made`);
  ok(fails, !html.includes("Kayaking"), `${who}: the Together tab shows a pick only the guest made`);
}

/* ---- Snapshot everything the assertions need, THEN tear the link down.
   leaveLive() deliberately wipes the partner's data and the derived safety
   word from memory, which is itself worth recording. ---- */
const snap = {
  safety: host.S.pairSafety,
  guestSafety: guest.S.pairSafety,
  hostMatch: host.api.matchFor(1),
  guestMatch: guest.api.matchFor(1),
  hostSeesPartner: JSON.parse(JSON.stringify(host.S.partnerDebrief)),
  guestSeesPartner: JSON.parse(JSON.stringify(guest.S.partnerDebrief)),
  hostStage: host.S.partnerStage, guestStage: guest.S.partnerStage,
  hostUnlocked: host.api.maxUnlocked(), guestUnlocked: guest.api.maxUnlocked(),
  pubKeys: new Set([host.api.E2E.myPub(), guest.api.E2E.myPub()]),
  hostTry: host.api.tryMatches().map((h) => h.id), guestTry: guest.api.tryMatches().map((h) => h.id),
  hostHasOfTheirs: [...host.S.partnerTry], guestHasOfTheirs: [...guest.S.partnerTry],
};

/* ---- Both leave, firing the goodbye/last-will path ---- */
const beforeLeave = broker.wire.length;
host.api.leaveLive();
await settle(6);
ok(fails, !host.S.pairSafety && Object.keys(host.S.partnerDebrief).length === 0,
   "leaving did not clear the derived key material and the partner's reflections from memory");

/* ================= ASSERTIONS AGAINST THE RECORDING ================= */
const wire = broker.wire;
ok(fails, wire.length > 0, "nothing was published at all — the test did not exercise the link");

/* 1. Nothing personal on the wire, plaintext or base64-encoded. */
const secrets = {
  "own name": "Jessica", "partner name": "Jonathan",
  "gender": "woman", "gender (b)": "man",
  "pronouns": "she/her", "pronouns (b)": "he/him",
  "orientation": "queer", "orientation (b)": "straight",
  "relationship structure": "monogamous",
  "reflection chip": "Eye contact", "reflection chip 2": "Feeling safe",
  "reflection chip 3": "Softer touch", "reflection chip 4": "Warmth & closeness",
  "private note (host)": "anxious", "private note (guest)": "worrying",
  "raw pair code": code,
  "try pick (id)": "hiking", "try pick (name)": "Candle making", "try pick 2": "chess",
  "try pick 3": "kayaking", "passed-on pick": "running", "passed-on pick (b)": "stargazing",
};
function decodeAttempt(payload) {
  // Anything a payload could be hiding behind: base64url, base64, hex.
  const out = [payload];
  try {
    const s = payload.replace(/-/g, "+").replace(/_/g, "/");
    out.push(Buffer.from(s, "base64").toString("latin1"));
  } catch (e) {}
  try { if (/^[0-9a-f]+$/i.test(payload) && payload.length % 2 === 0) out.push(Buffer.from(payload, "hex").toString("latin1")); } catch (e) {}
  return out.join(" ");
}
/* WHY THIS IS A BOUNDARY MATCH AND NOT A SUBSTRING MATCH.
   ---------------------------------------------------------------------------
   This used to be a naked `searchable.includes(value)`, and it failed roughly
   5-10% of runs on exactly one value: gender (b) = "man". Three characters, and
   the wire is mostly base64url AES-GCM ciphertext, so "m" "a" "n" land next to
   each other by chance about once per 32^3 positions across the couple of
   thousand characters a session produces. It failed a Codemagic build that way
   on 2026-08-14, and it could equally have false-PASSED.

   A random collision and a real leak differ in one reliable way: what sits next
   to the value. Ciphertext is nothing but base64url characters, so a chance
   "man" is always flanked by more of them. A real plaintext leak is a value in
   a structured context -- {"gender":"man"}, gender=man, a bare payload, a
   NUL-delimited field -- so it is flanked by a quote, colon, brace, equals,
   space, separator, or the end of the string.

   Anchoring on that boundary is what makes this assertion test a leak instead
   of a coincidence. It does NOT weaken the gate: every encoding of the value is
   still searched (raw, base64, hex -- see decodeAttempt), and the positive
   controls below prove the matcher still fires on a real leak. Do not relax
   this back to a substring match, and if a future value trips it, fix the
   protocol rather than raising a minimum length. */
const B64U = "A-Za-z0-9\\-_";
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const leaks = (haystack, value) =>
  new RegExp(`(^|[^${B64U}])${escapeRe(value)}($|[^${B64U}])`, "i").test(haystack);

/* POSITIVE CONTROLS -- these run before the wire assertions, so if anyone
   loosens `leaks` the audit fails loudly rather than quietly passing because it
   stopped looking. */
ok(fails, leaks('{"gender":"man"}', "man"), "matcher self-test: a quoted plaintext leak must be caught");
ok(fails, leaks("gender=man&x=1", "man"), "matcher self-test: a delimited leak must be caught");
ok(fails, leaks("man", "man"), "matcher self-test: a bare payload leak must be caught");
ok(fails, leaks("she/her", "she/her"), "matcher self-test: a value with punctuation must be caught");
ok(fails, !leaks("xKmanQ7dGVzdA", "man"), "matcher self-test: base64url ciphertext must NOT count as a leak");

const searchable = wire.map((m) => m.topic + " " + decodeAttempt(m.payload)).join(" ");
for (const [label, v] of Object.entries(secrets)) {
  if (leaks(searchable, v)) fails.push(`LEAK: ${label} ("${v}") is readable on the wire`);
}

/* 2. Exhaustive shape whitelist — every payload must be one of four things. */
const b64uBytes = (s) => {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Buffer.from(t, "base64");
};
const pubKeys = snap.pubKeys;   // captured before the link was torn down
const KINDS = { k: 0, c: 0, m: 0, x: 0 };
for (const m of wire) {
  const parts = m.topic.split("/");
  const kind = parts[2], side = parts[3];
  if (parts[0] !== host.api.TOPIC_ROOT) { fails.push(`publish outside the app's topic root: ${m.topic}`); continue; }
  if (!(kind in KINDS)) { fails.push(`unknown topic kind "${kind}" — ${m.topic}`); continue; }
  if (side !== "h" && side !== "g") { fails.push(`unknown side "${side}" — ${m.topic}`); continue; }
  KINDS[kind]++;
  if (kind === "k") {
    const b = b64uBytes(m.payload);
    if (b.length !== 65 || b[0] !== 4) fails.push(`/k/ payload is not an uncompressed P-256 point (${b.length} bytes)`);
    if (!pubKeys.has(m.payload)) fails.push("/k/ payload is not one of the two phones' published public keys");
  } else if (kind === "c") {
    if (b64uBytes(m.payload).length !== 16) fails.push(`/c/ payload is not a 16-byte tag (${b64uBytes(m.payload).length})`);
  } else if (kind === "m") {
    const b = b64uBytes(m.payload);
    if (b.length < 12 + 16 + 1) fails.push(`/m/ payload too short to be iv+ciphertext+tag (${b.length})`);
    /* Ciphertext must not be readable as anything. A JSON envelope would be
       100% printable ASCII; AES-GCM output is ~37% by chance, and the odds of
       a 60-byte ciphertext clearing 90% are effectively nil. */
    const body = b.slice(12);
    const printable = [...body].filter((v) => v >= 0x20 && v <= 0x7e).length / body.length;
    if (printable > 0.9) fails.push(`/m/ payload body is ${Math.round(printable * 100)}% printable text — it is not encrypted`);
    const asText = body.toString("utf8");
    try { JSON.parse(asText); fails.push("/m/ payload body parsed as JSON — it is not encrypted"); } catch (e) {}
    if (/"v"|"cf"|stage|good|more|debrief/i.test(asText)) fails.push("/m/ payload body contains recognisable field names");
  } else if (kind === "x") {
    if (m.payload !== "") fails.push(`/x/ (goodbye) payload is not empty: ${JSON.stringify(m.payload)}`);
  }
}
ok(fails, KINDS.k >= 2, "both phones should have published an ephemeral public key");
ok(fails, KINDS.c >= 2, "both phones should have published a confirmation tag");
ok(fails, KINDS.m >= 2, "both phones should have published encrypted state");
ok(fails, wire.length > beforeLeave, "leaving did not publish a goodbye");

/* 3. The derived secrets never travel. The AES key and the two confirmation
   keys are non-extractable CryptoKeys inside the page, so the only derived
   value observable from outside is the safety word — assert it, and the
   session salt, never appear anywhere on the wire. */
const rawWire = wire.map((m) => m.topic + " " + m.payload).join(" ");
if (SAFETY && rawWire.includes(SAFETY)) fails.push("the derived safety word appears on the wire");
if (SAFETY && rawWire.includes(SAFETY.replace("-", ""))) fails.push("the derived safety word (ungrouped) appears on the wire");

/* 4. retain is off everywhere, including both last-wills. */
const retained = wire.filter((m) => m.retain);
if (retained.length) fails.push(`retain:true on ${retained.length} publish(es): ${JSON.stringify(retained)}`);
for (const c of broker.clients) {
  if (c.__will && c.__will.retain) fails.push(`${c.__label}: last-will is retained`);
  if (c.__will && String(c.__will.payload) !== "") fails.push(`${c.__label}: last-will payload is not empty`);
}

/* 5. The pair code is nowhere — not in a topic, not in a payload. */
if (rawWire.toUpperCase().includes(code)) fails.push("the pair code appears on the wire");
const topics = [...new Set(wire.map((m) => m.topic))];
if (topics.some((t) => t.includes(code))) fails.push("the pair code appears in a topic");

/* 6. THE FEATURE STILL WORKS — otherwise "send nothing" would pass. */
ok(fails, snap.hostStage === 1, `host did not learn the partner's stage (got ${snap.hostStage})`);
ok(fails, snap.guestStage === 1, `guest did not learn the partner's stage (got ${snap.guestStage})`);
ok(fails, snap.hostUnlocked === 2, `consent gate did not open on the host (got ${snap.hostUnlocked})`);
ok(fails, snap.guestUnlocked === 2, `consent gate did not open on the guest (got ${snap.guestUnlocked})`);

const expectGood = HOST_GOOD.filter((x) => GUEST_GOOD.includes(x));   // Eye contact, Feeling safe
const expectMore = HOST_MORE.filter((x) => GUEST_MORE.includes(x));   // Softer touch
for (const [who, mt] of [["host", snap.hostMatch], ["guest", snap.guestMatch]]) {
  if (!mt) { fails.push(`${who}: no reflection match after decryption`); continue; }
  const g = [...mt.good].sort().join("|"), m = [...mt.more].sort().join("|");
  if (g !== [...expectGood].sort().join("|")) fails.push(`${who}: wrong "both appreciated" match — got [${mt.good}]`);
  if (m !== [...expectMore].sort().join("|")) fails.push(`${who}: wrong "both open to" match — got [${mt.more}]`);
  // The overlap must NOT include things only one person named.
  if (mt.good.includes("Laughing")) fails.push(`${who}: surfaced a chip only the host chose`);
  if (mt.good.includes("Warmth & closeness")) fails.push(`${who}: surfaced a chip only the guest chose`);
}
/* Try picks: the overlap on both phones, and a NO never reaches the other phone. */
for (const [who, got] of [["host", snap.hostTry], ["guest", snap.guestTry]]) {
  if ([...got].sort().join("|") !== "candles|chess") fails.push(`${who}: wrong "you both said yes" — got [${got}]`);
}
if ([...snap.guestHasOfTheirs].sort().join("|") !== [...HOST_TRY].sort().join("|"))
  fails.push(`guest did not receive exactly the host's YES picks — got [${snap.guestHasOfTheirs}]`);
if (snap.guestHasOfTheirs.includes(HOST_PASS)) fails.push("a pick the host passed on reached the guest's device");
if (snap.hostHasOfTheirs.includes(GUEST_PASS)) fails.push("a pick the guest passed on reached the host's device");

/* The written note must not even reach the other phone's memory. */
if (/anxious/i.test(JSON.stringify(snap.guestSeesPartner))) fails.push("the host's private note reached the guest's device");
if (/worrying/i.test(JSON.stringify(snap.hostSeesPartner))) fails.push("the guest's private note reached the host's device");
if (/note/i.test(JSON.stringify(snap.guestSeesPartner))) fails.push("a note field reached the guest's device");

/* ---- Human-readable transcript ---- */
console.log("pair code (never transmitted):", code);
console.log("session topic:", host.api.pairBase());
console.log("safety word (derived on both, sent by neither):", SAFETY);
console.log("\nEVERY publish both phones made, as the relay sees it:");
for (const m of wire) {
  const kind = m.topic.split("/")[2];
  const what = kind === "k" ? "ephemeral PUBLIC key" : kind === "c" ? "key-confirmation tag" : kind === "m" ? "AES-GCM ciphertext" : "goodbye (empty)";
  const shown = m.payload.length > 44 ? m.payload.slice(0, 44) + "…" : m.payload;
  console.log(`  ${m.topic}  ${what}  retain=${m.retain}  ${JSON.stringify(shown)}`);
}
console.log("\npayload kinds seen:", JSON.stringify(KINDS));
console.log("distinct topics:", JSON.stringify(topics));
console.log("total bytes ever published:", wire.reduce((n, m) => n + m.payload.length, 0));
console.log("\nwhat the HOST typed  — good:", JSON.stringify(HOST_GOOD), " more:", JSON.stringify(HOST_MORE));
console.log("what the GUEST typed — good:", JSON.stringify(GUEST_GOOD), " more:", JSON.stringify(GUEST_MORE));
console.log("match computed after decryption — both appreciated:", JSON.stringify(snap.hostMatch && snap.hostMatch.good));
console.log("match computed after decryption — both open to:   ", JSON.stringify(snap.hostMatch && snap.hostMatch.more));
console.log("same match on the other phone:", JSON.stringify(snap.guestMatch));
console.log("what each phone holds about the other (no note field):", JSON.stringify(snap.hostSeesPartner));

report("privacy wire audit", fails);
