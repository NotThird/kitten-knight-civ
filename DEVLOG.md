# DEVLOG — Kitten Knight (Civ)

Human-readable change log for iterative runs.

---

## 2026-02-27 12:19 CST — Modularization prep (CSS/JS extraction)

Summary
- Extracted the large inline `<style>` into `dist/css/app.css`.
- Extracted the large inline game `<script>` into `dist/js/main.js`.
- Left PWA service worker registration in `dist/js/pwa.js`.
- Rewrote `dist/index.html` to load `main.js` as an ES module.
- Verified the modularized build still renders + runs in a browser.

Files touched
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `dist/js/pwa.js`
- `scripts/extract_inline_to_modules.js`
- `DEVLOG.md`

What to try
- Load the local build and confirm the game still runs; then open DevTools → Network and ensure `css/app.css` + `js/main.js` load (no 404s).

---

## 2026-02-27 12:22 CST — v0.8.4 Mood + policy friction

Summary
- Added a per-kitten **Mood** stat (0–100%) that drifts based on personality alignment + stressors (hunger/cold/ALARM).
- Mood softly affects **efficiency** (small multiplier) so “happy specialists” feel a bit more productive.
- Low-mood kittens slightly bias toward **Rest**, creating emergent slowdowns if policy fights personalities too hard.
- UI: added **Mood** column in the kitten table and **avg mood** in the Season panel.
- Save-safe migration: older saves default mood to 55%.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set Policy preset **Advance**, then toggle **ALARM** / run through Winter: watch mood dip and see which kittens start seeking Rest (and whether role quotas/policy can keep productivity stable).

---

## 2026-02-27 12:37 CST — v0.8.5 Festivals (morale lever)

Summary
- Added **Hold Festival** button (Director): spend food+wood above reserves to trigger a ~50s morale boost.
- Festival gently increases mood drift for all kittens while active (small but readable productivity impact via mood).
- UI: Festival becomes an **active timer** on the button and is also shown in the **Season** panel for explainability.
- Save-safe migration: older saves now auto-add `effects.festivalUntil`.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Hoard some food/wood, hit **Hold Festival**, then watch avg mood climb and see if low-mood kittens stop bailing into Rest during a stressful Winter/ALARM window.
