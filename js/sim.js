// sim.js — core time/season helpers
// Phase 0 modularization: extracted from main.js to isolate deterministic sim utilities.

import { clamp01 } from './util.js';

export const SEASON_LEN = 90; // seconds per season
export const seasons = ['Spring','Summer','Fall','Winter'];
export const YEAR_LEN = SEASON_LEN * seasons.length;

export function seasonAt(t){
  const tt = Math.max(0, Number(t ?? 0) || 0);
  const idx = Math.floor((tt / SEASON_LEN) % seasons.length);
  const phase = (tt % SEASON_LEN) / SEASON_LEN;
  return { name: seasons[idx], idx, phase };
}

export function yearAt(t){
  const tt = Math.max(0, Number(t ?? 0) || 0);
  return Math.floor(tt / YEAR_LEN);
}

// --- Seasonal target shaping (small "AI foresight" without hidden rules)
// We keep player-set targets as the baseline, then apply a transparent seasonal adjustment.
// The point: late-Fall stockpiling so Winter doesn't instantly collapse the colony.
export function seasonTargets(s){
  const base = s?.targets ?? { foodPerKitten:120, warmth:60, maxThreat:70 };
  const season = seasonAt(s?.t ?? 0);

  let foodPerKitten = Number(base.foodPerKitten ?? 120) || 120;
  let warmth = Number(base.warmth ?? 60) || 60;
  let maxThreat = Number(base.maxThreat ?? 70) || 70;

  let why = 'baseline';

  // Prep window: late Fall pushes stockpiles (food + a bit of warmth) before winter penalties hit.
  if (season.name === 'Fall' && season.phase >= 0.55) {
    foodPerKitten += 25;
    warmth += 6;
    why = 'late-Fall prep (+food target, +warmth target)';
  }

  // Winter already has stronger warmth logic elsewhere; keep targets readable.
  return { foodPerKitten, warmth, maxThreat, why };
}

export function secondsToNextSeason(s){
  const t = Math.max(0, Number(s?.t ?? 0) || 0);
  const phase = (t % SEASON_LEN) / SEASON_LEN;
  return (1 - phase) * SEASON_LEN;
}

export function secondsToNextWinter(s){
  const season = seasonAt(s?.t ?? 0);
  // seasons: Spring(0) Summer(1) Fall(2) Winter(3)
  const curIdx = season.idx;
  const toIdx = 3;
  const seasonsAhead = (toIdx - curIdx + seasons.length) % seasons.length;
  // If we're already in Winter, 0.
  if (seasonsAhead === 0) return 0;

  const remThis = secondsToNextSeason(s);
  const fullSeasons = Math.max(0, seasonsAhead - 1);
  return remThis + fullSeasons * SEASON_LEN;
}

// --- Work effectiveness (makes "Eat/Rest" meaningful and creates emergent slowdown spirals)
// 1.00 = full speed, lower when hungry/tired/cold.
// NOTE: intentionally simple + explainable; shown in UI as "Eff".
export function efficiency(s, k){
  const energy = clamp01(Number(k?.energy ?? 0));
  const hunger = clamp01(Number(k?.hunger ?? 0)); // 0 = full, 1 = starving

  // Energy: below 30% you crater.
  const energyMul = clamp01((energy - 0.30) / 0.70);

  // Hunger: above 85% you crater.
  const sat = 1 - hunger;
  const hungerMul = clamp01((sat - 0.15) / 0.85);

  // Cold: only really bites in winter + low warmth.
  const season = seasonAt(s?.t ?? 0);
  let coldMul = 1;
  if (season.name === 'Winter') {
    const w = clamp01(Number(s?.res?.warmth ?? 0) / 40); // 0..1 at warmth 0..40
    coldMul = 0.65 + 0.35 * w; // 0.65..1.00
  }

  // Health: sickness/injury reduces throughput but doesn't hard-stop.
  const health = clamp01(Number(k?.health ?? 1));
  const healthMul = 0.55 + 0.45 * health; // 0.55..1.00

  // Mood: tiny boost/penalty based on how "aligned" they feel.
  const mood = clamp01(Number(k?.mood ?? 0.55));
  const moodMul = 0.88 + 0.24 * mood; // 0.88..1.12

  return Math.max(0.20, energyMul * hungerMul * coldMul * healthMul * moodMul);
}

// --- Momentum (emergent specialization via "getting in the groove")
// If a kitten keeps doing the same productive task for several seconds, they get a small throughput bonus.
export function momentumMul(k, action){
  const a = String(action ?? '');
  if (!a || a === 'Eat' || a === 'Rest' || a === 'Loaf' || a === 'Socialize' || a === 'Care') return 1;
  const streak = Math.max(0, Number(k?.taskStreak ?? 0) || 0);
  if (streak <= 1) return 1;
  // +2% per second after the first, capped at +20%.
  return 1 + Math.min(0.20, (streak - 1) * 0.02);
}

