/* STOREKIT / PRO TEST — run with `npm run test:iap`.
   -----------------------------------------------------------------
   ChordLoop was rejected TWICE under Guideline 2.1(b) — "no sandbox appeared
   after we tapped on the purchase button" — for two separate causes, both of
   which a naive test suite passes. This suite exists to make both impossible
   here, plus the gating that decides what Pro is worth.

   THE STUB MIRRORS cordova-plugin-purchase 13.18.0 EXACTLY.
   Its when() chain is the literal hook list from the installed plugin, so
   calling a hook the real plugin lacks — `owned`, the one that got ChordLoop
   rejected the second time — is a TypeError here exactly as it is on device.
   A stub more permissive than the real thing turns a crash into a green tick,
   which is worse than no stub at all. */
import { makeBroker, bootPhone, settle, ok, report } from "./harness.mjs";

const fails = [];
const PRO_ID = "com.jonathanbiles.slowburn.pro";

/* The real v13.18.0 hooks. `owned` is COMMENTED OUT in the plugin source —
   it must not appear here. */
const REAL_HOOKS = ["productUpdated","receiptUpdated","updated","approved","initiated",
  "pending","finished","verified","unverified","receiptsReady","receiptsVerified","storefrontUpdated"];

function makePlugin(cfg = {}) {
  const log = { registered: null, initialized: false, ordered: [], restores: 0, updates: 0 };
  const cbs = {};
  const products = {};
  const owned = new Set(cfg.ownedAtStart || []);

  const when = () => {
    const ret = {};
    for (const h of REAL_HOOKS) ret[h] = (fn) => { (cbs[h] = cbs[h] || []).push(fn); return ret; };
    return ret;
  };
  const fire = (h, arg) => (cbs[h] || []).forEach((f) => f(arg));

  const store = {
    register(list) {
      log.registered = list.slice();
      for (const p of list) products[p.id] = { id: p.id, type: p.type, pricing: null, getOffer: () => (products[p.id].pricing ? { order: () => log.ordered.push(p.id) } : null) };
    },
    when,
    error(fn) { store.__err = fn; },
    get(id) { return products[id]; },
    owned(p) { return owned.has(typeof p === "string" ? p : p.id); },
    update() { log.updates++; },
    order(offer) { offer.order(); },
    restorePurchases() {
      log.restores++;
      if (cfg.restoreError) return Promise.resolve(cfg.restoreError);
      if (cfg.restoreGrants) { owned.add(PRO_ID); setTimeout(() => fire("receiptUpdated"), 5); }
      return Promise.resolve(undefined);
    },
    initialize() {
      log.initialized = true;
      // Prices arrive from Apple, asynchronously, exactly as on device.
      setTimeout(() => {
        for (const id of Object.keys(products)) products[id].pricing = { price: cfg.prices && cfg.prices[id] ? cfg.prices[id] : "$2.99" };
        fire("productUpdated");
        if (owned.size) fire("receiptsReady");
      }, 5);
      return Promise.resolve(cfg.initErrors || []);
    },
    /* test helpers */
    __approve(id) { owned.add(id); fire("approved", { verify: () => setTimeout(() => fire("verified", { finish: () => {} }), 1) }); },
    __log: log, __owned: owned, __cbs: cbs,
  };
  return { store, ProductType: { CONSUMABLE: "consumable", NON_CONSUMABLE: "non consumable" },
           Platform: { APPLE_APPSTORE: "ios-appstore" }, ErrorCode: { PAYMENT_CANCELLED: 6777006 }, __log: log };
}

function boot(cfg = {}) {
  const broker = makeBroker();
  const toasts = [];
  const P = cfg.native === false ? null : makePlugin(cfg);
  const phone = bootPhone(broker, "iap", {
    preload(w) {
      if (cfg.native !== false) w.Capacitor = { isNativePlatform: () => true, platform: "ios" };
      if (P && !cfg.noBridge) w.CdvPurchase = P;
    },
  });
  const origToast = phone.w.eval("toast");
  phone.w.eval(`toast=function(m){ window.__toasts.push(m); };`);
  phone.w.__toasts = toasts;
  return { phone, P, toasts, api: phone.api };
}

