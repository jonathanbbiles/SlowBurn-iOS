# Slow Burn — App Store listing (copy/paste ready)

> Paste each field into **App Store Connect → Slow Burn → (version)**.
>
> **Slow Burn is a PAID app.** One price up front; everything in it is
> included. There is no in-app unlock, no subscription and no gated content.
> Jonathan sets the price tier in App Store Connect (~$2.99 target).
>
> ⚠️ lines below were corrected from an older listing that predated the
> inclusivity redesign and the end-to-end encrypted pairing.
>
> 🚨 **Rewritten for the Guideline 1.1 rejection (Aug 2026).** Apple rejected the
> listing under 1.1 — Objectionable Content, citing the app's marketing and
> metadata, and warned that "similar marketing and concept" would draw the same
> violation again. Every reference to a sexual act, sexual anatomy, or a
> sex-therapy service is now gone from this listing and from all six screenshots.
> The reasoning, the full before/after and the offending-string table live in
> `store/1.1-remediation-notes.md`. **This file is the source of truth for the
> listing; keep ASC matching it.**

## Names & identifiers
- **App Name (30 max):** `Slow Burn: Couples Connection` *(29)* — 🚨 *ASC had drifted
  to `Slow Burn: Couples Intimacy`, a suffix that was never in this repo.*
- **Subtitle (30 max):** `Reconnect, at your own pace` *(27)* — 🚨 *was "Rebuild
  intimacy, at your pace"; before that "Rebuild intimacy, together", which
  excluded solo users. "at your pace" is the app's own tagline and stays.*
- **Bundle ID:** `com.jonathanbiles.slowburn` ⚠️ *was a `com.CHANGE-ME.slowburn` placeholder*
- **Primary category:** Health & Fitness · **Secondary:** Lifestyle
- **Age rating:** answer truthfully — no imagery, instructional/clinical, but
  references sexual activity, so expect **17+**. Under "Medical/Treatment
  Information" note it is educational wellness, not treatment.

## Promotional text (170 max — editable anytime without review)
```
A calm, step-by-step program for rebuilding closeness at your own pace — on your own or with a partner. Built on Sensate Focus, used by licensed therapists for decades.
```
🚨 *168 chars. Was: "…through guided, unhurried touch — …based on the method **sex
therapists** have used for decades."*

## Keywords (100 max, comma-separated, no spaces)
```
sensate focus,couples,relationship,intimacy,reconnect,connection,closeness,marriage,partner,mindful
```
🚨 *99 chars. Removed `sex therapy`, `desire`, `libido`. Added the full clinical term
`sensate focus` (near-empty search space), plus `reconnect`, `partner`, `mindful`.
`intimacy` kept — Jonathan's call; it is the first thing to drop if Apple bounces again.*

## Description
```
Slow Burn is a guided closeness program — a calm, structured way to rebuild connection at your own pace, on your own or with a partner.

It's built on Sensate Focus, a structured, step-by-step method developed by clinical researchers in the 1970s and used by licensed therapists ever since. Instead of a single session, Slow Burn turns the protocol into a six-stage program you move through one unhurried step at a time.

HOW IT WORKS
• A staged program — from simple, pressure-free connection through to full integration — with clear, clinical guidance for each session. Every stage has a solo form as well as a partnered one.
• A readiness gate that removes the awkward part. With a partner, the next stage opens only when you have BOTH privately tapped "I feel ready." No negotiating, no pressure.
• Private reflections after each session. You each answer a few questions on your own — and Slow Burn only ever surfaces what you BOTH named. Never the rest.
• Gentle, never-nagging reminders to keep the practice going.

FOR EVERY KIND OF PERSON
Slow Burn adapts its language to you — your pronouns, your words for your partner, your relationship structure. It assumes no gender, no orientation, and no particular shape of relationship.

WHO IT'S FOR
Anyone reconnecting after a long stretch of drift — a new baby, a health change, a recovery, a stressful season, or simply years of two people moving at different speeds. It's for feeling close again, calmly and privately.

PRIVATE BY DESIGN
No account. No ads. No analytics. Nothing is collected about you. Your identity settings and your written notes never leave your device. If you pair two phones, they agree on a key only they hold and everything between them is end-to-end encrypted — the relay in the middle carries scrambled bytes it cannot read, and keeps none of them.

A NOTE FROM US
Slow Burn is a wellness and education program. It is not medical advice, and it is not a substitute for care from a qualified clinician. If you are managing pain, a medical condition, recovery, or a history of trauma, please work with a licensed therapist or a pelvic-floor physical therapist. The app links you to trusted professional directories to find one.
```
🚨 *The word "touch" is deliberately absent this round. Sensate Focus **is** a touch
protocol, so re-add "guided, unhurried touch" to HOW IT WORKS once 1.0 is approved —
Jonathan's call, deferred to keep this submission as clean as possible.*

