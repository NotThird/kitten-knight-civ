# DEVLOG - Kitten Knight (Civ)

Human-readable change log for iterative runs.

---

## 2026-03-02 03:48 CST - Aquarium: Coterie reputation ledger (respected vs resented)

Summary
- Aquarium depth: coteries now carry a tiny, transient **Reputation** score that decays back to neutral.
- Reputation is derived from recent macro outcomes (no player clicks required):
  - **Raid repelled** nudges circles toward **respected** (especially Safety circles).
  - **Raid hit** nudges circles toward **resented**.
  - **Winter → Spring** transition records a coarse winter outcome (**good** vs **hard**) and nudges reputations accordingly.
- Observability: influential circles can emit **Reputation:** Society feed beats and drop a `kind:'rep'` marker in Trends.
- UI: **Factions → Coteries** shows inline **RESPECT / RESENT** tags when the aura is strong.

Files touched
- `js/main.js`

What to try
- Let a **raid** happen (either outcome), then watch the Society feed for a **Reputation:** line and check **Factions → Coteries** for RESPECT/RESENT tags.
- Survive a **Winter → Spring** flip and see if circles gain/lose aura depending on how stable the colony was.

---

## 2026-03-02 03:33 CST - Aquarium: Coterie feud→truce status arcs (rivalry memory)

Summary
- Aquarium depth: coterie rivalry is now an actual **relationship arc**:
  - a clash sets a short-lived **FEUD** status between the two circles
  - when the timer expires, it automatically cools into a brief **TRUCE** and then fades out
- Observability: emits a **Society feed** truce line + drops **Trends** markers (`kind:'feud'` / `kind:'truce'`).
- UI: **Factions → Coteries** shows inline **FEUD/TRUCE** timer tags so you can see ongoing micro-politics without scrolling the feed.

Files touched
- `js/main.js`

What to try
- Run Curator hands-off with **6+ kittens** until you get an aid-vs-strict rivalry.
- Open **Factions → Coteries** and confirm the **FEUD** tag counts down; then wait for the **TRUCE** flip.

---

## 2026-03-02 03:18 CST - Aquarium: Coterie rivalry beat (aid vs strict)

Summary
- Aquarium depth: influential **mutual-aid** and **strict norms** coteries can now occasionally enter a small **rivalry** beat (deterministic cooldown).
- Consequence (tiny + bounded): members of both circles take a small **Mood** dip and **Grievance** bump (social friction texture).
- Observability: emits a **Society feed** line plus a **Trends** event marker (`kind:'rival'`) so you can correlate politics to macro swings.

Files touched
- `js/main.js`

What to try
- Run Curator hands-off with **6+ kittens** until you have at least one influential **aid** coterie and one influential **strict** coterie.
- Watch the Society feed for a **Rivalry:** line and confirm a matching `rival` marker appears in Trends.

---

## 2026-03-02 03:03 CST - Aquarium: Coterie pressure timers in Factions UI

Summary
- Observability: active **coterie pressure** windows now show inline in **Factions → Coteries** as small tags:
  - `AID 42s` for mutual-aid pressure (member grievance cools faster)
  - `STRICT 18s` for strict-norms pressure (slightly higher dissent desire)
- Pure UI surfacing (no balance changes intended) so the aquarium’s culture beats are readable without scrolling the feed.

Files touched
- `js/main.js`

What to try
- Run Curator hands-off until you see a **Culture:** pressure line.
- Open **Factions → Coteries** and confirm the affected circle shows an `AID …s` or `STRICT …s` tag counting down.

---

## 2026-02-28 23:45 CST - v0.9.133 QoL: Pinned projects auto-clear on completion

Summary
- QoL: pinned projects ("Pin (finish 1)") now auto-clear immediately when the requested build completes.
- Prevents a subtle stuck state where the Director keeps treating the pin as active even after you successfully finished the build.
- Applies to Hut / Palisade / Granary / Workshop / Library pins.
- Patch notes updated.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Pin a Hut (or Palisade) and let it complete; confirm the pin clears and the focus returns to normal behavior.

---

## 2026-02-28 23:15 CST - v0.9.131 QoL: Inspectable stat cards now visibly "clickable"

Summary
- QoL/Explainability: added an **INSPECT** tag + hover highlight to all clickable stat cards (Social, Storage, Threat inspectors).
- Makes the inspector modals discoverable without reading tooltips (click Dissent/Compliance/Focus-fit, Food Cap/Spoilage, or Threat).
- No logic changes to the underlying inspectors; pure UI/UX clarity.
- Patch notes updated.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Hover the Dissent / Food Cap / Threat stat cards and click them to confirm each opens the correct inspector modal.

---

## 2026-02-28 22:30 CST - v0.9.128 Explainability: Reserve hit ETA in top stats

Summary
- Explainability/QoL: top stat cards now show **time-to-reserve** (ETA until Food/Wood/Science/Tools hit your configured Reserves) when the current trend is negative.
- Added a clear **BELOW RES** flag when you are already under a reserve buffer, so "why are builders/crafters refusing?" is obvious immediately.
- Keeps existing time-to-zero forecasts (starvation/freezing/raid) intact.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set Food reserve to ~100 and intentionally overspend into a negative food rate; confirm the Food stat shows an ETA to reserve and flips to **BELOW RES** once crossed.

---

## 2026-02-28 22:14 CST - v0.9.127 QoL: Pin project selector in Director panel

Summary
- QoL: added a **Pin project** selector + **Pin (finish 1)** button directly in the Director panel (no need to scroll to Projects).
- Pinning still auto-clears after **ONE** unit completes.
- Pinning still sets **Project focus** to the matching track (so the AI immediately leans into it).
- UI: pin selector disables projects you haven’t unlocked yet (e.g., Granary before Granaries tech).
- Patch notes updated.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- In early Construction, pin **Hut** from the Director panel and verify it clears automatically after 1 hut completes.

---

## 2026-02-28 21:44 CST - v0.9.125 QoL: Task sorting + preference tags use executed task

Summary
- QoL/Explainability: sorting by **Task** now uses the *effective executed* task (shows fallback tasks when a sink is blocked by reserves/inputs).
- QoL/Clarity: Like/Dislike tags in the Colony table now evaluate against the executed task (so blocked sink attempts don’t mislabel a kitten’s preferences).
- Patch notes updated.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Sort the Colony table by **Task** during a reserve-constrained build (e.g., high wood reserve + BUILD PUSH) and confirm blocked builders cluster under the fallback task you’re actually getting.

---

## 2026-02-28 21:29 CST - v0.9.124 Save stability: cap persisted Event log

Summary
- QoL/Stability: persisted **Event log** is now capped to the last **260** lines (prevents localStorage/save bloat on long runs).
- Migration: older saves auto-trim oversized logs on load.
- Safety: log() now self-heals if the log array is missing/corrupt.
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Let the game run for a while (or spam actions), then Export/Import: the save string should stay a sane size and the game should still load instantly.

---

## 2026-02-28 21:14 CST - v0.9.123 Bloc health panel (values blocs at a glance)

Summary
- NEW: Added a **Bloc health** panel showing each values bloc’s **size + avg fit + avg mood + avg grievance**.
- Explainability: includes a simple “highest-pressure bloc” nudge so you can quickly tell *who* is driving dissent.
- UI-only: no simulation/balance changes; helps policy management feel more like a civ-sim.
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Let dissent climb a bit, then open **Bloc health** and compare the “pressure” hint with what you see in **Factions** (try negotiating that bloc and watch fit/grievance shift).

---

## 2026-02-28 20:59 CST - v0.9.122 Director: Social priority (mood + cohesion steering)

Summary
- Added a **Social** Director priority slider (50–150%) that biases Socialize/Care choices.
- Explainability: Social priority shows up in the Decision Inspector scoring reasons (prio Social x…).
- Colony focus/values alignment now incorporates Social priority (affects focus-fit + bloc alignment).
- Politics: negotiating with the **Social** bloc now nudges prioSocial (plus the existing cohesion-policy tweaks), and the undo snapshot restores it.
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Raise **Social** to ~130% during rising dissent and watch the plan shift toward Socialize/Care (and see the reason lines in the inspector).

---

## 2026-02-28 20:44 CST - v0.9.121 Inspector Directives: persistent + repeatable

Summary
- FIX: Decision Inspector Directive dropdown no longer “works once” (change it as many times as you want).
- Persistence: Changing/clearing a Directive now saves immediately (so refreshes won’t revert it).
- Explainability: Directive changes now write a clear Event log line (who changed to what).
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Click a kitten row → change Directive a few times (Food→Progress→Auto) and verify it persists after refresh.

---

## 2026-02-28 20:29 CST - v0.9.120 Raids now respect defenses (palisade + guards)

Summary
- Combat sim: Raid losses/injuries now scale down based on **Palisade** and **Guards on duty**, with small bonuses from **Security**, **Drills**, and **Curfew**.
- New outcome: strong defenses can fully **repel** a raid (threat knocked back; small morale bump).
- Explainability: Raid log now prints the mitigation factor and the defense snapshot (guards + palisade) so you can see *why* it hurt (or didn’t).
- Version bump + JS parse sanity check.

Files touched
- `prototype/index.html`
- `DEVLOG.md`

What to try
- Let threat hit 100 twice: first with **0 palisade/0 guards**, then with **2+ guards + palisade**, and compare the raid log + damage.

---

## 2026-02-28 20:14 CST - v0.9.119 Director stats: Edible buffer at a glance

Summary
- QoL/Clarity: Added an **Edible** stat (Food+Jerky) so you can see true starvation buffer at a glance.
- Explainability: Food stat subtitle now focuses on **fresh-food** trend + time-to-zero; Edible stat shows **total edible** trend + time-to-zero.
- Tooltip polish: Food tooltip now explicitly says it is **fresh** (spoils); Edible tooltip says it matches starvation checks.
- Version bump + dist rebuild.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Deliberately build up Jerky, then watch how **Edible** stays healthy even if **Food** dips — and compare the two “0 in …” forecasts.

---

## 2026-02-28 19:59 CST - v0.9.118 Faction Demand acceptance: cooldown-safe + better governance logging

Summary
- FIX: Accepting a **Faction Demand** now always applies the intended policy concession (no longer blocked by the normal negotiation cooldown).
- Explainability: Demand outcomes now write explicit **Governance log** entries (Accepted / Ignored / Expired) with concrete consequence deltas.
- Small refactor: `negotiateWithFaction()` now accepts optional opts (cooldown bypass + custom governance log labels) without changing existing callers.
- Version bump + dist rebuild.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Let **Dissent** climb until a **Faction Demand** appears, then spam a normal **Negotiate** right before clicking **Accept** — it should still apply the concession and log the result in Governance log.

---

## 2026-02-28 18:58 CST - v0.9.114 Storage inspector: edible breakdown

Summary
- Explainability: Storage inspector now shows Edible = Food + Jerky (and Edible/Kitten) to match starvation logic.
- Explainability: Clarified that only fresh Food counts toward the storage cap/spoilage; Jerky does not spoil and is your winter bank.
- QoL: Storage inspector now prints a quick “over-cap” formula so players understand why spoilage spiked.
- Version bump + dist rebuild.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Stockpile with PreserveFood: push fresh Food slightly over-cap, convert surplus to Jerky, and confirm spoilage only reacts to fresh Food.

---

## 2026-02-28 16:42 CST - v0.9.105 Policy quick-tune modifiers