/* ---------- 1. The stub really does reject the hook that got us rejected ---------- */
{
  const P = makePlugin();
  let threw = false;
  try { P.store.when().owned(() => {}); } catch (e) { threw = e instanceof TypeError; }
  ok(fails, threw, "1: the stub allows when().owned() — it must mirror the real plugin, which does not have it");
  console.log("1  stub matches plugin 13.18.0: when().owned() is a TypeError");
}

/* ---------- 2. Purchase opens the sheet and grants only on verify ---------- */
{
  const { phone, P, toasts, api } = boot();
  await settle(10);
  ok(fails, P.__log.initialized, "2: store.initialize() was never reached");
  const reg = (P.__log.registered || []).find((r) => r.id === PRO_ID);
  ok(fails, !!reg, "2: the Pro product was never registered");
  ok(fails, reg && reg.type === "non consumable", `2: Pro registered as ${reg && reg.type}, must be NON_CONSUMABLE`);
  ok(fails, api.Monetize.proPrice() === "$2.99", `2: price not read live from Apple (got ${api.Monetize.proPrice()})`);
  ok(fails, !api.Pro.active(), "2: Pro was active before any purchase");

  api.Monetize.buyPro();
  ok(fails, P.__log.ordered.includes(PRO_ID), "2: tapping Unlock did not call store.order() — this IS the 2.1(b) bug");
  ok(fails, !api.Pro.active(), "2: Pro was granted merely by ordering, before verification");

  P.store.__approve(PRO_ID);
  await settle(10);
  ok(fails, api.Pro.active(), "2: a verified purchase did not grant Pro");
  console.log("2  buy -> store.order() -> verified -> Pro granted (never before)");
}

/* ---------- 3. Hook drift cannot stop StoreKit ---------- */
{
  const broker = makeBroker();
  const P = makePlugin();
  // Simulate a future plugin dropping a hook the app listens for.
  const realWhen = P.store.when;
  P.store.when = () => { const w = realWhen(); delete w.receiptsReady; return w; };
  const phone = bootPhone(broker, "drift", { preload(w) { w.Capacitor = { isNativePlatform: () => true }; w.CdvPurchase = P; } });
  await settle(10);
  ok(fails, P.__log.initialized, "3: a missing when() hook stopped initialize() from being reached");
  ok(fails, phone.api.Monetize.diagnose().missingHooks.includes("receiptsReady"), "3: the missing hook was not recorded");
  console.log("3  missing hook degraded and recorded; initialize() still ran");
}

/* ---------- 4. Restore ---------- */
{
  const { api, toasts } = boot({ restoreGrants: true });
  await settle(10);
  api.Monetize.restorePro();
  await settle(160);   // restorePro waits ~600ms for the receipt hooks before reporting
  ok(fails, api.Pro.active(), "4a: restore did not grant Pro when the Apple ID owns it");
  console.log("4a restore with a prior purchase -> Pro active");
}
{
  const { api, toasts } = boot();
  await settle(10);
  api.Monetize.restorePro();
  await settle(160);   // restorePro waits ~600ms for the receipt hooks before reporting
  ok(fails, !api.Pro.active(), "4b: restore granted Pro with no purchase");
  ok(fails, toasts.some((t) => /no previous/i.test(t)), `4b: restore said nothing when there was nothing to restore — Apple tests this. Toasts: ${JSON.stringify(toasts)}`);
  console.log("4b restore with nothing to restore -> says so out loud");
}
{
  const { api, toasts } = boot({ restoreError: { message: "Network down" } });
  await settle(10);
  api.Monetize.restorePro();
  await settle(160);   // restorePro waits ~600ms for the receipt hooks before reporting
  ok(fails, toasts.some((t) => /couldn.t restore/i.test(t)), `4c: a restore error was swallowed. Toasts: ${JSON.stringify(toasts)}`);
  console.log("4c restore error -> explained, never silent");
}

/* ---------- 5. Ownership from the receipt, and grant is idempotent ---------- */
{
  const { api, toasts } = boot({ ownedAtStart: [PRO_ID] });
  await settle(15);
  ok(fails, api.Pro.active(), "5: an existing receipt did not unlock Pro on launch");
  const unlockToasts = toasts.filter((t) => /unlocked|restored/i.test(t)).length;
  ok(fails, unlockToasts <= 1, `5: grant is not idempotent — announced ${unlockToasts} times on one launch`);
  console.log(`5  receipt-driven unlock, announced ${unlockToasts}x (idempotent)`);
}