// --- Explainability: smoothed deltas (for UI rates + ETAs)
// Deterministic, save-safe: stored in transient keys on state (not persisted).

export function ensureRateState(s){
  if (!s._rate) s._rate = Object.create(null);
  if (!s._prevRes) s._prevRes = structuredClone(s.res);
}

export function ema(oldV, newV, alpha){
  if (!Number.isFinite(oldV)) return newV;
  return oldV + (newV - oldV) * alpha;
}

export function updateRates(s, dt){
  ensureRateState(s);
  const tau = 8; // seconds (higher = steadier)
  const alpha = clamp01(dt / tau);

  for (const key of Object.keys(s.res)) {
    const prev = Number(s._prevRes[key] ?? 0);
    const cur = Number(s.res[key] ?? 0);
    const inst = (cur - prev) / Math.max(0.001, dt);
    s._rate[key] = ema(s._rate[key], inst, alpha);
    s._prevRes[key] = cur;
  }
}

export function ensureProjRateState(s){
  if (!s._projRate) s._projRate = Object.create(null);
  if (!s._prevProj) s._prevProj = {
    _hutProgress: Number(s._hutProgress ?? 0) || 0,
    _palProgress: Number(s._palProgress ?? 0) || 0,
    _granProgress: Number(s._granProgress ?? 0) || 0,
    _workProgress: Number(s._workProgress ?? 0) || 0,
    _libProgress: Number(s._libProgress ?? 0) || 0,
  };
}

export function unwrapProjectDelta(delta, req){
  // Project progress wraps down when a building completes (progress -= req).
  // We treat that as continuous work for rate purposes.
  let d = Number(delta ?? 0);
  const r = Number(req ?? 0);
  if (!Number.isFinite(d) || !Number.isFinite(r) || r <= 0) return 0;
  if (d < 0) d = d + r; // wrapped completion
  if (d < 0) d = 0;
  return d;
}

export function updateProjectRates(s, dt){
  ensureProjRateState(s);
  const tau = 10; // seconds (steadier than resources; avoids noisy ETAs)
  const alpha = clamp01(dt / tau);

  const defs = [
    { key:'_hutProgress', req:12 },
    { key:'_palProgress', req:16 },
    { key:'_granProgress', req:22 },
    { key:'_workProgress', req:26 },
    { key:'_libProgress', req:30 },
  ];

  for (const d of defs) {
    const prev = Number(s._prevProj?.[d.key] ?? 0);
    const cur = Number(s[d.key] ?? 0);
    const delta = unwrapProjectDelta(cur - prev, d.req);
    const inst = delta / Math.max(0.001, dt);
    s._projRate[d.key] = ema(s._projRate[d.key], inst, alpha);
    s._prevProj[d.key] = cur;
  }
}

// --- Core per-tick kitten execution (modularization slice)
// Extracted from main.js: execute each kitten's current task + apply passive regen and hard-fail checks.
// Kept deterministic and dependency-injected so the sim layer can be reused in replay/offline harnesses.
export function runKittensTick(s, dt, deps){
  const taskDefs = deps?.taskDefs;
  const edibleFood = deps?.edibleFood;
  const log = deps?.log;
  const pinnedProjectInfo = deps?.pinnedProjectInfo;
  const clearPinnedProject = deps?.clearPinnedProject;

  for (const k of s.kittens) {
    // Per-tick execution marker for blocked sink actions that fallback to a different task.
    // Cleared every tick; set by doFallback(...).
    k._fallbackTo = null;
    // Per-tick mentoring target (only set when the Mentor action runs).
    k._mentor = null;

    const def = taskDefs?.[k.task] ?? taskDefs?.Rest;
    if (def?.tick) def.tick(s, k, dt);

    // Passive regen from warmth and shelter
    const comfort = (s.res.warmth / 100) * 0.004 + s.res.huts * 0.0007;
    k.energy = clamp01(k.energy + dt * comfort);
    if (k.hunger > 0.82) k.energy = clamp01(k.energy - dt * 0.01);

    // Starvation/sickness spiral: extreme hunger slowly damages health (even before death).
    // Jerky counts as edible food; only apply the harsh spiral when *nothing edible* remains.
    const edible = (typeof edibleFood === 'function') ? edibleFood(s) : 0;
    if (k.hunger > 0.92 && edible <= 0) {
      k.health = clamp01((k.health ?? 1) - dt * 0.020);
    } else if (k.hunger > 0.92) {
      k.health = clamp01((k.health ?? 1) - dt * 0.006);
    }

    // Hard fail: starvation (only if *no edible food* remains)
    if (edible <= 0 && k.hunger >= 0.98) {
      // lose a kitten (rare, but makes it a civ sim)
      s.kittens = s.kittens.filter(x => x.id !== k.id);
      if (typeof log === 'function') log(`A kitten starved. Population: ${s.kittens.length}`);
      break;
    }
  }

  // Pinned project completion: clear the pin once ONE unit completes.
  const pin = (typeof pinnedProjectInfo === 'function') ? pinnedProjectInfo(s) : null;
  if (pin && pin.completed && typeof clearPinnedProject === 'function') {
    clearPinnedProject(s, `Pinned project complete: built 1 ${pin.type}.`);
  }
}

