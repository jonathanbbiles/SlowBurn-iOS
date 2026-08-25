/* TIP JAR + NO-GATING TEST — run with `npm run test:content`.
   -----------------------------------------------------------------
   Slow Burn is a PAID app: one price up front, and everything in it is
   included. It also has a tip jar — one CONSUMABLE in-app purchase that
   unlocks nothing. Those two facts have to stay true together, and this
   suite is what keeps them true.

   It replaces the old no-paywall suite, which asserted that the binary
   contained NO purchase machinery at all. That assertion was written when
   the tip jar was ripped out after a 2.1(b) rejection, and it is now the
   wrong invariant: the fix for 2.1(b) was never "have no in-app purchase",
   it was "submit the in-app purchase for review with the app, and never
   ship a button Apple cannot fulfil". So what has to be proven now is
   sharper, not weaker:

     1. every deck, practice and theme is reachable — nothing is filtered
     2. there is no entitlement, no paywall screen and no lock UI anywhere,
        and no content carries a `pro:` flag waiting to be switched on
     3. the tip jar registers ONLY products that exist in App Store Connect,
        as CONSUMABLE, and nothing in the app gates on having tipped
     4. NO DEAD BUTTON: the tip button renders only once Apple has actually
        returned a purchasable product — not on the web, not with the plugin
        present but no products loaded
     5. NO OPTIMISTIC GRANT: the thank-you is recorded only from Apple's
        `verified` callback. `approved` alone does not do it, a store error
        does not do it, and tapping with no bridge does not do it
     6. the reflection screen offers the WHOLE chip vocabulary
     7. no subscription / tier / premium copy anywhere in the app
     8. the keepsake journal is opt-in for privacy reasons and needs no purchase
     9. the co-brand links are present (standing rule) */
import fs from "node:fs";
import { makeBroker, bootPhone, settle, seedProfile, ok, report } from "./harness.mjs";

const fails = [];
const SRC = fs.readFileSync(new URL("../www/index.html", import.meta.url).pathname, "utf8");
/* Comments describe history and intent; only real code counts. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* The one product that exists in App Store Connect for this app. Registering
   anything Apple does not have is how a dead buy button ships (2.1(b)), so
   this list is the contract between the binary and the store. */
const ASC_PRODUCTS = ["com.jonathanbiles.slowburn.tip.small"];

/* ---------- a stubbed CdvPurchase v13 bridge ----------
   Shaped like the real plugin, including the parts that have bitten this
   pipeline before: when() may be missing a hook, and initialize() resolves
   with an array of errors rather than rejecting. `products` empty models the
   real "plugin is here, Apple returned nothing" case. */
function makeBridge({ products = [], missingHooks = [] } = {}) {
  const fired = { approved: null, verified: null, productUpdated: null, error: null };
  const rec = { registered: null, initializedWith: null, ordered: [] };
  const store = {
    register(list) { rec.registered = list; },
    when() {
      const w = {};
      for (const h of ["approved", "verified", "productUpdated"]) {
        if (missingHooks.includes(h)) continue;
        w[h] = (fn) => { fired[h] = fn; return w; };
      }
      return w;
    },
    error(fn) { fired.error = fn; },
    initialize(platforms) { rec.initializedWith = platforms; return Promise.resolve([]); },
    get(id) {
      const p = products.find((x) => x.id === id);
      if (!p) return null;
      return {
        pricing: { price: p.price },
        getOffer: () => ({ order: () => { rec.ordered.push(id); } }),
      };
    },
  };
  return {
    rec, fired,
    plugin: {
      store,
      Platform: { APPLE_APPSTORE: "ios-appstore" },
      ProductType: { CONSUMABLE: "consumable", NON_CONSUMABLE: "non consumable" },
      ErrorCode: { PAYMENT_CANCELLED: 6500 },
    },
  };
}

function boot(broker, label, { native = true, bridge = null } = {}) {
  return bootPhone(broker, label, {
    preload(w) {
      w.Capacitor = { isNativePlatform: () => native };
      if (bridge) w.CdvPurchase = bridge.plugin;
    },
  });
}

const broker = makeBroker();

/* ---------- the main phone: native, plugin present, product loaded ---------- */
const live = makeBridge({ products: [{ id: ASC_PRODUCTS[0], price: "$1.99" }] });
const phone = boot(broker, "paid", { bridge: live });
const api = phone.api;
seedProfile(phone, { name: "Jess", gender: "woman", pronouns: "she", orientation: "queer" },
                    { name: "Jon", gender: "man", pronouns: "he", orientation: "straight" });
await settle(8);

/* ---------- 1. Everything is reachable ---------- */
ok(fails, api.decksOpen().length === api.DECKS.length,
   `1: ${api.decksOpen().length} of ${api.DECKS.length} decks reachable`);
ok(fails, api.practicesOpen().length === api.PRACTICES.length,
   `1: ${api.practicesOpen().length} of ${api.PRACTICES.length} practices reachable`);
ok(fails, api.themesOpen().length === api.THEMES.length,
   `1: ${api.themesOpen().length} of ${api.THEMES.length} themes reachable`);
