/* END-TO-END CRYPTO TEST — run with `npm run test:crypto`.
   -----------------------------------------------------------------
   The privacy audit proves nothing readable reaches the wire. This proves
   the link actually resists an attacker who owns the relay:

     1  two honest phones agree on the same key and the same safety word
     2  an attacker who owns the relay but does NOT know the pair code cannot
        complete the handshake, and the victim publishes nothing to it
     3  an attacker who DOES know the pair code and relays between the two
        phones cannot make their safety words agree — which is what the
        safety word is for
     4  a replayed message is rejected (stale state cannot be forced back)
     5  a message replayed onto the other side's topic is rejected
     6  a single flipped bit of ciphertext is rejected outright
     7  without WebCrypto the app REFUSES to pair rather than send plaintext

   These are assertions about behaviour, driven through the real app code —
   not about what the comments claim. */
import { webcrypto } from "node:crypto";
import { makeBroker, bootPhone, settle, waitFor, seedProfile, reflect, ok, report } from "./harness.mjs";

const fails = [];
const A = { name: "Jessica", gender: "woman", pronouns: "she", orientation: "queer" };
const B = { name: "Jonathan", gender: "man", pronouns: "he", orientation: "straight" };

/* Pair two phones over a broker and return them, confirmed. */
async function pairUp(broker, tagA = "host", tagB = "guest") {
  const host = bootPhone(broker, tagA), guest = bootPhone(broker, tagB);
  seedProfile(host, A, B); seedProfile(guest, B, A);
  host.S.screen = "pairing"; host.S.pairPhase = "choose"; host.api.render();
  host.click('[data-action="pair-create"]');
  await settle();
  const code = host.S.code;
  host.click('[data-action="enter-app-host"]');
  guest.S.screen = "pairing"; guest.S.pairPhase = "join"; guest.api.render();
  guest.byId("joincode").value = code;
  guest.click('[data-action="do-join"]');
  await waitFor(() => host.S.pairSecure && guest.S.pairSecure, "both phones to confirm the encrypted link");
  return { host, guest, code };
}

/* ---------- 1. Honest pairing ---------- */
{
  const broker = makeBroker();
  const { host, guest } = await pairUp(broker);
  ok(fails, host.S.pairSecure && guest.S.pairSecure, "1: honest pairing did not confirm on both phones");
  ok(fails, host.S.pairSafety === guest.S.pairSafety, "1: safety words differ between two honest phones");
  ok(fails, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(host.S.pairSafety), `1: safety word is not readable (${host.S.pairSafety})`);
  console.log("1  honest pairing confirmed; shared safety word:", host.S.pairSafety);
}

