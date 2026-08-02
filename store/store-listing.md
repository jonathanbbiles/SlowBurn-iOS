# Slow Burn — App Store listing (copy/paste ready)

> Paste each field into **App Store Connect → Slow Burn → (version)**.
>
> **CHANGED 2 Aug 2026 — needs Jonathan + Jessica's sign-off on the ⚠️ lines.**
> The previous listing was written before two things happened: the inclusivity
> redesign (the app is no longer couples-only — it has a full solo mode and does
> not assume a gender, orientation or relationship structure), and the
> end-to-end encrypted pairing link. Three claims in the old copy are now
> factually wrong and one set of review notes points a reviewer at buttons that
> no longer exist. Those are corrected below and marked ⚠️.

## Names & identifiers
- **App Name (30 max):** `Slow Burn`
- **Subtitle (30 max):** ⚠️ `Rebuild intimacy, at your pace` — *was "Rebuild intimacy,
  together", which excludes solo users; the app's own tagline is "at your pace".*
- **Bundle ID:** `com.jonathanbiles.slowburn` ⚠️ *was a `com.CHANGE-ME.slowburn` placeholder*
- **Primary category:** Health & Fitness · **Secondary:** Lifestyle
- **Age rating:** answer truthfully — no imagery, instructional/clinical, but
  references sexual activity, so expect **17+**. Under "Medical/Treatment
  Information" note it is educational wellness, not treatment.

## Promotional text (170 max — editable anytime without review)
```
A private, step-by-step program for rebuilding closeness through guided, unhurried touch — on your own or with a partner, based on the method sex therapists have used for decades.
```

## Keywords (100 max, comma-separated, no spaces)
```
intimacy,couples,relationship,sensate,sex therapy,desire,marriage,connection,libido,closeness
```

## Description
```
Slow Burn is a guided intimacy program — a calm, structured way to rebuild physical closeness at your own pace, on your own or with a partner.

It's built on Sensate Focus, the touch-based method sex therapists have used since Masters & Johnson. Instead of a single therapy session, Slow Burn turns the protocol into a six-stage program you move through one unhurried step at a time.

HOW IT WORKS
• A staged program — from unhurried, non-genital touch through to integration — with clear, clinical guidance for each session. Every stage has a solo form as well as a partnered one.
• A consent gate that removes the awkward part. With a partner, the next stage unlocks only when you have BOTH privately tapped "I feel ready." No negotiating, no pressure.
• Private reflections after each session. You each answer a few questions on your own — and Slow Burn only ever surfaces what you BOTH named. Never the rest.
• Gentle, never-nagging reminders to keep the practice going.

FOR EVERY KIND OF PERSON
Slow Burn adapts its language to you — your pronouns, your words for your partner, your relationship structure. It assumes no gender, no orientation, and no particular shape of relationship.

WHO IT'S FOR
Anyone navigating desire differences, postpartum recovery, menopause, erectile changes, recovery after illness, or simply years of drift. It's for reconnecting — calmly and privately.

PRIVATE BY DESIGN
No account. No ads. No analytics. Nothing is collected about you. Your identity settings and your written notes never leave your device. If you pair two phones, they agree on a key only they hold and everything between them is end-to-end encrypted — the relay in the middle carries scrambled bytes it cannot read, and keeps none of them.

FROM THE TEAM
Slow Burn is a wellness and education program. It is not medical advice, and it is not a substitute for care from a qualified clinician. If you are managing pain, a medical condition, recovery, or a history of trauma, please work with a licensed sex therapist or pelvic-floor physical therapist. The app links you to trusted directories to find one.
```

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

The tip jar (Us tab → Support Slow Burn) is optional and unlocks nothing — the entire program is free. Tip buttons render only once StoreKit has returned purchasable products, so they are never dead.
```

## App Privacy ("nutrition label" answers)
- **Do you collect data from this app?** → **No / Data Not Collected.**
  No account; identity settings and written notes stay on-device; the paired-phone
  link is end-to-end encrypted between two users' own devices, is not readable by
  us or by the relay, is not retained, and is not linked to any identity; no
  analytics; no ads; no tracking. Tips are handled by Apple; we receive no
  customer data.

## Export compliance
- **Does your app use encryption?** Yes.
- **Does it qualify for an exemption?** Yes — the app implements no cryptography
  of its own; it calls WebCrypto, which is part of iOS (WebKit), and uses it only
  to secure the app's own pairing link. `ITSAppUsesNonExemptEncryption=false` is
  set by the build lane, which is why no per-build prompt appears.

## Copyright
`© 2026 Jonathan Biles`
