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
