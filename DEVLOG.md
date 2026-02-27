# DEVLOG - Kitten Knight (Civ)

Human-readable change log for iterative runs.

---

## 2026-02-27 14:37 CST - v0.9.3 Decision inspector (click kitten for full scoring)

Summary
- Added a clickable **Decision inspector** modal: click any kitten row to see its top scored actions + detailed reason strings.
- Stored a small per-kitten scoring snapshot each decision tick (top 10 actions) and strip it from saves to avoid save bloat.
- Added modal UX polish: click backdrop or press Esc to close.
- UI hint: table now tells you you can click rows for the breakdown.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Start a colony, let it run ~5s, then click a kitten row and verify the scoring list updates as needs/season/policy change.

---

## 2026-02-27 12:19 CST - Modularization prep (CSS/JS extraction)

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

## 2026-02-27 12:22 CST - v0.8.4 Mood + policy friction

Summary
- Added a per-kitten **Mood** stat (0-100%) that drifts based on personality alignment + stressors (hunger/cold/ALARM).
- Mood softly affects **efficiency** (small multiplier) so "happy specialists" feel a bit more productive.
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

## 2026-02-27 12:37 CST - v0.8.5 Festivals (morale lever)

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

---

## 2026-02-27 12:52 CST - v0.8.6 Offline gains (small cap)

Summary
- Added **offline gains**: on load, the sim advances based on last real-world save time.
- Capped offline simulation to **~180s** to avoid log spam and runaway spirals.
- Save-safe migration: saves now store `meta.lastTs` (older saves default to 0).
- Added patch notes for the new offline behavior.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `dist/js/pwa.js`
- `DEVLOG.md`

What to try
- Play for ~30s, refresh the page, and confirm you get an "Offline gains" log line and visible resource changes.

---

## 2026-02-27 13:07 CST - v0.8.7 Policy Advisor panel

Summary
- Added an **Advisor** panel that reads current goals + trends and suggests which policy knobs to nudge (non-binding, explainable).
- Advisor focuses on the 3 core failure modes: **food stability**, **warmth pressure**, and **raid/threat risk**, plus housing caps.
- Suggestions reference existing controls (Policy multipliers, FOOD/ALARM signals, Winter Prep, reserves) to reduce "what do I do now?" stalls.
- Kept output intentionally short (top issues only) so it's scannable mid-run.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`

What to try
- Intentionally dip below food/kitten or warmth target and see if Advisor recommends the same nudge you'd do manually (Forage/Farm/StokeFire/Guard).

---

## 2026-02-27 13:22 CST - v0.8.8 Auto Mode (director mode switching)

Summary
- Added **Auto Mode** toggle (Director) to automatically switch Mode (Survive/Expand/Defend/Advance) based on simple stability checks.
- Added an **explanation line** to the Season panel showing *why* Auto Mode is currently choosing its behavior.
- Implemented a **15s cooldown** between Auto Mode switches to prevent mode-flapping.
- Refactored mode switching into a shared `setModeCore(...)` so manual clicks and Auto Mode behave identically.
- Save-safe migration: older saves default `director.autoMode*` fields to OFF.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Turn on **Auto Mode**, then deliberately trigger a shortage (drop warmth or food/kitten) and watch it snap to Survive/Defend; stabilize and see it drift back to Advance.

---

## 2026-02-27 13:37 CST — v0.8.9 Aptitude bias (skills influence AI + mood)

Summary
- Added an **Aptitude bias** in action scoring: kittens now gently prefer tasks they have higher skill in (emergent specialization).
- Mood now includes a small **aptitude fit** factor: doing your top-skill work feels slightly better; being forced far off-skill feels slightly worse.
- UI: added **Apt** column in the kitten table (shows each kitten's top skill + level); updated Mood tooltip.
- Save-safe migration: older saves now auto-fill missing `k.skills` / `k.xp` keys.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set a strong policy bias (e.g., ChopWood x2) for a few minutes, then relax it and watch the colony keep naturally assigning high-Woodcutting kittens back to wood tasks (and see mood stay higher when they get their aptitude work).

---

## 2026-02-27 13:52 CST � v0.9.0 Mentoring (science ? skills)

Summary
- Added a new **Mentor** task (unlocks with **Libraries**): spend science to train a lagging kitten in the mentor�s top skill.
- Mentor respects **science reserves**; if science is protected/scarce, it immediately falls back to **Research** (no wasted ticks).
- AI now considers Mentor during **stable** periods (especially in **Advance** mode) as a long-run compounding choice.
- UI: when a kitten is Mentoring, the Task column shows the **target kitten #** and **skill** for explainability.
- Added a small build helper script to rebuild dist/ directly from prototype/index.html to keep them in sync.

Files touched
- prototype/index.html
- dist/index.html
- dist/css/app.css
- dist/js/main.js
- scripts/build_dist_from_prototype.js
- DEVLOG.md

What to try
- Reach **Libraries**, set Mode ? **Advance**, keep science above your reserve, and watch Mentoring raise underleveled skills (especially Building/Combat) over time.

---

## 2026-02-27 14:07 CST - v0.9.1 Autonomy slider (central planning vs individuality)

Summary
- Added **Autonomy** slider (0�100%) to tune how strongly kittens follow their personality likes/dislikes.
- Autonomy now scales **personality scoring** (likes/dislikes) and **boredom/rotation** pressure.
- Autonomy inversely scales **role pressure**, so low autonomy feels more "central planning" (stronger specialization push).
- Mood alignment (likes/dislikes) now scales with Autonomy, making emergent behavior more noticeable.
- Explainability: Season panel now prints Autonomy details (+likes/-dislikes weights).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set Autonomy to **100%**, run +10s a few times, and watch kittens self-sort into liked tasks even if you keep policy multipliers at 1.0.

---

## 2026-02-27 14:22 CST - v0.9.2 Work Pace policy lever

Summary
- Added **Work pace** (80%..120%) as a new Director policy lever: higher pace increases output/build speed, but also increases fatigue/hunger costs and slowly drifts mood downward.
- Applied Work pace across productive tasks (forage/farm/wood/guard/research/build/craft/mentor) so the tradeoff is consistent and readable.
- UI: added a Work pace slider + live hint (output vs fatigue + mood drift direction).
- Save-safe migration: older saves default to Work pace = 100%.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- In Winter, set Work pace to **120%** for ~20–30s to stabilize warmth/threat, then drop to **90%** and watch mood/efficiency recover.
