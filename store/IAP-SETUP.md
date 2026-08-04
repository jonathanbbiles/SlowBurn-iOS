# Slow Burn Pro — App Store Connect setup

> **Nothing here is done yet.** The code is in and tested; these are the steps
> in App Store Connect that have to happen before a build with Pro can be
> reviewed. Jonathan + Jessica should settle the content split first (see
> "The split" below) — moving a deck between free and Pro is a one-word change
> in `www/index.html`, but only until it ships.

## 1. Create the in-app purchase

**App Store Connect → Slow Burn → Monetization → In-App Purchases → +**

| Field | Value |
|---|---|
| Type | **Non-Consumable** |
| Reference Name | `Slow Burn Pro` *(internal only, never shown)* |
| Product ID | `com.jonathanbiles.slowburn.pro` **— must match exactly** |
| Price | Jonathan's call. Target **Tier 3 (~$2.99 USD)**. The app never hardcodes it — it reads whatever you set, live from Apple. |
| Cleared for Sale | Yes |

### Localization (English (U.S.))

**Display Name** (30 char max):
```
Slow Burn Pro
```

**Description** (45 char max — Apple's limit is tight):
```
More decks, practices, themes and journal
```

> Apple shows the display name and description on the purchase sheet. Keep the
> description under 45 characters or ASC silently truncates.

### Review information for the IAP

**Screenshot:** required. Use `store/screenshots/iphone69_07_pro.png` — it is
the actual Pro screen, which is what Apple wants to see.

**Review notes:**
```
Slow Burn Pro is a one-time non-consumable that unlocks additional content already bundled inside the app: four extra reflection decks, six extra guided practices, three extra colour themes, and an optional on-device keepsake journal. Nothing is downloaded and no server is involved.

To reach it: launch the app, tap Begin, accept the disclaimer, choose "Just me" (no second device or account needed), then open the "You" tab at the bottom and tap "Slow Burn Pro".

The purchase button calls StoreKit directly and shows the sandbox sheet. "Restore a previous purchase" is on the same screen and is also on the Pro screen after purchase.

The entire six-stage program, two-phone pairing, and the reflection matching are FREE and are not gated by this purchase.
```

## 2. Attach it to the version

Apple requires the **first** in-app purchase to be submitted **with** a version.
In ASC, open the 1.1 version page → **In-App Purchases** → add `Slow Burn Pro`.
If you skip this, the IAP sits at "Ready to Submit" for ever and the purchase
will not work in production.

## 3. Paid Apps Agreement

**ASC → Business → Agreements.** It must read **Active**, with banking and tax
complete. A free app ships fine without it, but **no purchase will ever
succeed** until it is active — including in review.

## 4. Sandbox test before submitting

**ASC → Users and Access → Sandbox Testers** → create one if there isn't one.
On the device: Settings → App Store → sign out of the *sandbox* account, then
run the TestFlight build and tap Unlock. The sandbox sheet must appear.

If it does not, in Safari's Web Inspector:
```js
SlowBurnIAP.diagnose()
// {native, ready, pluginPresent, proLoaded, proPrice, ownsPro,
//  proPersisted, initError, lastError, missingHooks}
```
`ready:false` → StoreKit never started. `proLoaded:false` → the product ID does
not match ASC, or it is not Cleared for Sale, or not attached to the version.

## 5. Existing tip jar — unchanged

The three consumable tips (`…tip.small` / `.medium` / `.large`) are untouched
and still register in the same `store.register()` call. They unlock nothing.

---

# The split — for Jonathan + Jessica to approve

**Everything below is one word to change.** Each deck, practice and theme has a
`pro: true|false` flag in `www/index.html`; flip it and the reflection screen,
the paywall and the Pro tab all follow automatically. Nothing else in the app
needs touching. **Please settle this before the first Pro build ships** — after
that, moving a deck from Pro to free is generous, and moving one from free to
Pro takes something away from people who paid nothing for it but had it.

## Reflection decks

| Deck | Free / Pro | What it is |
|---|---|---|
| **The essentials** — 8 + 8 chips | **FREE** | Pace, attention, safety. The deck 1.0 shipped with, frozen for ever (it is the vocabulary paired phones share). |
| Presence & attention | Pro | Being properly looked at, breathing together, the quiet between us. |
| Sensation & body | Pro | Warmth, pressure, weight, texture — the physical grain of it. |
| Asking & telling | Pro | How the consent conversation actually went, not just that it happened. |
| Afterwards | Pro | Staying close, being covered up, what happened once it ended. |

## Practices

| Practice | Free / Pro |
|---|---|
| Three-minute arrival | **FREE** |
| Hands only | **FREE** |
| The long exhale | Pro |
| Map and name | Pro |
| Switch on a timer | Pro |
| Stillness practice | Pro |
| One sense at a time | Pro |
| The unhurried finish | Pro |

## Themes

| Theme | Free / Pro |
|---|---|
| Ember (the current look) | **FREE** |
| Midnight / Sage / Dawn | Pro |

## Keepsake journal — Pro, and **off by default**

Pro includes an on-device journal of past reflections. It is **off until the
user switches it on**, and switching it off deletes what is stored.

That default is a deliberate call and the one most worth a second opinion. A
reflection — including the free-text note — is the most personal thing in Slow
Burn, and the journal is the only feature that writes one to disk. Defaulting
to off means a paying user has to find and enable it; defaulting to on means
people's notes are on disk before they have thought about it. **Jessica may
well have a view.** Changing it is one line (`loadJournal()`).

## What stays free, deliberately

Not a trial, and the paywall says so in these words:

- All six stages, solo and partnered, with every step and boundary
- Two-phone pairing, end-to-end encrypted, with the safety word and the QR
- The consent gate — the thing the app is actually for
- The 16-chip essentials deck **and the full cross-device reflection match**
- Two practices, the clinician directory, and the tip jar

A free user can run the entire Sensate Focus program with a partner, for ever,
and never hit a wall. Pro is more vocabulary and more ways in — not permission.