⚠️ *The old PRIVATE BY DESIGN paragraph said "your reflections stay on your
device". That is no longer true and must not ship: with two paired phones, your
reflection **chip selections** cross the link (end-to-end encrypted) so the app
can show what you both welcome. Your written notes still never leave the phone.
See PRIVACY.md.*

## URLs
- **Privacy Policy URL (required):** `https://jonathanbbiles.github.io/app-privacy/slowburn.html` ⚠️ *live, verified 200*
- **Support URL (required):** `https://jonathanbbiles.github.io/app-privacy/slowburn.html`
  *(same page — it carries the support email, matching the scootstep/bullorbust convention)*
- **Marketing URL (optional):** `https://www.jessicaleighbiles.com`

## App Review — Notes (paste into "App Review Information → Notes")
⚠️ *Rewritten. The old notes told the reviewer to pick "Explore solo on one
phone" on a "How are you trying it?" screen and to use a "Sam / Alex" toggle.
None of those labels exist any more — a reviewer following them would have
concluded the app was broken.*
```
Slow Burn is a clinical wellness / education app based on Sensate Focus (Masters & Johnson), a standard sex-therapy exercise protocol. Content is instructional text only — there is NO explicit or sexual imagery. A not-medical-advice disclaimer is shown on first launch and must be acknowledged before the app can be used. The app links users to licensed-clinician directories (AASECT, APTA Pelvic Health).

TO REVIEW THE WHOLE APP ON ONE DEVICE, NO SECOND PHONE AND NO ACCOUNT:
1. Tap Begin, tick the acknowledgement, tap Continue.
2. On the "Who's practising?" screen, either:
   - tap "See a sample walkthrough" for a clearly-labelled example couple (Rowan & Ari, both they/them) with the whole flow already populated, or
   - tap "Me and a partner", then on the next screen choose "Share this one device". A toggle appears at the top of the screen to switch between the two people, which exercises the dual-consent unlock and the mutual-match check-ins on a single device.
3. "Just me" gives the full solo program — every stage has a solo form and nothing is locked off.

No login is required at any point. Nothing is collected about the user. The optional two-phone pairing feature uses an anonymous randomly generated pair code; the two phones perform an ephemeral ECDH key exchange and encrypt everything they exchange with AES-GCM, so the relay carries only ciphertext and retains nothing. The pair code itself is never transmitted.

PAIRING AND THE CAMERA (not required to review the app): pairing two phones is optional and the reviewer does not need it — steps 2 and 3 above exercise everything on one device. If you do try it, the pair code can be typed, or scanned: the QR contains ONLY the ten-character pair code, and the app's own in-app scanner reads it. No URL is opened and no web page is involved. The camera is used solely to decode that code on-device; no image is recorded, stored or transmitted, which is why the app declares no data collection. Declining the camera permission simply hides the scan button and leaves the typed-code path, which is identical.

BUSINESS MODEL: Slow Burn is a one-time PAID app. The purchase price on the App Store is the only transaction. There are NO in-app purchases, NO subscriptions, NO tip jar, and NO unlockable, locked or premium content of any kind. The binary contains no StoreKit code and does not link the in-app purchase framework. Everything described above — all six stages, all five reflection decks, all eight practices, all four themes, the keepsake journal, and two-phone pairing — is available to every user immediately on first launch, with no account and no further payment.

Note on wording: the app says a stage "unlocks" when both partners privately confirm they are ready. That is the consent gate, which is the core feature of the program — it is a progress gate between two people, not a purchase or a paid tier.

RE: THE PREVIOUS 1.1 REJECTION. The app's name, subtitle, description, promotional text, keywords and all screenshots have been rewritten. Every reference to sexual acts, sexual anatomy and sex-therapy services has been removed from the store listing and from every screenshot image. The listing now describes the app as what it is: a structured, staged program for rebuilding closeness and communication between partners, based on Sensate Focus. The app contains no imagery of any kind — all content is instructional text, gated behind a first-launch wellness / not-medical-advice acknowledgement that must be accepted before the app can be used, and rated 17+ accordingly.
```

## App Privacy ("nutrition label" answers)
- **Do you collect data from this app?** → **No / Data Not Collected.**
  No account; identity settings and written notes stay on-device; the paired-phone
  link is end-to-end encrypted between two users' own devices, is not readable by
  us or by the relay, is not retained, and is not linked to any identity; no
  analytics; no ads; no tracking. Tips are handled by Apple; we receive no
  customer data.
- **Camera:** requested only to decode a pair code on-device. No image or
  derived data is collected, transmitted or stored, so there is nothing to
  declare — "Data Not Collected" is still the correct answer. The permission
  string users see is set by the build lane (see codemagic.yaml).

## Export compliance
- **Does your app use encryption?** Yes.
- **Does it qualify for an exemption?** Yes — the app implements no cryptography
  of its own; it calls WebCrypto, which is part of iOS (WebKit), and uses it only
  to secure the app's own pairing link. `ITSAppUsesNonExemptEncryption=false` is
  set by the build lane, which is why no per-build prompt appears.

## Copyright
`© 2026 Jonathan Biles`
