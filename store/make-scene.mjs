/* Build a one-off copy of the real app frozen in a given state, for capture.

   The scenes below drive the SHIPPING www/index.html — they do not reimplement
   any of it. The driver is appended as a second classic <script>, so the app's
   top-level `let`/`const` (S, render, …) are reachable through the shared
   global lexical scope.

   Output lands in store/.scenes/ (gitignored). See capture-screenshots.mjs. */
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = path.join(ROOT, "store", ".scenes");
const html = fs.readFileSync(path.join(ROOT, "www", "index.html"), "utf8");

/* One shared profile so every screenshot shows the same two people. */
const PROFILE = `
function setProfile(){
  S.ack=true;
  S.profile={done:true,
    people:{A:{name:"Jessica",gender:"woman",genderCustom:"",pronouns:"she",pronounsCustom:"",orientation:"queer",orientationCustom:""},
            B:{name:"Jonathan",gender:"man",genderCustom:"",pronouns:"he",pronounsCustom:"",orientation:"straight",orientationCustom:""}},
    structure:"mono",structureCustom:"",partnerTerm:"partner",partnerTermCustom:"",areas:"inclusive"};
}`;

export const SCENES = {
  welcome: `S.screen="welcome";render();`,

  program: `setProfile();S.mode="live";S.screen="app";S.tab="program";
    S.data.A.ready={1:true,2:true};S.partnerStage=2;
    S.pairSecure=true;S.pairSafety="X4A-RTW";S.partnerOnline=true;S.code="RTT77MH4JN";render();`,

  consent: `setProfile();S.mode="live";S.screen="stage";S.stageOpen=2;
    S.data.A.ready={1:true};S.data.A.sessions={2:1};S.partnerStage=1;
    S.pairSecure=true;S.pairSafety="X4A-RTW";S.partnerOnline=true;S.code="RTT77MH4JN";render();`,

  /* The headline screen: cross-device reflection matching over the encrypted
     link. canMatch() normally requires a live confirmed handshake, which needs
     a second phone — patched here so one browser can render the exact state a
     real pairing produces. The chips shown are computed by the app's own
     matchFor(), not hardcoded: only the overlap appears. */
  checkins: `setProfile();S.mode="live";S.screen="app";S.tab="checkins";
    S.pairSecure=true;S.pairSafety="X4A-RTW";S.partnerOnline=true;S.partnerStage=1;S.code="RTT77MH4JN";
    S.data.A.debrief[1]={good:["Feeling unhurried","Eye contact","Feeling safe"],more:["More time","A slower pace"],note:"private"};
    S.partnerDebrief={1:{good:["Feeling unhurried","Eye contact","Warmth & closeness"],more:["More time","Softer touch"]}};
    canMatch=function(){return true;};render();`,

  /* The invite screen — the one that was broken. It now shows the pair code as
     the hero and a QR that carries only that code. No origin/URL line at all. */
  invite: `setProfile();S.mode="live";S.pairSide="h";S.code="RTT77MH4JN";
    S.screen="pairing";S.pairPhase="create";S.partnerOnline=false;render();`,

  /* Deliberately the CHOICE screen, not the invite screen: the invite screen
     prints location.origin, which is a capture artefact outside the real app. */
  pairchoose: `setProfile();S.mode=null;S.screen="pairing";S.pairPhase="choose";render();`,
};

export function buildScene(name) {
  if (!SCENES[name]) throw new Error("unknown scene: " + name);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `scene-${name}.html`);
  /* The scene lives outside www/, so www-relative <script src> would 404 —
     and a missing jsQR silently flips Scanner.supported() to false, which
     changes the invite screen's copy. Absolutise them. */
  const wwwDir = path.join(ROOT, "www");
  const fixed = html.replace(/(<script[^>]*\bsrc=")(?!https?:|file:)([^"]+)(")/g,
    (_, a, rel, b) => a + "file://" + path.join(wwwDir, rel) + b);
  fs.writeFileSync(file, fixed.replace("</body>", `<script>${PROFILE}\n${SCENES[name]}<\/script>\n</body>`));
  return file;
}

if (process.argv[1] && process.argv[1].endsWith("make-scene.mjs")) {
  const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);
  for (const n of want) console.log("built", buildScene(n));
}