// --- Core per-second decision/planning tick (modularization slice)
// Extracted from main.js: everything that happens at the 1s "decision cadence".
// Deterministic + dependency-injected so replay/offline harnesses can run the same logic.
export function runDecisionSecond(s, deps){
  const ensureBuddies = deps?.ensureBuddies;
  const desiredWorkerPlan = deps?.desiredWorkerPlan;
  const updateRoles = deps?.updateRoles;
  const makeShadowAvail = deps?.makeShadowAvail;
  const decideTask = deps?.decideTask;
  const updateMoodPerSecond = deps?.updateMoodPerSecond;
  const updateGrievancePerSecond = deps?.updateGrievancePerSecond;
  const updateBuddyNeedPerSecond = deps?.updateBuddyNeedPerSecond;
  const updateValuesPerSecond = deps?.updateValuesPerSecond;
  const commitSecondsForTask = deps?.commitSecondsForTask;
  const reserveForTask = deps?.reserveForTask;

  if (typeof ensureBuddies === 'function') ensureBuddies(s);

  // Explainability: reset per-second blocked-action counters (populated by doFallback during execution).
  s._blockedThisSecond = Object.create(null);
  s._blockedMsgThisSecond = Object.create(null);

  const plan = (typeof desiredWorkerPlan === 'function') ? desiredWorkerPlan(s) : { desired:{}, assigned:{} };
  if (typeof updateRoles === 'function') updateRoles(s, plan);

  // Planning-time reservations: keep later kittens from piling onto the same scarce-input sink.
  const shadowAvail = (typeof makeShadowAvail === 'function') ? makeShadowAvail(s) : null;
  const ctx = { shadowAvail };

  // Explainability: track what kind of decision dominated lately (rules vs emergencies vs commits vs normal scoring).
  const decisionKinds = { rule:0, emergency:0, commit:0, score:0 };

  // Decide in a stable order, but let needs/emergencies override plan.
  for (const k of (s.kittens ?? [])) {
    // Commitment timer ticks down at decision cadence (1s).
    k.taskLock = Math.max(0, (k.taskLock ?? 0) - 1);

    // Block cooldown timer ticks down too (prevents repeated retries of blocked sink actions).
    k.blockedCooldown = k.blockedCooldown ?? {};
    for (const key of Object.keys(k.blockedCooldown)) {
      const v = Math.max(0, (Number(k.blockedCooldown[key] ?? 0) || 0) - 1);
      if (v <= 0) delete k.blockedCooldown[key];
      else k.blockedCooldown[key] = v;
    }

    const prevTask = k.task;
    const d = (typeof decideTask === 'function') ? decideTask(s, k, plan, ctx) : { task: prevTask, why: 'no-decider' };

    // Mood/grievance/social drift at 1s cadence (makes colony feel "alive" without per-frame churn).
    if (typeof updateMoodPerSecond === 'function') updateMoodPerSecond(s, k, d.task);
    if (typeof updateGrievancePerSecond === 'function') updateGrievancePerSecond(s, k, d.task);
    if (typeof updateBuddyNeedPerSecond === 'function') updateBuddyNeedPerSecond(s, k, d.task);
    if (typeof updateValuesPerSecond === 'function') updateValuesPerSecond(s, k, d.task);

    // Memory: track how long we've been doing the same job (1s resolution)
    k.taskStreak = (prevTask === d.task) ? ((k.taskStreak ?? 0) + 1) : 0;

    // If we switched tasks, start a short commitment window.
    if (prevTask !== d.task && typeof commitSecondsForTask === 'function') {
      k.taskLock = commitSecondsForTask(s, d.task);
    }

    k.task = d.task;
    k.why = d.why;
    plan.assigned = plan.assigned ?? {};
    plan.assigned[d.task] = (plan.assigned[d.task] ?? 0) + 1;

    // Decision mix (explainability)
    const kind = String(k._lastDecision?.kind ?? 'score');
    if (kind in decisionKinds) decisionKinds[kind] += 1;
    else decisionKinds.score += 1;

    // Reserve estimated scarce inputs for this task so later kittens see reduced availability.
    if (typeof reserveForTask === 'function') reserveForTask(shadowAvail, d.task);
  }

  plan.decisionKinds = decisionKinds;

  // Attach last-second execution blockers so Plan debug can surface reserve/input stalls.
  plan.blocked = { ...(s._blockedThisSecond ?? {}) };
  plan.blockedMsg = { ...(s._blockedMsgThisSecond ?? {}) };

  // Activity history (explainability): keep a rolling window of what actually happened.
  s._actHist = s._actHist ?? [];
  s._actHist.push({ t: s.t, assigned: { ...(plan.assigned ?? {}) } });
  if (s._actHist.length > 30) s._actHist.splice(0, s._actHist.length - 30);

  // Decision mix history (explainability): why the plan is being overridden.
  s._decHist = s._decHist ?? [];
  s._decHist.push({ t: s.t, kinds: { ...(plan.decisionKinds ?? {}) } });
  if (s._decHist.length > 30) s._decHist.splice(0, s._decHist.length - 30);

  s._lastPlan = plan;
  return plan;
}

