/* TOGETHER TAB TEST — run with `npm run test:together`.
   -----------------------------------------------------------------
   The Together tab (1.1) has two halves: TALK, conversation cards drawn
   without repeats, and TRY, where each person privately marks what they would
   try and only the overlap is shown. The privacy wire audit already proves
   what crosses between two paired phones; this suite proves the rest:

     1. the content keeps its contracts — ids unique, the Try list's frozen
        prefix and fingerprint unchanged, three steps per hobby, no links,
        no shop, no price, no paywall wording, After Dark marked adult
     2. every deck and every hobby is reachable — nothing is gated
     3. shared device: only what BOTH people said yes to is shown, never a
        pick only one of them made; solo shows your own list
     4. Talk draws without repeating until a deck is done, then reshuffles
     5. After Dark asks first, and shows no card until it has
     6. a 1.0 partner (no Try fields) and a different list version are never
        compared, and bad indexes from the wire are dropped
     7. on-device storage survives corrupt data, drops unknown ids, and
        Reset clears it */
import { makeBroker, bootPhone, seedProfile, ok, report } from "./harness.mjs";

const fails = [];
const broker = makeBroker();
const p = bootPhone(broker, "phone");
const api = p.api;
const html = () => p.w.document.getElementById("root").innerHTML;
const click = (sel) => p.click(sel);

/* ---------- 1. Content contracts ---------- */
const { TALK, TRY } = api;
ok(fails, TALK.length === 7, `1: expected 7 Talk decks, got ${TALK.length}`);
const cardCount = TALK.reduce((n, d) => n + d.cards.length, 0);
ok(fails, cardCount === 280, `1: expected 280 Talk cards, got ${cardCount}`);
ok(fails, new Set(TALK.map((d) => d.id)).size === TALK.length, "1: duplicate Talk deck id");
ok(fails, TALK.filter((d) => d.adult).map((d) => d.id).join() === "afterdark", "1: After Dark must be the one adult deck");
for (const d of TALK) for (const c of d.cards) {
  ok(fails, Array.isArray(c) && c.length === 2 && c[0] && c[1], `1: malformed card in ${d.id}`);
}
ok(fails, TRY.length >= 30, `1: the Try list lost entries (${TRY.length})`);
ok(fails, api.TRY_FROZEN === 30, "1: TRY_FROZEN changed — it is the 1.1 wire contract");
ok(fails, new Set(TRY.map((h) => h.id)).size === TRY.length, "1: duplicate Try id");
/* The fingerprint two phones compare. Changing it silently stops every
   couple matching mid-rollout; append to TRY instead. */
ok(fails, api.TRY_FP === "8fd5bf0b" || process.env.PRINT_FP, `1: TRY_FP changed (now ${api.TRY_FP})`);
for (const h of TRY) {
  ok(fails, h.steps.length === 3, `1: ${h.id} must have exactly three steps`);
  ok(fails, h.name && h.emoji && h.line && h.together, `1: ${h.id} is missing a field`);
  ok(fails, ["in", "out", "both"].includes(h.where), `1: ${h.id} has an unknown where`);
}
const allText = JSON.stringify(TALK) + JSON.stringify(TRY);
ok(fails, !/https?:|www\.|amazon|youtube/i.test(allText), "1: Together content contains a link or a shop");
for (const [label, re] of [["subscription", /\bsubscri/i], ["upgrade", /\bupgrade\b/i], ["premium", /\bpremium\b/i],
  ["purchase", /\bpurchase\b/i], ["paywall", /\bpaywall\b/i], ["pro flag", /"pro"\s*:/]]) {
  ok(fails, !re.test(allText), `1: Together content contains ${label} wording`);
}

/* ---------- 2. Everything is reachable ---------- */
seedProfile(p, { name: "Sam", gender: "nonbinary", pronouns: "they", orientation: "queer" },
                { name: "Rae", gender: "woman", pronouns: "she", orientation: "queer" });
p.S.mode = "shared"; p.S.view = "A"; p.S.screen = "app"; p.S.tab = "talk";
api.render();
/* 1.1 redesign: Talk and Try are tabs of their own, and Home links to both —
   the new features must never again sit behind a toggle on a fourth tab. */
