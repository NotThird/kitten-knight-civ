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

  return {
    Forage: {
      enabled: () => true,
      tick: (s, k, dt) => {
        const season = seasonAt(s.t);
        const winterPenalty = season.name === 'Winter' ? 0.55 : 1;
        const mult = 1 + 0.07 * ((k.skills?.Foraging ?? 1) - 1);
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Forage');
        const wp = workPaceMul(s);
        const out = 1.85 * mult * winterPenalty * toolsB(s) * dt * eff * mom * wp;
        s.res.food += out;
        k.energy = clamp01(k.energy - dt * 0.04 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp);
        gain(k, 'Foraging', dt * 1.0 * efficiency(s, k));
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
        const wp = workPaceMul(s);
        const use = Math.min(s.res.wood, 0.9 * dt * wp);
        const mom = momentumMul(k, 'StokeFire');
        s.res.wood -= use;
        s.res.warmth = Math.min(100, s.res.warmth + use * 6.5 * mom);
        k.energy = clamp01(k.energy - dt * 0.02 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.02 * wp);
        // Firekeeping is a real skill: as you keep the hearth going, you get better at it.
        gain(k, 'Cooking', dt * 0.70 * efficiency(s, k));
      }
    },

    Guard: {
      enabled: () => true,
      tick: (s, k, dt) => {
        const mult = 1 + 0.10 * ((k.skills?.Combat ?? 1) - 1);
        let base = s.unlocked?.security ? 2.6 : 2.1;
        const drill = drillA(s) ? 1 : 0;
        if (drill) base += 0.55; // training + patrols

        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Guard');
        const wp = workPaceMul(s);
        s.res.threat = Math.max(0, s.res.threat - base * mult * dt * eff * mom * wp);
        k.energy = clamp01(k.energy - dt * 0.03 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp);
        gain(k, 'Combat', dt * (1.0 + 0.35 * drill) * efficiency(s, k));
      }
    },

    Research: {
      enabled: () => true,
      tick: (s, k, dt) => {
        const mult = 1 + 0.08 * ((k.skills?.Scholarship ?? 1) - 1);
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Research');
        const wp = workPaceMul(s);
        const out = 0.95 * mult * libB(s) * dt * eff * mom * wp;
        s.res.science += out;
        k.energy = clamp01(k.energy - dt * 0.035 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp);
        gain(k, 'Scholarship', dt * 1.0 * efficiency(s, k));
      }
    },
  };
}