// --- Headless-friendly pressures + minimal task bundle (P0.2 slice)
// Goal: let replay/offline harnesses run *meaningful* colony dynamics without importing main.js.
// This is intentionally conservative and incomplete vs the full game tickPressures.

export function foodStorageCap(s){
  const huts = Math.max(0, Number(s?.res?.huts ?? 0));
  const gran = Math.max(0, Number(s?.res?.granaries ?? 0));
  const base = 260;
  return base + huts * 90 + gran * 260;
}

export function edibleFood(s){
  return (Number(s?.res?.food ?? 0) || 0) + (Number(s?.res?.jerky ?? 0) || 0);
}

export function tickPressuresCore(s, dt, deps = {}){
  const stepDt = Math.max(0, Number(dt ?? 0) || 0);
  if (!s || stepDt <= 0) return;

  s.res = s.res ?? {};
  s.kittens = s.kittens ?? [];

  const season = seasonAt(s.t ?? 0);

  // --- Warmth decay (winter is harsher)
  // Tuned only to be plausible + deterministic for headless tests.
  const warmDecay = (season.name === 'Winter') ? 0.18 : 0.06;
  s.res.warmth = Math.max(0, (Number(s.res.warmth ?? 0) || 0) - warmDecay * stepDt);

  // --- Threat drift upward (slow, unless guards/drills/etc in full game)
  const thrGrow = (season.name === 'Winter') ? 0.040 : 0.030;
  s.res.threat = Math.max(0, (Number(s.res.threat ?? 0) || 0) + thrGrow * stepDt);

  // --- Food spoilage soft-cap (keeps granaries meaningful)
  const cap = foodStorageCap(s);
  const food = Math.max(0, Number(s.res.food ?? 0) || 0);
  if (food > cap) {
    const over = food - cap;
    const overFrac = over / Math.max(1, cap);
    const spoilMul = 1 + Math.min(3, overFrac * 3); // 1..4
    const baseSpoil = 0.012; // /s
    const loss = baseSpoil * spoilMul * stepDt;
    s.res.food = Math.max(0, food - loss);
  }

  // --- Baseline hunger/energy drift so headless sims aren't "frozen"
  // (Full game applies richer per-task costs; this just keeps state moving.)
  for (const k of s.kittens) {
    k.hunger = clamp01((Number(k.hunger ?? 0) || 0) + stepDt * 0.008);
    k.energy = clamp01((Number(k.energy ?? 1) || 0) - stepDt * 0.006);
    k.health = clamp01(Number(k.health ?? 1));
  }

  // Optional hook for tests (no-op in game)
  if (typeof deps.onPressures === 'function') deps.onPressures(s, stepDt, season);
}

export { efficiencyLite, minimalTaskDefs, decideTaskLite } from './tasks_lite.js';

// --- Headless-friendly sim step (for replay/offline harnesses)
// Mirrors main.js's step(dt) orchestration but keeps all dependencies injected.
export function stepSim(s, dt, deps = {}){
  const stepDt = Math.max(0, Number(dt ?? 0) || 0);
  if (stepDt <= 0) return;

  s.t = (Number(s.t ?? 0) || 0) + stepDt;

  // Optional outer-layer hooks (kept out of this module for now)
  if (typeof deps.applyUnlocks === 'function') deps.applyUnlocks(s);
  if (typeof deps.tickPressures === 'function') deps.tickPressures(s, stepDt);

  s._decTimer = (Number(s._decTimer ?? 0) || 0) + stepDt;
  while (s._decTimer >= 1) {
    s._decTimer -= 1;
    runDecisionSecond(s, deps);
  }

  runKittensTick(s, stepDt, deps);

  // Explainability: maintain smoothed deltas (not saved)
  updateRates(s, stepDt);
  updateProjectRates(s, stepDt);
}
