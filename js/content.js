// content.js — player-facing strings/content (patch notes, tooltips)

// Patch notes are cumulative: open after update to see everything since last seen version.
export const PATCH_HISTORY = [
    {
      v: '0.9.135',
      notes: [
        'QoL/Politics: added an optional confirmation prompt for Faction negotiations (prevents misclick drift).',
        'New toggle in Director: â€œConfirm politicsâ€. When ON, the prompt includes an exact preview of the policy deltas.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.134',
      notes: [
        'Explainability: added a Commitment stat card (coordination clarity).',
        'Commitment exposes the hidden Discipline + Effective Autonomy â†’ task lock tendency (helps diagnose thrash).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.133',
      notes: [
        'QoL: pinned projects ("Pin (finish 1)") now auto-clear immediately when the requested build completes.',
        'This prevents the Director from staying stuck in a stale pin state after you successfully finish the pinned Hut/Palisade/Granary/Workshop/Library.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.132',
      notes: [
        'QoL/Explainability: Auto Pause (danger) now uses simple trend forecasts (resource rates) so it can pause BEFORE you hit 0 (starving/freezing/raid imminent).',
        'The pause reason now includes an ETA when it is forecast-based (ex: â€œ0 in 18sâ€).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.131',
      notes: [
        'QoL/Explainability: clickable stat cards now show an "INSPECT" tag and highlight on hover (Dissent/Compliance/Focus-fit, Storage, Threat).',
        'Tip: click those stat cards to open the Social / Storage / Threat inspectors.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.130',
      notes: [
        'NEW Explainability: click the Threat stat card to open a Threat inspector (raid ETA, mitigation, repel chance, and defense breakdown).',
        'Escape closes the Threat inspector like other modals.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.129',
      notes: [
        'FIX: Action scoring now uses the current sim state consistently (plan pressure, role pressure, and personality pressure are preview-safe).',
        'This makes Advisor/Council previews and any cloned-state simulations more trustworthy (no hidden reads from the live global state).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.128',
      notes: [
        'Explainability/QoL: Top stat cards now show time-to-reserve (ETA until Food/Wood/Science/Tools hit your configured Reserves) when trends are negative.',
        'Added a clear BELOW RES flag when you are already under a reserve buffer.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.127',
      notes: [
        'QoL: Added a "Pin project" selector + button in the Director panel so pinning builds is discoverable without scrolling to Projects.',
        'Pinning still clears automatically after ONE unit completes, and it still sets Project focus to match.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.126',
      notes: [
        'QoL: Policy panel now has one-click bulk Policy Locks (Lock basics / Lock all / Unlock all) so Auto Policy can\'t fight your manual tuning.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.125',
      notes: [
        'QoL/Explainability: Sorting by Task now uses the effective executed task (shows fallback tasks when a sink is blocked by reserves/inputs).',
        'QoL/Explainability: Like/Dislike tags now evaluate against the executed task (so blocked fallbacks don\'t mislabel preferences).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.124',
      notes: [
        'QoL/Stability: Event log is now capped (persisted) so long sessions don\'t bloat save size / localStorage.',
        'Migration: old saves auto-trim oversized logs on load.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.123',
      notes: [
        'NEW: Bloc health panel (by values bloc) shows avg policy-fit, mood, and grievance so you can see who is unhappy at a glance.',
        'Explainability: panel includes a simple nudge pointing at the current highest-pressure bloc (useful when dissent starts creeping).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.122',
      notes: [
        'Director priorities: added a Social priority slider that biases Socialize/Care decisions (and shows in scoring reasons).',
        'Politics: Social bloc negotiations now steer prioSocial (with undo support + governance log deltas).',
        'No save-breaking changes (defaults to 100% if missing).'
      ]
    },
    {
      v: '0.9.121',
      notes: [
        'FIX/QoL: Directive selector in the Decision Inspector can now be changed repeatedly (it no longer only works once).',
        'Persistence: changing/clearing a kitten\'s Directive now saves immediately and writes a clear Event log line (so you can audit who you specialized).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.120',
      notes: [
        'Combat sim: Raids are now mitigated by your defenses (Palisade + Guards on duty + Security/Drills/Curfew). Strong defenses can fully repel a raid.',
        'Explainability: Raid log now reports mitigation factor + your defense snapshot (guards/palisade).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.119',
      notes: [
        'QoL/Clarity: Added an Edible stat (Food+Jerky) so you can see true starvation buffer at a glance (many systems use edible, not just fresh food).',
        'Explainability: Food stat subtitle now focuses on fresh-food trend + time-to-zero; Edible stat shows total edible trend + time-to-zero.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.118',
      notes: [
        'FIX: Accepting a Faction Demand now always applies the intended policy concession (it no longer fails due to the normal negotiation cooldown).',
        'Explainability: demand outcomes (Accepted / Ignored / Expired) now write clear entries into the Governance log with the concrete consequences.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.117',
      notes: [
        'QoL: Role Quotas panel now includes one-click presets (Stable / Advance) to quickly steer colony specialization without micromanaging each quota.',
        'Explainability: presets are population- and unlock-aware (won\'t assign Farmers before Farming, Toolsmith before Workshop, etc.).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.116',
      notes: [
        'NEW: Directive tools (batch): â€œMatch blocsâ€ sets each kittenâ€™s Directive to match their dominant Values bloc (Food/Safety/Progress/Social).',
        'QoL: Director panel now shows an â€œactive directives X/Yâ€ hint so you can see how many kittens youâ€™ve specialized at a glance.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.115',
      notes: [
        'QoL/Explainability: Season-change log now includes a compact Season Report (key stats + current season targets + active faction demand if any).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.114',
      notes: [
        'Explainability: Storage inspector now shows Edible (Food+Jerky) totals and clarifies that Jerky does not spoil and does not count toward the fresh-food storage cap.',
        'QoL: Storage inspector now surfaces Edible/Kitten and a quick â€œwhat is over-cap?â€ explanation so winter-prep decisions are less confusing.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.113',
      notes: [
        'NEW: Per-kitten Directive. Click a kitten row â†’ set Directive (Food/Safety/Progress/Social/Rest) to bias their scoring persistently (not a hard lock).',
        'UI: Pref column now shows â€œDir Xâ€ when a kitten has a non-Auto directive, so you can spot your specialists at a glance.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.111',
      notes: [
        'Explainability: the Social inspector now lists the most misaligned kittens (low focus-fit) so you can see who is grumbling without opening each inspector.',
        'QoL: click the Focus-fit (or Grievance) stat card to open the Social inspector directly.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.110',
      notes: [
        'QoL: Kitten Council now pops a â€œNEWâ€ badge and a single Event log line when a fresh council suggestion appears (so you don\'t miss bottom-up nudges while zoomed in elsewhere).',
        'Explainability: the log line includes the spokeskitten id + suggestion labels.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.109',
      notes: [
        'QoL: Projects panel now shows an ETA for in-progress builds (based on smoothed build progress/sec).',
        'Explainability: if a build is stalled by reserve-protected inputs, the ETA shows as â€œblockedâ€ (pairs with the Unblock button).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.108',
      notes: [
        'QoL: slider-driven policy logs are now debounced (Discipline / Work pace / Priorities) to prevent Event log spam while you drag.',
        'Explainability: log entries still fire after you stop dragging, so you can audit what you changed without noise.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.107',
      notes: [
        'AI behavior: when dissent is extreme but basics are stable, kittens are now more likely to actively organize (Socialize/Care) instead of everyone loafing.',
        'Explainability: Decision Inspector now shows â€œstrike recoveryâ€ scoring lines when this kicks in.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.106',
      notes: [
        'NEW: Governance log panel: records policy/priorities changes caused by Auto Policy and Faction negotiations.',
        'Explainability: Auto Policy entries include the top policy multiplier diffs so you can audit what changed (and why).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.104',
      notes: [
        'Fix: Auto Recruit no longer errors when enabled (season reference bug).',
        'Explainability: Season panel now shows why Auto Recruit is not triggering (housing / season window / stability / food+reserve cost).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.101',
      notes: [
        'QoL: Project pinning is now surfaced next to Project focus (shows what is pinned + a one-click Clear pin button).',
        'Explainability: Season panel also shows the active pinned project so you remember why focus is being forced.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.98',
      notes: [
        'NEW: Auto Council checkbox. When enabled, the Director will automatically hold Council when dissent is high and you can afford it (food+science above reserves).',
        'Fix: Director automation blocks are now correctly scoped again (Auto Drills no longer accidentally gated other automations).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.97',
      notes: [
        'NEW: Auto Pause (danger) checkbox. When enabled, the Director will auto-pause the sim during clear immediate danger (starving/freezing/raid risk).',
        'Explainability: Season panel shows the last auto-pause reason so you can diagnose the spiral.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.96',
      notes: [
        'UI/Explainability: Buddy column now shows buddy name + id + need% (instead of only id), making relationship pressure easier to read at a glance.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.95',
      notes: [
        'Advisor: now surfaces active Faction Demands (with a one-click Accept/Ignore suggestion) so politics doesn\'t get missed while you\'re fighting fires.',
        'Explainability: the Advisor recommendation explicitly keys off â€œbasics stable?â€ (food/warmth/threat) and time remaining.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.94',
      notes: [
        'QoL: added keyboard shortcut D to run Defense Drills (same behavior as the button; only triggers if drills are not already active).',
        'UI: Run Drills button tooltip now includes the shortcut.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.93',
      notes: [
        'Safety Rules: added condition â€œedible < Xâ€ (counts Food + Jerky) so you can trigger overrides based on total edible stores, not just fresh food.',
        'Explainability: the Safety Rules â€œAvailable conditionsâ€ list now calls out that edible includes jerky.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.92',
      notes: [
        'Civ-sim pressure: Overcrowding (pop > housing cap) now slowly increases Dissent and Grievance until you build more huts.',
        'Explainability: the event log pings once when overcrowding begins and once when it ends.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.91',
      notes: [
        'QoL: new Policy Undo button (2 minute window) restores your last manual Policy multiplier and Role quota change.',
        'Undo snapshot is recorded for: +/- tweaks, presets, policy reset, and role quota reset.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.90',
      notes: [
        'Civ-sim flavor: kittens now have deterministic names (save-safe). Names show in the colony table and the Decision Inspector.',
        'Explainability: buddy + faction behavior is easier to track when you can recognize individuals at a glance.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.89',
      notes: [
        'UI/Explainability: Colony table now shows a dedicated â€œFitâ€ column (policy focus-fit %) so you can quickly spot which kittens are misaligned with your current Mode + priority sliders.',
        'The Fit tag is color-coded (green/yellow/red) and has a tooltip explaining why low fit can drag mood and raise dissent under strong central planning.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.88',
      notes: [
        'Civ-sim: Kittens now slowly drift their Values (Food/Safety/Progress/Social) toward what they actually do each second. Specialization becomes "sticky" over minutes, creating emergent faction shifts.',
        'Explainability: Inspect + table tooltips show a short "drift â†’ AXIS" note when it happens, so policy changes feel traceable.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.87',
      notes: [
        'UI/Explainability: Faction negotiations now create an Undo snapshot (2 minute window) so you can experiment without permanent policy drift.',
        'Negotiation undo restores Director priorities (Food/Safety/Progress), Work pace, Discipline, and Policy multipliers.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.86',
      notes: [
        'Civ-sim pressure: Faction Demands now have teeth even if you ignore them by accident â€” when a Demand expires, it resolves as an automatic soft ignore (small dissent + grievance hit).',
        'Explainability: the event log explicitly calls out when a demand expires, so you can connect the mood/dissent drift to politics.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.85',
      notes: [
        'UI/Explainability: When a kittenâ€™s chosen task is BLOCKED by reserves/inputs and it executes a fallback (e.g. BuildHut â†’ ChopWood), the Task cell is now highlighted and tagged BLOCKED.',
        'This makes it easier to spot "why builders are stalling" moments and tune Reserves/Policy accordingly.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.84',
      notes: [
        'UI/Explainability: Food Cap and Spoilage stat cards are now clickable and open a Storage Inspector with the full cap breakdown and guidance.',
        'This makes the overcap/spoilage system easier to reason about (why you are bleeding food, and what levers to pull).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.83',
      notes: [
        'UI/Explainability: Colony table now shows each kitten\'s values bloc (Food/Safety/Progress/Social) as a first-class column.',
        'This makes Factions/Demands more legible: you can see who is in which bloc without opening the inspector.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.82',
      notes: [
        'NEW: Spoilage warning in the event log when food exceeds your storage cap by a meaningful margin.',
        'Explainability: the warning includes your current cap and spoilage multiplier, and suggests Granary / PreserveFood (jerky).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.81',
      notes: [
        'NEW: Faction Demands. On some season changes (when dissent is meaningful and the dominant values bloc feels misaligned), a bloc will issue a demand.',
        'You can Accept (small policy concession + stronger cohesion boost) or Ignore (dissent spikes + grievance for that bloc).',
        'Explainability: Demand shows its trigger reason + expiry timer in the Factions panel.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.80',
      notes: [
        'UI/Explainability: Policy panel now shows per-action plan impact (without policy â†’ with policy) next to each multiplier.',
        'This makes it easier to see which quotas actually change the colony plan (vs what is being overridden by needs/autonomy).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.79',
      notes: [
        'NEW: Auto Policy (Director checkbox). The Director gently nudges policy multipliers toward your Targets (food/kitten, warmth, threat).',
        'It makes small reversible changes with a cooldown, and it pauses during Crisis Protocol.',
        'Explainability: Season panel shows the last Auto Policy reason (what it was responding to).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.78',
      notes: [
        'UI/Explainability: Colony table now has a dedicated Buddy column that shows buddy id + buddy-need % (relationship pressure).',
        'High buddy-need highlights in yellow/red, giving an early warning for upcoming mood/grievance/dissent drift.',
        'No behavior changes; purely visibility (save-safe).'
      ]
    },
    {
      v: '0.9.77',
      notes: [
        'NEW: Auto Drills (Director checkbox). When enabled, the Director automatically runs Defense Drills when threat is getting high and basics are stable.',
        'Safety: won\'t spend below your reserves; uses a cooldown to avoid spammy re-firing.',
        'Explainability: Season panel shows the last auto-drill trigger (or why it\'s waiting).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.76',
      notes: [
        'NEW: Defense Drills (Director button). Spend food+wood for ~40s of improved security.',
        'Effect: threat grows slower while drills are running, and Guard training is more effective (faster threat reduction + more Combat XP).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.75',
      notes: [
        'UI/Explainability: starvation forecast now uses *edible* stores (food + jerky) instead of only fresh food.',
        'Director stats: Food stat subline now shows fresh rate vs edible rate, plus time-to-zero for edible stores (more accurate when preserving food).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.74',
      notes: [
        'FIX/QoL: Save files now strip more transient runtime/debug fields (decision history, dissent driver snapshots, per-second timers).',
        'Result: smaller saves and less chance of save bloat over long sessions; behavior is unchanged.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.73',
      notes: [
        'Factions: negotiating now has a short cooldown and the UI shows a preview of the policy concession before you click.',
        'Explainability: negotiation log now includes the exact policy/priority deltas that were applied.',
        'Result: the civ-sim politics lever is clearer and less spammy (fewer accidental priority drifts).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.72',
      notes: [
        'Buddy bonds upgraded: kittens now track Buddy-need (rises when separated; falls when spending time together).',
        'Behavior: high Buddy-need nudges Socialize choices and adds mild mood/grievance pressure (especially under strong central planning).',
        'Explainability: Decision Inspector header now shows buddy-need % when a buddy exists.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.71',
      notes: [
        'Director: Discipline/Autonomy now (transparently) affect task commitment length via a Coordination multiplier.',
        'Result: fewer 1s task flaps when Discipline is high; more emergent switching/wandering when Autonomy is high.',
        'Explainability: COMMIT decisions now display the current coord multiplier, and the Discipline hint shows "commitment xâ€¦".',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.70',
      notes: [
        'NEW: Factions (values blocs). Kittens now group into simple values blocs (Food/Safety/Progress/Social) based on their dominant Values axis.',
        'You can "Negotiate" with a bloc to apply a small, bounded policy concession (priority sliders / social levers). This eases dissent slightly (being heard) but can drift your plan.',
        'This adds a civ-sim governance loop: manage policy *and* politics, not just optimization.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.69',
      notes: [
        'NEW: Auto Build Push (Director checkbox). When enabled, BUILD PUSH toggles ON automatically while you are housing-capped, and OFF once housing is available again.',
        'This reduces micro: you can keep your huts moving without babysitting the BUILD signal.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.68',
      notes: [
        'NEW: Curfew (Director button + Q hotkey). Curfew slows threat growth (fewer raids) but steadily lowers morale and slightly increases dissent pressure while active.',
        'Explainability: Social inspector now includes Curfew as a dissent driver when enabled.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.67',
      notes: [
        'NEW: Grievance (per-kitten + colony avg) â€” a slow-burn resentment meter that rises when kittens are pushed into disliked/misaligned work under strong central planning.',
        'Dissent pressure now also includes Grievance (visible in Social inspector).',
        'Hold Council now also reduces Grievance (represents being heard).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.66',
      notes: [
        'FIX: Food stability/pressure now treats Jerky as edible food (food/kitten heuristics, auto-crisis, auto-recruit, advisor warnings, etc).',
        'FIX: Starvation now only triggers when *no edible food remains* (food + jerky).',
        'UI: added Edible/Kitten + Fresh/Kitten stats so preservation is visible and not confusing.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.65',
      notes: [
        'Explainability: Decision Inspector now shows a short-lived "Execution" line when a sink action was blocked by reserves/inputs and the kitten immediately fell back to a different task.',
        'Task tooltip also includes the short block reason for a few seconds (helps diagnose "why won\'t they build/craft" without digging through plan debug).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.64',
      notes: [
        'Explainability: Social inspector now shows colony average Values vs your current focus (Mode + priorities), plus the biggest mismatch axis.',
        'Helps you diagnose mood/dissent drift as a governance problem ("we want Food, you are pushing Progress") instead of a mystery.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.63',
      notes: [
        'Explainability: season transitions now log a clear one-line reminder of what just changed (Winter penalties, Spring relief, Fall prep window).',
        'Helps connect sudden output shifts to the seasonal model without needing to open panels.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.62',
      notes: [
        'NEW: Director priority preset "Consensus" sets Food/Safety/Progress priorities based on the colony\'s average kitten Values (bottom-up governance).',
        'This reduces value mismatch (often a precursor to mood/dissent issues) and lightly lowers dissent immediately to represent being listened to.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.61',
      notes: [
        'Explainability: Plan debug now includes a "Decision mix" section (rules vs emergencies vs commitment vs normal scoring).',
        'This makes it easier to tell whether the colony is off-plan because of hard safety overrides, personal needs, or just autonomy sampling.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.60',
      notes: [
        'Explainability: Plan debug now includes an "Activity" section (rolling last ~30s task shares).',
        'This makes it easier to see when autonomy/needs/dissent are pulling behavior off-plan, without clicking through every kitten.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.59',
      notes: [
        'QoL/Explainability: the Compliance stat card is now clickable (like Dissent) to open the Social inspector.',
        'This makes it faster to answer: "why are kittens ignoring the plan right now?" (compliance is the plan-strength multiplier).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.58',
      notes: [
        'Explainability/QoL: added Director policy stats to the top panel (Autonomy, Effective autonomy, Discipline, Work pace).',
        'These numbers make it easier to understand why kittens sometimes ignore the central plan (effective autonomy rises with dissent and falls with discipline).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.57',
      notes: [
        'QoL/Explainability: Reserves panel now shows a live "Recommended" line (season + population aware) so the buffer system is less guessy.',
        'NEW: "Apply recommended" sets your current reserves to those suggested values without enabling Auto Reserves (manual but guided).',
        'Auto Reserves uses the same shared recommendation logic (no behavior change, just consistency).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.56',
      notes: [
        'QoL/Explainability: the Food stat now shows your storage cap and (when relevant) current spoilage multiplier in its trend line.',
        'Food stat tooltip now explains the soft-cap â†’ spoilage mechanic in one place.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.55',
      notes: [
        'Explainability: added a Focus-fit stat (avg values alignment) so you can see at a glance when colony policy is mismatched with kitten values (often a precursor to mood/dissent issues).',
        'The stat also shows min fit + how many kittens are in the "low alignment" zone.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.54',
      notes: [
        'Explainability: Plan debug now shows when sink actions were blocked by reserves/inputs ("Blocked sinks"), so "desired vs assigned" mismatches are actionable.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.53',
      notes: [
        'Explainability: Threat stat now shows ETA to your Max threat target (when threat is rising), in addition to raid ETA.',
        'This makes it clearer when you are drifting into danger *before* an actual raid timer appears.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.52',
      notes: [
        'QoL: Stats cards now show tiny per-second trends + a few key ETAs (starve/freeze/raid/next unlock).',
        'Explainability: makes it easier to catch spirals early without opening the Advisor/Inspect panels.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.51',
      notes: [
        'FIX: Advisor now reads food storage over-cap/spoilage from the *current* state (was accidentally using the global state object).',
        'FIX: Winter Prep / Crisis Protocol toggles are now preview-safe for Council/Advisor simulations (no more accidental global mutations during preview).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.50',
      notes: [
        'QoL: keyboard shortcuts (when not typing): Space = Pause/Resume, 1â€“4 = Modes (Survive/Expand/Defend/Advance).',
        'QoL: W toggles Winter Prep, C toggles Crisis Protocol.',
        'QoL: F = Hold Festival, V = Hold Council (only when not already active).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.49',
      notes: [
        'NEW: Mentoring is now need-aware: mentors will preferentially teach skills that fill role quota shortfalls or current plan deficits (instead of always teaching their own specialty).',
        'Explainability: Mentor task tooltip now shows why that teaching skill was chosen (quota vs plan vs mentor specialty).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.48',
      notes: [
        'Explainability: Policy panel now includes a Plan preview (desired worker counts) shown both WITH and WITHOUT your policy multipliers.',
        'This makes it easier to see what your quota sliders are doing to the colony plan before Autonomy/traits/needs add variance.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.47',
      notes: [
        'FIX/NEW: StokeFire is now a real skill path (Cooking). Firekeepers gain Cooking XP while stoking the fire, and aptitude/traits can now bias toward hearth work.',
        'This makes winter warmth management feel more incremental: repeated firekeeping creates a specialist instead of a perpetual generalist.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.46',
      notes: [
        'FIX: Kitten Council once again reads real kitten likes/dislikes (personality); it was accidentally wired to an old k.prefs field.',
        'NEW: Council can now make Values-driven suggestions (nudge Food/Safety/Progress priority sliders, or raise Autonomy) when focus-fit is poor under strong central planning.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.45',
      notes: [
        'NEW: Kitten Values (Food/Safety/Progress/Social). When central planning is strong (low effective autonomy), value mismatch slowly reduces mood.',
        'Explainability: kitten table + inspector now show value vector and focus-fit % so you can see who is vibing with your current Mode + Priorities.',
        'No save-breaking changes (values are generated deterministically for older saves).'
      ]
    },
    {
      v: '0.9.44',
      notes: [
        'Kitten Council: added an "Undo last" button for a short window after accepting a council suggestion (restores previous policy multipliers).',
        'Explainability: council panel now shows what can be undone and for how long.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.43',
      notes: [
        'Kitten Council: council suggestion tooltips now include a preview of the exact policy multiplier changes (diff) before you accept.',
        'This makes bottom-up policy nudges more legible and safer to click.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.42',
      notes: [
        'Advisor: new quick action to toggle Winter Prep when Winter is near (late Fall).',
        'This makes the seasonal stockpile overlay more discoverable without auto-enabling it.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.41',
      notes: [
        'NEW: Priority presets (Balanced / Food / Safety / Progress) next to the Priority sliders.',
        'This makes it easier to quickly steer individual kitten behavior without touching detailed policy multipliers.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.39',
      notes: [
        'NEW: Kitten Council â€” occasional bottom-up policy suggestions from individual kittens (based on likes/traits + colony status).',
        'Accepting a council suggestion applies a small policy multiplier nudge (no hard locks).',
        'Explainability: the council panel shows who is speaking and why (mood/dissent/traits).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.38',
      notes: [
        'NEW: Director Priorities sliders (Food / Safety / Progress) â€” high-level policy weights that bias individual kitten scoring (not just the colony plan).',
        'Explainability: the action score breakdown now includes the priority line when it applies (look in the Decision Inspector).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.37',
      notes: [
        'QoL: Auto-pause when the tab is hidden; automatically resumes when you come back (does not override manual Pause).',
        'This reduces background CPU usage and avoids "oops I left it running" resource spirals.'
      ]
    },
    {
      v: '0.9.36',
      notes: [
        'NEW: Buddy bonds â€” each kitten gets a buddy (shown as b#id in the Traits column tooltip).',
        'When a kitten and their buddy Socialize at the same time, dissent drops a bit faster and their mood recovers slightly faster.',
        'Explainability: Buddy is shown in the Decision Inspector header.'
      ]
    },
    {
      v: '0.9.35',
      notes: [
        'Advisor: new quick actions for social stability â€” it can recommend (and one-click) Hold Council to reduce dissent and Hold Festival to boost mood when you can afford them.',
        'Explainability: makes the "colony is grumbling" fix path more discoverable without adding hidden automation.'
      ]
    },
    {
      v: '0.9.34',
      notes: [
        'NEW: Auto Rations toggle â€” the Director can automatically switch Tight/Normal/Feast based on food stability and dissent (with a cooldown to avoid flapping).',
        'Explainability: Season panel shows Auto rations status + the last reason.'
      ]
    },
    {
      v: '0.9.33',
      notes: [
        'Explainability: kitten Task cells now show an override badge when a RULE / EMERG / COMMIT decision forced the action (so you can instantly see why the plan wasn\'t followed).',
        'Task tooltip also mentions if autonomy sampled a non-#1 action ("top score was X").'
      ]
    },
    {
      v: '0.9.32',
      notes: [
        'Projects panel: new Unblock button appears when an in-progress project is stalled by reserve-protected inputs (wood/science/tools).',
        'Clicking Unblock lowers only the blocking reserve(s) by a small, safe step and sets Project focus to that track.',
        'This mirrors the Advisor\'s unblock behavior but puts it right where you\'re watching build progress.'
      ]
    },
    {
      v: '0.9.31',
      notes: [
        'Advisor: detects when an in-progress build (hut/palisade/granary/workshop/library) is stalled by reserves (wood/science/tools).',
        'New quick action: Loosen reserve (drops only the blocking reserve(s) by a small step and focuses that project).',
        'Explainability: reduces the "why won\'t they build?" confusion without removing the reserve system.'
      ]
    },
    {
      v: '0.9.30',
      notes: [
        'New: kitten Traits (Brave/Studious/Builder/Caretaker/Forager). Traits add a steady bias to scoring (separate from Autonomy likes/dislikes).',
        'Explainability: trait bonuses show directly in the Decision Inspector scoring reasons.',
        'UI: Traits column now shows trait tags; tooltip includes trait descriptions + prefs.'
      ]
    },
    {
      v: '0.9.29',
      notes: [
        'FIX: Safety Rules can now choose the Care action (previously missing from the rule action dropdown).',
        'Explainability: rule-created Care actions still respect reserves and will fall back to Socialize if blocked.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.28',
      notes: [
        'Explainability: food storage over-cap now shows Spoilage multiplier (x1..x4) in stats.',
        'Advisor: warns when you are bleeding food to over-cap spoilage, with a one-click Storage response.',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.27',
      notes: [
        'Patch notes: now cumulative (shows everything since your last seen version).',
        'Explainability: Projects panel now states which reserves are blocking a build (wood/science/tools).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.26',
      notes: [
        'QoL: +Kitten button shows pop/cap and disables itself when you are housing-capped or can\'t afford the food cost.',
        'Explainability: hover the button to see the exact reason (need food vs build huts).'
      ]
    }
];
