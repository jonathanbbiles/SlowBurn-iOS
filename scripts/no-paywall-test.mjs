/* NO-PAYWALL / FULL-CONTENT TEST — run with `npm run test:content`.
   -----------------------------------------------------------------
   Slow Burn is a PAID app: one price up front, and everything in it included.
   This suite exists because that is a promise the code has to keep, and
   because a freemium build was briefly started here and then removed — so the
   most useful thing a test can do is make sure none of it grew back.

   It asserts, against the real app:

     1. every deck, practice and theme is reachable — nothing is filtered
     2. there is no entitlement, no paywall screen and no lock UI anywhere
     3. no non-consumable is registered with StoreKit; the only products are
        the three optional tips, which unlock nothing
     4. the reflection screen offers the WHOLE chip vocabulary
     5. the keepsake journal is opt-in for privacy reasons and works without
        any purchase
     6. the co-brand links are present (standing rule) */
import fs from "node:fs";
import { makeBroker, bootPhone, settle, seedProfile, ok, report } from "./harness.mjs";

const fails = [];
const SRC = fs.readFileSync(new URL("../www/index.html", import.meta.url).pathname, "utf8");
/* Comments describe history; only real code counts. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const broker = makeBroker();
const phone = bootPhone(broker, "paid", { preload(w) { w.Capacitor = { isNativePlatform: () => true }; } });
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
                     'data-action="pro-buy"', 'data-action="open-pro"', "sb_pro_v1"]) {
  ok(fails, !CODE.includes(ghost), `2: the freemium build left "${ghost}" behind`);
}
/* A `pro:` flag on any content item would be a gate waiting to be switched on. */
ok(fails, !api.DECKS.some((d) => "pro" in d), "2: a deck still carries a pro flag");
ok(fails, !api.PRACTICES.some((p) => "pro" in p), "2: a practice still carries a pro flag");
ok(fails, !api.THEMES.some((t) => "pro" in t), "2: a theme still carries a pro flag");
console.log("2  no entitlement, no paywall screen, no pro flags on any content");

/* ---------- 3. StoreKit: tips only, no unlock to sell ---------- */
ok(fails, !CODE.includes("NON_CONSUMABLE"), "3: a non-consumable is still registered — a paid app has nothing to sell in-app");
ok(fails, CODE.includes("ProductType.CONSUMABLE"), "3: the pre-existing tip jar was removed — it was not part of this change");
ok(fails, Object.keys(api.Monetize.TIPS).length === 3, "3: the tip products changed");
ok(fails, typeof api.Monetize.buyPro === "undefined", "3: a buyPro() entry point still exists");
console.log("3  StoreKit registers only the 3 optional tips; nothing unlocks content");

/* ---------- 4. The reflection screen offers the whole vocabulary ---------- */
{
  const S = phone.S;
  S.mode = "live"; S.screen = "session";
  S.session = { stageId: 1, startedAt: Date.now(), phase: "reflect" };
  S.form = { good: new Set(), more: new Set(), note: "" };
  api.render();
  const html = phone.w.document.getElementById("root").innerHTML;
  ok(fails, api.goodChips().length === api.GOOD.length,
     `4: reflection offers ${api.goodChips().length} of ${api.GOOD.length} "felt good" chips`);
  ok(fails, api.moreChips().length === api.MORE.length,
     `4: reflection offers ${api.moreChips().length} of ${api.MORE.length} "welcome more" chips`);
  /* The app HTML-escapes titles, so compare against the escaped form:
     "Presence & attention" renders as "Presence &amp; attention". */
  const escHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  for (const d of api.DECKS) {
    ok(fails, html.includes(escHtml(d.title)), `4: deck "${d.title}" is missing from the reflection screen`);
  }
  ok(fails, !/unlock|upgrade|in pro\b/i.test(html), "4: the reflection screen still shows upsell copy");
  console.log(`4  reflection screen shows all ${api.DECKS.length} decks — ${api.GOOD.length}+${api.MORE.length} chips, no upsell`);
}

/* ---------- 5. Journal: opt-in, and works with no purchase ---------- */
{
  const S = phone.S;
  ok(fails, S.journalOn === false, "5: the journal is on by default — it must stay opt-in");
  api.setJournalOn(true);
  api.journalAdd(1, ["Eye contact"], ["More time"], "a note");
  ok(fails, S.journal.length === 1, "5: the journal did not record once switched on — no purchase should be required");
  api.setJournalOn(false);
  ok(fails, S.journal.length === 0, "5: switching the journal off left entries behind");
  console.log("5  journal is opt-in, needs no purchase, and deletes on off");
}

/* ---------- 6. Links ---------- */
ok(fails, CODE.includes("jonathanscribbles.com"), "6: the jonathanscribbles.com link is missing");
ok(fails, CODE.includes("jessicaleighbiles.com"), "6: the jessicaleighbiles.com co-brand link is missing");
console.log("6  both co-brand links present");

report("no-paywall / full-content test", fails);
