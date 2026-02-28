# DEVLOG - Kitten Knight (Civ)

Human-readable change log for iterative runs.

---

## 2026-02-27 19:08 CST - v0.9.20 Decision Inspector: show decision origin (rule vs score)

Summary
- Decision Inspector now explicitly shows whether the current task came from **RULE**, **EMERGENCY**, **COMMIT**, or normal **SCORE** selection.
- When **Autonomy** sampling picks something other than the strict best score, the inspector calls that out (makes emergence debuggable).
- For rule/emergency/commit decisions, we still show the last computed score table as **informational context** (so you can see what they *would* have done).
- No save break: decision metadata is transient and stripped during save.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Trigger a safety rule (e.g., hunger/tired), then click that kitten row and confirm the inspector reads **Decision: RULE/EMERGENCY** instead of looking like the score picker “changed its mind”.

---

## 2026-02-27 18:23 CST - v0.9.17 Director action: Hold Council (dissent/compliance lever)

Summary
- Added **Hold Council** button: spend **food + science** to reduce colony **Dissent** and temporarily boost **Compliance**.
- Council is a timed, transparent effect (`councilUntil`) shown in the **Season** panel; while active, dissent decays faster.
- Slight immediate mood bump on council to reinforce “cohesion restored” feel.
- Compliance formula now includes a small temporary bonus while Council is active (kept bounded + explainable).
- Migration-safe: old saves default `effects.councilUntil = 0` (no save break).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Push Dissent into **murmur/strike** (high work pace + Tight rations), then press **Hold Council** and watch Compliance jump + Loafing drop.

---

## 2026-02-27 18:08 CST - v0.9.16 Patch notes modal (auto-opens once per version)

Summary
- Added a **Patch Notes** button in the header.
- Patch notes now display in a **modal** (re-uses the existing modal styling) instead of only logging into the event log.
- On version update, patch notes **auto-open once**, tracked via `meta.seenVersion` in the save.
- Keeps explainability: patch notes are explicit player-facing deltas (no hidden AI changes).
- No save-breaking changes; existing saves load cleanly.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Refresh the page after this update and confirm the patch notes modal opens once; then refresh again and confirm it **does not** re-open.

---

## 2026-02-27 17:53 CST - v0.9.15 Policy control: Mentor multiplier + preset support

Summary
- Added **Mentor** to the **Policy multipliers** panel (0..2), letting you explicitly throttle or boost colony-wide skill training.
- Mentor now shows up (and is editable) once **Libraries** are unlocked; it stays disabled/hidden behind the tech gate before that.
- Updated all **Policy presets** to include Mentor (Advance boosts it; Defend/Survive de-emphasize it).
- Plan summary now includes Mentor, and over-budget shaving now considers Mentor earlier (so it won’t “crowd out” critical work when population is small).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- In **Advance** mode with **Libraries** unlocked, crank **Mentor mult → 2.0** and watch low-skill kittens catch up faster (then set it to 0.0 to stockpile science).

---

## 2026-02-27 17:23 CST - v0.9.13 Fix: Tight rations now correctly raise dissent (Feast eases it)

Summary
- Fixed a logic inversion in the **Dissent** model: **Tight rations** (lower food use) now *increase* dissent pressure, while **Feast** rations now *reduce* it slightly.
- This makes the social layer behave intuitively: starving them “politely” causes murmurs/slowdowns faster; feeding well buys cohesion.
- No save-breaking changes; just a corrected driver in the 1s dissent update.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Flip rations **Tight → Feast** for ~30–60s and watch **Dissent%** trend reverse (especially if Work pace is high).

---

## 2026-02-27 17:08 CST - v0.9.12 Social slowdown: new Loaf action (dissent → visible productivity drag)

Summary
- Added a new personal task: **Loaf** — a morale-recovery action that becomes more attractive when **Mood is low** and especially when **Dissent is high**.
- This turns the Dissent system into a more *legible* civ-sim effect: high dissent now shows up as a real **soft strike / idle time** (instead of only abstract plan-compliance drift).
- Loaf is intentionally self-limiting: it is heavily penalized during **food emergencies** and when **Winter is cold**, so the colony still fights to survive.
- Updated safety-rule action picker + action list to include Loaf (you can force it with a rule if you want, but it’s mainly emergent).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `scripts/parse_check.js`
- `DEVLOG.md`