Summary
- QoL: Policy +/- buttons now support modifier keys for faster tuning.
- Shift-click changes by ±0.50, Alt-click changes by ±1.00, Ctrl/⌘-click snaps to min/max (0 or 2).
- Added tooltips to make the shortcuts discoverable.
- Version bump + dist rebuild.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`

What to try
- In Policy, Shift/Alt/Ctrl-click +/- to quickly stabilize before Winter (e.g., snap StokeFire/Forage to 2 during crises).

---

## 2026-02-28 16:27 CST - v0.9.104 Auto Recruit fix + why text

Summary
- Fix: Auto Recruit no longer errors when enabled (missing `season` reference in the automation block).
- Explainability: Auto Recruit now writes a short “why” string (housing / season window / stability / food+reserve requirement).
- UI: Season panel shows that Auto Recruit “why” line when Auto Recruit is enabled.
- Patch notes updated.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Enable **Auto Recruit**, then watch the Season panel: it should tell you what condition is blocking recruitment (and it should successfully recruit once you’re stable mid-Spring with spare housing + enough food above reserves).

---

## 2026-02-28 15:42 CST - v0.9.101 Pinned project discoverability

Summary
- QoL: Director panel now shows the currently **Pinned project** (if any) right next to Project focus.
- Added a one-click **Clear pin** button (so you can stop forcing focus without hunting in Projects).
- Explainability: Season panel now also echoes the active pinned project so you remember why focus is being overridden.
- Patch notes updated.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Pin a Hut/Granary from Projects, then confirm the Director + Season panels clearly show the pin and that **Clear pin** stops the forced focus.

---

## 2026-02-28 14:42 CST - v0.9.98 Auto Council + Director automation scoping fix

Summary
- NEW: **Auto Council** Director toggle (holds Council when dissent is high and you can afford it above reserves).
- Explainability: Season panel now shows **Auto council** status + last reason (trigger/waiting).
- Fix: corrected a missing brace that unintentionally gated other Director automations behind **Auto Drills**.
- Patch notes updated to include Auto Council.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Enable **Auto Council**, intentionally push dissent (high Work pace + Curfew), then watch it fire a Council once you have spare food+science.

---

## 2026-02-28 11:57 CST - v0.9.87 Faction negotiation Undo snapshot

Summary
- Factions: **Negotiate** now stores a short-lived **Undo snapshot** (2 minutes) so you can experiment without permanent policy drift.
- Undo restores: Director priorities (Food/Safety/Progress), Work pace, Discipline, and all Policy multipliers.
- UI: Factions panel shows an **Undo** card with an expiry timer.
- Explainability: negotiation snapshots are explicitly described as a prototype affordance (so players understand why it exists).
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Negotiate with any bloc, watch policy drift, then hit **Undo** within ~2 minutes to revert.

---

## 2026-02-28 11:42 CST - v0.9.86 Faction demands expire with consequences

Summary
- Civ-sim pressure: **Faction Demands** no longer silently vanish on timeout.
- If a demand expires unresolved, it now auto-resolves as a **soft ignore** (small dissent + grievance + mood hit for that bloc).
- Explainability: the event log explicitly reports the expiry so you can connect mood/dissent drift to politics.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Let a Demand spawn on a season change, then ignore it and watch the expiry log + small dissent bump.

---

## 2026-02-28 11:27 CST - v0.9.85 Blocked fallback highlight (reserve thrash visibility)

Summary
- UI/Explainability: when a kitten’s chosen task is **BLOCKED** (usually by reserves/inputs) and it executes a fallback (e.g. **BuildHut → ChopWood**), the **Task** cell is now highlighted + tagged.
- Makes it much easier to spot “builders/researchers are stalling” moments and adjust **Reserves / Policy / Project Focus**.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set Wood reserve high (so building blocks), then watch the **BLOCKED** tag appear as builders fall back; tune the reserve until the tag disappears.

---

## 2026-02-28 10:57 CST - v0.9.83 Values bloc column (Faction legibility)

Summary
- UI/Explainability: Colony table now shows each kitten’s **values bloc** (Food/Safety/Progress/Social) as a dedicated column.
- Makes the **Factions/Demands** civ-sim layer more readable at-a-glance (no need to open the inspector to see who’s in which bloc).
- Inspector subheader also now includes the kitten’s bloc.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- In the Colony table, sort mentally by **Bloc** and then hit the **Factions** panel: negotiate with the largest bloc and watch which kittens are “represented.”

---

## 2026-02-28 10:42 CST - v0.9.82 Spoilage warning ping (food storage cap visibility)

Summary
- NEW: Event log now pings once when **Food** exceeds the storage soft cap by a meaningful margin (helps catch silent spoilage loss).
- Explainability: the ping includes **cap, current food, and spoilage multiplier**, plus a direct suggestion (Granary / PreserveFood jerky).
- Save-safe: `_spoilWarned` is transient and stripped on save.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Intentionally overstock food above the **Food Cap** and watch for the one-time **spoilage warning** (then build Granaries or run PreserveFood to stabilize).

---

## 2026-02-28 10:27 CST - v0.9.81 Faction Demands (seasonal politics)

Summary
- NEW: **Faction Demands** can trigger on season change when dissent is meaningful and the dominant values bloc feels misaligned.
- Demand appears in the **Factions** panel with an expiry timer and its trigger reason (explainability).
- You can **Accept** (small policy concession, bigger cohesion/dissent drop) or **Ignore** (dissent spike + grievance for that bloc).
- Logged as an event when it spawns.
- No save-breaking changes (demand state is optional + safe defaults).

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Get dissent into the ~40–70% range, then hit a season change and choose **Accept vs Ignore** to see how quickly cohesion recovers (and which bloc gets mad).

---

## 2026-02-28 10:11 CST - v0.9.80 Policy per-action plan impact (explainability)

Summary
- UI/Explainability: Policy panel now shows per-action plan impact next to each multiplier (**without policy → with policy**).
- Makes it obvious when a quota is changing the colony-level plan vs when behavior is being overridden by needs/autonomy/safety rules.
- Patch notes updated.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Toggle a single policy (e.g., Guard x1.50) and watch the per-action plan preview change immediately, then compare to actual assigned tasks.

---

## 2026-02-28 09:41 CST - v0.9.78 Buddy-need visibility in colony table

Summary
- UI/Explainability: added a dedicated **Buddy** column in the Colony table.
- Buddy column shows buddy id plus **buddy-need %** (relationship pressure) so social stress is visible without opening the inspector.
- High buddy-need highlights in **yellow/red** as an early warning for upcoming mood/grievance pressure.
- Patch notes updated.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `DEVLOG.md`

What to try
- Let Autonomy be low + Discipline high for a bit, then watch which kittens’ **buddy-need** climbs first and how it correlates with Mood/Griev.

---

## 2026-02-28 09:26 CST - v0.9.77 Auto Drills automation

Summary
- NEW: **Auto Drills** checkbox (Director): automatically runs Defense Drills when threat is getting high.
- Guardrails: only triggers when basics are stable (food/kitten + warmth) and you can afford the cost **above reserves**.
- Explainability: Season panel shows the last auto-drill trigger (or why it’s waiting).
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Enable **Auto Drills**, let threat climb near your target, and watch it auto-fire (then compare Threat +/s while drills are active).

---

## 2026-02-28 09:11 CST - v0.9.76 Defense Drills timed effect

Summary
- NEW: **Defense Drills** button (Director): spend food+wood for a short security window.
- While active (~40s): **threat growth slows** and **Guard** is more effective (stronger threat reduction + extra Combat XP).
- UI: button shows remaining seconds while the effect is running.
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Let threat climb, then hit **Run Drills** and compare the Threat +/s and Guard impact during the 40s window.

---

## 2026-02-28 08:56 CST - v0.9.75 Starvation forecast uses edible stores (food + jerky)

Summary
- UI/Explainability: **Food** stat now shows both **fresh** and **edible** (food+jerky) rates, and the time-to-zero forecast uses **edible stores**.
- FIX: the “Danger forecast” line in inspectors now reports **edible→0 ETA** (avoids false panic when you’re living off jerky).
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Build some jerky (PreserveFood), then intentionally run fresh food down: watch **edible** rate + **edible→0 ETA** stay truthful while fresh goes negative.

---

## 2026-02-28 07:11 CST - v0.9.68 Curfew: safety ↔ morale governance lever

Summary
- NEW: **Curfew** toggle (Director button + **Q** hotkey): slows **threat growth** (fewer raids), but steadily **drains mood** and adds a small **dissent pressure** while active.
- Curfew is save-safe (defaults OFF for old saves).
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- When threat is climbing toward your max target, toggle **Curfew ON** and watch threat’s +/s drop; keep an eye on Mood/Dissent and turn it OFF once stable.

---

## 2026-02-28 06:41 CST - v0.9.66 Jerky counts as edible food (fix starvation + heuristics)

Summary
- FIX: all **food/kitten** stability heuristics now treat **Jerky as edible food** (advisor warnings, auto-food-crisis, auto-crisis, auto-recruit, auto-mode/rations decisions).
- FIX: starvation + the harsh hunger→health spiral now only apply when **no edible food remains** (food + jerky).
- UI: stats now show **Edible/Kitten** (food+jerky) plus **Fresh/Kitten** (food only) so preservation is legible.
- Patch notes updated for v0.9.66.
- Save-safe: no schema changes (just smarter reads).

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Stockpile **Jerky**, let **Food** hit 0, and confirm the colony stabilizes (no starvation) while **Edible/Kitten** remains > 0.

---

## 2026-02-28 06:26 CST - v0.9.65 Inspector: show blocked sink → fallback execution

Summary
- NEW: Decision Inspector now shows an **Execution** line when a sink task was blocked by reserves/inputs and immediately fell back (includes the block reason).
- Task tooltip now includes a short **blocked reason** for a few seconds after it happens.
- Improves explainability for the common "why won’t they build/craft?" moment without changing AI behavior.
- Patch notes updated for v0.9.65.
- Save-safe: new `_lastBlocked` field is transient and stripped on save.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set **wood reserve** high, enable **BUILD PUSH**, then open a kitten’s **Decision Inspector** and watch it report the blocked build → fallback.

---

## 2026-02-28 06:11 CST - v0.9.64 Social inspector: Values vs Focus readout

Summary
- NEW: Social inspector now shows **avg kitten Values** vs your current **Focus** (Mode + Director priorities), plus an **avg focus-fit** percentage.
- Highlights the **biggest mismatch axis** (e.g. “Progress 12pp over colony preference”) to make mood/dissent drift feel like a governance tradeoff.
- Adds a short note when the mismatch is large (expect mood drag under low autonomy / tight planning).
- Patch notes updated for v0.9.64.
- Save-safe: uses existing deterministic values generation; no schema changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Click the **Dissent** or **Compliance** stat → compare Values vs Focus, then flip Mode (Survive/Advance) or tweak priorities and watch the mismatch axis change.

---

## 2026-02-28 05:56 CST - v0.9.63 Explainability: season transition log pings

Summary
- NEW: log a one-line **Season change** message when the season flips (Spring/Summer/Fall/Winter).
- Message calls out the key mechanical shifts (Winter warmth decay + Forage penalty; Spring relief; Fall prep window).
- Goal: reduce “why did my outputs suddenly change?” confusion without adding hidden automation.
- Patch notes updated for v0.9.63.
- Save-safe: uses a transient `state._lastSeasonName` field (not persisted).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Let the sim run across a season boundary and watch the event log for the new **Season change → ...** ping.

---

## 2026-02-28 05:41 CST - v0.9.62 Director: Consensus priority preset (values-driven)

Summary
- NEW: added a **Consensus** priority preset that sets Food/Safety/Progress priorities based on the colony’s average kitten Values (bottom-up governance).
- Clicking Consensus lightly reduces **Dissent** immediately (represents the Director listening), helping stabilize compliance without hiding mechanics.
- Keeps the effect conservative (a steer, not a hard lock): values are mapped into the existing 50–150% priority range.
- Patch notes updated for v0.9.62.
- Save-safe: uses existing saved fields; older saves generate values deterministically as before.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Let Dissent rise (murmurs), then hit **Consensus** and watch compliance recover + kitten task choices shift toward what the population actually values.

---

## 2026-02-28 05:25 CST - v0.9.61 Explainability: Decision mix history in Plan debug

Summary
- Explainability: Plan debug now shows a **Decision mix (last ~30s)** line: rule vs emergency vs commit vs normal scoring.
- Helps diagnose *why* the colony is off-plan (hard safety overrides vs personal needs vs commitment inertia vs autonomy sampling).
- Stored transiently (not saved) to avoid save bloat.
- Patch notes updated for v0.9.61.
- Save-safe: UI-only explainability.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Trigger a winter warmth crunch (low warmth) and watch Decision mix swing toward **rule/commit**, then stabilize and see it return to mostly **score**.

---

## 2026-02-28 05:10 CST - v0.9.60 Explainability: recent Activity breakdown in Plan debug

Summary
- Explainability: Plan debug now includes an **Activity (last ~30s)** section showing actual task shares.
- Helps diagnose when autonomy/needs/dissent pull kittens off-plan without clicking each kitten.
- Keeps history transient (not saved) to avoid save bloat.
- Patch notes updated for v0.9.60.
- Save-safe: UI-only explainability.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Let the colony run 20–30s, then open **Plan debug** and compare desired/assigned vs the new **Activity** block (try toggling Autonomy to see divergence).

---

## 2026-02-28 04:55 CST - v0.9.59 QoL: Compliance card opens Social inspector

Summary
- QoL/Explainability: the **Compliance** stat card is now clickable (same as Dissent) to open the Social inspector modal.
- Makes it faster to debug “why aren’t they following the plan?” since compliance is the plan-strength multiplier.
- Patch notes updated for v0.9.59.
- Save-safe: UI-only change.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Click **Compliance** in the top stats while Dissent is high and verify the Social inspector explains the current drivers.

---

## 2026-02-28 04:40 CST - v0.9.58 Stats: surface Director policy levers (autonomy/discipline/work pace)

Summary
- QoL/Explainability: added Director policy stats to the top panel: **Autonomy**, **Effective autonomy**, **Discipline**, and **Work pace**.
- Clarifies why kittens sometimes diverge from the central plan: effective autonomy rises with dissent and falls with discipline.
- Added tooltips to each new stat card so the numbers are self-explanatory.
- Save-safe: display-only change; no simulation logic changed.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Crank Discipline up, then increase Dissent (e.g., Tight rations + high work pace) and watch **Eff Auto** climb even though Autonomy stays fixed.

---

## 2026-02-28 04:25 CST - v0.9.57 Reserves: live recommendations + one-click apply

Summary
- QoL/Explainability: added a live "Recommended" reserves line (season + population aware) directly under the reserve inputs.
- NEW: "Apply recommended" button sets your current reserves to the suggested values without enabling Auto Reserves.
- Refactor: Auto Reserves now uses the same shared recommendation helper as the UI hint (keeps behavior consistent).
- Save-safe: adds UI elements + helper; existing reserve values are unchanged unless you click the button (or have Auto Reserves ON).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Turn Auto Reserves OFF, change seasons (or grow pop), and watch the "Recommended" line update; then click "Apply recommended" and see sinks stop thrashing against reserves.

---

## 2026-02-28 04:10 CST - v0.9.56 Food stat surfaces storage cap + spoilage (faster spiral diagnosis)

Summary
- QoL/Explainability: Food stat’s trend line now includes your current **Food Cap** and (when relevant) the **Spoilage x** multiplier.
- Added a Food stat tooltip that explains the soft-cap → accelerated spoilage mechanic in one place.
- This makes “why is food bleeding out?” diagnosable without cross-referencing separate stat cards.
- Save-safe: UI-only change.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Overcap food (push Food above Food Cap) and verify the Food stat subline shows `spoil x… | cap …` while your Food rate drops.

---

## 2026-02-28 03:55 CST - v0.9.55 Focus-fit stat (values alignment) for policy explainability

Summary
- Explainability: added a new top stat, **Focus-fit**, showing average values-alignment between kittens and the colony focus (Mode + priority sliders).
- The stat includes a mini breakdown: minimum alignment in the colony + how many kittens are in the low-alignment zone.
- Makes “policy mismatch → mood drift → dissent” more legible without opening the inspector.
- Save-safe: no schema changes (pure UI/explainability).

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set Autonomy low + Discipline high, then flip Mode/priority presets; watch Focus-fit drop and (over time) mood/dissent respond.

---

## 2026-02-28 03:40 CST - v0.9.54 Plan debug shows blocked sinks (reserves/inputs)

Summary
- Explainability: Plan debug now reports which sink actions were actually *blocked* by reserves/inputs in the last second (and why), so desired/assigned mismatches are actionable.
- Captures execution-layer stalls (the same ones that trigger fallback work) without spamming the event log.
- Helps diagnose “why won’t they build/research?” moments: usually protected reserves or missing inputs.
- Save-safe: no schema changes (blocked counters are ephemeral).

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `dist/index.html`
- `DEVLOG.md`

What to try
- Crank Food/Wood/Science reserves high, set a build focus (e.g., Industry), and watch Plan debug surface “Blocked sinks” when builders fall back due to reserves.

---

## 2026-02-28 03:25 CST - v0.9.53 Threat ETA now includes target warning

Summary
- Explainability: Threat stat now shows ETA to your **Max threat** target (when threat is rising), not just the raid ETA.
- This makes “we’re drifting into danger” visible earlier, so Defend/Guard nudges feel more proactive.
- Small UX polish: hides the ETAs when threat is falling or already above target (avoids confusing negative timers).
- Save-safe: no schema changes.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `dist/index.html`
- `DEVLOG.md`

What to try
- Let threat climb slowly and watch the Threat stat show “tgt in …” before “raid in …”, then switch to Defend and see the ETAs disappear as threat falls.

---

## 2026-02-28 03:10 CST - v0.9.52 Stats trends + ETAs in the top bar

Summary
- QoL: Stats cards now show small resource trends (per-second deltas) for key resources.
- Explainability: added a few “danger/goal” ETAs inline (starve/freeze/raid/next unlock) so spirals are visible without opening panels.
- Uses existing rate smoothing (EMA) so the numbers don’t jitter.
- Save-safe: no schema changes.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `dist/index.html`
- `DEVLOG.md`

What to try
- Let the colony run into Winter with low warmth and watch the Warmth stat show the negative trend + freeze ETA; then recover and see the ETA stabilize.

---

## 2026-02-28 02:55 CST - v0.9.51 Preview-safe Winter Prep + correct Advisor overcap

Summary
- FIX: Advisor “storage over-cap / spoilage x…” now reads from the current sim state (was accidentally reading the global `state`, which breaks Council/preview sims).
- FIX: Winter Prep and Crisis Protocol are now **preview-safe** (they can be applied to cloned states for Council/Advisor previews without mutating the live game).
- Explainability: Council/Advisor previews are now trustworthy when they show “what would happen if you click this”.
- Save-safe: no schema changes.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Open **Kitten Council**, hover a suggestion, and confirm the preview no longer causes any live toggles/log spam; then try **Advisor → Winter Prep** and verify it applies cleanly.

---

## 2026-02-28 02:40 CST - v0.9.50 Keyboard shortcuts (policy micro-QoL)

Summary
- NEW: Keyboard shortcuts (ignored while typing in inputs): **Space** toggles Pause/Resume.
- NEW: **1–4** switch Modes quickly (Survive / Expand / Defend / Advance).
- NEW: **W** toggles Winter Prep; **C** toggles Crisis Protocol.
- NEW: **F** triggers Hold Festival; **V** triggers Hold Council (only when not already active).
- UI: added button tooltips for Pause + Mode buttons to make shortcuts discoverable.
- Save-safe: no schema changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- During a tense Winter, use **W** to flip Winter Prep while watching the Plan/Projects panels, and hit **Space** to pause when you want to inspect kitten scoring.

---

## 2026-02-28 02:25 CST - v0.9.49 Need-aware mentoring (quota/plan driven)

Summary
- NEW: **Mentor** now teaches what the colony needs: it prioritizes skills that fill **role quota shortfalls**, then **current plan deficits**, before falling back to the mentor’s own specialty.
- This makes “policy management” feel more civ-sim: your quotas/plans shape the colony’s long-run specialization instead of just today’s task picks.
- Explainability: Mentor’s task tooltip now shows *why* that teaching skill was chosen (quota vs plan vs mentor top skill).
- Save-safe: adds only a tiny `_mentor.why` note in runtime state; existing saves keep working.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Unlock **Library**, set a role quota (e.g. **Builder=2** or **Scholar=1**), then watch Mentors start teaching **Building/Scholarship** to the weakest candidates; hover the Mentor task for the reason.

---

## 2026-02-28 02:10 CST - v0.9.48 Policy panel plan preview

Summary
- NEW (explainability): Policy panel now shows a **Plan preview** of the colony’s desired worker counts.
- Shows both **with policy multipliers** (your current quotas) and **without policy multipliers** (baseline), so you can see what your nudges are actually doing.
- Clarifies the "policy → plan → kitten scoring" pipeline: plan is advisory; Autonomy/traits/needs can still diverge.
- Save-safe: preview uses transient `_lastPlan` data only.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set Mode=Advance, bump **CraftTools** and **Research** multipliers, then check the Policy panel’s plan preview to confirm the desired worker counts changed before watching the kittens execute.

---

## 2026-02-28 01:55 CST - v0.9.47 Firekeeping now levels (Cooking)

Summary
- FIX/NEW: **StokeFire** is now tied to the **Cooking** skill (so aptitude bias + value fit can naturally create a “Firekeeper” specialist).
- NEW: Kittens gain **Cooking XP** while stoking the fire, so repeated winter hearth duty becomes an incremental advantage instead of a perpetual generalist task.
- Explainability: the Decision Inspector/score breakdown can now surface Cooking skill bonuses for StokeFire (since it’s a real skill action).
- Save-safe: no schema changes; existing kittens simply start accruing Cooking XP when doing StokeFire.

Files touched
- `prototype/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- In Winter (or with low warmth), set a **Firekeeper** role quota to 1 and watch that kitten’s **Cooking** skill start climbing as they keep the hearth going.

