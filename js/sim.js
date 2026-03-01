// sim.js — core time/season helpers
// Phase 0 modularization: extracted from main.js to isolate deterministic sim utilities.

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