What to try
- Crank **Work pace 120% + Tight rations** and watch Dissent rise; you should start seeing some kittens pick **Loaf** (then restore cohesion with Discipline / better rations / festival).

---

## 2026-02-27 16:53 CST - v0.9.11 Projects: show which reserve blocks each build

Summary
- Projects panel now shows **which reserve-protected inputs** are blocking progress (wood/science/tools), per project.
- Workshops and libraries are now much easier to debug (e.g., “blocked by science reserve” vs looking like AI is just idling).
- Keeps the system incremental + explainable: this is purely UI feedback, no new hidden rules.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Set a high **Science reserve** (e.g., 200), then try to build a Workshop/Library and confirm the Projects panel calls out **science reserve** as the blocker.

---

## 2026-02-27 16:38 CST - v0.9.10 Social layer: Dissent + Discipline (plan compliance becomes emergent)

Summary
- Added a **Dissent** meter (0–100%) that rises when mood is low + policies are harsh (high work pace, tight rations, prolonged hunger, alarms).
- Dissent directly reduces **plan + role pressure** via a new *Compliance* multiplier; high dissent means more wandering/rotation and less perfect central planning.
- Added a new Director slider: **Discipline** — restores compliance and reduces effective autonomy sampling, but has a small steady **morale cost**.
- Added explainability: Season panel shows Autonomy (base + effective), Discipline, Dissent, and current **compliance x…**.
- Save-safe: new fields default in (director.discipline, social.dissent). Old saves auto-initialize.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Set **Work pace 120% + Tight rations** and watch Dissent climb (plan compliance drops), then raise **Discipline** or ease policies to restore cohesion.

---

## 2026-02-27 15:22 CST - v0.9.5 Advisor quick actions (click to apply policy nudges)

Summary
- Advisor now generates **clickable quick actions** when it detects a problem (food, warmth, defense, housing, tools, science).
- Each action applies a **small, explainable nudge**: bumps relevant policy multipliers, toggles the right signal (FOOD/BUILD/ALARM where allowed), and may raise a matching reserve to reduce overspend thrash.
- Keeps the "policy management" vibe: you’re still steering, but now the advisor can be acted on in 1 click instead of manual slider hunting.
- Save-safe: no schema changes required; it only edits existing policy/signal/reserve fields.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Intentionally starve (drop Forage/Farm), then click **Food stabilize** and watch the plan debug swing back toward food within a few seconds.

---

## 2026-02-27 15:07 CST - v0.9.4 Season forecast (end-of-season + Winter projections)

Summary
- Added **Season forecast** lines: projects food/kitten + warmth at **end of season** and **at Winter start** using the smoothed trend rates.
- Forecast is explicitly *best-effort*: it assumes the last few seconds of rates continue (good for spotting spirals early).
- Makes Director policy more legible: you can see whether you’re safe to push growth or should toggle Winter Prep / Crisis.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Watch the Season forecast while toggling **Rations** and **Work pace**; see if the Winter projection flips from red-zone to stable.

---

## 2026-02-27 14:52 CST - v0.9.3 Auto Recruit (Spring immigration)

Summary
- Added **Auto Recruit** Director toggle: once per year, during Spring, a stray kitten can join if the colony is clearly stable.
- Recruitment is explainable + not free: it consumes food, respects your **Food reserve**, and requires low threat + good mood + surplus food/kitten.
- Added season panel line showing Auto Recruit eligibility (and whether you already recruited this year).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Enable **Auto Recruit**, stabilize food/kitten above target in Spring, and watch for the “stray kitten joined” log event.

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

---

## 2026-02-27 15:37 CST - v0.9.6 Autonomy now sometimes picks #2/#3 scored tasks

Summary
- Autonomy no longer just weights likes/dislikes/roles: at higher autonomy, kittens will occasionally choose a **near-top alternative** instead of always taking the single best score.
- This makes the colony feel more �civ sim�: same policy can produce different individual behaviors (without turning into pure randomness).
- Kept explainable: the **Why** line now shows when autonomy caused a non-top pick (e.g. `autonomy picked #2/3`).
- Inspector still shows the full top scoring list so you can see what they *could* have done.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set **Autonomy = 80%** and **Mode = Advance**, then watch if different kittens �freestyle� into research/industry even while the plan biases food/wood.

---

## 2026-02-27 15:52 CST - v0.9.7 Projects panel (progress bars + focus buttons)