/* ---------- 6. Never a silent dead end ---------- */
{
  const { api, toasts } = boot({ noBridge: true });
  await settle(6);
  api.Monetize.buyPro();
  ok(fails, toasts.length > 0, "6a: tapping Unlock with no StoreKit bridge did nothing at all — that is the rejection");
  console.log(`6a no bridge -> "${toasts[toasts.length - 1]}"`);
}
{
  const { api, toasts } = boot({ initErrors: [{ message: "Store unavailable" }] });
  await settle(10);
  const before = toasts.length;
  api.Monetize.buyPro();
  ok(fails, toasts.length > before || api.Monetize.diagnose().initError, "6b: an init error was not surfaced anywhere");
  console.log("6b init error captured:", JSON.stringify(api.Monetize.diagnose().initError));
}

/* ---------- 7. Web preview must not fake-unlock ---------- */
{
  const { api, toasts } = boot({ native: false });
  await settle(6);
  api.Monetize.buyPro();
  ok(fails, !api.Pro.active(), "7: the web build unlocked Pro without a purchase — this is the original ChordLoop bug");
  ok(fails, toasts.some((t) => /App Store/i.test(t)), `7: the web build said nothing useful. Toasts: ${JSON.stringify(toasts)}`);
  console.log("7  non-native build refuses and explains; no demo unlock exists");
}

/* ---------- 8. Gating: what Pro actually changes ---------- */
{
  const { api } = boot();
  await settle(10);
  const freeGood = api.goodChips().length, freeMore = api.moreChips().length;
  const freePractices = api.practicesOpen().length, freeThemes = api.themesOpen().length;
  ok(fails, freeGood === api.STARTER.good.length, `8: free build offers ${freeGood} good chips, expected the starter deck's ${api.STARTER.good.length}`);
  ok(fails, api.decksLocked().length === api.DECKS.filter((d) => d.pro).length, "8: locked deck count is wrong for a free user");

  api.Pro.grant();
  const proGood = api.goodChips().length, proMore = api.moreChips().length;
  ok(fails, proGood === api.GOOD.length, `8: Pro offers ${proGood} good chips but the wire vocabulary has ${api.GOOD.length}`);
  ok(fails, api.decksLocked().length === 0, "8: decks still locked after Pro");
  ok(fails, api.practicesOpen().length > freePractices, "8: Pro unlocked no extra practices");
  ok(fails, api.themesOpen().length > freeThemes, "8: Pro unlocked no extra themes");
  console.log(`8  gating: chips ${freeGood}/${freeMore} free -> ${proGood}/${proMore} Pro; practices ${freePractices}->${api.practicesOpen().length}; themes ${freeThemes}->${api.themesOpen().length}`);
}

/* ---------- 9. The wire vocabulary is Pro-independent ---------- */
{
  const free = boot(); await settle(8);
  const pro = boot(); await settle(8); pro.api.Pro.grant();
  ok(fails, free.api.CHIPS_FP === pro.api.CHIPS_FP, "9: the chip fingerprint differs between a free and a Pro phone — they would refuse to match");
  ok(fails, JSON.stringify(free.api.GOOD) === JSON.stringify(pro.api.GOOD), "9: the wire chip list differs between free and Pro — indexes would mean different things");
  ok(fails, free.api.CHIPS_FP === "d63a9bd4", `9: the fingerprint moved off the 1.0 value (got ${free.api.CHIPS_FP}) — 1.0 phones would stop matching`);
  console.log("9  free and Pro phones share one wire vocabulary, unchanged since 1.0");
}

/* ---------- 10. The journal is off until asked for, and off means gone ---------- */
{
  const { api, phone } = boot();
  await settle(8);
  ok(fails, phone.S.journalOn === false, "10: the keepsake journal is on by default — it must be opt-in");
  api.journalAdd(1, ["Eye contact"], ["More time"], "a private note");
  ok(fails, phone.S.journal.length === 0, "10: the journal recorded a reflection while switched off");

  api.Pro.grant(); api.setJournalOn(true);
  api.journalAdd(1, ["Eye contact"], ["More time"], "a private note");
  ok(fails, phone.S.journal.length === 1, "10: the journal did not record when Pro + switched on");

  api.setJournalOn(false);
  ok(fails, phone.S.journal.length === 0, "10: switching the journal off left entries behind — the copy promises deletion");
  console.log("10 journal off by default, records only when Pro + on, deletes on off");
}

report("StoreKit / Pro test", fails);
