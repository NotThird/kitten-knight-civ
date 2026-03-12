// tasks_lite.js — headless-safe "lite" task bundle for replay/offline harnesses.
//
// P0.2 follow-up slice: move the minimal task definitions out of sim.js so the harness
// can evolve independently (and we can later swap in real/shared task defs).
//
// NOTE: This file intentionally duplicates a tiny subset of season/target helpers to
// avoid circular imports with sim.js (no bundler, ES modules).

import { clamp01 } from './util.js';

const SEASON_LEN = 90;
const seasons = ['Spring','Summer','Fall','Winter'];

function seasonAtLite(t){
  const tt = Math.max(0, Number(t ?? 0) || 0);
  const idx = Math.floor((tt / SEASON_LEN) % seasons.length);
  const phase = (tt % SEASON_LEN) / SEASON_LEN;
  return { name: seasons[idx], idx, phase };
}

function seasonTargetsLite(s){
  const base = s?.targets ?? { foodPerKitten:120, warmth:60, maxThreat:70 };
  const season = seasonAtLite(s?.t ?? 0);

  let foodPerKitten = Number(base.foodPerKitten ?? 120) || 120;
  let warmth = Number(base.warmth ?? 60) || 60;
  let maxThreat = Number(base.maxThreat ?? 70) || 70;

  // Match sim.js: late-Fall prep bump.
  if (season.name === 'Fall' && season.phase >= 0.55) {
    foodPerKitten += 25;
    warmth += 6;
  }

  return { foodPerKitten, warmth, maxThreat, why: 'lite' };
}

function edibleFoodLite(s){
  return (Number(s?.res?.food ?? 0) || 0) + (Number(s?.res?.jerky ?? 0) || 0);
}

export function efficiencyLite(s, k){
  const energy = clamp01(Number(k?.energy ?? 1));
  const hunger = clamp01(Number(k?.hunger ?? 0));
  const sat = 1 - hunger;
  const season = seasonAtLite(s?.t ?? 0);
  const coldMul = (season.name === 'Winter') ? (0.70 + 0.30 * clamp01((Number(s?.res?.warmth ?? 0) || 0) / 40)) : 1;
  return Math.max(0.25, (0.60 + 0.40 * energy) * (0.55 + 0.45 * sat) * coldMul);
}

export function minimalTaskDefs(){
  // Minimal action set used by replay_test. Not intended to match full game balance.
  return {
    Rest: {
      tick: (s, k, dt) => {
        k.energy = clamp01((Number(k.energy ?? 0) || 0) + dt * 0.020);
        // Eat tiny amount if hungry and food exists.
        if (k.hunger > 0.15 && (Number(s.res.food ?? 0) || 0) > 0.2) {
          const eat = Math.min(0.30 * dt, Number(s.res.food ?? 0) || 0);
          s.res.food = Math.max(0, (Number(s.res.food ?? 0) || 0) - eat);
          k.hunger = clamp01(k.hunger - eat * 0.012);
        }
      }
    },
    Forage: {
      tick: (s, k, dt) => {
        const season = seasonAtLite(s.t ?? 0);
        const eff = efficiencyLite(s, k);
        const winterPenalty = (season.name === 'Winter') ? 0.55 : 1.0;
        const gain = 0.16 * eff * winterPenalty * dt;
        s.res.food = (Number(s.res.food ?? 0) || 0) + gain;
        k.hunger = clamp01(k.hunger - gain * 0.006);
      }
    },
    StokeFire: {
      tick: (s, k, dt) => {
        const eff = efficiencyLite(s, k);
        const needWood = 0.050 * dt;
        const wood = Number(s.res.wood ?? 0) || 0;
        if (wood >= needWood) {
          s.res.wood = wood - needWood;
          s.res.warmth = (Number(s.res.warmth ?? 0) || 0) + 0.35 * eff * dt;
        }
      }
    },
    Guard: {
      tick: (s, k, dt) => {
        const eff = efficiencyLite(s, k);
        s.res.threat = Math.max(0, (Number(s.res.threat ?? 0) || 0) - 0.10 * eff * dt);
      }
    },
    Research: {
      tick: (s, k, dt) => {
        const eff = efficiencyLite(s, k);
        s.res.science = (Number(s.res.science ?? 0) || 0) + 0.07 * eff * dt;
      }
    },
  };
}

export function decideTaskLite(s, k){
  // Very small headless planner: keep edible/kitten and warmth near seasonal targets.
  const pop = Math.max(1, Number(s?.kittens?.length ?? 1));
  const targets = seasonTargetsLite(s);

  const ediblePk = edibleFoodLite(s) / pop;
  const warm = Number(s?.res?.warmth ?? 0) || 0;
  const thr = Number(s?.res?.threat ?? 0) || 0;

  if (ediblePk < targets.foodPerKitten * 0.65) return { task:'Forage', why:'lite: food deficit' };
  if (warm < targets.warmth * 0.70) return { task:'StokeFire', why:'lite: warmth deficit' };
  if (thr > targets.maxThreat * 1.10) return { task:'Guard', why:'lite: threat high' };

  // Otherwise: build science in good times.
  if ((Number(s?.res?.science ?? 0) || 0) < 60) return { task:'Research', why:'lite: early science' };

  return { task:'Rest', why:'lite: rest' };
}