---

## 2026-02-28 01:40 CST - v0.9.46 Council: values-driven policy nudges + bugfix

Summary
- FIX: Kitten Council now reads the real personality likes/dislikes (it was incorrectly looking for `k.prefs`, so it often went silent).
- FIX: Council now reports colony-wide dissent correctly (no phantom per-kitten dissent field).
- NEW: Values-driven council suggestions when focus-fit is poor under strong central planning: nudges **Priority Food/Safety/Progress** or suggests raising **Autonomy**.
- Explainability: council tooltips still preview exact multiplier diffs; new values-suggestions include focus-fit % in the tooltip.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Set Autonomy low, switch to a mismatched Mode (e.g., Advance), then watch Council suggest either a priority nudge or a small Autonomy increase.

---

## 2026-02-28 01:25 CST - v0.9.45 Kitten Values: policy-fit affects mood (emergent civ pressure)

Summary
- Added **Kitten Values** (Food/Safety/Progress/Social) as a deterministic per-kitten preference vector.
- When **effective autonomy is low** (strong central planning), **value mismatch** slowly drags mood down (discipline amplifies this slightly; Festival/Council soften it).
- Explainability: the kitten table now shows **focus-fit %** and the Inspector shows the full **values vector** so you can see who is aligned with your current Mode + Priorities.
- Save-safe: older saves generate values deterministically from kitten id + traits.

Files touched
- `prototype/index.html`
- `dist/` (rebuilt)
- `DEVLOG.md`

What to try
- Set Mode = **Advance**, drop Autonomy, and watch which kittens show low focus-fit % (and start getting grumpier) vs which ones thrive.

---

## 2026-02-28 00:55 CST - v0.9.43 Council: preview exact multiplier diffs (safer clicks)

Summary
- Kitten Council suggestion tooltips now include a **preview diff** of the exact policy multiplier changes that will be applied.
- Council rows also show a short inline preview (first 1–2 changes) so you can scan without hovering.
- Improves explainability + reduces “mystery nudges” while keeping council influence soft (small multiplier steps).

Files touched
- `prototype/index.html`
- `dist/` (rebuilt)
- `DEVLOG.md`

What to try
- Hover a council suggestion and confirm the tooltip shows the full `xA→xB` preview before you accept.

---

## 2026-02-28 00:24 CST - v0.9.41 Director Priorities: quick presets

Summary
- Added **Priority presets** next to the Food/Safety/Progress sliders: Balanced / Food / Safety / Progress.
- Presets set all 3 values at once (e.g. Food preset bumps Food to 125% and slightly lowers Progress) for faster, more legible steering.
- Logs a single "Priority preset" line so you can correlate policy changes with behavior in the Decision Inspector.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- In a stable Summer, hit **Progress** preset and watch how many kittens swap into Research/CraftTools in the Plan Debug within ~5 seconds.

---

## 2026-02-28 00:09 CST - v0.9.40 Council: show exact policy nudges (explainability)

Summary
- Council buttons now show a **plain-English effects preview** (e.g. `Guard +0.30, BuildPalisade +0.20`) so you can accept/decline with intent.
- Accepting a council suggestion now logs the **exact before → after** multiplier changes (e.g. `Forage x1.00→x1.25`).
- Council panel briefly shows the **last accepted** policy diff (~2 minutes) to reinforce cause → effect without opening any inspectors.

Files touched
- `prototype/index.html`
- `dist/` (rebuilt)
- `DEVLOG.md`

What to try
- Wait for a council suggestion, accept it, then immediately open a kitten’s **Decision Inspector** and confirm the nudged action’s score line matches the new multiplier.

---

## 2026-02-27 23:54 CST - v0.9.39 Kitten Council: bottom-up policy suggestions

Summary
- Added **Kitten Council** panel: occasional bottom-up policy suggestions generated from a specific kitten.
- Suggestions combine **colony status** (food/warmth/threat) with **kitten likes/dislikes** to create emergent, legible nudges.
- Accepting a suggestion applies a **small policy multiplier nudge** (+/-) and then starts a short cooldown to prevent spam.
- Explainability: council panel shows the **spokeskitten** with mood/dissent/traits.

Files touched
- `prototype/index.html`
- `dist/` (rebuilt)
- `DEVLOG.md`

What to try
- Raise **Autonomy**, then wait for a council suggestion and accept it; watch how the colony plan shifts and check Decision Inspector reasons for the nudged task.

---

## 2026-02-27 23:39 CST - v0.9.38 Director: Priorities sliders (policy weights)

Summary
- Added **Director Priorities** sliders: **Food / Safety / Progress** (50%–150%).
- These priorities bias **individual kitten action scoring** (not just the colony plan), creating a clearer "policy → behavior" loop.
- Explainability: affected actions include a `prio ...` line in the **Decision Inspector** score breakdown.
- Priorities are saved + included in Director profiles (save-safe; defaults to 100% for old saves).

Files touched
- `prototype/index.html`
- `dist/` (rebuilt)
- `DEVLOG.md`

What to try
- Set **Food 150% / Progress 50%** and confirm kittens strongly prefer Forage/Farm/PreserveFood even in Expand mode (then flip to **Progress 150%** once stable).

---

## 2026-02-27 23:24 CST - v0.9.37 QoL: Auto-pause on hidden tab