Summary
- Added a **Projects** panel under Plan debug: shows live progress bars for Hut/Palisade/Granary/Workshop/Library.
- Each project includes a 1-click **Focus** button that sets Project focus (a build-order nudge) without hunting the dropdown.
- Explicitly surfaces when building is **blocked by your Wood reserve**, so "stalled" progress is explainable (buffers did it).
- Kept Season panel�s compact "Projects:" summary line for quick scanning.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Start a Hut, then crank **Wood reserve** above current wood and confirm the Projects panel shows "blocked by wood reserve" (and progress stops) until you lower the reserve.

---

## 2026-02-27 16:07 CST - v0.9.8 Director Profiles (save/load policy stacks)

Summary
- Added **Director Profiles**: three slots (A/B/C) you can Save/Load/Clear.
- Each profile captures your full **policy stack**: mode, targets, reserves, policy multipliers, role quotas, and signals.
- Profiles also remember **Project Focus + Autonomy + Work pace**, so seasonal playbooks become one-click swaps.
- Save-safe migration: old saves simply get empty profile slots.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Save a stable setup in **A**, then intentionally wreck your policy (e.g., set Forage=0). Load **A** and watch the plan + assignments snap back within 1�2 decision ticks.

---

## 2026-02-27 16:23 CST - v0.9.9 Preference + autonomy flags in colony table

Summary
- Colony table **Traits** column is now compact (likes/hates counts) with the full list in a tooltip.
- Added a new **Pref** column that shows when a kitten is doing a **liked** or **disliked** task.
- Pref also surfaces an **Autonomy** tag when the kitten sampled a non-#1 scored option (tiny emergent behavior signal).
- Decision inspector now includes the autonomy sampling note when it happens.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set **Autonomy** to 80�100%, then click kittens and look for �autonomy picked #2/3� in the inspector + **Autonomy** tags in Pref.

---

## 2026-02-27 17:38 CST - v0.9.14 Social loop clarity: Dissent + Compliance surfaced in top stats

Summary
- Added **Dissent** and **Compliance** to the top stat cards so the social layer is visible at-a-glance.
- Dissent now shows its current band (**calm / murmur / strike**) right in the main stats, reducing the �why are they loafing / ignoring plan?� confusion moment.
- Compliance is shown as a multiplier (x0.45..x1.15) so players can immediately see how hard the plan/roles will actually push.
- Updated patch notes + bumped version to **0.9.14**.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Crank **Work pace** up and/or set **Tight** rations until dissent rises, then watch **Compliance** drop and task variance/loafing increase.

---

## 2026-02-27 18:38 CST - v0.9.18 Policy lever: Labor doctrine (Balanced / Specialize / Rotate)

Summary
- Added **Labor doctrine** selector: **Balanced**, **Specialize**, **Rotate**.
- Doctrine tunes emergent behavior: **Specialize** increases role pressure + reduces boredom rotation; **Rotate** reduces role pressure + increases boredom rotation.
- Doctrine also slightly affects **Dissent** buildup (Rotate reduces it a bit; Specialize increases it a bit) to reinforce the civ-sim �social texture�.
- Updated autonomy hint to show doctrine-aware **role pressure**.
- Patch notes updated; migration-safe (missing doctrine defaults to Balanced).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Flip doctrine to **Specialize** (Autonomy ~20%) vs **Rotate** (Autonomy ~80%) and watch role stability + Loafing/Dissent trends diverge over a full season.

---

## 2026-02-27 18:53 CST - v0.9.19 Auto Doctrine (Director toggles labor doctrine via dissent)

Summary
- Added **Auto Doctrine** toggle: the Director can switch **Labor doctrine** (Balanced/Specialize/Rotate) based on **Dissent + compliance**.
- When dissent is high, it favors **Rotate** (more natural rotation; slightly reduces dissent buildup).
- When the colony is calm (low dissent, good compliance), it favors **Specialize** (roles stick harder; better momentum/output).
- Adds a short **cooldown** between doctrine switches to avoid flapping.
- Season panel now shows Auto Doctrine status + the current reason (explainability).

Files touched
- prototype/index.html
- dist/index.html
- dist/js/main.js
- DEVLOG.md

What to try
- Turn **Auto Doctrine ON**, crank **Work pace** up to trigger murmurs, then watch it flip to **Rotate**; stabilize with Council/rations and see it drift back toward **Specialize/Balanced**.