/* ---------- 2. Relay-owning attacker WITHOUT the pair code ---------- */
{
  const broker = makeBroker();
  const host = bootPhone(broker, "victim");
  seedProfile(host, A, B);
  host.S.screen = "pairing"; host.S.pairPhase = "choose"; host.api.render();
  host.click('[data-action="pair-create"]');
  await settle();
  host.click('[data-action="enter-app-host"]');
  reflect(host, 1, ["Eye contact", "Feeling safe"], ["Softer touch"], "private");
  await settle();

  const base = host.api.pairBase();
  const before = broker.wire.length;

  /* The attacker sees the topic (it owns the relay) and can publish anything.
     It just doesn't know the pair code. */
  const kp = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const rawPub = Buffer.from(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  broker.deliver({ topic: base + "/k/g", payload: b64u(rawPub), retain: false, from: "attacker" });
  await settle();
  // …plus a forged confirmation tag, guessed 8 different ways.
  for (let i = 0; i < 8; i++) {
    broker.deliver({ topic: base + "/c/g", payload: b64u(Buffer.from(webcrypto.getRandomValues(new Uint8Array(16)))), retain: false, from: "attacker" });
  }
  await settle();

  ok(fails, !host.S.pairSecure, "2: the victim confirmed an encrypted link with an attacker that had no pair code");
  const victimSent = broker.wire.slice(before).filter((m) => m.from === "victim");
  const cipherSent = victimSent.filter((m) => m.topic.split("/")[2] === "m");
  ok(fails, cipherSent.length === 0, `2: the victim published ${cipherSent.length} encrypted state message(s) to an unconfirmed peer`);
  ok(fails, Object.keys(host.S.partnerDebrief).length === 0, "2: the victim accepted reflections from an unconfirmed peer");
  console.log(`2  attacker without the pair code: handshake refused, ${cipherSent.length} state messages leaked to it`);
}

/* ---------- 3. Attacker WITH the pair code, relaying in the middle ----------
   This attacker can complete a handshake with each phone separately — that is
   inherent, and exactly why the safety word exists. Assert that it cannot make
   the two phones show the same word. */
{
  const broker = makeBroker();
  const phoneH = bootPhone(broker, "h"), phoneG = bootPhone(broker, "g");
  const midToH = bootPhone(broker, "m1"), midToG = bootPhone(broker, "m2");
  const code = "RTT77MH4JN";
  const sid = phoneH.api.sessionId(code);
  const pubH = await phoneH.api.E2E.begin(sid);
  const pubG = await phoneG.api.E2E.begin(sid);
  const pubM1 = await midToH.api.E2E.begin(sid);
  const pubM2 = await midToG.api.E2E.begin(sid);

  // The attacker terminates each side with its own key.
  await phoneH.api.E2E.derive(pubM1, code, "h");
  await midToH.api.E2E.derive(pubH, code, "g");
  await phoneG.api.E2E.derive(pubM2, code, "g");
  await midToG.api.E2E.derive(pubG, code, "h");

  const sasH = phoneH.api.E2E.safety(), sasG = phoneG.api.E2E.safety();
  ok(fails, sasH === midToH.api.E2E.safety(), "3: attacker's own half-handshake did not agree (test is broken)");
  ok(fails, sasH !== sasG, "3: a code-knowing relay attacker produced the SAME safety word on both phones — the SAS is not transcript-bound");

  // And an honest pairing over the same code must still agree, so the check is meaningful.
  const honestH = bootPhone(broker, "hh"), honestG = bootPhone(broker, "gg");
  const hp = await honestH.api.E2E.begin(sid), gp = await honestG.api.E2E.begin(sid);
  await honestH.api.E2E.derive(gp, code, "h");
  await honestG.api.E2E.derive(hp, code, "g");
  ok(fails, honestH.api.E2E.safety() === honestG.api.E2E.safety(), "3: honest pairing over the same code disagreed");
  console.log(`3  code-knowing relay attack: phones show ${sasH} vs ${sasG} — visibly different`);
}

/* ---------- 4 / 5 / 6. Replay, cross-side replay, tampering ---------- */
{
  const broker = makeBroker();
  const { host, guest } = await pairUp(broker);
  const role = host.api.activeRole();

  host.S.data[role].ready[1] = true; host.api.publishProgress();
  await settle();
  ok(fails, guest.S.partnerStage === 1, "4: setup — guest did not see stage 1");
  const staleMsg = broker.wire.filter((m) => m.topic.endsWith("/m/h")).slice(-1)[0];

  host.S.data[role].ready[1] = false; host.api.publishProgress();
  await settle();
  ok(fails, guest.S.partnerStage === 0, `4: setup — guest did not see the un-confirm (got ${guest.S.partnerStage})`);

  // 4. Replay the stale "I am ready" message.
  broker.deliver({ ...staleMsg, from: "attacker-replay" });
  await settle();
  ok(fails, guest.S.partnerStage === 0, "4: a replayed message rolled the guest's view of consent BACK to ready");
  console.log("4  replayed stale consent message: rejected");

  // 5. Replay a host message onto the guest's topic (wrong sender in the AAD).
  const before5 = host.S.partnerStage;
  broker.deliver({ topic: host.api.pairBase() + "/m/g", payload: staleMsg.payload, retain: false, from: "attacker-reflect" });
  await settle();
  ok(fails, host.S.partnerStage === before5, "5: a message reflected onto the other side's topic was accepted");
  console.log("5  message reflected onto the other side's topic: rejected");

  // 6. Flip one bit of a fresh ciphertext.
  host.S.data[role].ready[1] = true; host.api.publishProgress();
  await settle();
  const fresh = broker.wire.filter((m) => m.topic.endsWith("/m/h")).slice(-1)[0];
  guest.S.partnerStage = 0;
  const chars = fresh.payload.split("");
  chars[chars.length - 3] = chars[chars.length - 3] === "A" ? "B" : "A";
  broker.deliver({ topic: fresh.topic, payload: chars.join(""), retain: false, from: "attacker-tamper" });
  await settle();
  ok(fails, guest.S.partnerStage === 0, "6: a tampered ciphertext was accepted");
  console.log("6  ciphertext with one flipped character: rejected");
}

/* ---------- 7. No WebCrypto → no pairing, and no plaintext fallback ---------- */
{
  const broker = makeBroker();
  const phone = bootPhone(broker, "old-webview", { noSubtle: true });
  seedProfile(phone, A, B);
  phone.S.screen = "pairing"; phone.S.pairPhase = "choose"; phone.api.render();
  phone.click('[data-action="pair-create"]');
  await settle();
  ok(fails, phone.S.mode !== "live", `7: a device without WebCrypto entered live mode anyway (mode=${phone.S.mode})`);
  ok(fails, broker.wire.length === 0, `7: a device without WebCrypto published ${broker.wire.length} message(s)`);
  console.log("7  device without WebCrypto: refused to pair, published nothing");
}

report("end-to-end crypto test", fails);
