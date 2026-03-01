// scripts/replay_test.js
// Deterministic replay-style harness (Phase 0.2 → expanded)
//
// This is still intentionally "headless": no DOM, no UI, no browser globals.
// Goal: exercise the orchestration layer ("stepSim") + migrations against a
// canned save blob, and assert basic invariants (no NaNs/infinities).
//
// Run: node scripts/replay_test.js

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function assert(cond, msg){
  if (!cond) throw new Error(msg || 'assertion failed');
}

function isFiniteNumber(n){
  return Number.isFinite(n) && !Number.isNaN(n);
}

function clamp01(n){
  const x = Number(n ?? 0) || 0;
  return Math.max(0, Math.min(1, x));
}

async function main(){
  const simUrl = pathToFileURL(path.resolve(__dirname, '../js/sim.js')).href;
  const stateUrl = pathToFileURL(path.resolve(__dirname, '../js/state.js')).href;

  const sim = await import(simUrl);
  const st = await import(stateUrl);

  // --- Basic season timeline invariants
  let lastIdx = null;
  let lastYear = null;
  for (let t = 0; t <= sim.YEAR_LEN * 3; t += 0.5) {
    const sea = sim.seasonAt(t);
    const yr = sim.yearAt(t);
    assert(sim.seasons.includes(sea.name), `bad season name at t=${t}: ${sea.name}`);
    assert(sea.idx >= 0 && sea.idx < sim.seasons.length, `bad season idx at t=${t}: ${sea.idx}`);
    assert(sea.phase >= 0 && sea.phase <= 1.000001, `bad season phase at t=${t}: ${sea.phase}`);
    assert(Number.isInteger(yr) && yr >= 0, `bad year at t=${t}: ${yr}`);

    if (lastYear != null) assert(yr >= lastYear, `year went backwards at t=${t}: ${yr} < ${lastYear}`);
    lastYear = yr;

    if (lastIdx == null) lastIdx = sea.idx;
    // idx can wrap, but should only change by 0 or +1 (mod N) each step.
    const diff = (sea.idx - lastIdx + sim.seasons.length) % sim.seasons.length;
    assert(diff === 0 || diff === 1, `season jumped at t=${t}: ${lastIdx} -> ${sea.idx}`);
    lastIdx = sea.idx;
  }

  // --- Load + migrate canned save (headless)
  const cannedPath = path.resolve(__dirname, './canned_save.json');
  const canned = JSON.parse(fs.readFileSync(cannedPath, 'utf8'));

  const s = st.migrateState(canned, {
    LOG_MAX: 120,
    clamp01,
    // Headless stubs (real game fills these in browser main.js)
    ensureKittenName: (k) => { k.name = k.name ?? `Kitten ${k.id}`; },
    genPersonality: () => ({}),
    genTraits: () => ([]),
  });
  assert(s, 'migrateState returned null');

  // --- Headless deps: keep it minimal (we are testing orchestration + invariants, not balance)
  const deps = {
    // Execution layer
    taskDefs: sim.coreTaskDefs(),
    edibleFood: sim.edibleFood,
    log: () => {},

    // Decision layer (lite headless)
    ensureBuddies: () => {},
    desiredWorkerPlan: () => ({ desired:{}, assigned:{} }),
    updateRoles: () => {},
    makeShadowAvail: () => ({}),
    decideTask: (ss, k) => sim.decideTaskLite(ss, k),
    updateMoodPerSecond: () => {},
    updateGrievancePerSecond: () => {},
    updateBuddyNeedPerSecond: () => {},
    updateValuesPerSecond: () => {},
    commitSecondsForTask: () => 0,
    reserveForTask: () => {},

    // Optional outer-layer hooks (now partially extracted)
    applyUnlocks: () => {},
    tickPressures: (ss, ddtt) => sim.tickPressuresCore(ss, ddtt),

    pinnedProjectInfo: () => null,
    clearPinnedProject: () => {},
  };

  // --- Simulate N seconds and assert invariants
  const dt = 0.25;
  const seconds = 60;
  const steps = Math.floor(seconds / dt);

  const startRes = { ...(s.res ?? {}) };
  const startPop = (s.kittens ?? []).length;
  const startVitals = (s.kittens ?? []).map(k => ({
    id: k.id,
    hunger: Number(k.hunger ?? 0),
    energy: Number(k.energy ?? 0),
    health: Number(k.health ?? 1),
  }));

  for (let i = 0; i < steps; i++) {
    sim.stepSim(s, dt, deps);

    assert(isFiniteNumber(s.t), `t NaN/Inf at i=${i}: ${s.t}`);
    const EPS = 1e-7;

    for (const [rk, rv] of Object.entries(s.res ?? {})) {
      assert(isFiniteNumber(rv), `res.${rk} NaN/Inf at i=${i}: ${rv}`);
      // Most resources should never go negative. Allow a tiny epsilon for float math.
      assert(rv >= -EPS, `res.${rk} negative at i=${i}: ${rv}`);
    }

    assert((s.kittens ?? []).length <= 500, `kittens array grew unbounded at i=${i}: len=${(s.kittens ?? []).length}`);

    for (const k of (s.kittens ?? [])) {
      assert(isFiniteNumber(k.hunger), `kitten.hunger NaN/Inf at i=${i}: ${k.hunger}`);
      assert(isFiniteNumber(k.energy), `kitten.energy NaN/Inf at i=${i}: ${k.energy}`);
      assert(isFiniteNumber(k.health), `kitten.health NaN/Inf at i=${i}: ${k.health}`);

      // Core vitals are clamped 0..1 in sim; allow epsilon so we catch runaway values.
      assert(k.hunger >= -EPS && k.hunger <= 1 + EPS, `kitten.hunger out of [0,1] at i=${i}: ${k.hunger}`);
      assert(k.energy >= -EPS && k.energy <= 1 + EPS, `kitten.energy out of [0,1] at i=${i}: ${k.energy}`);
      assert(k.health >= -EPS && k.health <= 1 + EPS, `kitten.health out of [0,1] at i=${i}: ${k.health}`);
    }
  }

  // --- Compact deterministic delta summary (helps debugging without a debugger)
  const endRes = { ...(s.res ?? {}) };
  const endPop = (s.kittens ?? []).length;
  const keyRes = ['food','jerky','wood','warmth','threat','science','tools','huts','palisade','granaries'];
  const deltas = keyRes
    .filter(k => k in startRes || k in endRes)
    .map(k => ({ k, d: (Number(endRes[k] ?? 0) || 0) - (Number(startRes[k] ?? 0) || 0) }));

  function fmtDelta(n){
    const x = Number(n ?? 0);
    const r = Math.round(x * 1000) / 1000;
    return (r >= 0 ? '+' : '') + String(r);
  }

  const vitNow = (s.kittens ?? []).map(k => ({
    hunger: Number(k.hunger ?? 0),
    energy: Number(k.energy ?? 0),
    health: Number(k.health ?? 1),
  }));

  function avg(arr, key){
    if (!arr.length) return 0;
    let sum = 0;
    for (const o of arr) sum += Number(o[key] ?? 0) || 0;
    return sum / arr.length;
  }

  console.log('replay_test: summary');
  console.log(`  sim: +${seconds}s @ dt=${dt}s (steps=${steps})`);
  console.log(`  pop: ${startPop} -> ${endPop}`);
  console.log('  resΔ:', deltas.map(x => `${x.k}:${fmtDelta(x.d)}`).join(' | '));

  function fmt3(n){
    return Math.round((Number(n ?? 0) || 0) * 1000) / 1000;
  }

  function minmax(arr, key){
    if (!arr.length) return { min: 0, max: 0 };
    let min = Infinity;
    let max = -Infinity;
    for (const o of arr) {
      const v = Number(o[key] ?? 0) || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  const avgStart = {
    hunger: avg(startVitals, 'hunger'),
    energy: avg(startVitals, 'energy'),
    health: avg(startVitals, 'health'),
  };
  const avgEnd = {
    hunger: avg(vitNow, 'hunger'),
    energy: avg(vitNow, 'energy'),
    health: avg(vitNow, 'health'),
  };
  const mm = {
    hunger: minmax(vitNow, 'hunger'),
    energy: minmax(vitNow, 'energy'),
    health: minmax(vitNow, 'health'),
  };

  console.log(`  vitals(avg): hunger ${fmt3(avgStart.hunger)} -> ${fmt3(avgEnd.hunger)} (${fmtDelta(avgEnd.hunger - avgStart.hunger)})`);
  console.log(`              energy ${fmt3(avgStart.energy)} -> ${fmt3(avgEnd.energy)} (${fmtDelta(avgEnd.energy - avgStart.energy)})`);
  console.log(`              health ${fmt3(avgStart.health)} -> ${fmt3(avgEnd.health)} (${fmtDelta(avgEnd.health - avgStart.health)})`);
  console.log(`  vitals(end min..max): hunger ${fmt3(mm.hunger.min)}..${fmt3(mm.hunger.max)} | energy ${fmt3(mm.energy.min)}..${fmt3(mm.energy.max)} | health ${fmt3(mm.health.min)}..${fmt3(mm.health.max)}`);

  // --- EMA/rate smoothing invariants (existing coverage)
  const toy = {
    t: 0,
    res: {
      food: 100,
      jerky: 30,
      wood: 50,
      warmth: 60,
      threat: 10,
      huts: 3,
      science: 0,
      tools: 0,
    },
    _hutProgress: 0,
    _palProgress: 0,
    _granProgress: 0,
    _workProgress: 0,
    _libProgress: 0,
  };

  // Drive the state with a deterministic pattern (sinusoid-ish without floats noise)
  // and ensure the smoothing never produces NaNs/infinities.
  for (let i = 0; i < 2000; i++) {
    toy.t += dt;

    // Deterministic deltas
    const step = i % 40;
    const dFood = (step < 20) ? +0.6 : -0.55;
    const dWood = (step < 10) ? +0.35 : -0.2;

    toy.res.food += dFood;
    toy.res.wood += dWood;
    toy.res.warmth += (step < 25) ? -0.05 : +0.04;
    toy.res.threat += (step < 30) ? +0.03 : -0.02;

    // Project progress with occasional wrap completion
    toy._hutProgress += (step < 30) ? 0.12 : 0;
    if (toy._hutProgress >= 12) toy._hutProgress -= 12;

    sim.updateRates(toy, dt);
    sim.updateProjectRates(toy, dt);

    for (const k of Object.keys(toy._rate)) {
      assert(isFiniteNumber(toy._rate[k]), `rate NaN/Inf for ${k} at i=${i}: ${toy._rate[k]}`);
      // sanity: rates should remain within plausible bounds for our toy updates
      assert(Math.abs(toy._rate[k]) < 1000, `rate runaway for ${k} at i=${i}: ${toy._rate[k]}`);
    }

    for (const k of Object.keys(toy._projRate)) {
      assert(isFiniteNumber(toy._projRate[k]), `projRate NaN/Inf for ${k} at i=${i}: ${toy._projRate[k]}`);
      assert(toy._projRate[k] >= 0, `projRate negative for ${k} at i=${i}: ${toy._projRate[k]}`);
      assert(toy._projRate[k] < 1000, `projRate runaway for ${k} at i=${i}: ${toy._projRate[k]}`);
    }
  }

  // --- Targets helper invariant
  const tt = sim.seasonTargets({ t: sim.SEASON_LEN * 2 + sim.SEASON_LEN * 0.6, targets: { foodPerKitten: 120, warmth: 60, maxThreat: 70 } });
  assert(tt.foodPerKitten >= 120, 'seasonTargets should not lower foodPerKitten baseline');

  console.log('replay_test: OK');
}

main().catch((err) => {
  console.error('replay_test: FAIL');
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
