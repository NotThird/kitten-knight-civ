// kitten-knight-civ/scripts/replay_test.js
// Minimal deterministic replay-style harness (Phase 0.2)
//
// This repo build is browser-first; a full sim replay requires more modular exposure.
// For now, we at least exercise the deterministic sim utilities (js/sim.js) under Node
// and assert invariants (no NaNs, stable season math, sane EMA/rate smoothing).
//
// Run: node scripts/replay_test.js

const path = require('path');
const { pathToFileURL } = require('url');

function assert(cond, msg){
  if (!cond) throw new Error(msg || 'assertion failed');
}

function isFiniteNumber(n){
  return Number.isFinite(n) && !Number.isNaN(n);
}

async function main(){
  const simUrl = pathToFileURL(path.resolve(__dirname, '../js/sim.js')).href;
  const sim = await import(simUrl);

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
    const diff = (sea.idx - lastIdx + sim.seasons.length) % sim.seasons.length;
    assert(diff === 0 || diff === 1, `season jumped at t=${t}: ${lastIdx} -> ${sea.idx}`);
    lastIdx = sea.idx;
  }

  // --- EMA/rate smoothing invariants
  const s = {
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

  const dt = 0.25;
  for (let i = 0; i < 2000; i++) {
    s.t += dt;

    const step = i % 40;
    const dFood = (step < 20) ? +0.6 : -0.55;
    const dWood = (step < 10) ? +0.35 : -0.2;

    s.res.food += dFood;
    s.res.wood += dWood;
    s.res.warmth += (step < 25) ? -0.05 : +0.04;
    s.res.threat += (step < 30) ? +0.03 : -0.02;

    s._hutProgress += (step < 30) ? 0.12 : 0;
    if (s._hutProgress >= 12) s._hutProgress -= 12;

    sim.updateRates(s, dt);
    sim.updateProjectRates(s, dt);

    for (const k of Object.keys(s._rate)) {
      assert(isFiniteNumber(s._rate[k]), `rate NaN/Inf for ${k} at i=${i}: ${s._rate[k]}`);
      assert(Math.abs(s._rate[k]) < 1000, `rate runaway for ${k} at i=${i}: ${s._rate[k]}`);
    }

    for (const k of Object.keys(s._projRate)) {
      assert(isFiniteNumber(s._projRate[k]), `projRate NaN/Inf for ${k} at i=${i}: ${s._projRate[k]}`);
      assert(s._projRate[k] >= 0, `projRate negative for ${k} at i=${i}: ${s._projRate[k]}`);
      assert(s._projRate[k] < 1000, `projRate runaway for ${k} at i=${i}: ${s._projRate[k]}`);
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