Summary
- NEW: the sim **auto-pauses when the browser tab is hidden** and **auto-resumes** when you return.
- Safety: it **does not override manual Pause** (only resumes if the auto-pause triggered it).
- Prevents background CPU burn and reduces "oops I left it running" spirals.
- Adds clear log events: "Auto-paused" and "Resumed".

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Let the sim run, switch to another tab/window for ~10s, then come back and confirm it auto-resumed (and didn\'t fast-forward).

---

## 2026-02-27 23:09 CST - v0.9.36 Social: Buddy bonds (Socialize synergy)

Summary
- NEW: each kitten now has a deterministic **Buddy** bond (save-safe; assigned automatically).
- Buddy is surfaced in explainability: shown in the Decision Inspector header and in the Traits tooltip as `b#<id>`.
- When buddies **Socialize** at the same time, **dissent drops a bit faster** and their mood recovers slightly faster.
- Goal: small civ-sim emergence layer that rewards "pairing" behavior without hard-locking roles.

Files touched
- `prototype/index.html`
- `dist/` (rebuilt)
- `DEVLOG.md`

What to try
- Set policy to encourage **Socialize**, then watch for buddy pairs syncing up and stabilizing dissent faster than solo socializing.

---

## 2026-02-27 22:54 CST - v0.9.35 Advisor: one-click Council/Festival

Summary
- Advisor can now recommend (and one-click) **Hold Council** when dissent is high and you can afford it.
- Advisor can now recommend (and one-click) **Hold Festival** when average mood is low and you can afford it.
- Adds discoverability for the civ-sim "social stability" layer without hiding automation.

Files touched
- `prototype/index.html`
- `DEVLOG.md`

What to try
- Let dissent climb above ~55%, then click **Hold Council** from Advisor and watch Dissent/Compliance stabilize.

---

## 2026-02-27 22:39 CST - v0.9.34 Director: Auto Rations

Summary
- NEW: **Auto Rations** toggle — the Director can automatically switch **Tight / Normal / Feast** based on food stability + dissent (with a cooldown to avoid flapping).
- Tight triggers when food/kitten is genuinely low; Feast triggers when food is stable but cohesion is failing (high dissent).
- Explainability: Season panel shows **Auto rations** status + the last reason.

Files touched
- `prototype/index.html`
- `dist/` (rebuilt)
- `DEVLOG.md`

What to try
- Enable **Auto Rations**, then tank food/kitten to force **Tight**, stabilize, and spike dissent (high Work pace + Tight) to see it flip to **Feast** when food is safe.

---

## 2026-02-27 22:24 CST - v0.9.33 Explainability: decision override badges in Task

Summary
- Kittens now show a small badge in the **Task** cell when their action was forced by a **RULE / EMERG / COMMIT** decision (so you can instantly tell why the plan wasn’t followed).
- Task tooltip now includes extra context when autonomy sampled a non-#1 choice ("top score was X").
- No sim/balance changes; pure UI explainability.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Create a Safety Rule (e.g. warmth < 35 → StokeFire) and watch the Task badge flip to **RULE** when it triggers.

---

## 2026-02-27 22:09 CST - v0.9.32 Projects panel: Unblock stalled builds

Summary
- Projects panel now shows an **Unblock** button when a project has progress but is stalled because **reserves are protecting required inputs** (wood/science/tools).
- Clicking **Unblock** lowers only the blocking reserve(s) by a small, safe step and sets **Project focus** to that track.
- Makes the “why won’t they finish this build?” loop fixable directly from the build progress UI (no hunting for the Advisor).

Files touched
- `prototype/index.html`
- `dist/` (rebuilt)
- `DEVLOG.md`

What to try
- Start a Workshop/Library build, raise Science/Tools reserve until it stalls, then click **Unblock** in Projects and confirm builders resume progress.

---

## 2026-02-27 21:54 CST - v0.9.31 Advisor: detect reserve-blocked builds + quick fix

Summary
- Advisor now detects when an in-progress build project is stalled because **reserves are protecting required inputs** (wood/science/tools).
- New Advisor quick action: **Loosen reserve** (drops only the blocking reserve(s) by a small step and sets Project focus to that build track).
- Improves explainability around the reserve system without removing the strategic tradeoff.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Start a Workshop/Library build, set Science/Tools reserve high enough to block it, then click **Loosen reserve** in Advisor and confirm the project resumes.

---

## 2026-02-27 21:39 CST - v0.9.30 Kitten traits (steady scoring bias)

Summary
- NEW: Each kitten now rolls a simple **Trait** (Brave / Studious / Builder / Caretaker / Forager).
- Traits apply a steady, explainable scoring bias (separate from Autonomy-driven likes/dislikes), pushing more distinct specialization patterns.
- Explainability: trait bonuses show directly in the Decision Inspector reason list (e.g. `trait Builder → +8`).
- UI: Traits column now shows trait tags; tooltip includes trait descriptions + the kitten’s prefs.
- Save-safe: old saves auto-generate traits for existing kittens.

Files touched
- `prototype/index.html`
- `dist/` (rebuilt)
- `DEVLOG.md`

What to try
- Open the Decision Inspector on a kitten and confirm you see `trait X → +Y` in the scoring breakdown; then toggle Autonomy to compare trait-vs-preference behavior.

---

## 2026-02-27 21:24 CST - v0.9.29 Safety Rules: Care action selectable

Summary
- FIX: Safety Rules action dropdown now includes **Care** (was missing, despite being a real action).
- Explainability: a rule-driven **Care** attempt still respects reserves and will immediately fall back to **Socialize** if blocked.
- Patch notes updated for v0.9.29.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Add a Safety Rule: `always → Care`, set food/wood reserves high, and confirm the kitten transparently falls back to **Socialize** (and the Task cell shows the fallback).

---

## 2026-02-27 20:54 CST - v0.9.27 Cumulative patch notes (since last seen version)

Summary
- NEW: Patch notes are now **cumulative** — when you update, the modal shows everything since your last seen version.
- Explainability: patch notes now include version headers (e.g., `v0.9.27`, `v0.9.26`) so changes are easier to scan.
- QoL: patch notes modal still auto-opens once per version, but now remembers the “from version” for the session.
- Updated the on-screen patch note text for v0.9.27 (previous text was stale).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Import an older save (or clear localStorage), reload, and confirm Patch Notes shows the correct “Changes since vX.Y.Z” list.

---

## 2026-02-27 20:24 CST - v0.9.25 Social Inspector (dissent driver breakdown)

Summary
- NEW: **Social Inspector** modal — click the **Dissent** stat to see what’s driving dissent (mood, work pace, rations, hunger, alarm).
- Explainability: inspector shows the exact per-tick **dissent desire** inputs and how they smooth into the current dissent value.
- UX: adds actionable guidance on which Director knobs to turn (Festival/Council/Discipline/Work pace/rations/food stability).
- Save-safe: driver snapshot is transient (`state._dissentDrivers`) and not persisted.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Intentionally spike dissent (Tight rations + Work pace 120%), then click **Dissent** and confirm the breakdown matches what you changed.

---

## 2026-02-27 20:09 CST - v0.9.24 Save migration fixes (Care + Council) + Winter Prep string fix

Summary
- FIX: **Care** policy multiplier now properly migrates into older saves (prevents undefined/NaN multipliers and weird planner bias).
- FIX: `effects.councilUntil` now migrates for older saves, keeping Council timers consistent across refresh/import.
- FIX: corrected a JavaScript string in Winter Prep preset text that could break parsing ("don\'t" → "do not").
- Updated patch notes for the new version.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Load an older save (pre-Care), open **Policy**, and confirm **Care** shows a sane multiplier (defaults to 1.00) and Council duration persists after refresh.

---

## 2026-02-27 19:53 CST - v0.9.23 Care action (paid stability lever)

Summary
- Added a new action: **Care** — spend **food + wood** (above reserves) to reduce **Dissent** faster and raise **Mood** (direct “welfare” policy lever).
- Care is **resource-gated + reserve-safe**: if buffers are tight, it automatically falls back to **Socialize** instead of burning critical supplies.
- Director **Policy multipliers** now expose **Socialize** + **Care**, so you can explicitly trade output for cohesion/stability.
- Planner will sometimes allocate 1 kitten to Care during high dissent *when surplus exists* (keeps strikes from becoming a slow death spiral).
- Personality pool updated so some kittens can naturally like/dislike Care (more emergent texture).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Let Dissent rise into **murmurs**, then set **Care** multiplier to **2.0** and watch Dissent fall faster while food/wood drain (confirm it falls back to Socialize if reserves get tight).

---

## 2026-02-27 19:38 CST - v0.9.22 Auto Crisis (Director)

Summary
- Added **Auto Crisis** toggle: the Director can automatically enable **Crisis Protocol** when the colony is clearly spiraling (food/kitten, warmth, or threat).
- Auto Crisis is intentionally non-invasive: it will only auto-disable Crisis if **Auto Crisis turned it on** (manual Crisis stays manual).
- Added an explainability line in the **Season** panel showing Auto crisis status + the last trigger reason.
- Migration-safe: missing `director.autoCrisis*` fields default in cleanly.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Turn **Auto Crisis ON**, then deliberately tank food/kitten or warmth in Winter; confirm Crisis toggles ON, and toggles OFF once you stabilize.

---

## 2026-02-27 19:23 CST - v0.9.21 Socialize action (labor → cohesion lever)

Summary
- Added a new action: **Socialize** — kittens can spend time organizing/chatting to **reduce Dissent** (improves Compliance) and gently lift Mood.
- AI scoring now treats Socialize as attractive when Dissent is high, but heavily deprioritizes it during **food/warmth/threat** emergencies.
- Planner will reserve **1 kitten** for Socialize when Dissent > ~50% *and* basics are stable, making “slow-motion strikes” self-correcting.
- Policy multipliers now include **Socialize** so the Director can explicitly trade throughput for cohesion.
- Migration-safe: older saves auto-add the new policy key (defaults to 1.0).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Push Dissent into **murmur/strike** (Tight rations + high Work pace), then set **Socialize mult → 2.0** and watch Dissent trend down + Compliance recover.

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

## 2026-02-27 20:39 CST - v0.9.26 Recruit button QoL (pop/cap + disabled states)

Summary
- QoL: **+Kitten** button now shows **pop/cap** inline so the housing constraint is always visible.
- UX: **+Kitten** auto-disables when you�re **housing-capped** or **can�t afford** the current food cost.
- Explainability: hover the button to see the exact block reason ("need food" vs "build huts").
- Patch notes updated to reflect the change.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Get to pop cap, then hover +Kitten to confirm the tooltip explains the block; build a hut and watch it re-enable.

---

## 2026-02-27 21:09 CST - v0.9.28 Spoilage multiplier + storage overcap advisor

Summary
- Explainability: top stats now show **Spoilage x�** (x1.00..x4.00) so food over-cap loss is visible at a glance.
- Advisor: detects **storage over-cap** and offers a 1-click **Storage fix** (Project focus ? Storage when available, +BuildGranary, +PreserveFood, and a small wood reserve nudge).
- Patch notes updated for v0.9.28.

Files touched
- prototype/index.html
- dist/js/main.js
- DEVLOG.md

What to try
- Hoard food above the Food Cap and confirm Spoilage rises above x1.00, then click **Storage fix** and watch the colony pivot into Granary/Jerky to stop bleeding food.


---

## 2026-02-28 00:40 CST - v0.9.42 Advisor Winter Prep quick action

Summary
- Advisor now explicitly warns when **Winter is near** (late Fall / =45s to Winter) and offers a 1-click **Winter Prep** action.
- Winter Prep remains a manual, reversible overlay (no hidden auto-enable) � this just makes the tool discoverable.
- Keeps the loop incremental: you feel the seasonal pressure, then choose whether to spend policy authority to stockpile.
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- In late Fall, click **Advisor ? Winter Prep** and watch targets/reserves/policy shift; then toggle it OFF in Spring to return to your previous stack.


## 2026-02-28 01:10 CST - v0.9.44 Council: undo last suggestion (safety net)

Summary
- Kitten Council: after accepting a suggestion, you now get an **Undo last** button (120s window) that restores the previous policy multipliers.
- Explainability: the council panel shows the remaining undo window timer so you can safely experiment.
- Undo only affects policyMult (does not rewind resources/time), keeping it simple + save-safe.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Accept a council suggestion, then immediately click **Undo last** and confirm the multipliers snap back.


---

## 2026-02-28 06:56 CST - v0.9.67 Grievance: slow-burn resentment ? dissent pressure

Summary
- Added per-kitten **Grievance** (0�100%) that rises when kittens are pushed into disliked/misaligned work under strong central planning, and cools down with comfort work.
- Colony-level **Grievance** average is now visible as a stat card.
- **Dissent desire** now includes a grievance pressure term (visible in Social inspector driver breakdown).
- **Hold Council** now also reduces grievance (represents being heard), helping you recover from rigid policy pushes.
- Added a Colony table column (Griev) for quick diagnosis.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `DEVLOG.md`

What to try
- Set low Autonomy + high Discipline, crank a quota for a disliked job (watch Pref column), then see Grievance climb and Dissent follow; recover by raising Autonomy or holding Council.

---

## 2026-02-28 07:26 CST - v0.9.69 Auto Build Push (hands-off hut pressure)

Summary
- Added **Auto Build Push** Director toggle: automatically turns BUILD PUSH ON while you are **housing-capped**, and OFF once housing is available again.
- Keeps hut building pressure consistent without needing to babysit the BUILD signal (still fully explainable/visible).
- Added Season panel line indicating when Auto Build Push is active.
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `DEVLOG.md`

What to try
- Enable **Auto Build Push**, recruit up to the cap, and watch BUILD PUSH toggle itself ON until a hut completes.

---

## 2026-02-28 07:41 CST - v0.9.70 Factions (values blocs) + negotiate button

Summary
- Added **Factions (values blocs)** panel: kittens are grouped by their dominant Values axis (Food/Safety/Progress/Social).
- Each bloc shows size + avg mood + avg grievance + avg focus-fit, so "politics" is readable.
- NEW action: **Negotiate** with a bloc to apply a small, bounded policy concession (priorities or social levers) and ease dissent slightly.
- This creates a new governance loop: you can stabilize cohesion by drifting policy toward what the population wants (tradeoff, not free).
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Let dissent drift into **Murmur**, then click **Negotiate** on the biggest bloc and watch dissent/compliance stabilize (and notice how your priorities/policy shift).

---

## 2026-02-28 07:56 CST - v0.9.71 Coordination-scaled task commitment

Summary
- Director levers now affect **task commitment length**: higher **Discipline** increases coordination (less 1s flapping), higher **Autonomy** reduces it (more emergent switching).
- Commitment duration remains short (clamped), and Safety Rules/emergencies still override immediately.
- Explainability: COMMIT decisions now show the live **coord multiplier**, and the Discipline hint shows `commitment x�`.
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Set **Discipline high** + **Autonomy low** and watch kittens stick to build/research tasks; then flip to **Autonomy high** and notice more preference-driven switching.


---

## 2026-02-28 08:11 CST - v0.9.72 Buddy-need (relationship pressure)

Summary
- Buddy bonds now include a persistent **Buddy-need** meter (0..1) that rises when buddies are apart and falls when they spend time together.
- High Buddy-need gently nudges kittens toward **Socialize** and adds mild **mood/grievance** pressure (most noticeable under low Autonomy / high Discipline).
- Explainability: the Decision Inspector header now shows **buddy-need %** when a kitten has a buddy.
- Patch notes updated.

Files touched
- prototype/index.html
- dist/js/main.js
- DEVLOG.md

What to try
- Set **Autonomy low** and watch Buddy-need creep up; then bump **Socialize** policy multiplier (or let buddies socialize) and see it drain + stabilize mood.


## 2026-02-28 08:26 CST - v0.9.73 Factions: negotiation preview + cooldown + delta logging

Summary
- Factions: **Negotiate** now has a short **cooldown (~45s)** so it�s a deliberate politics lever (not a spam click).
- UI: each faction row now shows a **preview** of the policy concession you�ll make before clicking.
- Explainability: negotiation log now includes the **exact deltas** applied (priority sliders / policy multipliers) plus the dissent reduction.
- Save-safe: adds optional `director.factionsNextAt` / `director.factionsLast` fields.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Open **Factions**, click **Negotiate** with the largest bloc, then watch the log for the precise deltas and confirm the button cooldown + preview text.

---

## 2026-02-28 08:41 CST - v0.9.74 Save bloat fix (strip transient runtime fields)

Summary
- FIX/QoL: saves now strip additional transient runtime/debug fields (decision history, dissent driver snapshots, per-second timers).
- Result: smaller saves and less chance of save bloat over long sessions; simulation behavior unchanged.
- Patch notes updated for v0.9.74.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Play for a few minutes, refresh the page, and confirm the save restores correctly while LocalStorage usage doesn�t creep as fast.

## 2026-02-28 10:02 CST - v0.9.79 Auto Policy (targets ? policy nudges)

Summary
- NEW: **Auto Policy** checkbox (Director): a small �governor� that nudges policy multipliers toward your Targets (food/kitten, warmth, threat).
- Makes tiny, reversible changes (�0.05 steps) with cooldowns; logs sparingly to avoid spam.
- Pauses automatically during **Crisis Protocol** so emergency overlays remain authoritative.
- Explainability: Season panel shows the last Auto Policy reason (what deficit it reacted to).
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Turn on **Auto Policy**, set food target a bit high (e.g., 140), then intentionally overbuild: watch it shift policy away from Research/Build and back once basics stabilize.

---

## 2026-02-28 11:12 CST - v0.9.84 Storage Inspector modal (cap + spoilage breakdown)

Summary
- UI/Explainability: **Food Cap** and **Spoilage** stat cards are now clickable.
- NEW: Storage Inspector modal explains the **soft cap ? spoilage** system, shows the **cap breakdown** (base + huts + granaries), and prints your current overcap + season context.
- Gives clear �what to do� levers (Granary focus / PreserveFood ? Jerky / stop over-foraging) without changing simulation balance.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Intentionally overstock food above **Food Cap**, then click **Spoilage** to verify you can immediately see *why* food is bleeding and what to do about it.

---

## 2026-02-28 12:12 CST - v0.9.88 Values drift (kittens learn from work)

Summary
- NEW (civ-sim): each kitten’s **Values** (Food/Safety/Progress/Social) now slowly drift toward what they actually do each second.
- Higher **effective autonomy** (Autonomy + Dissent, reduced by Discipline) makes drift faster; central planning makes it slower.
- Emergent behavior: specializing a colony changes *who your kittens become* over minutes, which can cascade into **Faction** makeup and demands.
- Explainability: table + Inspect tooltips show a short, recent **"drift → AXIS"** note.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Run **Advance** for a few minutes, then open **Factions** and see if your dominant bloc shifts toward **Progress** as kittens acclimate.

---

## 2026-02-28 12:27 CST - v0.9.89 Colony table: Fit column (policy alignment)

Summary
- NEW: Added a dedicated **Fit** column in the Colony table showing each kitten�s policy focus-fit (% alignment to current Mode + priority sliders).
- Fit is color-coded (green/yellow/red) to make �who is misaligned� instantly scannable.
- Tooltip explains the civ-sim loop: low fit under strong planning (low effective autonomy) tends to drag mood and increase dissent pressure.
- Patch notes updated.
- No save-breaking changes.

Files touched
- prototype/index.html
- dist/index.html
- dist/js/main.js
- DEVLOG.md

What to try
- Push **Advance** + high **Discipline**, then watch which kittens show red Fit and whether mood/dissent starts to drift until you negotiate (Factions) or change priorities.

---


---

## 2026-02-28 12:42 CST - v0.9.90 Deterministic kitten names (readability)

Summary
- Civ-sim readability: kittens now have **deterministic names** based on id (save-safe; no RNG/state needed).
- UI: colony table �#� column renamed to **Kitten** and now shows **Name + #id**.
- Explainability: Decision Inspector title now includes the kitten�s name so you can track individuals across seasons, factions, and buddy stress.
- Save compatibility: older saves are migrated by assigning missing names on load.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Start/continue a run and watch how named individuals drift into blocs/roles (it�s much easier to spot the "Brave guard" vs the "Studious scholar").

---

## 2026-02-28 12:57 CST - v0.9.91 Policy Undo (multipliers + role quotas)

Summary
- QoL: added a **Policy Undo** button (2 minute window) in the Policy panel.
- Undo snapshot captures your last manual change to **Policy multipliers** (including presets/reset and +/- tweaks).
- Undo snapshot also captures **Role Quotas** changes (including quota reset).
- Explainability: Undo shows time-left + the reason label (e.g., �tweak Forage�, �Policy preset ? Survive�).
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Hit any Policy preset, then immediately click **Undo** to revert.

---

## 2026-02-28 13:12 CST - v0.9.92 Overcrowding ? dissent/grievance pressure

Summary
- Civ-sim pressure: when **population exceeds housing cap**, overcrowding now adds a slow-burn **Dissent** increase (reduced by Discipline) and raises kitten **Grievance**.
- Overcrowding also applies a tiny colony-wide **Mood** penalty, making �build huts� a clearer, legible stability goal.
- Explainability: event log pings once when overcrowding begins and once when it resolves.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Intentionally go **1 kitten over cap** and watch Dissent/Grievance climb until you prioritize **BuildHut** (or raise Discipline to blunt the dissent).
---

## 2026-02-28 13:27 CST - v0.9.93 Safety Rules: edible< (Food+Jerky)

Summary
- Safety Rules: added a new condition type **edible < X** (counts **Food + Jerky**) so overrides can trigger on true edible stores.
- Rule editor: condition dropdown now includes **edible <** with a sensible default threshold.
- Explainability: Safety Rules "Available" list now clarifies that "edible" includes jerky.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Create a rule: **If edible < 80 ? Forage** and verify it triggers even if fresh food is low but you still have jerky.

---

## 2026-02-28 13:42 CST - v0.9.94 QoL: keyboard shortcut for Defense Drills

Summary
- QoL: added keyboard shortcut **D** to run **Defense Drills** (same effect as the Run Drills button; only triggers if drills are not already active).
- UI: Run Drills button tooltip now advertises the shortcut.
- Patch Notes updated for v0.9.94.
- No save-breaking changes.

Files touched
- prototype/index.html
- dist/index.html
- dist/js/main.js
- DEVLOG.md

What to try
- When threat starts climbing (or you hit **ALARM**), press **D** and watch the **Season** panel show an active Drills timer + slower threat growth.

## 2026-02-28 13:57 CST - v0.9.95 Advisor surfaces Faction Demands

Summary
- Advisor: now calls out when a **Faction Demand** is active (axis + time remaining).
- Advisor: provides a one-click **Accept** (when basics are stable) or **Ignore** (when collapsing) recommendation.
- Explainability: the recommendation is explicitly keyed off food/kitten, warmth, and threat stability.
- Patch notes updated.
- No save-breaking changes.

Files touched
- prototype/index.html
- dist/js/main.js

What to try
- Let Dissent rise until a Demand appears on a season change; see the Advisor button and resolve it without opening the Factions panel.
## 2026-02-28 14:12 CST - v0.9.96 Buddy names in colony table

Summary
- UI/Explainability: Buddy column now shows **buddy name + id + need%** (instead of just id), making relationship pressure readable at a glance.
- Tooltips now include the buddy�s full name as well.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Let buddy-need climb (avoid Socialize), then watch the Buddy column color + need% spike to flag brewing social stress.

---
## 2026-02-28 14:27 CST - v0.9.97 Auto Pause (danger)\n\nSummary\n- NEW Director checkbox: **Auto Pause (danger)** to pause the sim during clear imminent collapse (starving/freezing/raid risk).\n- Adds a short cooldown so resuming doesn�t immediately re-pause.\n- Season panel now shows the last auto-pause reason for quick diagnosis.\n- No save-breaking changes.\n\nFiles touched\n- prototype/index.html\n- dist/index.html\n- dist/css/app.css\n- dist/js/main.js\n- DEVLOG.md\n\nWhat to try\n- Enable Auto Pause (danger), then intentionally run low on food/warmth or let threat spike; confirm it pauses and the Season panel shows why.\n\n---\n


---
## 2026-02-28 14:57 CST - v0.9.98 Pinned Projects (finish one building)

Summary
- NEW Projects panel action: **Pin** a Hut / Palisade / Granary / Workshop / Library to temporarily force Project focus until **one** completes.
- Pin automatically clears itself on completion (logs a message), so it behaves like a small build-order command, not a permanent policy change.
- Explainability: pinned projects show a **PINNED** tag in the Projects list; focus line shows the reason ("pinned project: …").
- Save-safe: stored in `director.pinnedProject` (sanitized on load).

Files touched
- prototype/index.html
- dist/index.html
- dist/js/main.js
- DEVLOG.md

What to try
- Unlock Construction, then **Pin a Hut** while not housing-capped; confirm builders finish 1 hut and the pin clears itself.

## 2026-02-28 15:12 CST - v0.9.99 Offline progress (capped) + clean summary log

Summary
- NEW: **Offline progress** � on load, the sim now advances up to **5 minutes** since your last save.
- Explainability: adds a single compact log line showing offline deltas (food/jerky/wood/warmth/threat/science/tools).
- Safety: offline sim suppresses spammy logs (season warnings, etc.) and reports how many were suppressed.
- Save-safe: uses existing meta.lastTs stamping; no schema changes required.

Files touched
- prototype/index.html
- dist/index.html
- dist/css/app.css
- dist/js/main.js
- DEVLOG.md

What to try
- Close the tab for ~60�180s, reopen, and check the Event log for the offline summary + whether your colony survived the gap.


## 2026-02-28 15:27 CST - v0.9.100 Policy locks (Auto Policy guardrails)

Summary
- NEW: **Policy Lock** button next to each policy multiplier (0..2) in the Policy panel.
- Auto Policy now respects locks: if a multiplier is locked, the governor will **not** nudge it.
- Adds a clear log line when you lock/unlock a multiplier so changes are trackable during play.
- Save-safe: stored under director.policyLocks (missing keys default to unlocked).

Files touched
- prototype/index.html
- dist/js/main.js
- DEVLOG.md

What to try
- Enable **Auto Policy**, lock **Research** (or **Guard**) and watch the governor adjust other multipliers while leaving the locked one untouched.

---


## 2026-02-28 15:57 CST - v0.9.102 Auto-danger pause indicator

Summary
- UI: Pause button now turns red when the Director **auto-pauses on danger**, and shows the danger reason in its tooltip.
- QoL: Manual pause/resume clears the auto-danger reason so the UI doesn�t stay �alarm red� forever.
- Explainability: Makes slow spirals (starvation/freezing/raid risk) more visible at a glance, without changing sim balance.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`

What to try
- Enable **Auto Pause (danger)**, let threat or food/warmth drift into risk, then confirm the Pause button highlights with the reason.

---


## 2026-02-28 16:12 CST - v0.9.103 Advisor: overcrowding fix

Summary
- Advisor: detects when **population exceeds housing cap** and surfaces an explicit overcrowding warning.
- Advisor: adds a one-click **Fix housing** recommendation (sets Project focus ? Housing, enables BUILD PUSH, nudges BuildHut + ChopWood).
- Explainability: calls out that overcrowding steadily worsens mood/cohesion (dissent + grievance), so the player understands the urgency.

Files touched
- prototype/index.html
- dist/index.html
- dist/css/app.css
- dist/js/main.js
- DEVLOG.md

What to try
- Let population exceed cap (e.g. buy/add a kitten) and confirm the Advisor offers **Fix housing** and that huts start finishing without extra micro.


## 2026-02-28 16:57 CST - v0.9.106 Governance log (audit trail)

Summary
- NEW: added a �Governance log� panel that records Director-driven policy shifts.
- Auto Policy now writes an audit entry when it nudges multipliers (includes top diffs + the reason string).
- Faction negotiations also write to the Governance log (so politics-driven drift is traceable).
- Coalesces rapid Auto Policy nudges into a single recent entry to avoid spam.
- Version bump + dist rebuild.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`

What to try
- Enable **Auto Policy**, let it run through a wobble (food/warmth/threat), then check **Governance log** to see exactly what it changed and why.

---

## 2026-02-28 17:12 CST - v0.9.107 Strike recovery: organizers emerge

Summary
- AI behavior: when dissent is extreme but basics are stable, kittens are now more likely to pick Socialize/Care to actively restore cohesion (instead of everyone defaulting to Loaf).
- Balance: Loaf gets a small penalty in �strike but stable� states to prevent passive stall loops.
- Explainability: Decision Inspector scoring now includes explicit �strike recovery� reasons (Socialize/Care) and a matching Loaf reason when it is deprioritized.
- Version bump + dist rebuild.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`

What to try
- Intentionally let dissent climb into strike, then stabilize food/warmth and watch for one kitten to become an organizer via Socialize/Care (click them to inspect �strike recovery�).

---

## 2026-02-28 17:27 CST - v0.9.108 Debounced policy slider logs

Summary
- QoL: dragging **Discipline / Work pace / Priorities** sliders no longer spams the Event log.
- Logs are now debounced: you still get a clear “X → Y%” entry shortly after you stop dragging.
- Patch notes updated + version bump.
- No save-breaking changes.

Files touched
- `prototype/index.html`

What to try
- Drag Work pace from 80%→120% back and forth: you should only see 1–2 log lines total (not dozens).


---

## 2026-02-28 17:43 CST - v0.9.109 Project ETAs (smoothed build progress)

Summary
- QoL: Projects panel now shows an ETA for in-progress builds (based on smoothed build progress/sec).
- Explainability: if a build is stalled by reserve-protected inputs, the ETA shows as �blocked� (pairs with the Unblock button).
- Under the hood: added a transient per-project EMA rate tracker (no save data changes).
- Version bump + dist rebuild.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`

What to try
- Start building a Hut/Palisade (get some progress), then watch the ETA update as you change Work pace / Policy / Reserves.

---

## 2026-02-28 17:58 CST - v0.9.110 Kitten Council: NEW badge + announcement log

Summary
- QoL: Kitten Council now shows a brief **NEW** badge when a fresh suggestion appears.
- QoL: a single Event log line announces the spokeskitten + suggestion labels (no per-frame spam).
- Patch notes updated + version bump.
- Dist rebuilt.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Let the sim run until a council suggestion appears; confirm you see the **NEW** badge + a one-time log line, then apply a suggestion.


---

## 2026-02-28 18:13 CST - v0.9.111 Social inspector: lowest focus-fit kittens + clickable stat

Summary
- Explainability: Social inspector now lists the **lowest focus-fit kittens** (fit %, grievance %, bloc, current role/task) so you can see who is most misaligned at a glance.
- QoL: Focus-fit stat card is now clickable (opens the Social inspector).
- QoL: Grievance stat card is now clickable (opens the Social inspector).
- Patch notes updated + version bump.
- Dist rebuilt.
- No save-breaking changes.

Files touched
- prototype/index.html
- dist/index.html
- dist/js/main.js
- dist/css/app.css
- DEVLOG.md

What to try
- Push Mode/Priorities hard (e.g., Advance + Progress 150%) and watch the Social inspector list the kittens with the lowest fit; then click Focus-fit/Grievance to jump there.

---

## 2026-02-28 18:28 CST - v0.9.112 Colony table sorting (click headers)

Summary
- QoL: the Colony table can now be sorted by clicking column headers (desc → asc → off).
- Added sorting for key civ-sim debugging signals: Fit, Eff, Mood, Griev, Buddy-need, etc.
- Visual indicator: active sort header shows ▲/▼.
- Sorting is transient UI state only (does not affect sim; not saved).
- Version bump + dist rebuild.

Files touched
- prototype/index.html
- dist/index.html
- dist/css/app.css
- dist/js/main.js

What to try
- Click **Fit** to find the most misaligned kittens, then open the Social inspector to see why they’re unhappy.

---

## 2026-02-28 18:43 CST - v0.9.113 Per-kitten Directive (persistent scoring bias)

Summary
- NEW: Per-kitten **Directive** (Auto/Food/Safety/Progress/Social/Rest) to bias that kitten�s scoring persistently (not a hard lock; rules/emergencies still override).
- UI: Directive can be set in the Decision Inspector (click a kitten row), with a one-click Clear button.
- UI: Colony table Pref column now shows **Dir X** when a kitten has a non-Auto directive.
- Patch notes updated + version bump.
- Dist rebuilt.
- No save-breaking changes.

Files touched
- prototype/index.html
- dist/index.html
- dist/js/main.js
- dist/css/app.css
- DEVLOG.md

What to try
- Click a kitten ? set Directive=Progress, then sort by Task/Fit and watch that kitten  lean into research/crafting when it�s safe.

---

## 2026-02-28 19:13 CST - v0.9.115 Season-change " Season Report\ (actionable stats + targets)

Summary
- QoL/Explainability: season-change log now includes a compact Season Report (year, pop/cap, edible/kitten, warmth, threat, dissent, avg mood).
- Explainability: report also prints the current season targets (edible/kitten, warmth, threat) and notes when a faction demand is already active.
- Kept the existing seasonal hint text (Winter/Spring/Summer/Fall) so new players still get the conceptual reminder.
- Version bump + dist rebuild.
- No save-breaking changes.

Files touched
- prototype/index.html
- dist/index.html
- dist/css/app.css
- dist/js/main.js
- DEVLOG.md

What to try
- Let a season flip, then use the Season Report line to decide whether to toggle Winter Prep / Crisis Protocol *before* the spiral starts.

---

## 2026-02-28 19:28 CST - v0.9.116 Directive tools (batch: match blocs)

Summary
- NEW: Director panel now includes **Directive tools**.
- �Match blocs� sets each kitten�s Directive to match their dominant Values bloc (Food/Safety/Progress/Social) for quick bottom-up specialization.
- �Clear all� resets all Directives back to Auto.
- QoL: Director panel shows an **active directives X/Y** hint.
- Version bump + dist rebuild.
- No save-breaking changes.

Files touched
- prototype/index.html
- dist/index.html
- dist/js/main.js
- dist/css/app.css
- DEVLOG.md

What to try
- Click **Match blocs**, then sort the Colony table by **Bloc** and watch how stable the colony stays when you loosen central planning (raise Autonomy).

---

## 2026-02-28 19:43 CST - v0.9.117 Role Quota presets (Stable / Advance)

Summary
- QoL: Role Quotas panel now has **Preset: Stable** (keeps basics staffed, adds warmth/guard/building as needed) and **Preset: Advance** (keeps scholar/toolsmith/builder online when unlocked).
- Presets are **unlock-aware** (won\'t assign Farmers before Farming, Toolsmith before Workshop, etc.) and **population-clamped** (won\'t exceed current pop).
- Works with existing **Undo** (policy + role quotas) snapshots.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- In **Role Quotas**, click **Preset: Stable** right before Winter and watch the colony self-staff Firekeeper/Forager/Woodcutter while still following your policy plan.

---

## 2026-02-28 21:59 CST - v0.9.126 Bulk Policy Locks (Auto Policy guardrail)

Summary
- QoL: Added **bulk Policy Locks** controls in the Policy panel (Lock basics / Lock all / Unlock all).
- This makes it easy to freeze your chosen multipliers so **Auto Policy** can�t fight your manual tuning during a run.
- Bulk actions are save-safe and only affect the existing per-action lock flags.
- Patch notes updated.

Files touched
- prototype/index.html
- dist/index.html
- dist/js/main.js
- dist/css/app.css
- DEVLOG.md

What to try
- Turn **Auto Policy** ON, then hit **Lock basics** and see the colony still adapts via non-locked levers (Research/Build/etc) without touching your survival multipliers.
---

## 2026-02-28 22:45 CST - v0.9.129 Preview-safe scoring (no global-state leaks)

Summary
- FIX: role pressure, personality pressure, and plan pressure now read from the current sim state (`s`) instead of the live global `state` (important for cloned-state previews).
- Advisor/Council preview sims (and any future lookahead tools) are now more trustworthy: decisions match the previewed policy/autonomy/dissent, not whatever the live tab is doing.
- No balance changes intended; this is a correctness + explainability reliability fix.
- Patch notes updated for v0.9.129 (and backfilled v0.9.128 notes that were missing from the list).

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/css/app.css`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Open Patch Notes and confirm v0.9.129 appears; then use any feature that runs a preview (Advisor/Council/Factions tooltips) and sanity-check that predicted behavior matches what happens when you click.

---

## 2026-02-28 23:00 CST - v0.9.130 Threat inspector (raids + defense explainability)

Summary
- NEW: click the **Threat** stat card to open a Threat inspector panel (raid ETA, threat target ETA, and trend).
- Explainability: inspector breaks down **defense score**, **damage mitigation multiplier**, and **repel chance** from palisade/guards/security/drills/curfew.
- QoL: Escape now closes the Threat inspector like the other modals.
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Let threat climb, then toggle **Curfew** / **Run Drills** and watch the inspector�s mitigation + repel chance update in real time.
---

## 2026-02-28 23:30 CST - v0.9.132 Auto Pause (danger) now forecasts spirals

Summary
- Upgraded **Auto Pause (danger)** to use smoothed resource rates to forecast near-term collapse instead of only hard thresholds.
- The director can now pause *before* you hit 0 edible food / 0 warmth / raid-at-100 threat when the trend says it�s imminent.
- Pause reasons now include a compact ETA for forecast-triggered pauses (ex: "0 in 18s").
- Patch notes updated.

Files touched
- `prototype/index.html`
- `dist/js/main.js`
- `dist/index.html`
- `dist/css/app.css`
- `DEVLOG.md`

What to try
- Enable **Auto Pause (danger)**, then intentionally run a negative food trend (raise Work pace + Tight rations) and watch it pause before edible hits zero.

---

## 2026-03-01 00:00 CST - v0.9.134 Commitment stat card (coordination clarity)

Summary
- NEW: added a **Commitment** stat card (x-multiplier) showing how long kittens tend to stick to tasks before reconsidering.
- Explainability: Commitment exposes the hidden Discipline + Effective Autonomy -> coordination multiplier, with example lock times for build/work tasks.
- This makes diagnosing task thrash ("why won't they stay on building") possible without digging into policy tooltips.
- Version bumped to v0.9.134.

Files touched
- `prototype/index.html`
- `dist/index.html`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Crank **Autonomy** high (and/or trigger dissent) vs crank **Discipline** high, then watch **Commitment** and the colony's task-switching behavior change.

---

## 2026-03-01 00:15 CST - v0.9.135 QoL/Politics: confirm faction negotiations

Summary
- QoL: added an optional confirmation prompt before applying **Faction negotiations** (prevents accidental policy drift).
- NEW Director toggle: **Confirm politics** (defaults ON). If ON, the prompt includes a preview of the exact deltas that will be applied.
- Keeps the existing **Undo** window intact (still ~120s).
- Patch notes updated.
- No save-breaking changes.

Files touched
- `prototype/index.html`
- `DEVLOG.md`

What to try
- Click **Negotiate** on any faction bloc and verify you get a preview + confirm; toggle Confirm politics OFF and verify it applies immediately.


---

## 2026-03-01 02:21 CST - P0.1 Modularization: extract save/load into state.js

Summary
- Phase 0 modularization slice: moved Save/Load + migrations into a new ES module: `js/state.js`.
- `main.js` now imports `saveGame/loadGame` and delegates save/load through the module boundary.
- No behavior changes intended; should be save-compatible.

Files touched
- `dist/js/state.js`
- `dist/js/main.js`
- `kitten-knight-civ/js/state.js`
- `kitten-knight-civ/js/main.js`
- `DEVLOG.md`

What to try
- Refresh with an existing save: confirm load works (kittens/resources appear) and that Export/Import still works.
- Make a small change (toggle a director setting), refresh, and confirm it persisted.


---

## 2026-03-01 02:53 CST - P0.1 Modularization: extract tiny helpers into util.js

Summary
- Phase 0 modularization slice: extracted tiny shared helpers into a new ES module: js/util.js.
- main.js now imports mt, clamp01, and 
ow from util.js instead of defining them inline.
- No behavior changes intended; this is a pure boundary/cleanup move.

Files touched
- js/util.js
- js/main.js
- DEVLOG.md

What to try
- Load the game and confirm the console is clean (no module 404s).
- Quick smoke: let it run ~10s, toggle Pause, refresh, and confirm save/load still works.
---

## 2026-03-01 03:53 CST - P0.1 Modularization: extract efficiency + momentum into sim.js

Summary
- Phase 0 modularization slice: moved the two core tick helpers **efficiency(...)** and **momentumMul(...)** out of js/main.js into js/sim.js.
- main.js now imports these helpers from sim.js instead of defining them inline.
- No behavior changes intended; this is a pure boundary/cleanup move to keep the sim layer reusable for future replay/offline harness work.

Files touched
- `kitten-knight-civ/js/sim.js`
- `kitten-knight-civ/js/main.js`
- `DEVLOG.md`

What to try
- Load an existing save and sanity-check:
  - kitten **Eff** values still respond to hunger/energy/winter warmth
  - momentum specialization still ramps slightly when a kitten repeats the same productive task

---

## 2026-03-01 04:23 CST - P0.1 Modularization: extract rate smoothing helpers into sim.js

Summary
- Phase 0 modularization slice: moved the deterministic **resource rate** smoothing (`ensureRateState`, `updateRates`) and **project ETA rate** smoothing (`updateProjectRates`) out of `js/main.js` into `js/sim.js`.
- `main.js` now imports these helpers from `sim.js`, further thinning the boot/UI file and centralizing sim utilities (useful for upcoming replay harness work).
- No behavior changes intended.

Files touched
- `kitten-knight-civ/js/sim.js`
- `kitten-knight-civ/js/main.js`
- `dist/js/sim.js`
- `dist/js/main.js`
- `DEVLOG.md`

What to try
- Open the game and sanity-check that:
  - top stat trends still update smoothly (food/wood/warmth/etc)
  - Projects panel ETAs still update for in-progress builds
  - Auto Pause (danger) still forecasts starvation/freezing/raid risk correctly


---

## 2026-03-01 04:53 CST - P0.1 Modularization: extract per-tick kitten execution into sim.js

Summary
- Phase 0 modularization slice: extracted the per-tick kitten execution loop (task tick + passive comfort regen + starvation hard-fail + pinned project auto-clear) into js/sim.js as runKittensTick(...).
- main.js now calls runKittensTick(state, dt, deps) instead of owning that loop.
- No behavior changes intended; this is a pure boundary/cleanup move to keep core sim steps reusable for replay/offline harness work.

Files touched
- kitten-knight-civ/js/sim.js
- kitten-knight-civ/js/main.js
- dist/js/sim.js
- dist/js/main.js
- DEVLOG.md

What to try
- Load the game and sanity-check:
  - kittens still execute tasks normally (Forage/Build/etc)
  - pinned projects still clear after 1 completion
  - starvation behavior still triggers only when no edible food remains

---

## 2026-03-01 05:23 CST - P0.1 Modularization: extract 1s decision/planning tick into sim.js

Summary
- Phase 0 modularization slice: extracted the 1-second �decision cadence� block (plan creation + per-kitten task selection + decision/act history bookkeeping) out of `js/main.js` into `js/sim.js` as `runDecisionSecond(s, deps)`.
- `main.js` now calls `runDecisionSecond(...)` and passes the needed deterministic helpers via dependency injection (matching the `runKittensTick(...)` pattern).
- No behavior changes intended; this is a boundary cleanup to prep for a deterministic replay harness.

Files touched
- `js/sim.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- Load the game and sanity-check:
  - kittens still re-plan once per second (tasks change at the same cadence)
  - Plan debug still shows desired/assigned + decision mix/activity history
  - no console errors (module import for runDecisionSecond)

---

## 2026-03-01 05:53 CST - P0.2 Test harness: add minimal replay_test.js (deterministic sim utilities)

Summary
- Phase 0.2: added a tiny `scripts/replay_test.js` harness that imports the deterministic sim utilities (`js/sim.js`) and runs invariant checks (seasons, EMA/rates, no NaNs).
- This is an incremental first step toward a full canned-save replay; it already catches obvious regression classes like broken exports, NaNs, or bad season math.

Files touched
- `scripts/replay_test.js`
- `DEVLOG.md`

What to try
- Run `node scripts/replay_test.js` (should print `replay_test: OK`).
---

## 2026-03-01 06:23 CST - P0.2 Replay harness: headless migrateState + stepSim (canned save)

Summary
- Phase 0.2: added a headless-friendly `migrateState(...)` helper in `js/state.js` (and refactored `loadGame(...)` to delegate to it).
- Added `stepSim(s, dt, deps)` in `js/sim.js` so replay/offline harnesses can drive the same sim orchestration layer without DOM/UI.
- Expanded `scripts/replay_test.js` to:
  - load a `scripts/canned_save.json`,
  - run migrations headlessly,
  - simulate 60s via `stepSim`,
  - assert basic invariants (no NaNs/infinities).

Files touched
- `dist/js/state.js`
- `dist/js/sim.js`
- `kitten-knight-civ/js/state.js`
- `kitten-knight-civ/js/sim.js`
- `scripts/replay_test.js`
- `scripts/canned_save.json`

What to try
- Run `node scripts/replay_test.js`.

---

## 2026-03-01 06:53 CST - P0.2 Replay harness: headless pressures + minimal task bundle

Summary
- Phase 0.2: added a small headless-safe `tickPressuresCore(s, dt)` to `dist/js/sim.js` and `js/sim.js` (warmth decay, threat drift, food spoilage soft-cap, and baseline hunger/energy drift).
- Added a minimal action bundle for the replay harness (`minimalTaskDefs()` + `decideTaskLite(...)`) so canned-save replays exercise real resource dynamics (not just invariants).
- Updated `scripts/replay_test.js` to use the new helpers (now tests real sim movement without importing main.js).

Files touched
- `dist/js/sim.js`
- `js/sim.js`
- `scripts/replay_test.js`
- `DEVLOG.md`

What to try
- Run `node scripts/replay_test.js` and confirm it prints `replay_test: OK`.

---

## 2026-03-01 07:23 CST - P0.2 Replay harness: extract lite task bundle into tasks_lite.js

Summary
- Phase 0.2: moved the replay harness lite task bundle (`efficiencyLite`, `minimalTaskDefs`, `decideTaskLite`) out of `js/sim.js` into a dedicated module: `js/tasks_lite.js`.
- `sim.js` now re-exports those helpers, keeping the public API stable while we iterate toward a shared subset of real task defs.
- No behavior changes intended; replay harness should still run identically.

Files touched
- `kitten-knight-civ/js/tasks_lite.js`
- `kitten-knight-civ/js/sim.js`
- `dist/js/tasks_lite.js`
- `dist/js/sim.js`
- `DEVLOG.md`

What to try
- Run `node scripts/replay_test.js` (should still print `replay_test: OK`).

---

## 2026-03-01 07:53 CST - P0.2 Replay harness: shared subset of real task defs (tasks_core)

Summary
- Phase 0.2: added `kitten-knight-civ/js/tasks_core.js`, a shared task-def factory (`makeCoreTaskDefs`) for the real economy tasks: **Forage / StokeFire / Guard / Research**.
- `kitten-knight-civ/js/main.js` now overrides those four task defs from the shared module (keeps behavior 1:1 with the game while we continue modularization).
- `scripts/replay_test.js` now uses the same shared task defs (with small stubs for tool/library bonuses + XP), reducing drift vs the live game.

Files touched
- `kitten-knight-civ/js/tasks_core.js`
- `kitten-knight-civ/js/main.js`
- `kitten-knight-civ/scripts/replay_test.js`
- `DEVLOG.md`

What to try
- Run `node scripts/replay_test.js` (should print `replay_test: OK`).
- Open the game and sanity-check early loops: Forage increases Food, StokeFire converts Wood?Warmth, Guard reduces Threat, Research increases Science.

---

## 2026-03-01 09:24 CST - P0.2 Replay harness: print compact deterministic delta summary

Summary
- Phase 0.2: `scripts/replay_test.js` now prints a compact **deterministic summary** after the 60s sim run (pop change, key resource deltas, avg vitals).
- Makes failures easier to diagnose (you can see "what moved" even when invariants still pass).

Files touched
- `scripts/replay_test.js`
- `DEVLOG.md`

What to try
- Run `node scripts/replay_test.js` and confirm it prints a `replay_test: summary` block before `replay_test: OK`.
---

## 2026-03-01 10:54 CST - P0.2 Replay harness: decision mix snapshot (AI triage)

Summary
- Expanded replay harness output with a deterministic **decisionMix** line.
- decisionMix reports counts/percentages for **rule / emergency / commit / score** decisions over the 60s window.
- Pairs with taskMix to make planner/execution regressions diagnosable from CI logs.

Files touched
- scripts/replay_test.js
- DEVLOG.md

What to try
- Run 
ode scripts/replay_test.js and confirm the summary includes decisionMix: (and remains deterministic run-to-run).

---

## 2026-03-01 11:24 CST - P0.2 Replay harness: end-state checksum line

Summary
- Added a deterministic `checksum:` line to the replay harness summary (both `scripts/replay_test.js` and `kitten-knight-civ/scripts/replay_test.js`).
- Checksum is an **FNV-1a 32-bit** hash over a stable payload: pop + key resources + vitals aggregates + taskMix + decisionMix.
- Gives CI logs a single-line, easy-to-diff replay signature.

Files touched
- scripts/replay_test.js
- kitten-knight-civ/scripts/replay_test.js
- DEVLOG.md

What to try
- Run `node scripts/replay_test.js` and confirm the checksum is stable run-to-run.
- With the current canned save, you should see: `checksum: fnv1a32:9ca10bb0`.


---

## 2026-03-01 11:54 CST - P0.2 Replay harness: golden checksum assert (+ update escape hatch)

Summary
- Replay harness now enforces a **golden checksum** for `scripts/canned_save.json` (fails if the end-state checksum drifts).
- Added `--update-golden` flag to intentionally refresh the golden checksum file (`scripts/canned_save.golden.json`).
- This turns the checksum into a real regression tripwire for CI/local runs while still keeping iteration unblocked.

Files touched
- `scripts/replay_test.js`
- `scripts/canned_save.golden.json`
- `DEVLOG.md`

What to try
- Run `node scripts/replay_test.js` (should print `golden: OK`).
- Temporarily change `scripts/canned_save.json` (or the sim) and confirm it fails with a golden mismatch.
- If the change is intentional, run `node scripts/replay_test.js --update-golden` to refresh.


---

## 2026-03-01 12:25 CST - P0.2 CI: GitHub Actions sanity workflow (parse + replay)

Summary
- Added a minimal GitHub Actions **CI** workflow that runs on every push/PR:
  - 
ode scripts/parse_check.js (imports core ES modules)
  - 
ode scripts/replay_test.js (golden checksum enforced)
- Goal: make replay checksum drift a visible regression signal.

Files touched
- .github/workflows/ci.yml
- scripts/parse_check.js
- DEVLOG.md

What to try
- Open the GitHub Actions tab and confirm **CI** passes (look for PARSE_IMPORT_OK + 
eplay_test: OK).



---

## 2026-03-01 12:55 CST - P0.1 Modularization: extract lightweight UI wiring into ui.js

Summary
- Phase 0 modularization slice: extracted a small, dependency-injected UI module (js/ui.js).
- Moved three UI concerns out of main.js:
  - clickable stat-card inspector routing (Social/Storage/Threat)
  - colony table header sorting wiring + transient uiSort state
  - debounced UI log helper (uiDebouncedLog) for sliders
- main.js now imports initUI(...) and receives uiSort + uiDebouncedLog back for render/handlers.
- No behavior changes intended; this is a boundary/cleanup move to keep UI code separable from sim for future refactors.

Files touched
- js/ui.js
- js/main.js
- DEVLOG.md

What to try
- In the game: click Dissent/Compliance/Focus-fit/Grievance and confirm Social inspector opens.
- Click Food Cap/Spoilage and Threat stat cards and confirm the right inspector opens.
- Click colony table headers to sort (desc->asc->off) and verify it still re-renders correctly.
- Drag Discipline/Work pace/Priorities sliders and confirm the event log stays debounced.
---

## 2026-03-01 13:25 CST - P0.1 Modularization: extract Patch Notes modal + history into ui.js/content.js

Summary
- Phase 0 modularization slice: moved Patch Notes **history data** into a new module: js/content.js.
- Moved Patch Notes **modal wiring + renderer** into initPatchNotes(...) in js/ui.js.
- main.js now just instantiates the patch-notes UI and delegates open/close/render + auto-show-on-update logic.
- No behavior changes intended (same patch list, same auto-open-on-new-version behavior).

Files touched
- js/content.js
- js/ui.js
- js/main.js
- DEVLOG.md

What to try
- Click **Patch Notes** in the header: confirm it opens and renders correctly.
- Hard refresh and verify there are no console/module 404 errors (content.js should load).


---

## 2026-03-01 13:55 CST - P0.1 Modularization: extract Decision/Inspect modal into ui.js

Summary
- Phase 0 modularization slice: extracted the Decision/Inspect modal subsystem (open/close/render + directive controls) into `initInspectModal(...)` in `js/ui.js`.
- `main.js` now delegates inspect modal rendering through the module boundary (further thinning the boot file).
- Also fixed a small import-line glitch where a literal `\n` had accidentally been embedded into the `ui.js` import line.
- No behavior changes intended.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- Click any kitten row to open the Decision Inspector; verify Directive controls still work (change directive repeatedly + refresh).
- Press **Esc** to close the inspector.

---

## 2026-03-01 14:55 CST - P0.1 Modularization: extract Save export/import/reset wiring into ui.js

Summary
- Phase 0 modularization slice: moved Save **Export/Import/Hard Reset** button wiring out of `main.js` and into a new `initSaveIO(...)` helper in `js/ui.js`.
- `main.js` now delegates UI events to the module boundary (keeps boot file thinner; keeps sim/mechanics separate).
- No behavior changes intended (same prompt/confirm flows; same clipboard + download behavior).

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- Click **Export**: confirm it copies to clipboard and downloads a JSON file.
- Click **Import**: paste a save JSON and confirm it loads.
- Click **Reset**: confirm it clears localStorage + returns to a fresh state.


---

## 2026-03-01 15:25 CST - P0.1 Modularization: extract Director Profiles wiring into ui.js

Summary
- Phase 0 modularization slice: moved the **Director Profiles (A/B/C)** button click wiring out of `main.js` and into `initDirectorProfiles(...)` in `js/ui.js`.
- `main.js` now just instantiates the UI helper and injects the sim/state concerns (ensureProfiles + snapshot/apply).
- No behavior changes intended; this is a boundary move to keep main.js thinner.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director Profiles, Save a slot, change some policy sliders, then Load that slot and confirm everything snaps back.

---

## 2026-03-01 15:56 CST - P0.1 Modularization: extract Director Profiles rendering into ui.js

Summary
- Phase 0 modularization slice: moved the **Director Profiles (A/B/C)** UI rendering (slot rows + saved-at hint text) out of main.js into a pure render helper: 
enderDirectorProfiles(...) in js/ui.js.
- main.js now just ensures profile data exists and delegates rendering to the UI module boundary.
- No behavior changes intended (same buttons, same enable/disable logic).

Files touched
- js/ui.js
- js/main.js
- DEVLOG.md

What to try
- Open Director Profiles: confirm slots show **empty/saved HH:MM**.
- Save a slot, refresh, and confirm the saved timestamp label persists.

---

## 2026-03-01 16:26 CST - P0.1 Modularization: extract pinned project UI rendering into ui.js

Summary
- Phase 0 modularization slice: moved the Director pinned-project selector + hint rendering out of `main.js` into a pure UI helper: `renderPinnedProjectControls(...)` in `js/ui.js`.
- `main.js` now just delegates rendering and injects the sim/state functions (`pinnedProjectInfo` / `pinnedProjectDef`).
- No behavior changes intended (same unlock gating + enable/disable logic).

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director: confirm the pinned hint + Clear Pin button show/hide correctly.
- Use the Pin Project dropdown: options should disable until the right unlocks (Granary/Workshop/Library).
- Pin a Hut: confirm the Pin button enables only when a valid option is selected.


---

## 2026-03-01 16:56 CST - P0.1 Modularization: extract Project Focus hint rendering into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Project focus** hint text rendering (auto "why" line + manual description) out of main.js into a pure UI helper: renderProjectFocusHint(...) in js/ui.js.
- main.js now delegates rendering and injects getEffectiveProjectFocus (keeps the sim-side decision logic in main).
- No behavior changes intended; UI text should match prior output 1:1.

Files touched
- js/ui.js
- js/main.js
- DEVLOG.md

What to try
- In Director, switch **Project focus** between Auto and a manual value (Housing/Defense/etc) and confirm the hint line updates correctly (including the auto "why" text).


---

## 2026-03-01 17:26 CST - P0.1 Modularization: extract Directive tools hint rendering into ui.js

Summary
- Phase 0 modularization slice: moved the Director Directive tools hint + enable/disable rendering out of main.js into a pure UI helper: renderDirectiveTools(...) in js/ui.js.
- main.js now delegates rendering and injects countActiveDirectives (keeps state logic in main).
- Small QoL: the Match blocs / Clear all buttons now disable when there are zero kittens.
- No behavior changes intended for the sim (UI-only).

Files touched
- js/ui.js
- js/main.js
- DEVLOG.md

What to try
- In Director, confirm the "active directives: X/Y" hint still updates.
- Start a fresh run (0 kittens) and confirm Directive tools buttons are disabled until you recruit.


---

## 2026-03-01 17:56 CST - P0.1 Modularization: extract Directive tools click wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Directive tools** button click wiring (Match blocs / Clear all) out of main.js into a new UI helper: initDirectiveTools(...) in js/ui.js.
- main.js now just injects the state mutators (setDirectivesMatchBlocs / clearAllDirectives) plus save/render into the UI module.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- js/ui.js
- js/main.js
- DEVLOG.md

What to try
- In Director, click **Match blocs** and confirm directives are applied + the event log reports counts.
- Click **Clear all** and confirm all directives reset to Auto.


---

## 2026-03-01 18:26 CST - P0.1 Modularization: extract Labor doctrine selector wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Labor doctrine** selector change wiring out of main.js into a new UI helper: `initDoctrineControls(...)` in `js/ui.js`.
- main.js now injects a tiny `setDoctrine(...)` mutator (normalizes to Balanced/Rotate/Specialize) plus log/save/render into the UI module.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director, switch doctrine between **Balanced / Rotate / Specialize** and confirm:
  - it logs a single "Labor doctrine ? X" line
  - it persists after refresh

---

## 2026-03-01 18:56 CST - P0.1 Modularization: extract Auto Doctrine toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Auto Doctrine** checkbox change wiring out of `main.js` into `js/ui.js` as `initAutoDoctrineControls(...)`.
- `main.js` now injects a tiny `setAutoDoctrine(...)` mutator (resets cooldown + clears last why) plus `log/save/render` into the UI module.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- Toggle **Auto Doctrine** ON/OFF in Director and confirm it logs once and persists after refresh.

---

## 2026-03-01 19:26 CST - P0.1 Modularization: extract Auto Rations toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Auto Rations** checkbox change wiring out of main.js into a new UI helper: initAutoRationsControls(...) in js/ui.js.
- main.js now injects a tiny setAutoRations(...) mutator (resets the auto-rations cooldown and clears the last why string when toggled off) plus log/save/render into the UI module.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director, toggle **Auto Rations** ON/OFF and confirm:
  - it logs a single "Auto Rations -> ON/OFF" line
  - turning it ON allows an immediate rations switch (no waiting)
  - it persists after refresh


---

## 2026-03-01 19:56 CST - P0.1 Modularization: extract Auto Recruit toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Auto Recruit** checkbox change wiring out of main.js into a new UI helper: initAutoRecruitControls(...) in js/ui.js.
- main.js now injects a tiny setAutoRecruit(...) mutator (clears the last why string when toggled off) plus log/save/render into the UI module.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director, toggle **Auto Recruit** ON/OFF and confirm:
  - it logs a single "Auto Recruit -> ON/OFF" line
  - it persists after refresh
  - the Season panel still shows the Auto Recruit why line when enabled



---

## 2026-03-01 20:27 CST - P0.1 Modularization: extract Auto Winter Prep toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Auto Winter Prep** checkbox change wiring out of main.js into a new UI helper: `initAutoWinterPrepControls(...)` in `js/ui.js`.
- main.js now injects a tiny `setAutoWinterPrep(...)` mutator plus log/save/render into the UI module.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director, toggle **Auto Winter Prep** ON/OFF and confirm:
  - it logs a single "Auto Winter Prep â†’ ON/OFF" line
  - it persists after refresh


---

## 2026-03-01 20:57 CST - P0.1 Modularization: extract Auto Food Crisis toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Auto Food Crisis** checkbox change wiring out of main.js into a new UI helper: `initAutoFoodCrisisControls(...)` in `js/ui.js`.
- main.js now injects a tiny `setAutoFoodCrisis(...)` mutator plus log/save/render into the UI module.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director, toggle **Auto Food Crisis** ON/OFF and confirm:
  - it logs a single "Auto Food Crisis ? ON/OFF" line
  - it persists after refresh

---

## 2026-03-01 21:27 CST - P0.1 Modularization: extract Auto Reserves toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Auto Reserves** checkbox change wiring out of main.js into a new UI helper: `initAutoReservesControls(...)` in `js/ui.js`.
- main.js now injects a tiny `setAutoReserves(...)` mutator plus log/save/render into the UI module.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director, toggle **Auto Reserves** ON/OFF and confirm:
  - it logs a single "Auto Reserves → ON/OFF" line
  - it persists after refresh\n
---

## 2026-03-01 21:57 CST - P0.1 Modularization: extract Auto Policy toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Auto Policy** checkbox change wiring out of main.js into a new UI helper: `initAutoPolicyControls(...)` in `js/ui.js`.
- main.js now injects a tiny `setAutoPolicy(...)` mutator (resets `autoPolicyNextAt` and clears `autoPolicyWhy` when toggled) plus log/save/render into the UI module.
- Removed the old inline DOM listener to avoid double-wiring.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director, toggle **Auto Policy** ON/OFF and confirm:
  - it logs a single "Auto Policy ? ON/OFF" line
  - it persists after refresh
  - turning it ON lets policy automation run immediately (no waiting)

---

## 2026-03-01 22:28 CST - P0.1 Modularization: extract Auto Build Push toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Auto Build Push** checkbox change wiring out of main.js into a new UI helper: `initAutoBuildPushControls(...)` in `js/ui.js`.
- main.js now injects a tiny `setAutoBuildPush(...)` mutator plus log/save/render into the UI module.
- Removed the old inline DOM listener to avoid double-wiring.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director, toggle **Auto Build Push** ON/OFF and confirm:
  - it logs a single "Auto Build Push → ON/OFF" line
  - it persists after refresh


---

## 2026-03-01 22:58 CST - P0.1 Modularization: extract Confirm politics toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Confirm politics** checkbox (`director.confirmFactions`) change wiring out of main.js into a new UI helper: `initConfirmPoliticsControls(...)` in `js/ui.js`.
- main.js now injects a tiny `setConfirmPolitics(...)` mutator plus log/save/render into the UI module.
- Removed the old inline DOM listener to avoid double-wiring.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `dist/js/ui.js`
- `dist/js/main.js`
- `kitten-knight-civ/js/ui.js`
- `kitten-knight-civ/js/main.js`
- `DEVLOG.md`

What to try
- In Director, toggle **Confirm politics** ON/OFF and confirm:
  - it logs a single "Confirm politics ? ON/OFF" line
  - it persists after refresh

---

## 2026-03-01 23:28 CST - P0.1 Modularization: extract Auto Mode toggle wiring into ui.js

Summary
- Phase 0 modularization slice: moved the Director **Auto Mode** checkbox change wiring out of main.js into a new UI helper: `initAutoModeControls(...)` in `js/ui.js`.
- main.js now injects a tiny `setAutoMode(...)` mutator (resets cooldown + clears last why when toggled off) plus log/save/render into the UI module.
- Removed the old inline DOM listener to avoid double-wiring.
- No behavior changes intended; this is a boundary/thinning step.

Files touched
- `js/ui.js`
- `js/main.js`
- `DEVLOG.md`

What to try
- In Director, toggle **Auto Mode** ON/OFF and confirm:
  - it logs a single "Auto Mode → ON/OFF" line
  - turning it ON allows an immediate mode switch (no waiting)
  - it persists after refresh
\n\n## 2026-03-01 23:36 CST � Curator mode UI purge (aquarium pivot)\n- Added new **Curator** controls (Culture goal / Ethos / Intervention) and tucked the old Director cockpit into a collapsed **Advanced controls** <details>.\n- Curator goal auto-enables core automation and sets sensible defaults for mode/priorities/doctrine; ethos maps to autonomy/discipline.\n- Added a live **Steering** summary line (shows what automation is currently doing + why).\n- Save-safe: added director.curator defaults + migration (goal/ethos/intervention/enabled/appliedOnce).\n
\n\n## 2026-03-02 00:10 CST � Observer HUD v1 (aquarium: feed + trends + canvas)\n- Added **Society feed** (persisted state.feed, capped) with periodic status lines + milestone events (unlocks, raids, skill-ups).\n- Added **Trends** sparkline canvas (last ~2 minutes; food/warmth/threat/science/dissent).\n- Added **Tank view** canvas: zones + kitten dots snap to task zones (no pathing; purely representational).\n- Added **Developer Mode** toggle to hide/show Advanced controls by default.\n
\n\n## 2026-03-02 00:33 CST � Graph overhaul v1 + ML v1 (learned priorities)\n- Trends graph upgraded to 5 stacked mini-charts (Food/Warmth/Threat/Science/Dissent) with per-row scaling + threshold lines + event markers (season flips/unlocks/raids/curator changes).\n- Added ML v1: deterministic online linear learner that adjusts Director priority sliders around Curator base intent (bounded deltas) and shows live ML deltas + loss under the Trends panel.\n
\n\n## 2026-03-02 00:41 CST � Safety Rules made read-only (Curator)\n- Safety Rules panel remains visible for transparency, but editing is disabled unless **Developer Mode** is enabled.\n- Disabled rule reorder/delete/toggle and hid Add/Restore buttons in Curator mode; attempts to edit produce a feed notice.\n
\n\n## 2026-03-02 00:56 CST � Adaptive Safety v1 (ML tunes thresholds)\n- Safety Rules remain player read-only in Curator mode, but ML can now tune a bounded subset of numeric thresholds: hungry/tired/warmth/threat.\n- Updates every ~8s with capped ranges + feed logs like \Learned safety: hungry>0.75?0.71 �\ plus a short reason (food deficit / cold risk / threat pressure / fatigue).\n- ML hint line now includes the current learned safety thresholds.\n
\n\n## 2026-03-02 01:00 CST � Easier population growth\n- Manual kitten cost curve reduced (cheaper base + gentler exponent).\n- Auto Recruit Spring immigration cost reduced (starts at ~18 food, slower scaling).\n- Immigration now posts to Society feed + adds a chart event marker.\n


---

## 2026-03-02 01:15 CST - Aquarium: Dominant bloc shift markers (feed + trends)

Summary
- Aquarium/Observability: when the **dominant values bloc** (Food/Safety/Progress/Social) changes, the sim now posts a one-line **Politics shift** message to the Society feed.
- Trends: the same shift drops a purple-ish **event marker** into the Trends graph (`kind: bloc`) so you can correlate macro-politics changes with resource swings.
- Anti-spam: includes a short cooldown + simple anti-flap rule so near-ties don't spam the feed.

Files touched
- `kitten-knight-civ/js/main.js`
- `dist/js/main.js`
- `PLAN_STATUS.md`

What to try
- Let the colony run hands-off with Curator enabled; watch the Society feed for a "Politics shift" line and see a matching marker line in Trends.

---

## 2026-03-02 01:30 CST - Aquarium: Relationship beats (buddy-need threshold markers)

Summary
- Aquarium depth/observability: buddy pairs now produce occasional **relationship beats** in the Society feed.
- When a pair�s buddy-need crosses thresholds, we log either:
  - **"drifting apart"** (high relationship pressure), or
  - **"reconnected"** (pressure relieved).
- Trends: each beat drops a small event marker (`kind:'rel'`, label drift/reconnect) so you can correlate social dynamics with resource swings.
- Anti-spam: one-side-only emission per pair + a short pair cooldown; beats are transient and stripped from saves.

Files touched
- `kitten-knight-civ/js/main.js`
- `dist/js/main.js`
- `kitten-knight-civ/js/state.js`
- `dist/js/state.js`
- `PLAN_STATUS.md`
- `DEVLOG.md`

What to try
- Run Curator hands-off for a few minutes with 4+ kittens.
- Watch the Society feed for **Relationship:** lines and confirm matching markers appear in the Trends graph.

---

## 2026-03-02 01:45 CST - Aquarium: Coteries (micro-factions)

Summary
- Aquarium depth: added **Coteries** — deterministic micro-factions that form as buddy-linked friendship circles (connected components over the buddy graph).
- Observability: Coteries are surfaced under the **Factions** panel (shows dominant axis + member names).
- Aquarium markers: when a coterie becomes **influential** (big + values-aligned), the sim posts a Society feed line and drops a Trends event marker (`kind:'cot'`).
- Anti-spam: rising-edge only with per-coterie cooldown.

Files touched
- `kitten-knight-civ/js/main.js`
- `dist/js/main.js`
- `PLAN_STATUS.md`
- `kitten-knight-civ/DEVLOG.md`

What to try
- Run Curator hands-off until you have **4+ kittens**.
- Open **Factions** and scroll to the **Coteries** section; confirm it lists circles and their dominant axis.
- Let the sim run a bit longer and watch for a feed line like **"Coterie rising"** plus a matching Trends marker.

---

## 2026-03-02 02:03 CST - Aquarium: Shared-work edges for Coteries (dynamic circles)

Summary
- Aquarium depth: Coteries now form from **buddy links + repeated shared-work ties** (not just static buddy connected-components).
- New transient, decaying **co-work edge** tracker: when multiple kittens execute the same productive task in the same second, their tie strengthens; it decays over time.
- Factions panel: coteries show a simple **cowork cohesion** sublabel + tooltip so you can see *why* a circle exists.
- Save-safe: shared-work edges are transient (`_sharedWorkEdges`) and automatically stripped from saves.

Files touched
- `kitten-knight-civ/js/main.js`
- `dist/js/main.js`
- `PLAN_STATUS.md`

What to try
- Run Curator hands-off with 4+ kittens.
- Watch coteries in **Factions** as the workforce shifts (e.g., several kittens foraging together should start merging circles over ~10�20s).

---

## 2026-03-02 02:18 CST - Aquarium: Coterie traditions (dominant co-work craft)

Summary
- Aquarium depth: each **Coterie** now has a tiny **Tradition** label derived from what its members have mostly been *doing lately* (dominant productive task over a decayed ~2-minute window).
- Observability: when a coterie�s tradition **meaningfully changes** (anti-tie + cooldown), the sim posts a one-line **Society feed** beat and drops a **Trends** event marker (`kind:'trad'`).
- Save-safety: per-kitten work memory + tradition trackers are transient and stripped on save.

Files touched
- `kitten-knight-civ/js/main.js`
- `dist/js/main.js`
- `kitten-knight-civ/js/state.js`
- `dist/js/state.js`
- `PLAN_STATUS.md`
- `DEVLOG.md`

What to try
- Run Curator hands-off with 4+ kittens.
- Open **Factions ? Coteries**: each coterie should show a tradition label (e.g., �builders� circle�).
- Let labor shift (toggle goals / seasons): watch for **Tradition shift:** lines in the Society feed and matching `trad` markers in Trends.

---

## 2026-03-02 02:33 CST - Aquarium: Coterie norms (ethos) + grievance bias

Summary
- Aquarium depth: each **Coterie** now develops a tiny 0..1 **Ethos** axis (**mutual aid** ↔ **strictness**) that slowly drifts from member Social values + the coterie's dominant tradition.
- Observability: coteries now show their **Ethos label** in the Factions panel, and influential ethos shifts post a **Society feed** beat + a Trends event marker (`kind:'eth'`).
- Emergence: when a coterie is **influential**, its ethos gently biases **Grievance** buildup for its members (mutual aid reduces resentment growth; strictness amplifies it slightly).
- Save-safe: ethos trackers are transient (stored under `_coterie*` and stripped from saves).

Files touched
- `kitten-knight-civ/js/main.js`
- `dist/js/main.js`
- `DEVLOG.md`
- `kitten-knight-civ/DEVLOG.md`
- `PLAN_STATUS.md`

What to try
- Run Curator hands-off with 4+ kittens.
- Open **Factions → Coteries** and watch each coterie show an ethos label (mutual aid/balanced/strictness).
- Let the colony drift between calm and stressful periods; watch for **Norms:** lines in the Society feed and see if grievance climbs slower/faster for members of influential circles.

---

## 2026-03-02 02:48 CST - Aquarium: Coterie pressure beats (aid vs strictness)

Summary
- Aquarium depth: influential coteries can now occasionally emit a short-lived **culture pressure** window:
  - **Mutual aid** ? members� **Grievance cools faster** for ~60s.
  - **Strict norms** ? colony **dissent desire** rises slightly for ~60s.
- Observability: each pressure posts a clear **Society feed** line and drops a Trends event marker (kind:'press').
- Save-safe: pressure state is transient (_coteriePressure*) and stripped from saves.

Files touched
- kitten-knight-civ/js/main.js
- dist/js/main.js
- kitten-knight-civ/js/state.js
- dist/js/state.js
- PLAN_STATUS.md

What to try
- Run Curator hands-off with **4+ kittens**.
- Watch the Society feed for **Culture:** lines, then:
  - during **mutual aid**, observe Grievance settle faster for members of the named circle
  - during **strict norms**, watch Dissent drift upward a bit faster (especially under harsh policy)