ok(fails, !!p.w.document.querySelector('.tabs [data-tab="talk"]') && !!p.w.document.querySelector('.tabs [data-tab="try"]'),
   "2: Talk and Try are not both in the tab bar");
p.S.tab = "today"; api.render();
ok(fails, !!p.w.document.querySelector('.tiles [data-tab="talk"]') && !!p.w.document.querySelector('.tiles [data-tab="try"]'),
   "2: Home does not link straight to Talk and Try");
const homeCard = p.w.document.querySelector(".deal .deal-text");
ok(fails, !!homeCard && TALK.some((d) => !d.adult && d.cards.some((c) => homeCard.textContent === c[1])),
   "2: Home does not show a live conversation card from an everyday deck");
p.click('[data-action="home-card-next"]');
ok(fails, !!p.w.document.querySelector(".deal .deal-text"), "2: Another one did not deal a new card on Home");
p.S.tab = "talk"; api.render();
for (const d of TALK) ok(fails, html().includes(`data-id="${d.id}"`), `2: deck ${d.id} is not listed`);
for (const h of TRY) {
  p.S.screen = "hobby"; p.S.hobbyOpen = h.id; api.render();
  ok(fails, html().includes(h.steps[0].replace(/’/g, "’")), `2: hobby ${h.id} does not open`);
}
p.S.screen = "app"; api.render();

/* ---------- 3. Shared device: overlap only ---------- */
p.S.tab = "try"; api.render();
api.trySet("chess", "yes"); api.trySet("hiking", "yes"); api.trySet("running", "no");
ok(fails, api.tryMatches().length === 0, "3: matches shown before the other person picked anything");
p.S.view = "B";
api.trySet("chess", "yes"); api.trySet("kayaking", "yes"); api.trySet("hiking", "no");
api.render();
ok(fails, api.tryMatches().map((h) => h.id).join() === "chess", `3: wrong overlap: ${api.tryMatches().map((h) => h.id)}`);
let h = html();
ok(fails, h.includes("You both said yes") && h.includes("Chess"), "3: the overlap is not on screen");
ok(fails, !h.includes("Hiking") && !h.includes("Kayaking"), "3: a one-sided pick is on screen");
p.S.view = "A"; api.render(); h = html();
ok(fails, h.includes("Chess") && !h.includes("Kayaking"), "3: side A sees the wrong overlap");
/* Through the real buttons: B changes a NO to YES in the answers list. */
p.S.view = "B"; p.S.screen = "trylist"; api.render();
click('[data-action="try-set"][data-id="hiking"][data-val="yes"]');
ok(fails, html().includes("It’s a match") && html().includes("Hiking"), "3: a new mutual yes did not show the match moment");
click('[data-action="match-close"]');
ok(fails, !html().includes("It’s a match"), "3: the match moment did not close");
ok(fails, api.tryMatches().map((x) => x.id).sort().join() === "chess,hiking", "3: changing an answer did not update the overlap");
p.S.screen = "app"; p.S.view = "A"; api.render();

/* Solo: your own list. */
const solo = bootPhone(broker, "solo");
seedProfile(solo, { name: "Kai", gender: "man", pronouns: "he", orientation: "gay" }, { name: "", gender: "", pronouns: "", orientation: "" });
solo.S.mode = "solo"; solo.S.screen = "app"; solo.S.tab = "try";
solo.api.trySet("yoga", "yes");
solo.api.render();
ok(fails, solo.api.tryMatches().map((x) => x.id).join() === "yoga", "3: solo does not show its own list");
ok(fails, solo.w.document.getElementById("root").innerHTML.includes("On your list"), "3: solo list heading missing");
ok(fails, !solo.w.document.getElementById("root").innerHTML.includes("It’s a match"), "3: solo should never show a match moment");

