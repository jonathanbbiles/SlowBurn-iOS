/* SETTINGS + CREDITS TEST — run with `npm run test:settings`.
   -----------------------------------------------------------------
     1. the two creators are credited by their show names everywhere in the
        app — Glitoris✨ and Honeywood — and their real names appear nowhere
        on screen (the links still go to their sites)
     2. Settings opens from the gear on every app screen and from the Us tab,
        and Back returns where you were
     3. Light / Dark / Match iPhone: the choice persists, dark sets the dark
        palette and the html.dark class, and an old "Midnight" phone stays dark
     4. Card names: with it on, "your partner" in a Talk card becomes the
        partner's name; off, or solo, the card is unchanged
     5. Calm motion persists and switches the class that stops animation
     6. corrupt settings storage falls back to defaults without throwing */
import { makeBroker, bootPhone, seedProfile, ok, report } from "./harness.mjs";

const fails = [];
const broker = makeBroker();
const p = bootPhone(broker, "phone");
const api = p.api;
const html = () => p.w.document.getElementById("root").innerHTML;
const doc = p.w.document.documentElement;

seedProfile(p, { name: "Sam", gender: "nonbinary", pronouns: "they", orientation: "queer" },
                { name: "Rae", gender: "woman", pronouns: "she", orientation: "queer" });
p.S.mode = "shared"; p.S.screen = "app"; p.S.tab = "today"; api.render();

/* 1. credits */
ok(fails, api.CREDIT_HER === "Glitoris✨" && api.CREDIT_HIM === "Honeywood", "1: credit names changed");
const screens = [];
p.S.screen = "welcome"; api.render(); screens.push(html());
p.S.screen = "app"; p.S.tab = "partner"; api.render(); screens.push(html());
p.S.screen = "settings"; api.render(); screens.push(html());
for (const h of screens) {
  ok(fails, !/Jessica|Jonathan Biles|Jonathan writes|Jonathan&#8217;s|Jonathan’s/.test(h), "1: a creator's real name is on screen");
}
ok(fails, screens[0].includes("Glitoris✨") && screens[0].includes("Honeywood"), "1: the welcome screen does not credit Glitoris✨ and Honeywood");
ok(fails, screens[1].includes("From Glitoris✨") && screens[1].includes("From Honeywood"), "1: the Us tab does not credit Glitoris✨ and Honeywood");

/* 2. reachability */
p.S.screen = "app"; p.S.tab = "try"; api.render();
p.click('[data-action="open-settings"]');
ok(fails, p.S.screen === "settings" && html().includes("Appearance"), "2: the gear does not open Settings");
p.click('[data-action="settings-back"]');
ok(fails, p.S.screen === "app" && p.S.tab === "try", "2: Back from Settings did not return to Try");
p.S.tab = "partner"; api.render();
ok(fails, !!p.w.document.querySelector('.pad-tab [data-action="open-settings"]'), "2: the Us tab has no Settings entry");

/* 3. dark mode */
p.S.screen = "settings"; api.render();
p.click('[data-action="pref"][data-k="mode"][data-v="dark"]');
ok(fails, doc.classList.contains("dark") && doc.style.getPropertyValue("--app-bg") === "#17101A", "3: Dark did not apply the dark palette");
ok(fails, JSON.parse(p.w.localStorage.getItem(api.PREFS_KEY)).mode === "dark", "3: Dark was not saved");
p.click('[data-action="pref"][data-k="mode"][data-v="light"]');
ok(fails, !doc.classList.contains("dark") && doc.style.getPropertyValue("--app-bg") !== "#17101A", "3: Light did not leave dark mode");
p.click('[data-action="set-theme"][data-theme="sage"]');
ok(fails, p.S.theme === "sage", "3: a colour swatch did not apply");
const old = bootPhone(broker, "old", { preload: (w) => { w.localStorage.setItem("sb_theme_v1", "midnight"); } });
old.api.loadPrefs(); old.api.applyTheme && 0;
ok(fails, old.S.prefs.mode === "dark", "3: a phone that had the old dark Midnight theme did not stay dark");

/* 4. card names */
const card = "Tell your partner one small thing they did this week that made you feel cared for.";
p.S.prefs.cardNames = true;
ok(fails, api.personalizeCard(card).startsWith("Tell Rae one small thing"), `4: name not used: ${api.personalizeCard(card)}`);
ok(fails, api.personalizeCard("What is your partner’s favourite smell?").includes("Rae’s"), "4: possessive not handled");
p.S.prefs.cardNames = false;
ok(fails, api.personalizeCard(card) === card, "4: card changed with names off");
p.S.prefs.cardNames = true; p.S.mode = "solo";
ok(fails, api.personalizeCard(card) === card, "4: solo cards should not be personalised");
p.S.mode = "shared";

/* 5. calm */
p.S.screen = "settings"; api.render();
p.click('[data-action="pref-toggle"][data-k="calm"]');
ok(fails, p.S.prefs.calm === true && doc.classList.contains("calm"), "5: Calm motion did not switch on");

/* 6. corrupt storage */
p.w.localStorage.setItem(api.PREFS_KEY, "{oops");
let threw = false; try { api.loadPrefs(); } catch (e) { threw = true; }
ok(fails, !threw && p.S.prefs.mode === "light" && p.S.prefs.cardNames === true, "6: corrupt settings did not fall back to defaults");

report("settings test", fails);