console.log(`1  all content reachable: ${api.DECKS.length} decks, ${api.PRACTICES.length} practices, ${api.THEMES.length} themes, 6 stages`);

/* ---------- 2. No entitlement, no paywall, no lock ---------- */
for (const ghost of ["Pro.active", "Pro.grant", "screenPro(", "proCard(", "lockedDecksCard(",
                     "decksLocked", "practicesLocked", "buyPro", "restorePro", "PRO_ID",
                     'data-action="pro-buy"', 'data-action="open-pro"', "sb_pro_v1",
                     "NON_CONSUMABLE", "restorePurchases", "PAID_SUBSCRIPTION"]) {
  ok(fails, !CODE.includes(ghost), `2: an entitlement/paywall construct is present: "${ghost}"`);
}
ok(fails, !api.DECKS.some((d) => "pro" in d), "2: a deck still carries a pro flag");
ok(fails, !api.PRACTICES.some((p) => "pro" in p), "2: a practice still carries a pro flag");
ok(fails, !api.THEMES.some((t) => "pro" in t), "2: a theme still carries a pro flag");
console.log("2  no entitlement, no paywall screen, no pro flags on any content");

/* ---------- 3. The tip jar is one consumable, and gates nothing ---------- */
{
  const ids = Object.values(api.Monetize.TIPS);
  ok(fails, JSON.stringify(ids) === JSON.stringify(ASC_PRODUCTS),
     `3: the app registers ${JSON.stringify(ids)} but App Store Connect has ${JSON.stringify(ASC_PRODUCTS)} — `
     + "a product Apple does not have can never load, which is a dead buy button (2.1(b))");
  ok(fails, Array.isArray(live.rec.registered) && live.rec.registered.length === ASC_PRODUCTS.length,
     "3: the store was not handed exactly the App Store Connect product list");
  ok(fails, (live.rec.registered || []).every((p) => p.type === "consumable"),
     "3: a tip is registered as something other than a CONSUMABLE — a tip buys no content, "
     + "so a non-consumable or a subscription would be a paid tier by another name");
  /* The decisive one. If anything except Monetize reads the tipped flag, the
     tip has become an entitlement and the app is no longer "nothing gated". */
  const readers = (CODE.match(/sb_supported/g) || []).length;
  ok(fails, readers === 1,
     `3: "sb_supported" appears ${readers} times in code — it must appear exactly once `
     + "(Monetize's own key). More than one reader means a tip gates something.");
  const hasSupportedCalls = (CODE.match(/hasSupported\s*\(/g) || []).length;
  ok(fails, hasSupportedCalls <= 3,
     `3: hasSupported() is called ${hasSupportedCalls} times — it may only decide whether to `
     + "show a thank-you line, never whether content is available");
  console.log(`3  one CONSUMABLE tip, matching App Store Connect; nothing in the app gates on it`);
}

/* ---------- 4. NO DEAD BUTTON ---------- */
{
  /* (a) the real case: product loaded -> a button, with Apple's own price */
  const card = api.supportCard();
  ok(fails, card.includes('data-action="tip"'), "4a: no tip button even though Apple returned a product");
  ok(fails, card.includes("$1.99"), "4a: the tip button does not show the price Apple returned");
  ok(fails, !/subscri|upgrade|premium|unlock/i.test(card),
     "4a: the support card uses tier wording");

  /* (b) plugin present, Apple returned NOTHING -> no button at all */
  const empty = makeBridge({ products: [] });
  const p2 = boot(makeBroker(), "noproducts", { bridge: empty });
  await settle(8);
  const card2 = p2.api.supportCard();
  ok(fails, !card2.includes('data-action="tip"'),
     "4b: a tip button rendered with no purchasable product behind it — that button would do "
     + "nothing, which is exactly the 2.1(b) dead-button rejection");
  ok(fails, card2.includes("Support Slow Burn"),
     "4b: the fallback support card disappeared instead of degrading to the honest note");

  /* (c) no native bridge at all (web / simulator) -> no button */
  const p3 = boot(makeBroker(), "web", { native: false, bridge: null });
  await settle(8);
  ok(fails, !p3.api.supportCard().includes('data-action="tip"'),
     "4c: a tip button rendered with no StoreKit bridge present");
  console.log("4  tip button appears ONLY when Apple has returned a purchasable product");
}

/* ---------- 5. NO OPTIMISTIC GRANT ---------- */
{
  const M = api.Monetize;
  ok(fails, !M.hasSupported(), "5: the app starts out already 'supported' — nothing was purchased");

  /* Tapping asks Apple and records nothing by itself. */
  ok(fails, M.tip("small") === true, "5: tip() did not start a purchase with a loaded product");
  ok(fails, live.rec.ordered.length === 1, "5: tip() did not place an order with StoreKit");
  ok(fails, !M.hasSupported(), "5: tapping the tip button recorded a tip WITHOUT a purchase");

  /* Apple approving is not Apple verifying. */
  live.fired.approved({ verify() {} });
  ok(fails, !M.hasSupported(), "5: an 'approved' transaction recorded a tip before verification");

  /* A store error must never record anything either. */
  if (live.fired.error) live.fired.error({ code: 999, message: "boom" });
  ok(fails, !M.hasSupported(), "5: a store error recorded a tip");

  /* Only this does. */
  live.fired.verified({ finish() {} });
  ok(fails, M.hasSupported(), "5: a VERIFIED transaction did not record the thank-you");

  /* And once recorded, the thank-you is all that changes. */
  const after = api.supportCard();
  ok(fails, /Thank you/i.test(after), "5: the thank-you never appears after a verified tip");
  ok(fails, api.decksOpen().length === api.DECKS.length && api.practicesOpen().length === api.PRACTICES.length,
     "5: content availability CHANGED after a tip — a tip must unlock nothing");

  /* Not native: no purchase can be started at all. */
  const p4 = boot(makeBroker(), "web2", { native: false, bridge: null });
  await settle(8);
  ok(fails, p4.api.Monetize.tip("small") === false, "5: tip() started a purchase off-device");
  ok(fails, !p4.api.Monetize.hasSupported(), "5: tip() recorded a tip off-device");
  console.log("5  the thank-you is recorded ONLY from Apple's verified callback");
}

/* ---------- 6. The reflection screen offers the whole vocabulary ---------- */
{
  const S = phone.S;
  S.mode = "live"; S.screen = "session";
  S.session = { stageId: 1, startedAt: Date.now(), phase: "reflect" };
  S.form = { good: new Set(), more: new Set(), note: "" };
  api.render();
  const html = phone.w.document.getElementById("root").innerHTML;
  ok(fails, api.goodChips().length === api.GOOD.length,
     `6: reflection offers ${api.goodChips().length} of ${api.GOOD.length} "felt good" chips`);
  ok(fails, api.moreChips().length === api.MORE.length,
     `6: reflection offers ${api.moreChips().length} of ${api.MORE.length} "welcome more" chips`);
  /* The app HTML-escapes titles, so compare against the escaped form:
     "Presence & attention" renders as "Presence &amp; attention". */
  const escHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  for (const d of api.DECKS) {
    ok(fails, html.includes(escHtml(d.title)), `6: deck "${d.title}" is missing from the reflection screen`);
  }
  ok(fails, !/upgrade|in pro\b|subscribe|purchase|unlock (it|now|everything)/i.test(html),
     "6: the reflection screen still shows upsell copy");
  console.log(`6  reflection screen shows all ${api.DECKS.length} decks — ${api.GOOD.length}+${api.MORE.length} chips, no upsell`);
}

/* ---------- 7. No business-model copy anywhere in the app ----------
   "unlock"/"locked" survive deliberately: they are the CONSENT GATE — "Stage 3
   unlocks once you have both confirmed" — which is the product, not a price.
   A tip jar is allowed to say "tip"; what must not appear is anything that
   reads as a tier, a recurring charge, or content behind a payment. */
{
  /* Scan app copy, not code. MQTT's own client.subscribe() is protocol, not a
     business model, and a naive quoted-string sweep spans across it. */
  const copy = SRC.replace(/client\.subscribe\([^)]*\)/g, "");
  const strings = (copy.match(/["'`][^"'`]{8,240}["'`]/g) || []).join(" ");
  for (const [label, re] of [
    ["subscription wording", /\bsubscription\b|\bsubscribe (to|now)\b/i],
    ["upgrade wording", /\bupgrade\b/i],
    ["premium wording", /\bpremium\b/i],
    ["Pro tier wording", /\bSlow Burn Pro\b|\bPro tier\b|\bgo Pro\b/i],
    ["trial wording", /\bfree trial\b|\btrial version\b/i],
    ["paywall wording", /\bpaywall\b/i],
    ["restore wording", /\brestore purchase/i],
  ]) {
    ok(fails, !re.test(strings), `7: ${label} still appears in app copy`);
  }
  console.log("7  no subscription / upgrade / premium / tier / restore copy in the app");
}

/* ---------- 8. Journal: opt-in, and works with no purchase ---------- */
{
  const S = phone.S;
  ok(fails, S.journalOn === false, "8: the journal is on by default — it must stay opt-in");
  api.setJournalOn(true);
  api.journalAdd(1, ["Eye contact"], ["More time"], "a note");
  ok(fails, S.journal.length === 1, "8: the journal did not record once switched on — no purchase should be required");
  api.setJournalOn(false);
  ok(fails, S.journal.length === 0, "8: switching the journal off left entries behind");
  console.log("8  journal is opt-in, needs no purchase, and deletes on off");
}

/* ---------- 9. Links ---------- */
ok(fails, CODE.includes("jonathanscribbles.com"), "9: the jonathanscribbles.com link is missing");
ok(fails, CODE.includes("jessicaleighbiles.com"), "9: the jessicaleighbiles.com co-brand link is missing");
console.log("9  both co-brand links present");

report("tip jar / no-gating test", fails);