/* ---------- 4. Talk draws without repeats ---------- */
const deck = TALK.find((d) => d.id === "warmup");
p.S.tg.talk.seen = {};
const drawn = new Set();
for (let i = 0; i < deck.cards.length; i++) {
  const re = api.talkDraw("warmup");
  ok(fails, !re, "4: reshuffled before the deck was finished");
  drawn.add(p.S.talkCard);
}
ok(fails, drawn.size === deck.cards.length, `4: repeated a card before finishing (${drawn.size}/${deck.cards.length})`);
ok(fails, api.talkDraw("warmup") === true, "4: did not reshuffle after the last card");
/* Through the UI: open a deck, save a card, it appears in Saved. */
p.S.screen = "app"; p.S.tab = "talk"; api.render();
click('[data-action="open-talk"][data-id="deeptalk"]');
ok(fails, p.S.screen === "talk" && html().includes("Next card"), "4: a deck does not open to a card");
const shown = TALK.find((d) => d.id === "deeptalk").cards[p.S.talkCard][1];
click('[data-action="talk-fav"]');
click('[data-action="tg-back"]');
click('[data-action="open-saved"]');
ok(fails, html().includes(shown.replace(/&/g, "&amp;")), "4: a saved card is not in Saved cards");

/* ---------- 5. After Dark asks first ---------- */
p.S.screen = "app"; p.S.tab = "talk"; p.S.tg.talk.adultOk = false; api.render();
click('[data-action="open-talk"][data-id="afterdark"]');
const ad = TALK.find((d) => d.id === "afterdark");
h = html();
ok(fails, h.includes("We’ve both chosen this"), "5: After Dark did not ask first");
ok(fails, !ad.cards.some((c) => h.includes(c[1].replace(/&/g, "&amp;"))), "5: an After Dark card is visible before both chose it");
click('[data-action="talk-adult-ok"]');
ok(fails, html().includes("Next card"), "5: After Dark did not open after both chose it");

/* ---------- 6. Wire compatibility ---------- */
p.S.mode = "live";
api.applyEnvelope({ v: api.PROTO_V || 4, n: 2, u: 0, cf: p.w.__api.CHIPS_FP, r: {} });
ok(fails, p.S.partnerTryKnown === false && p.S.partnerTry.length === 0 && !p.S.partnerTryMismatch, "6: a 1.0 partner was not treated as 'has no Try list'");
api.applyEnvelope({ v: 4, n: 2, u: 0, cf: p.w.__api.CHIPS_FP, r: {}, t: [0, 1], tf: "deadbeef" });
ok(fails, p.S.partnerTryMismatch && p.S.partnerTry.length === 0, "6: a different Try list version was compared");
api.applyEnvelope({ v: 4, n: 2, u: 0, cf: p.w.__api.CHIPS_FP, r: {}, t: [0, 999, -1, "3", 1.5, 2], tf: api.TRY_FP });
ok(fails, p.S.partnerTry.join() === [TRY[0].id, TRY[2].id].join(), `6: bad indexes were not dropped: ${p.S.partnerTry}`);
p.S.mode = "shared";

/* ---------- 7. Storage ---------- */
const ls = p.w.localStorage;
ok(fails, !!ls.getItem(api.TOGETHER_KEY), "7: picks were not saved on the device");
ls.setItem(api.TOGETHER_KEY, "{not json");
let threw = false; try { api.loadTogether(); } catch (e) { threw = true; }
ok(fails, !threw && p.S.tg.picks.A.yes.length === 0, "7: corrupt storage was not handled");
ls.setItem(api.TOGETHER_KEY, JSON.stringify({ picks: { A: { yes: ["chess", "not-a-hobby"], no: [] } }, tried: ["nope"] }));
api.loadTogether();
ok(fails, p.S.tg.picks.A.yes.join() === "chess" && p.S.tg.tried.length === 0, "7: unknown ids survived a load");
p.S.screen = "app"; api.render();
click('[data-action="reset"]');
ok(fails, !ls.getItem(api.TOGETHER_KEY) && p.S.tg.picks.A.yes.length === 0, "7: Reset did not clear the Together data");

if (process.env.PRINT_FP) console.log("TRY_FP =", api.TRY_FP);
console.log(`together: ${TALK.length} decks, ${cardCount} cards, ${TRY.length} things to try`);
report("together tab test", fails);
