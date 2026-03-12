// tasks_core.js — shared task definitions for both the browser game and headless harnesses.
//
// Phase 0.2 follow-up: start replacing the replay "lite" bundle with a shared subset
// of real task defs (Forage/StokeFire/Guard/Research at minimum).
//
// Design: export a factory so callers can inject any game-specific helpers.
// This avoids circular imports (no bundler) and keeps the harness headless-safe.

export function makeCoreTaskDefs(h = {}){
  const {
    clamp01,
    seasonAt,
    efficiency,
    momentumMul,
    workPaceMul,
    toolsBonus,
    libraryBonus,
    drillActive,
    gainXP,
    skillEffects,
  } = h;

  if (typeof clamp01 !== 'function') throw new Error('makeCoreTaskDefs: clamp01 required');
  if (typeof seasonAt !== 'function') throw new Error('makeCoreTaskDefs: seasonAt required');
  if (typeof efficiency !== 'function') throw new Error('makeCoreTaskDefs: efficiency required');
  if (typeof momentumMul !== 'function') throw new Error('makeCoreTaskDefs: momentumMul required');
  if (typeof workPaceMul !== 'function') throw new Error('makeCoreTaskDefs: workPaceMul required');

  const toolsB = (typeof toolsBonus === 'function') ? toolsBonus : (() => 1);
  const libB = (typeof libraryBonus === 'function') ? libraryBonus : (() => 1);
  const drillA = (typeof drillActive === 'function') ? drillActive : (() => 0);
  const gain = (typeof gainXP === 'function') ? gainXP : (() => {});
  const sfx = (typeof skillEffects === 'function') ? skillEffects
    : () => ({ outputMult: 1, fatigueMult: 1, hungerMult: 1, speedMult: 1, qualityMult: 1 });

  return {
    Forage: {
      enabled: () => true,
      tick: (s, k, dt) => {
        const season = seasonAt(s.t);
        const winterPenalty = season.name === 'Winter' ? 0.55 : 1;
        const fx = sfx(s, k, 'Forage');
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Forage');
        const wp = workPaceMul(s);
        const out = 1.85 * fx.outputMult * winterPenalty * toolsB(s) * dt * eff * mom * wp;
        s.res.food += out;
        k.energy = clamp01(k.energy - dt * 0.04 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp * fx.hungerMult);
        gain(s, k, 'Forage', dt * 1.0 * efficiency(s, k));
      }
    },

    StokeFire: {
      enabled: () => true,
      tick: (s, k, dt) => {
        // Convert wood to warmth. In winter, warmth decays faster, so this matters.
        if (s.res.wood <= 0) {
          k.energy = clamp01(k.energy - dt * 0.015);
          k.hunger = clamp01(k.hunger + dt * 0.02);
          return;
        }
        const fx = sfx(s, k, 'StokeFire');
        const wp = workPaceMul(s);
        const use = Math.min(s.res.wood, 0.9 * dt * wp * fx.speedMult);
        const mom = momentumMul(k, 'StokeFire');
        s.res.wood -= use;
        s.res.warmth = Math.min(100, s.res.warmth + use * 6.5 * mom * fx.outputMult);
        k.energy = clamp01(k.energy - dt * 0.02 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.02 * wp * fx.hungerMult);
        // Firekeeping is a real skill: as you keep the hearth going, you get better at it.
        gain(s, k, 'StokeFire', dt * 0.70 * efficiency(s, k));
      }
    },

    Guard: {
      enabled: () => true,
      tick: (s, k, dt) => {
        const fx = sfx(s, k, 'Guard');
        let base = s.unlocked?.security ? 2.6 : 2.1;
        const drill = drillA(s) ? 1 : 0;
        if (drill) base += 0.55; // training + patrols

        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Guard');
        const wp = workPaceMul(s);
        s.res.threat = Math.max(0, s.res.threat - base * fx.outputMult * dt * eff * mom * wp);
        k.energy = clamp01(k.energy - dt * 0.03 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp * fx.hungerMult);
        gain(s, k, 'Guard', dt * (1.0 + 0.35 * drill) * efficiency(s, k));
      }
    },

    Research: {
      enabled: () => true,
      tick: (s, k, dt) => {
        const fx = sfx(s, k, 'Research');
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Research');
        const wp = workPaceMul(s);
        const out = 0.95 * fx.outputMult * libB(s) * dt * eff * mom * wp;
        s.res.science += out;
        k.energy = clamp01(k.energy - dt * 0.035 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp * fx.hungerMult);
        gain(s, k, 'Research', dt * 1.0 * efficiency(s, k));
      }
    },
  };
}
