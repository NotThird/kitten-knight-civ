(() => {
  const GAME_VERSION = '0.9.77';
  const SAVE_KEY = 'kittenKnightCiv';

  const fmt = (n) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(1)).replace(/\.0$/, '');
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const now = () => performance.now();

  // --- Work effectiveness (makes "Eat/Rest" meaningful and creates emergent slowdown spirals)
  // 1.00 = full speed, lower when hungry/tired/cold.
  // NOTE: this is intentionally simple + explainable; we expose it in UI as "Eff".
  function efficiency(s, k){
    const energy = clamp01(Number(k.energy ?? 0));
    const hunger = clamp01(Number(k.hunger ?? 0)); // 0 = full, 1 = starving

    // Energy: below 30% you crater.
    const energyMul = clamp01((energy - 0.30) / 0.70);

    // Hunger: above 85% you crater.
    const sat = 1 - hunger;
    const hungerMul = clamp01((sat - 0.15) / 0.85);

    // Cold: only really bites in winter + low warmth.
    const season = seasonAt(s.t);
    let coldMul = 1;
    if (season.name === 'Winter') {
      const w = clamp01(Number(s.res?.warmth ?? 0) / 40); // 0..1 at warmth 0..40
      coldMul = 0.65 + 0.35 * w; // 0.65..1.00
    }

    // Health: sickness/injury reduces throughput but doesn't hard-stop.
    const health = clamp01(Number(k.health ?? 1));
    const healthMul = 0.55 + 0.45 * health; // 0.55..1.00

    // Mood: tiny boost/penalty based on how "aligned" they feel (personality + stress).
    // Kept intentionally small so needs (food/warmth) still dominate.
    const mood = clamp01(Number(k.mood ?? 0.55));
    const moodMul = 0.88 + 0.24 * mood; // 0.88..1.12

    return Math.max(0.20, energyMul * hungerMul * coldMul * healthMul * moodMul);
  }

  // --- Momentum (emergent specialization via "getting in the groove")
  // If a kitten keeps doing the same productive task for several seconds, they get a small throughput bonus.
  // This pairs with commitment windows + role bias to create readable specialization without hard locks.
  function momentumMul(k, action){
    const a = String(action ?? '');
    if (!a || a === 'Eat' || a === 'Rest' || a === 'Loaf' || a === 'Socialize' || a === 'Care') return 1;
    const streak = Math.max(0, Number(k.taskStreak ?? 0) || 0);
    if (streak <= 1) return 1;
    // +2% per second after the first, capped at +20%.
    return 1 + Math.min(0.20, (streak - 1) * 0.02);
  }

  // --- Aptitude: kittens slowly become specialists (via skill levels) and prefer work they are good at.
  // This gives "policy management" long-term consequences: if you keep leaning on Forage, those kittens get better at it.
  const ACTION_SKILL = {
    Forage: 'Foraging',
    PreserveFood: 'Cooking',
    Farm: 'Farming',
    ChopWood: 'Woodcutting',
    Guard: 'Combat',
    Research: 'Scholarship',
    Mentor: 'Scholarship',
    CraftTools: 'Building',
    BuildHut: 'Building',
    BuildPalisade: 'Building',
    BuildGranary: 'Building',
    BuildWorkshop: 'Building',
    BuildLibrary: 'Building',
    StokeFire: 'Cooking',
    Socialize: null,
    Care: null,
    Eat: null,
    Rest: null,
  };

  function skillForAction(action){
    const a = String(action ?? '');
    return ACTION_SKILL[a] ?? null;
  }

  function topSkillInfo(k){
    const skills = k?.skills ?? {};
    let best = null;
    let bestLvl = -1;
    for (const [name, lvlRaw] of Object.entries(skills)) {
      const lvl = Number(lvlRaw ?? 1);
      if (!Number.isFinite(lvl)) continue;
      if (lvl > bestLvl) { bestLvl = lvl; best = name; }
    }
    return { skill: best, level: (bestLvl > 0 ? bestLvl : 1) };
  }

  // --- Season model (no map yet, but real pressure)
  const SEASON_LEN = 90; // seconds per season
  const seasons = ['Spring','Summer','Fall','Winter'];
  const YEAR_LEN = SEASON_LEN * seasons.length;
  const seasonAt = (t) => {
    const idx = Math.floor((t / SEASON_LEN) % seasons.length);
    const phase = (t % SEASON_LEN) / SEASON_LEN;
    return { name: seasons[idx], idx, phase };
  };
  const yearAt = (t) => Math.floor(Math.max(0, t) / YEAR_LEN);

  // --- Seasonal target shaping (small "AI foresight" without hidden rules)
  // We keep player-set targets as the baseline, then apply a transparent seasonal adjustment.
  // The point: late-Fall stockpiling so Winter doesn't instantly collapse the colony.
  function seasonTargets(s){
    const base = s.targets ?? { foodPerKitten:120, warmth:60, maxThreat:70 };
    const season = seasonAt(s.t);

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

  function secondsToNextSeason(s){
    const phase = (s.t % SEASON_LEN) / SEASON_LEN;
    return (1 - phase) * SEASON_LEN;
  }

  function secondsToNextWinter(s){
    const season = seasonAt(s.t);
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

  // --- Auto Project Focus (Director)
  // "Project focus" is a player nudge to bias build choices.
  // When set to Auto, we pick a focus each second based on obvious colony pain points.
  // This keeps the loop incremental (one priority at a time) while staying explainable.
  function getEffectiveProjectFocus(s){
    const set = String(s.director?.projectFocus ?? 'Auto');
    if (set !== 'Auto') return { focus: set, why: 'player-set', auto: false };

    // If you can't build yet, focus does nothing.
    if (!s.unlocked?.construction) return { focus: 'Auto', why: 'construction not unlocked', auto: true };

    const n = Math.max(1, s.kittens?.length ?? 1);
    const cap = housingCap(s);
    const season = seasonAt(s.t);
    const targets = seasonTargets(s);

    // Housing: being capped hard-stops growth.
    if ((s.kittens?.length ?? 0) >= cap) {
      return { focus: 'Housing', why: `housing cap hit (${s.kittens.length}/${cap})`, auto: true };
    }

    // Defense: if raids are imminent or alarm is up, walls matter more than comfort.
    if ((s.signals?.ALARM) || (s.res?.threat ?? 0) > targets.maxThreat * 0.92) {
      return { focus: 'Defense', why: `threat high (${fmt(s.res.threat)} > ${(targets.maxThreat*0.92).toFixed(0)})`, auto: true };
    }

    // Industry: if Workshop exists and tools are under target, prioritize tool maintenance.
    if (s.unlocked?.workshop) {
      const tools = Number(s.res?.tools ?? 0);
      const wantTools = n * 10;
      if (tools < wantTools * 0.75 && (s.res?.science ?? 0) > 25 && (s.res?.wood ?? 0) > 12) {
        return { focus: 'Industry', why: `tools low (${fmt(tools)}/${wantTools})`, auto: true };
      }

      // If we're in Advance mode and underbuilt on workshops, push one occasionally.
      const w = Number(s.res?.workshops ?? 0);
      const wantW = Math.max(1, Math.floor(n / 5));
      if (s.mode === 'Advance' && w < wantW && (s.res?.science ?? 0) > 80 && (s.res?.wood ?? 0) > 28) {
        return { focus: 'Industry', why: `workshops low (${w}/${wantW})`, auto: true };
      }
    }

    // Knowledge: once Libraries unlock, they are a compounding science engine.
    if (s.unlocked?.library) {
      const l = Number(s.res?.libraries ?? 0);
      const wantL = Math.max(1, Math.floor(n / 7));
      if (s.mode === 'Advance' && l < wantL && (s.res?.science ?? 0) > 220 && (s.res?.wood ?? 0) > 30 && (s.res?.tools ?? 0) > 10) {
        return { focus: 'Knowledge', why: `libraries low (${l}/${wantL})`, auto: true };
      }
    }

    // Storage: only matters once you have surplus worth protecting.
    if (s.unlocked?.granary) {
      const g = Number(s.res?.granaries ?? 0);
      const wantG = Math.max(1, Math.floor(n / 6) + 1);
      const surplus = (s.res?.food ?? 0) - targets.foodPerKitten * n * 1.35;
      if (g < wantG && surplus > 0 && (s.res?.wood ?? 0) > 18) {
        return { focus: 'Storage', why: `surplus food (${fmt(surplus)}) + low granaries (${g}/${wantG})`, auto: true };
      }
    }

    // Default: no strong build priority.
    // (Let scoring + policy handle the rest.)
    const winterSoon = secondsToNextWinter(s);
    if (season.name === 'Fall' && season.phase >= 0.55 && winterSoon > 0) {
      return { focus: 'Storage', why: 'late-Fall: prefer stability projects if surplus exists', auto: true };
    }

    return { focus: 'Auto', why: 'no urgent build pain point', auto: true };
  }

  // --- Unlock ladder (Progress Knight style)
  const unlockDefs = [
    { id:'construction', at: 80, name:'Construction', desc:'BuildHut + BuildPalisade actions become meaningful', apply:(s)=>{ s.unlocked.construction = true; } },
    { id:'workshop', at: 200, name:'Workshop', desc:'Unlock CraftTools + BuildWorkshop (industry buildings that improve tool throughput + global productivity)', apply:(s)=>{ s.unlocked.workshop = true; } },
    { id:'farming', at: 350, name:'Farming', desc:'Unlock Farm (steadier food, less tiring)', apply:(s)=>{ s.unlocked.farm = true; } },
    { id:'security', at: 650, name:'Security', desc:'Threat grows slower; ALARM signal unlocks; Guard stronger', apply:(s)=>{ s.unlocked.security = true; } },
    { id:'granary', at: 900, name:'Granaries', desc:'Unlock BuildGranary. Each granary reduces food spoilage (stacking).', apply:(s)=>{ s.unlocked.granary = true; } },
    { id:'library', at: 1400, name:'Libraries', desc:'Unlock BuildLibrary. Each library boosts research output (stacking).', apply:(s)=>{ s.unlocked.library = true; } },
  ];

  const defaultState = () => ({
    t: 0,
    paused: false,
    mode: 'Survive',
    rations: 'Normal', // Normal | Tight | Feast
    signals: { BUILD:false, FOOD:false, ALARM:false },
    targets: { foodPerKitten: 120, warmth: 60, maxThreat: 70 },
    // Reserves prevent "sink" tasks (building/crafting) from consuming critical buffers.
    // The AI treats these as soft constraints via scoring + plan shaping.
    reserve: { food: 0, wood: 18, science: 25, tools: 0 },
    res: { food: 120, jerky: 0, wood: 0, warmth: 55, threat: 10, huts: 0, palisade: 0, granaries: 0, workshops: 0, libraries: 0, science: 0, tools: 0 },
    unlocked: { construction:false, workshop:false, farm:false, security:false, granary:false, library:false },
    seenUnlocks: {},
    kittens: [ makeKitten(1), makeKitten(2), makeKitten(3) ],
    // Player policy: biases the colony-level plan (not hard locks; rules still override).
    policyMult: { Socialize:1, Care:1, Forage:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, PreserveFood:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Mentor:1, Research:1 },
    // Optional role quotas: "try to keep N kittens in this role" (0 = no quota).
    roleQuota: { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 },
    rules: defaultRules(),
    // Director helpers (not required for core sim; safe to ignore in old saves)
    director: { winterPrep:false, saved:null, crisis:false, crisisSaved:null, curfew:false, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoBuildPush:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', autoRecruit:false, autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00 },
    // Social layer (emergence): dissent reduces plan compliance; discipline restores it.
    social: { dissent: 0, band: 'calm', lastLogBand: '', lastLogAt: 0 },
    // Lightweight timed colony-wide effects (kept simple + transparent)
    effects: { festivalUntil: 0, councilUntil: 0 },
    meta: { version: GAME_VERSION, seenVersion: '', lastTs: Date.now() },
    log: []
  });

  // --- Personality / micro-emergence
  // Kittens have soft preferences (likes/dislikes). This does NOT hard-lock actions; it just nudges.
  function seededRng(seed){
    // xorshift32-ish, deterministic
    let x = (seed | 0) || 123456789;
    return () => {
      x ^= x << 13; x |= 0;
      x ^= x >>> 17; x |= 0;
      x ^= x << 5; x |= 0;
      return ((x >>> 0) / 4294967296);
    };
  }

  function pickDistinct(rng, arr, n){
    const a = arr.slice();
    for (let i=a.length-1;i>0;i--) {
      const j = Math.floor(rng() * (i+1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, Math.max(0, Math.min(n, a.length)));
  }

  function genPersonality(id){
    const rng = seededRng((id * 2654435761) | 0);
    // Keep this mostly to "productive" jobs (not Eat/Rest), but include some support jobs.
    const pool = ['Forage','PreserveFood','ChopWood','StokeFire','Guard','Research','Farm','BuildHut','BuildGranary','BuildWorkshop','BuildLibrary','CraftTools','Care'];
    const likes = pickDistinct(rng, pool, 2);
    const remaining = pool.filter(x => !likes.includes(x));
    const dislikes = pickDistinct(rng, remaining, 1);
    return { likes, dislikes };
  }

  // --- Traits (civ-sim identity layer)
  // One small "trait" per kitten. Unlike likes/dislikes (which depend on Autonomy), traits are a steady bias.
  // Goal: make colonies feel different across runs and make specialization feel more "character-driven".
  const TRAIT_DEFS = [
    { id:'Brave',     desc:'Leans into danger. Prefers Guard; ALARM stresses them less.', bias: { Guard: 12 } },
    { id:'Studious',  desc:'Bookish. Prefers Research (and Mentor once unlocked).', bias: { Research: 10, Mentor: 8 } },
    { id:'Builder',   desc:'Hands-on. Prefers construction + tool work.', bias: { BuildHut: 9, BuildPalisade: 8, BuildGranary: 8, BuildWorkshop: 8, BuildLibrary: 8, CraftTools: 8 } },
    { id:'Caretaker', desc:'Keeps spirits up. Prefers Socialize/Care.', bias: { Socialize: 10, Care: 10 } },
    { id:'Forager',   desc:'Wilderness savvy. Prefers Forage/Farm/ChopWood.', bias: { Forage: 9, Farm: 7, ChopWood: 7 } },
  ];

  function genTraits(id){
    const rng = seededRng((id * 1103515245 + 12345) | 0);
    const pick = TRAIT_DEFS[Math.floor(rng() * TRAIT_DEFS.length)]?.id ?? 'Forager';
    return [pick];
  }

  // --- Values (emergent "policy fit")
  // Each kitten has a simple 4-axis value vector. When central planning is strong (low effective autonomy),
  // mismatching the colony's current focus slowly drags their mood down.
  // Goal: make "policy management" feel like negotiating with a population, not puppeteering.
  const VALUE_AXES = ['Food','Safety','Progress','Social'];

  function genValues(id, traits){
    const rng = seededRng((id * 1664525 + 1013904223) | 0);
    // Start near-balanced with small deterministic noise.
    const v = {
      Food: 0.25 + (rng()-0.5)*0.08,
      Safety: 0.25 + (rng()-0.5)*0.08,
      Progress: 0.25 + (rng()-0.5)*0.08,
      Social: 0.25 + (rng()-0.5)*0.08,
    };

    const t = Array.isArray(traits) ? traits : [];
    if (t.includes('Forager'))   { v.Food += 0.18; v.Safety += 0.05; v.Progress -= 0.10; v.Social -= 0.05; }
    if (t.includes('Brave'))     { v.Safety += 0.22; v.Progress -= 0.05; }
    if (t.includes('Studious'))  { v.Progress += 0.26; v.Social -= 0.05; }
    if (t.includes('Builder'))   { v.Progress += 0.20; v.Food += 0.06; v.Social -= 0.04; }
    if (t.includes('Caretaker')) { v.Social += 0.28; v.Safety += 0.04; v.Progress -= 0.06; }

    // Normalize + clamp.
    for (const k of VALUE_AXES) v[k] = Math.max(0.03, Number(v[k] ?? 0));
    const sum = VALUE_AXES.reduce((a,k)=>a+v[k],0) || 1;
    for (const k of VALUE_AXES) v[k] /= sum;
    return v;
  }

  function ensureValues(k){
    if (!k || typeof k !== 'object') return;
    if (k.values && typeof k.values === 'object') return;
    k.values = genValues(Number(k.id ?? 0), k.traits);
  }

  function colonyFocusVec(s){
    // Player-facing knobs: Director priorities + Mode.
    const base = {
      Food: prioMul(s,'prioFood'),
      Safety: prioMul(s,'prioSafety'),
      Progress: prioMul(s,'prioProgress'),
      Social: 1.00,
    };

    const m = String(s.mode ?? 'Survive');
    if (m === 'Survive') { base.Food += 0.25; base.Safety += 0.25; base.Progress -= 0.10; }
    if (m === 'Expand')  { base.Progress += 0.22; base.Food += 0.10; base.Safety -= 0.06; }
    if (m === 'Defend')  { base.Safety += 0.35; base.Food += 0.05; base.Progress -= 0.14; }
    if (m === 'Advance') { base.Progress += 0.35; base.Social += 0.05; base.Food -= 0.10; base.Safety -= 0.10; }

    // Clamp + normalize.
    for (const k of VALUE_AXES) base[k] = Math.max(0.05, Number(base[k] ?? 0));
    const sum = VALUE_AXES.reduce((a,k)=>a+base[k],0) || 1;
    for (const k of VALUE_AXES) base[k] /= sum;
    return base;
  }

  function valuesAlignment01(s, k){
    ensureValues(k);
    const kv = k?.values;
    if (!kv) return 0.75;
    const cv = colonyFocusVec(s);
    let dot = 0;
    for (const ax of VALUE_AXES) dot += Number(kv[ax] ?? 0) * Number(cv[ax] ?? 0);
    return clamp01(dot * 1.25); // rescale so "neutral" feels like ~0.7–0.8
  }

  function valuesShort(k){
    ensureValues(k);
    const v = k?.values;
    if (!v) return '-';
    const pct = (x)=>Math.round(100*x);
    return `F${pct(v.Food)} S${pct(v.Safety)} P${pct(v.Progress)} So${pct(v.Social)}`;
  }

  function traitInfoList(k){
    const arr = Array.isArray(k?.traits) ? k.traits : [];
    const out = [];
    for (const id of arr) {
      const def = TRAIT_DEFS.find(t => t.id === id);
      out.push(def ? `${def.id}: ${def.desc}` : String(id));
    }
    return out;
  }

  function makeKitten(id){
    const traits = genTraits(id);
    return {
      id,
      role: 'Generalist',
      roleWhy: 'boot',
      task: 'Forage',
      why: 'boot',
      energy: 0.9,
      hunger: 0.2,
      // Health: 1.0 = healthy, lower = sick/injured (reduces efficiency). Recovers via Rest/Eat + good warmth.
      health: 1.0,
      // Mood: 0..1. Softly affects efficiency + preferences (adds "civ sim" texture without hard locks).
      mood: 0.55,
      skills: { Foraging:1, Farming:1, Woodcutting:1, Building:1, Scholarship:1, Combat:1, Cooking:1 },
      xp: { Foraging:0, Farming:0, Woodcutting:0, Building:0, Scholarship:0, Combat:0, Cooking:0 },
      // Personality: soft preferences that bias scoring (adds emergent specialization)
      personality: genPersonality(id),
      // Traits: steady "identity" bias (civ-sim flavor)
      traits,
      // Values: what this kitten *wants* the colony to be doing (policy fit affects mood under central planning)
      values: genValues(id, traits),

      // Social bond: each kitten has a "buddy" they vibe with.
      // When both buddies Socialize at the same time, dissent drops faster and both feel better.
      // This is tiny on purpose: it's a civ-sim texture layer, not a hard mechanic.
      buddyId: null,
      // Buddy need (0..1): rises when separated, falls when spending time together. High need nudges Socialize and can add mild stress.
      buddyNeed: 0,
      // Timestamp of last meaningful buddy interaction (explainability hook; save-safe default 0).
      lastBuddyAt: 0,

      // Memory: how long they've been stuck doing the same thing (adds natural rotation)
      taskStreak: 0,
      // Commitment: reduces 1s task-flapping; will only break for safety rules/emergencies.
      taskLock: 0,

      // Execution debugging: if a sink task was blocked by reserves/missing inputs, we surface it in "Why".
      _blockedAction: null,
      _blockedMsg: '',
      _fallbackTo: null,
      _mentor: null,

      // Transient: last time a sink action was blocked (by reserves/inputs) and we executed a fallback.
      // Used for explainability in the Decision Inspector.
      _lastBlocked: null,

      // Anti-thrash: short per-action cooldown if we just discovered an action is blocked.
      // Prevents kittens from repeatedly "trying" the same no-op sink every 1s.
      blockedCooldown: {},
    };
  }

  // --- Social bonds (buddy system)
  // Deterministic + save-safe: if a save doesn't have buddyIds yet, we assign them on the fly.
  // Buddy assignment is stable given the current population (id-sorted ring).
  function ensureBuddies(s){
    const ids = (s.kittens ?? []).map(k => Number(k?.id ?? 0)).filter(n => Number.isFinite(n) && n > 0).sort((a,b)=>a-b);
    const set = new Set(ids);
    if (ids.length < 2) {
      for (const k of (s.kittens ?? [])) k.buddyId = null;
      return;
    }

    for (const k of (s.kittens ?? [])) {
      const id = Number(k?.id ?? 0);
      if (!Number.isFinite(id) || id <= 0) { k.buddyId = null; continue; }

      const cur = Number(k.buddyId ?? 0);
      if (cur && cur !== id && set.has(cur)) continue;

      const idx = ids.indexOf(id);
      const buddy = ids[(idx + 1) % ids.length];
      k.buddyId = (buddy && buddy !== id) ? buddy : null;
    }
  }

  function buddyOf(s, k){
    const bid = Number(k?.buddyId ?? 0);
    if (!bid) return null;
    return (s.kittens ?? []).find(x => Number(x?.id ?? 0) === bid) ?? null;
  }

  // Buddy need (relationship pressure)
  // Increases slowly when separated; decreases when spending time together.
  // Purpose: small emergent social texture + a policy lever (Socialize/Care + Autonomy).
  function updateBuddyNeedPerSecond(s, k, task){
    const b = buddyOf(s, k);
    if (!b) { k.buddyNeed = clamp01(Number(k.buddyNeed ?? 0)); return; }

    const t = String(task ?? k.task ?? '');
    const bt = String(b.task ?? '');

    // "Together" heuristics (no map/positions yet):
    // - Explicitly together if both Socialize.
    // - Also count as together if doing the same non-rest task (working side-by-side).
    const together = (t === 'Socialize' && bt === 'Socialize') || (t && t === bt && t !== 'Rest');

    const a = effectiveAutonomy01(s);
    let need = clamp01(Number(k.buddyNeed ?? 0));

    if (together) {
      // Faster relief at higher autonomy (they can actually choose to pair up).
      need = clamp01(need - (0.10 + 0.06 * a));
      k.lastBuddyAt = Number(s.t ?? 0);
    } else {
      // Under strong planning (low autonomy), "missing your buddy" stress rises a bit faster.
      const planPressure = (1 - a);
      need = clamp01(need + (0.006 + 0.006 * planPressure));
    }

    k.buddyNeed = need;
  }

  function defaultRules(){

    return [
      rule('If hungry > 0.75 → Eat', {type:'hungry_gt', v:0.75}, {type:'Eat'}),
      rule('If tired > 0.88 → Rest', {type:'tired_gt', v:0.88}, {type:'Rest'}),
      rule('If health < 0.45 → Rest', {type:'health_lt', v:0.45}, {type:'Rest'}),
      rule('If warmth < 35 → StokeFire', {type:'warmth_lt', v:35}, {type:'StokeFire'}),
      rule('If threat > 85 or ALARM → Guard', {type:'threat_gt_or_alarm', v:85}, {type:'Guard'}),
      rule('If FOOD CRISIS → Forage', {type:'signal', v:'FOOD'}, {type:'Forage'}),
    ];
  }

  function rule(name, cond, act){
    return { id: crypto.randomUUID?.() ?? String(Math.random()), enabled:true, name, cond, act };
  }

  let state = load() ?? defaultState();

  function workshopBonus(s){
    // Workshops amplify crafting/industry. Diminishing returns so it doesn't explode.
    const w = Math.max(0, s.res.workshops ?? 0);
    return 1 + 0.10 * Math.sqrt(w);
  }

  function toolsBonus(s){
    // Tools are global productivity. Workshops further amplify "industry" (incl. tool use).
    // 0 tools => 1.00x. 100 tools => ~1.15x (before workshops).
    const t = Math.max(0, s.res.tools ?? 0);
    const tools = 1 + 0.015 * Math.sqrt(t);
    return tools * workshopBonus(s);
  }

  function libraryBonus(s){
    // Libraries amplify research output. Stacks with diminishing returns.
    const l = Math.max(0, s.res.libraries ?? 0);
    return 1 + 0.14 * Math.sqrt(l);
  }

  function getReserve(s, key){
    const r = s.reserve ?? {};
    const v = Number(r[key] ?? 0);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  }

  // Edible food includes preserved rations (jerky).
  // Important: many stability heuristics should consider TOTAL edible stores,
  // otherwise the colony can "think" it's starving while sitting on jerky.
  function edibleFood(s){
    const f = Number(s?.res?.food ?? 0);
    const j = Number(s?.res?.jerky ?? 0);
    const total = (Number.isFinite(f) ? f : 0) + (Number.isFinite(j) ? j : 0);
    return Math.max(0, total);
  }

  function ediblePerKitten(s){
    const n = Math.max(1, Number(s?.kittens?.length ?? 1) || 1);
    return edibleFood(s) / n;
  }

  // Recommended reserves (season/pop aware). Used for Auto Reserves + UI hint.
  // Intentionally simple + rounded so the player can reason about it.
  function recommendedReserves(s){
    const season = seasonAt(s.t);
    const n = Math.max(1, s.kittens.length);
    const winter = season.name === 'Winter';
    const lateFall = (season.name === 'Fall' && season.phase >= 0.55);

    // Food reserve: scaled by pop; higher in winter/late-fall so the colony banks stability.
    let recFood = n * (winter ? 85 : lateFall ? 72 : 55);
    // If you're explicitly in Advance mode, allow a slightly leaner buffer.
    if (s.mode === 'Advance') recFood *= 0.88;

    // Wood reserve: enough to keep warmth + a little building online.
    let recWood = (winter ? 32 : 20);
    if (s.unlocked.construction && s.signals.BUILD) recWood = Math.max(recWood, 26);
    if (lateFall) recWood = Math.max(recWood, 28);

    // Science reserve: prevents Tools/Workshops from consuming ALL science.
    // Keep it low early so you still reach unlock thresholds.
    let recSci = 25;
    if (s.unlocked.workshop) recSci = 32;

    // Tools reserve: prevents Library building from consuming all tools (and crashing productivity).
    let recTools = 0;
    if (s.unlocked.workshop) recTools = Math.round((n * 6) / 5) * 5; // ~6 per kitten, rounded to 5s
    if (winter || lateFall) recTools = Math.round((recTools * 1.10) / 5) * 5;

    // Round to readable steps.
    recFood = Math.round(recFood / 10) * 10;
    recWood = Math.round(recWood / 2) * 2;
    recSci = Math.round(recSci / 5) * 5;

    return { food: recFood, wood: recWood, science: recSci, tools: recTools, season };
  }

  // Spend helpers (prevents "sink" tasks from dipping below player-defined reserves).
  // This is a *hard* constraint at the execution layer (not just scoring), so the AI
  // can't accidentally overspend when multiple kittens pick the same sink in the same second.
  function availableAboveReserve(s, key){
    const cur = Number(s.res?.[key] ?? 0);
    const resv = getReserve(s, key);
    return Math.max(0, cur - resv);
  }

  function spendUpToReserve(s, key, want){
    const can = availableAboveReserve(s, key);
    const use = Math.max(0, Math.min(can, Math.max(0, Number(want) || 0)));
    s.res[key] = Math.max(0, Number(s.res[key] ?? 0) - use);
    return use;
  }

  // --- Execution fallback (prevents "staring at a blocked build" when reserves lock inputs)
  // If a sink task can't spend its required inputs (because resources are missing OR protected by reserves),
  // the kitten immediately does a sensible alternate task for this dt.
  // This keeps the sim from wasting time/energy on no-op work and makes AI behavior more legible.
  function doFallback(s, k, dt, altTask, msg){
    const blocked = k.task;
    k._blockedAction = blocked;
    k._blockedMsg = msg;

    // Persist a short-lived blocked snapshot for inspector/debug (k._blockedMsg is cleared after decision).
    k._lastBlocked = { at: Number(s?.t ?? 0), action: String(blocked), to: String(altTask), msg: String(msg ?? '') };

    // Explainability: accumulate a per-second "blocked sinks" summary so Plan debug can tell you
    // why desired != assigned (or why builders/researchers seem to "refuse" a sink).
    // NOTE: this is not saved; it's purely last-tick explainability.
    s._blockedThisSecond = s._blockedThisSecond ?? Object.create(null);
    s._blockedMsgThisSecond = s._blockedMsgThisSecond ?? Object.create(null);
    s._blockedThisSecond[blocked] = (s._blockedThisSecond[blocked] ?? 0) + 1;
    if (!s._blockedMsgThisSecond[blocked]) s._blockedMsgThisSecond[blocked] = msg;

    // Explainability: show what we actually did this tick (since the "task" column will still
    // display the intended action selected at 1s decision time).
    k._fallbackTo = altTask;

    // Mark a short cooldown so scoring avoids retrying the same blocked action repeatedly.
    k.blockedCooldown = k.blockedCooldown ?? {};
    k.blockedCooldown[blocked] = Math.max(Number(k.blockedCooldown[blocked] ?? 0) || 0, 3);

    const alt = taskDefs[altTask] ?? taskDefs.Rest;
    // small inefficiency for context-switching
    alt.tick(s, k, dt * 0.85);
  }

  // --- Explainability: smoothed resource deltas + simple ETAs
  function ensureRateState(s){
    if (!s._rate) s._rate = Object.create(null);
    if (!s._prevRes) s._prevRes = structuredClone(s.res);
  }

  function ema(oldV, newV, alpha){
    if (!Number.isFinite(oldV)) return newV;
    return oldV + (newV - oldV) * alpha;
  }

  function updateRates(s, dt){
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

  function fmtRate(v){
    if (!Number.isFinite(v)) return '0/s';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${fmt(v)}/s`;
  }

  function fmtEtaSeconds(sec){
    if (!Number.isFinite(sec) || sec <= 0) return '-';
    if (sec > 3600) return `${Math.ceil(sec/60)}m`;
    if (sec > 120) return `${Math.ceil(sec/60)}m`;
    return `${Math.ceil(sec)}s`;
  }

  function etaToTarget(cur, target, rate){
    if (!Number.isFinite(rate) || rate <= 0) return Infinity;
    return (target - cur) / rate;
  }

  // --- Rations (player-facing economic lever)
  // Tight rations save food but kittens recover hunger/energy slower per Eat action.
  // Feast rations burn food faster but help performance (less time eating/resting).
  const rationDefs = {
    Tight:  { foodUse: 0.75, hungerRelief: 0.78, energyGain: 0.90, label:'Tight' },
    Normal: { foodUse: 1.00, hungerRelief: 1.00, energyGain: 1.00, label:'Normal' },
    Feast:  { foodUse: 1.25, hungerRelief: 1.18, energyGain: 1.08, label:'Feast' },
  };
  function getRations(s){
    const key = String(s.rations ?? 'Normal');
    return rationDefs[key] ?? rationDefs.Normal;
  }

  // --- Work pace (player-facing policy lever)
  // 1.00 = baseline. Higher pace increases output/build speed, but costs (fatigue/hunger) are higher and mood drifts down a bit.
  function workPaceMul(s){
    const raw = Number(s?.director?.workPace ?? 1.00);
    if (!Number.isFinite(raw)) return 1.00;
    return Math.max(0.8, Math.min(1.2, raw));
  }

  // --- Director priorities (high-level weights that bias *individual* action scoring)
  // Values are multipliers in [0.50..1.50]. 1.00 = neutral.
  function prioMul(s, key){
    const v = Number(s?.director?.[key] ?? 1.00);
    if (!Number.isFinite(v)) return 1.00;
    return Math.max(0.50, Math.min(1.50, v));
  }

  // --- Task defs
  const taskDefs = {
    Eat: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const rat = getRations(s);
        // Prefer fresh food, but fall back to preserved rations (jerky) if needed.
        const haveFood = Number(s.res.food ?? 0);
        const haveJerky = Number(s.res.jerky ?? 0);
        if (haveFood <= 0 && haveJerky <= 0) return;

        const need = 0.95 * dt * rat.foodUse;
        const useFood = Math.min(haveFood, need);
        s.res.food = Math.max(0, haveFood - useFood);
        const rem = Math.max(0, need - useFood);
        const useJerky = Math.min(haveJerky, rem);
        s.res.jerky = Math.max(0, haveJerky - useJerky);
        const use = useFood + useJerky;
        k.hunger = clamp01(k.hunger - dt * 0.55 * rat.hungerRelief);
        k.energy = clamp01(k.energy + dt * 0.03 * rat.energyGain);
        // Food helps recovery.
        k.health = clamp01((k.health ?? 1) + dt * 0.015);
        gainXP(k,'Cooking', dt * 0.35);
      }
    },
    Rest: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        k.energy = clamp01(k.energy + dt * 0.16);
        k.hunger = clamp01(k.hunger + dt * 0.03);
        // Rest recovers health; warmth speeds recovery.
        const w = clamp01(Number(s.res?.warmth ?? 0) / 100);
        k.health = clamp01((k.health ?? 1) + dt * (0.018 + 0.020 * w));
      }
    },
    Loaf: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        // "Soft strike" / morale recovery.
        // Loafing is less efficient than Rest at recovering energy/health, but better at recovering mood.
        // It creates an emergent social slowdown when Dissent is high.
        k.energy = clamp01(k.energy + dt * 0.09);
        k.hunger = clamp01(k.hunger + dt * 0.02);

        const w = clamp01(Number(s.res?.warmth ?? 0) / 100);
        k.health = clamp01((k.health ?? 1) + dt * (0.010 + 0.010 * w));

        // Mood: meaningful bump (especially if the colony is celebrating).
        const fest = festivalActive(s) ? 1 : 0;
        k.mood = clamp01(Number(k.mood ?? 0.55) + dt * (0.020 + 0.006 * fest));
      }
    },
    Socialize: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        // Socialize: a "civ sim" pressure valve.
        // Reduces dissent (improves compliance) and gently boosts mood, at the cost of no direct resources.
        // This gives the player a labor lever that trades throughput for stability.
        s.social = s.social ?? { dissent: 0, band: 'calm' };
        if (!('dissent' in s.social)) s.social.dissent = 0;

        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Socialize');

        // Self-care: chatting/organizing is less physically taxing than work.
        k.energy = clamp01(k.energy + dt * 0.06);
        k.hunger = clamp01(k.hunger + dt * 0.015);

        // Mood: meaningful but bounded.
        const fest = festivalActive(s) ? 1 : 0;
        k.mood = clamp01(Number(k.mood ?? 0.55) + dt * (0.018 + 0.006 * fest));

        // Colony cohesion: bring dissent down.
        // Discipline makes this more effective (you have "institutions" to channel the organizing).
        const d = discipline01(s);
        let reduce = dt * (0.010 + 0.010 * d) * eff * mom;

        // Buddy synergy: if your buddy is ALSO socializing, it works better.
        const b = buddyOf(s, k);
        if (b && String(b.task ?? '') === 'Socialize') {
          reduce *= 1.22;
          k.mood = clamp01(Number(k.mood ?? 0.55) + dt * 0.004);
        }

        s.social.dissent = clamp01(Number(s.social.dissent ?? 0) - reduce);

        // Small spillover: boost one other kitten's mood a tiny amount.
        const others = (s.kittens ?? []).filter(x => x && x.id !== k.id);
        if (others.length) {
          const target = others[(Math.random() * others.length) | 0];
          target.mood = clamp01(Number(target.mood ?? 0.55) + dt * 0.004);
        }
      }
    },
    Care: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        // Care: spend small resources to directly stabilize the colony.
        // Think: soup kitchen + repairs + quiet comforts.
        // Trade: consumes food+wood (above reserves) to reduce dissent and raise mood.
        s.social = s.social ?? { dissent: 0, band: 'calm' };
        if (!('dissent' in s.social)) s.social.dissent = 0;

        const foodAvail = availableAboveReserve(s,'food');
        const woodAvail = availableAboveReserve(s,'wood');
        if (foodAvail <= 0.01 || woodAvail <= 0.01) {
          // If we can't afford care, fall back to a free cohesion action.
          doFallback(s, k, dt, 'Socialize', `Care blocked by reserve (avail food ${foodAvail.toFixed(1)}, wood ${woodAvail.toFixed(1)}) → Socialize`);
          return;
        }

        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Care');
        const wp = workPaceMul(s);

        // Costs per second at eff=1.
        const wantFood = 0.38 * dt * eff * mom * wp;
        const wantWood = 0.12 * dt * eff * mom * wp;

        const useFood = Math.min(foodAvail, wantFood);
        const useWood = Math.min(woodAvail, wantWood);
        const norm = Math.min(useFood / wantFood, useWood / wantWood);
        if (!Number.isFinite(norm) || norm <= 0.0001) {
          doFallback(s, k, dt, 'Socialize', 'Care blocked → Socialize');
          return;
        }

        // Spend actual resources (respect reserves).
        spendUpToReserve(s,'food', wantFood * norm);
        spendUpToReserve(s,'wood', wantWood * norm);

        // Self-care: less tiring than labor.
        k.energy = clamp01(k.energy + dt * 0.05);
        k.hunger = clamp01(k.hunger + dt * 0.010);

        // Mood bump: meaningful.
        const fest = festivalActive(s) ? 1 : 0;
        k.mood = clamp01(Number(k.mood ?? 0.55) + dt * (0.024 + 0.008 * fest));

        // Dissent reduction: stronger than Socialize, because it's "real help", but it costs resources.
        const d = discipline01(s);
        const reduce = dt * (0.016 + 0.010 * d) * eff * mom;
        s.social.dissent = clamp01(Number(s.social.dissent ?? 0) - reduce);

        // Tiny spillover: improve another kitten's health slightly (care/repairs).
        const others = (s.kittens ?? []).filter(x => x && x.id !== k.id);
        if (others.length) {
          const target = others[(Math.random() * others.length) | 0];
          target.health = clamp01(Number(target.health ?? 1) + dt * 0.002);
        }
      }
    },
    Forage: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const season = seasonAt(s.t);
        const winterPenalty = season.name === 'Winter' ? 0.55 : 1;
        const mult = 1 + 0.07*(k.skills.Foraging-1);
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Forage');
        const wp = workPaceMul(s);
        const out = 1.85 * mult * winterPenalty * toolsBonus(s) * dt * eff * mom * wp;
        s.res.food += out;
        k.energy = clamp01(k.energy - dt * 0.04 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp);
        gainXP(k,'Foraging', dt * 1.0 * efficiency(s,k));
      }
    },
    PreserveFood: {
      enabled: (s) => !!s.unlocked.construction,
      tick: (s,k,dt) => {
        // Convert food+wood into preserved rations (jerky).
        // Jerky doesn't spoil, making Winter prep + surplus storage more meaningful.
        // It is intentionally less efficient than just eating food, but stabilizes long horizons.
        const foodAvail = availableAboveReserve(s,'food');
        const woodAvail = availableAboveReserve(s,'wood');
        if (foodAvail <= 0.01 || woodAvail <= 0.01) {
          const alt = (foodAvail <= woodAvail) ? 'Forage' : 'ChopWood';
          doFallback(s, k, dt, alt, `PreserveFood blocked by reserve (avail food ${foodAvail.toFixed(1)}, wood ${woodAvail.toFixed(1)}) → ${alt}`);
          return;
        }

        const eff = efficiency(s, k);
        const mult = 1 + 0.06*(k.skills.Cooking-1);
        const mom = momentumMul(k, 'PreserveFood');
        const wp = workPaceMul(s);

        // Costs per second at eff=1 (tuned to be a midgame sink, not a free win).
        const wantFood = 0.95 * mult * dt * eff * mom * wp;
        const wantWood = 0.22 * mult * dt * eff * mom * wp;
        const useFood = Math.min(foodAvail, wantFood);
        const useWood = Math.min(woodAvail, wantWood);
        const norm = Math.min(useFood / wantFood, useWood / wantWood);
        if (!Number.isFinite(norm) || norm <= 0.0001) {
          doFallback(s, k, dt, 'Forage', 'PreserveFood blocked → Forage');
          return;
        }

        // Spend actual resources (respect reserves).
        const spentFood = spendUpToReserve(s,'food', wantFood * norm);
        const spentWood = spendUpToReserve(s,'wood', wantWood * norm);
        const made = Math.min(spentFood / 0.95, spentWood / 0.22) * 0.72; // yield < 1 to keep it from dominating

        s.res.jerky = (s.res.jerky ?? 0) + made;
        k.energy = clamp01(k.energy - dt * 0.03 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.02 * wp);
        gainXP(k,'Cooking', dt * 0.95 * efficiency(s,k));
      }
    },
    Farm: {
      enabled: (s) => s.unlocked.farm,
      tick: (s,k,dt) => {
        const season = seasonAt(s.t);
        const winterPenalty = season.name === 'Winter' ? 0.85 : 1;
        const mult = 1 + 0.08*(k.skills.Farming-1);
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Farm');
        const wp = workPaceMul(s);
        const out = 2.35 * mult * winterPenalty * toolsBonus(s) * dt * eff * mom * wp;
        s.res.food += out;
        k.energy = clamp01(k.energy - dt * 0.035 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.025 * wp);
        gainXP(k,'Farming', dt * 1.0 * efficiency(s,k));
      }
    },
    ChopWood: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const mult = 1 + 0.07*(k.skills.Woodcutting-1);
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'ChopWood');
        const wp = workPaceMul(s);
        const out = 1.05 * mult * toolsBonus(s) * dt * eff * mom * wp;
        s.res.wood += out;
        k.energy = clamp01(k.energy - dt * 0.05 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.035 * wp);
        gainXP(k,'Woodcutting', dt * 1.0 * efficiency(s,k));
      }
    },
    StokeFire: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
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
        gainXP(k,'Cooking', dt * 0.70 * efficiency(s,k));
      }
    },
    Guard: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const mult = 1 + 0.10*(k.skills.Combat-1);
        let base = s.unlocked.security ? 2.6 : 2.1;
        const drill = drillActive(s) ? 1 : 0;
        if (drill) base += 0.55; // training + patrols

        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Guard');
        const wp = workPaceMul(s);
        s.res.threat = Math.max(0, s.res.threat - base * mult * dt * eff * mom * wp);
        k.energy = clamp01(k.energy - dt * 0.03 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp);
        gainXP(k,'Combat', dt * (1.0 + 0.35*drill) * efficiency(s,k));
      }
    },
    BuildHut: {
      enabled: (s) => s.unlocked.construction,
      tick: (s,k,dt) => {
        const woodAvail = availableAboveReserve(s,'wood');
        if (s.res.wood <= 0 || woodAvail <= 0.01) {
          doFallback(s, k, dt, 'ChopWood', woodAvail <= 0.01 ? 'BuildHut blocked by wood reserve → ChopWood' : 'BuildHut blocked (no wood) → ChopWood');
          return;
        }
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'BuildHut');
        const wp = workPaceMul(s);
        const speed = (1 + 0.06*(k.skills.Building-1)) * toolsBonus(s) * eff * mom * wp;
        const use = spendUpToReserve(s,'wood', 1.0 * speed * dt);
        if (use <= 0.0001) {
          doFallback(s, k, dt, 'ChopWood', 'BuildHut blocked by wood reserve → ChopWood');
          return;
        }
        s._hutProgress = (s._hutProgress ?? 0) + use;
        if (s._hutProgress >= 12) {
          s._hutProgress -= 12;
          s.res.huts += 1;
          log(`Built a hut. Huts: ${s.res.huts}`);
        }
        k.energy = clamp01(k.energy - dt * 0.06 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp);
        gainXP(k,'Building', dt * 1.0 * efficiency(s,k));
      }
    },
    BuildPalisade: {
      enabled: (s) => s.unlocked.construction,
      tick: (s,k,dt) => {
        const woodAvail = availableAboveReserve(s,'wood');
        if (s.res.wood <= 0 || woodAvail <= 0.01) {
          doFallback(s, k, dt, 'ChopWood', woodAvail <= 0.01 ? 'BuildPalisade blocked by wood reserve → ChopWood' : 'BuildPalisade blocked (no wood) → ChopWood');
          return;
        }
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'BuildPalisade');
        const wp = workPaceMul(s);
        const speed = (1 + 0.06*(k.skills.Building-1)) * toolsBonus(s) * eff * mom * wp;
        const use = spendUpToReserve(s,'wood', 1.1 * speed * dt);
        if (use <= 0.0001) {
          doFallback(s, k, dt, 'ChopWood', 'BuildPalisade blocked by wood reserve → ChopWood');
          return;
        }
        s._palProgress = (s._palProgress ?? 0) + use;
        if (s._palProgress >= 16) {
          s._palProgress -= 16;
          s.res.palisade += 1;
          log(`Built palisade segment. Palisade: ${s.res.palisade}`);
        }
        k.energy = clamp01(k.energy - dt * 0.06 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp);
        gainXP(k,'Building', dt * 1.0 * efficiency(s,k));
      }
    },
    BuildGranary: {
      enabled: (s) => s.unlocked.construction && s.unlocked.granary,
      tick: (s,k,dt) => {
        const woodAvail = availableAboveReserve(s,'wood');
        if (s.res.wood <= 0 || woodAvail <= 0.01) {
          doFallback(s, k, dt, 'ChopWood', woodAvail <= 0.01 ? 'BuildGranary blocked by wood reserve → ChopWood' : 'BuildGranary blocked (no wood) → ChopWood');
          return;
        }
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'BuildGranary');
        const wp = workPaceMul(s);
        const speed = (1 + 0.06*(k.skills.Building-1)) * toolsBonus(s) * eff * mom * wp;
        const use = spendUpToReserve(s,'wood', 0.95 * speed * dt);
        if (use <= 0.0001) {
          doFallback(s, k, dt, 'ChopWood', 'BuildGranary blocked by wood reserve → ChopWood');
          return;
        }
        s._granProgress = (s._granProgress ?? 0) + use;
        if (s._granProgress >= 22) {
          s._granProgress -= 22;
          s.res.granaries = (s.res.granaries ?? 0) + 1;
          log(`Built a granary. Granaries: ${s.res.granaries}`);
        }
        k.energy = clamp01(k.energy - dt * 0.055 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.035 * wp);
        gainXP(k,'Building', dt * 1.0 * efficiency(s,k));
      }
    },
    BuildWorkshop: {
      enabled: (s) => s.unlocked.construction && s.unlocked.workshop,
      tick: (s,k,dt) => {
        // Convert wood + science into a persistent Workshop building.
        // Workshops boost industry (see Prod x) and also improve tool crafting throughput.
        const woodAvail = availableAboveReserve(s,'wood');
        const sciAvail  = availableAboveReserve(s,'science');
        if (s.res.wood <= 0 || s.res.science <= 0 || woodAvail <= 0.01 || sciAvail <= 0.01) {
          // If we're blocked, do something that unblocks us (prefer science if science is the limiting input).
          const alt = (s.res.science <= 0 || sciAvail <= woodAvail) ? 'Research' : 'ChopWood';
          const reason = (woodAvail <= 0.01 || sciAvail <= 0.01)
            ? `BuildWorkshop blocked by reserve (${woodAvail.toFixed(1)} wood avail, ${sciAvail.toFixed(1)} sci avail) → ${alt}`
            : `BuildWorkshop blocked (need wood+science) → ${alt}`;
          doFallback(s, k, dt, alt, reason);
          return;
        }
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'BuildWorkshop');
        const wp = workPaceMul(s);
        const speed = (1 + 0.06*(k.skills.Building-1)) * toolsBonus(s) * eff * mom * wp;
        // Respect reserves (hard stop at execution time).
        const maxByWood = woodAvail / 0.85;
        const maxBySci  = sciAvail / 0.55;
        const maxByTime = speed * dt;
        // Progress is limited by the scarcer input and by time.
        const prog = Math.min(maxByTime, maxByWood, maxBySci);
        if (prog <= 0.0001) {
          doFallback(s, k, dt, 'Research', 'BuildWorkshop blocked by reserve → Research');
          return;
        }
        spendUpToReserve(s,'wood', prog * 0.85);
        spendUpToReserve(s,'science', prog * 0.55);
        s._workProgress = (s._workProgress ?? 0) + prog;
        if (s._workProgress >= 26) {
          s._workProgress -= 26;
          s.res.workshops = (s.res.workshops ?? 0) + 1;
          log(`Built a workshop. Workshops: ${s.res.workshops} (industry x${workshopBonus(s).toFixed(2)})`);
        }
        k.energy = clamp01(k.energy - dt * 0.06 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp);
        const effXp = efficiency(s,k);
        gainXP(k,'Building', dt * 0.9 * effXp);
        gainXP(k,'Scholarship', dt * 0.3 * effXp);
      }
    },
    BuildLibrary: {
      enabled: (s) => s.unlocked.construction && s.unlocked.library,
      tick: (s,k,dt) => {
        // Convert wood + science + tools into a persistent Library building.
        // Libraries boost Research output (stacking), making "Advance" mode a real compounding loop.
        const woodAvail = availableAboveReserve(s,'wood');
        const sciAvail  = availableAboveReserve(s,'science');
        const toolsAvail = availableAboveReserve(s,'tools');
        const toolsHave = Math.max(0, Number(s.res.tools ?? 0));

        if (s.res.wood <= 0 || s.res.science <= 0 || toolsHave <= 0.01 || woodAvail <= 0.01 || sciAvail <= 0.01 || toolsAvail <= 0.01) {
          // If we're blocked, do the thing that unblocks us.
          let alt = 'CraftTools';
          if (!s.unlocked.workshop) alt = (sciAvail <= woodAvail) ? 'Research' : 'ChopWood';
          else if (toolsHave <= 0.01 || toolsAvail <= 0.01) alt = 'CraftTools';
          else if (sciAvail <= woodAvail) alt = 'Research';
          else alt = 'ChopWood';

          const reason = (woodAvail <= 0.01 || sciAvail <= 0.01 || toolsAvail <= 0.01)
            ? `BuildLibrary blocked by reserve (${woodAvail.toFixed(1)} wood avail, ${sciAvail.toFixed(1)} sci avail, ${toolsAvail.toFixed(1)} tools avail) → ${alt}`
            : `BuildLibrary blocked (need wood+science+tools) → ${alt}`;
          doFallback(s, k, dt, alt, reason);
          return;
        }

        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'BuildLibrary');
        const wp = workPaceMul(s);
        const speed = (1 + 0.06*(k.skills.Building-1)) * toolsBonus(s) * eff * mom * wp;

        // Costs per 1 progress.
        const maxByWood  = woodAvail / 0.75;
        const maxBySci   = sciAvail / 0.65;
        const maxByTools = toolsAvail / 0.35;
        const maxByTime  = speed * dt;
        const prog = Math.min(maxByTime, maxByWood, maxBySci, maxByTools);

        if (prog <= 0.0001) {
          doFallback(s, k, dt, 'CraftTools', 'BuildLibrary blocked → CraftTools');
          return;
        }

        spendUpToReserve(s,'wood', prog * 0.75);
        spendUpToReserve(s,'science', prog * 0.65);
        spendUpToReserve(s,'tools', prog * 0.35);

        s._libProgress = (s._libProgress ?? 0) + prog;
        if (s._libProgress >= 30) {
          s._libProgress -= 30;
          s.res.libraries = (s.res.libraries ?? 0) + 1;
          log(`Built a library. Libraries: ${s.res.libraries} (research x${libraryBonus(s).toFixed(2)})`);
        }

        k.energy = clamp01(k.energy - dt * 0.06 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp);
        const effXp = efficiency(s,k);
        gainXP(k,'Building', dt * 0.75 * effXp);
        gainXP(k,'Scholarship', dt * 0.55 * effXp);
      }
    },
    CraftTools: {
      enabled: (s) => !!s.unlocked.workshop,
      tick: (s,k,dt) => {
        // Convert wood + science into Tools (global productivity with diminishing returns).
        // Rate is constrained by both inputs so you can't print tools from nothing.
        const woodAvail = availableAboveReserve(s,'wood');
        const sciAvail  = availableAboveReserve(s,'science');
        if (s.res.wood <= 0 || s.res.science <= 0 || woodAvail <= 0.01 || sciAvail <= 0.01) {
          // If tools are blocked, do something that refills the limiting input.
          const alt = (s.res.science <= 0 || sciAvail <= woodAvail) ? 'Research' : 'ChopWood';
          const reason = (woodAvail <= 0.01 || sciAvail <= 0.01)
            ? `CraftTools blocked by reserve (${woodAvail.toFixed(1)} wood avail, ${sciAvail.toFixed(1)} sci avail) → ${alt}`
            : `CraftTools blocked (need wood+science) → ${alt}`;
          doFallback(s, k, dt, alt, reason);
          return;
        }
        const eff = efficiency(s, k);
        const mult = 1 + 0.06*(k.skills.Building-1);
        const mom = momentumMul(k, 'CraftTools');
        const wp = workPaceMul(s);
        // Respect reserves (hard stop at execution time).
        const useWood = Math.min(woodAvail, 0.55 * mult * dt * eff * wp);
        const useSci  = Math.min(sciAvail, 0.40 * mult * dt * eff * wp);
        const craft = Math.min(useWood / 0.55, useSci / 0.40); // normalize to "tool-seconds"
        if (craft <= 0.0001) {
          doFallback(s, k, dt, 'Research', 'CraftTools blocked by reserve → Research');
          return;
        }
        const made = craft * 0.55 * workshopBonus(s) * mom; // workshops improve throughput
        spendUpToReserve(s,'wood', craft * 0.55);
        spendUpToReserve(s,'science', craft * 0.40);
        s.res.tools = (s.res.tools ?? 0) + made;
        k.energy = clamp01(k.energy - dt * 0.05 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp);
        const effXp = efficiency(s,k);
        gainXP(k,'Building', dt * 0.6 * effXp);
        gainXP(k,'Scholarship', dt * 0.4 * effXp);
      }
    },
    Mentor: {
      enabled: (s) => !!s.unlocked.library,
      tick: (s,k,dt) => {
        // Spend science to accelerate long-run specialization.
        // Mentoring is intentionally a "stable times" action: if science is scarce or protected by reserves, it falls back to Research.
        const sciAvail = availableAboveReserve(s,'science');
        if ((s.res.science ?? 0) <= 0 || sciAvail <= 0.01) {
          doFallback(s, k, dt, 'Research', `Mentor blocked by science reserve (avail ${sciAvail.toFixed(1)}) → Research`);
          return;
        }

        // Choose a skill to teach.
        // Default: mentor's top skill (excluding Cooking) if it exists; otherwise Scholarship.
        // Upgrade: if the colony is short on a quota/plan role, teach the corresponding role skill instead.
        const top = topSkillInfo(k);
        let teachSkill = (top.skill && top.skill !== 'Cooking') ? top.skill : 'Scholarship';
        let teachRole = null;
        let teachWhy = `mentor top skill: ${teachSkill}`;

        // 1) Role quotas: if you're under quota, train toward that role.
        const roleCounts = Object.create(null);
        for (const kk of (s.kittens ?? [])) {
          const r = String(kk?.role ?? 'Generalist');
          roleCounts[r] = (roleCounts[r] ?? 0) + 1;
        }
        const q = s.roleQuota ?? {};
        let bestQuota = { miss: 0, roleId: null, skill: null, why: '' };
        for (const r of roleDefs) {
          if (r.req && !r.req(s)) continue;
          const want = Math.max(0, Math.min(99, Number(q?.[r.id] ?? 0) | 0));
          if (want <= 0) continue;
          const have = roleCounts[r.id] ?? 0;
          const miss = Math.max(0, want - have);
          if (miss > bestQuota.miss) {
            bestQuota = { miss, roleId: r.id, skill: r.skill, why: `quota shortfall ${r.id} ${have}/${want}` };
          }
        }
        if (bestQuota.miss > 0 && bestQuota.skill) {
          teachSkill = bestQuota.skill;
          teachRole = bestQuota.roleId;
          teachWhy = bestQuota.why;
        } else {
          // 2) Plan deficit: if the last colony plan wants more of an action, teach the skill for that role.
          const plan = s._lastPlan ?? null;
          if (plan && plan.desired && plan.assigned) {
            let bestNeed = { need: 0, roleId: null, skill: null, why: '' };
            for (const r of roleDefs) {
              if (r.req && !r.req(s)) continue;
              let need = 0;
              for (const a of r.actions) {
                const want = Number(plan.desired?.[a] ?? 0);
                const have = Number(plan.assigned?.[a] ?? 0);
                if (want > have) need += (want - have);
              }
              if (need > bestNeed.need) {
                bestNeed = { need, roleId: r.id, skill: r.skill, why: `plan deficit: need more ${r.id}` };
              }
            }
            if (bestNeed.need > 0 && bestNeed.skill) {
              teachSkill = bestNeed.skill;
              teachRole = bestNeed.roleId;
              teachWhy = bestNeed.why;
            }
          }
        }

        // Pick a target: someone else with the lowest level in that skill (so mentoring actually balances the colony).
        const others = (s.kittens ?? []).filter(x => x && x.id !== k.id);
        if (!others.length) {
          taskDefs.Research.tick(s,k,dt);
          return;
        }
        let target = others[0];
        let bestScore = Infinity;
        for (const o of others) {
          const lvl = Number(o.skills?.[teachSkill] ?? 1);
          // If we're training to fill a role gap, prefer kittens NOT already in that role.
          const rolePenalty = (teachRole && String(o.role ?? '') === teachRole) ? 0.35 : 0;
          const score = lvl + rolePenalty;
          if (score < bestScore) { bestScore = score; target = o; }
        }

        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Mentor');
        const mult = 1 + 0.07 * ((k.skills.Scholarship ?? 1) - 1);
        const wp = workPaceMul(s);

        // Science cost scales with teaching throughput.
        const wantSci = 0.42 * mult * dt * eff * mom * wp;
        const spent = spendUpToReserve(s,'science', wantSci);
        if (spent <= 0.0001) {
          doFallback(s, k, dt, 'Research', 'Mentor blocked by science reserve → Research');
          return;
        }

        // Teaching value: convert spent science into XP for the target.
        const teach = (spent / 0.42) * 1.20 * libraryBonus(s);
        gainXP(target, teachSkill, teach);
        gainXP(k, 'Scholarship', teach * 0.45);

        // Small morale bump for both; mentoring feels good.
        k.mood = clamp01(Number(k.mood ?? 0.55) + dt * 0.004);
        target.mood = clamp01(Number(target.mood ?? 0.55) + dt * 0.003);

        // Track for UI explainability.
        k._mentor = { id: target.id, skill: teachSkill, why: teachWhy };

        k.energy = clamp01(k.energy - dt * 0.032 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.028 * wp);
      }
    },
    Research: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const mult = 1 + 0.08*(k.skills.Scholarship-1);
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Research');
        const wp = workPaceMul(s);
        const out = 0.95 * mult * libraryBonus(s) * dt * eff * mom * wp;
        s.res.science += out;
        k.energy = clamp01(k.energy - dt * 0.035 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp);
        gainXP(k,'Scholarship', dt * 1.0 * efficiency(s,k));
      }
    },
  };

  function gainXP(k, skill, amt){
    k.xp[skill] = (k.xp[skill] ?? 0) + amt;
    let level = k.skills[skill] ?? 1;
    while (k.xp[skill] >= xpToNext(level)) {
      k.xp[skill] -= xpToNext(level);
      level += 1;
      k.skills[skill] = level;
      log(`Kitten ${k.id} leveled ${skill} → ${level}`);
    }
  }
  function xpToNext(level){ return 10 + Math.pow(level, 1.35) * 6; }

  // --- Conditions
  function evalCond(cond, s, k){
    const foodPerKitten = ediblePerKitten(s);
    switch(cond.type){
      case 'always': return true;
      case 'hungry_gt': return k.hunger > cond.v;
      case 'tired_gt': return (1 - k.energy) > cond.v;
      case 'health_lt': return (Number(k.health ?? 1) || 0) < cond.v;
      case 'food_lt': return s.res.food < cond.v;
      case 'wood_lt': return s.res.wood < cond.v;
      case 'warmth_lt': return s.res.warmth < cond.v;
      case 'threat_gt': return s.res.threat > cond.v;
      case 'foodperkitten_lt': return foodPerKitten < cond.v;
      case 'signal': return !!s.signals[cond.v];
      case 'threat_gt_or_alarm': return s.res.threat > cond.v || !!s.signals.ALARM;
      default: return false;
    }
  }

  // --- Roles (lightweight specialization with inertia + explainability)
  // Roles don't force actions; they just bias scoring so kittens naturally specialize.
  const roleDefs = [
    { id:'Forager',   actions:['Forage'],      skill:'Foraging' },
    { id:'Farmer',    actions:['Farm'],        skill:'Farming',    req:(s)=>s.unlocked.farm },
    { id:'Woodcutter',actions:['ChopWood'],    skill:'Woodcutting' },
    { id:'Firekeeper',actions:['StokeFire'],   skill:'Cooking' },
    { id:'Guard',     actions:['Guard'],       skill:'Combat' },
    { id:'Builder',   actions:['BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary'], skill:'Building', req:(s)=>s.unlocked.construction },
    { id:'Scholar',   actions:['Research'],    skill:'Scholarship' },
    { id:'Toolsmith', actions:['CraftTools'],  skill:'Building',   req:(s)=>s.unlocked.workshop },
  ];

  function roleNeedBonus(plan, actions){
    if (!plan) return 0;
    let b = 0;
    for (const a of actions) {
      const want = plan.desired[a] ?? 0;
      const have = plan.assigned[a] ?? 0;
      if (want <= 0) continue;
      if (have < want) b += (want - have);
    }
    return Math.min(3, b); // cap; plan still matters separately
  }

  function updateRoles(s, plan){
    // Optional "role quotas": if the player sets a quota > 0, try to keep that many kittens in the role.
    // This is a gentle bias (not a hard lock) and still allows safety rules + emergencies to override tasks.
    s.roleQuota = s.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };

    // Start from current roles to avoid oscillation.
    const counts = Object.create(null);
    for (const k of s.kittens) {
      k.role = k.role ?? 'Generalist';
      counts[k.role] = (counts[k.role] ?? 0) + 1;
    }

    const quotaFor = (roleId) => {
      const q = Number(s.roleQuota?.[roleId] ?? 0);
      return Number.isFinite(q) ? Math.max(0, Math.min(99, q|0)) : 0;
    };

    // We update one kitten at a time and adjust counts as we change roles.
    for (const k of s.kittens) {
      // Migration safety
      k.role = k.role ?? 'Generalist';
      k.roleWhy = k.roleWhy ?? '';

      let best = { id:'Generalist', score: 0, why:'no strong specialization yet' };
      for (const r of roleDefs) {
        if (r.req && !r.req(s)) continue;

        const lvl = k.skills[r.skill] ?? 1;
        const need = roleNeedBonus(plan, r.actions);
        const stick = (k.role === r.id) ? 1.2 : 0;

        // Quota pressure: if a role is under quota, make it more attractive; if over, make it less.
        const q = quotaFor(r.id);
        let quotaAdj = 0;
        let quotaWhy = '';
        if (q > 0) {
          const have = counts[r.id] ?? 0;
          if (have < q) {
            const miss = q - have;
            quotaAdj = Math.min(40, 14 + miss * 12);
            quotaWhy = `quota ${have}/${q} → +${quotaAdj}`;
          } else if (have > q) {
            const over = have - q;
            quotaAdj = -Math.min(30, 10 + over * 10);
            quotaWhy = `quota ${have}/${q} → ${quotaAdj}`;
          }
        }

        const score = lvl * 10 + need * 6 + stick * 8 + quotaAdj;
        if (score > best.score) {
          best = { id:r.id, score, why:`${r.skill} L${lvl} (+need ${need}, +stick ${stick?1:0})${quotaWhy?` | ${quotaWhy}`:''}` };
        }
      }

      // Hysteresis: avoid role-flapping unless meaningfully better.
      const currentIsBest = (k.role === best.id);
      if (!currentIsBest) {
        const curDef = roleDefs.find(r=>r.id===k.role);
        const curLvl = curDef ? (k.skills[curDef.skill] ?? 1) : 1;
        const curNeed = curDef ? roleNeedBonus(plan, curDef.actions) : 0;
        const curStick = 1.2;
        const curQuota = quotaFor(k.role);
        let curQuotaAdj = 0;
        if (curQuota > 0) {
          const have = counts[k.role] ?? 0;
          if (have < curQuota) curQuotaAdj = Math.min(40, 14 + (curQuota - have) * 12);
          else if (have > curQuota) curQuotaAdj = -Math.min(30, 10 + (have - curQuota) * 10);
        }

        const curScore = curDef ? (curLvl*10 + curNeed*6 + curStick*8 + curQuotaAdj) : 0;

        if (best.score >= curScore + 10) {
          // Apply role change + update counts.
          counts[k.role] = Math.max(0, (counts[k.role] ?? 0) - 1);
          k.role = best.id;
          counts[k.role] = (counts[k.role] ?? 0) + 1;
          k.roleWhy = best.why;
        }
      } else {
        k.roleWhy = best.why;
      }
    }
  }

  function autonomy01(s){
    const a = Number(s?.director?.autonomy ?? 0.60);
    return clamp01(a);
  }

  function discipline01(s){
    const d = Number(s?.director?.discipline ?? 0.40);
    return clamp01(d);
  }

  // Labor doctrine: a simple policy that changes how "central planning" expresses itself.
  // - Balanced: default
  // - Specialize: stronger role pressure, weaker boredom rotation (specialists stick)
  // - Rotate: weaker role pressure, stronger boredom rotation, slightly reduces dissent buildup
  function doctrineKey(s){
    const d = String(s?.director?.doctrine ?? 'Balanced');
    return (d === 'Specialize' || d === 'Rotate' || d === 'Balanced') ? d : 'Balanced';
  }

  function dissent01(s){
    const x = Number(s?.social?.dissent ?? 0);
    return clamp01(x);
  }

  // Effective autonomy is the *felt* autonomy after discipline + dissent.
  // - Discipline reduces wandering / "near-top" sampling (more compliance)
  // - Dissent increases it (more emergent, less plan-perfect)
  function effectiveAutonomy01(s){
    const a = autonomy01(s);
    const d = discipline01(s);
    const dis = dissent01(s);
    return clamp01(a * (1 - 0.60*d) + dis * 0.25);
  }

  // Compliance scales how strongly plan/role pressure works.
  // Higher dissent reduces it; higher discipline restores it.
  function compliance01(s){
    const dis = dissent01(s);
    const a = autonomy01(s);
    const d = discipline01(s);
    let c = 1 - dis * (0.35 + 0.35*a) + d * 0.35;
    // Council temporarily boosts cohesion (more compliance with the plan).
    if (councilActive(s)) c += 0.08;
    return Math.max(0.45, Math.min(1.20, c));
  }

  // Autonomy sampling: at higher autonomy, kittens sometimes pick a near-top alternative.
  // This makes behavior feel less perfectly optimized while staying explainable (we still show scores).
  function pickWithAutonomy(scored, a01){
    const a = clamp01(Number(a01 ?? 0));
    if (!Array.isArray(scored) || !scored.length) return { row: { action:'Rest', score:0, reasons:[] }, note:'' };
    if (a <= 0.02) return { row: scored[0], note:'' };

    const n = Math.max(1, Math.min(3, scored.length));
    const top = scored.slice(0, n);

    // Temperature: higher autonomy → flatter choice distribution.
    const temp = 2 + a * 10; // 2..12
    const max = Math.max(...top.map(r => Number(r.score) || 0));
    const weights = top.map(r => Math.exp(((Number(r.score) || 0) - max) / temp));
    const sum = weights.reduce((acc,x)=>acc+x,0) || 1;

    let roll = Math.random() * sum;
    let idx = 0;
    for (let i=0;i<weights.length;i++) {
      roll -= weights[i];
      if (roll <= 0) { idx = i; break; }
    }

    const row = top[idx];
    const note = (idx > 0) ? `autonomy picked #${idx+1}/${n}` : '';
    return { row, note };
  }

  function applyRolePressure(scored, k){
    const role = k.role ?? 'Generalist';
    if (role === 'Generalist') return;
    const def = roleDefs.find(r=>r.id===role);
    if (!def) return;

    // Autonomy: higher autonomy means individuals resist rigid specialization a bit.
    // (They still specialize via skills + the plan; this just dampens the role push.)
    const a = effectiveAutonomy01(state);
    const comp = compliance01(state);
    const doc = doctrineKey(state);
    const docMul = (doc === 'Specialize') ? 1.18 : (doc === 'Rotate') ? 0.78 : 1.00;
    const roleMul = (1.10 - 0.35 * a) * docMul; // 1.10 @ 0% autonomy → 0.75 @ 100% (then doctrine scales it)

    for (const row of scored) {
      if (!def.actions.includes(row.action)) continue;
      const lvl = k.skills[def.skill] ?? 1;
      const base = Math.min(22, 8 + (lvl-1) * 3.5);
      const add = base * roleMul * comp;
      row.score += add;
      row.reasons.push(`role=${role} (${def.skill} L${lvl}) → +${add.toFixed(0)}` + (comp < 0.95 ? ` (comp x${comp.toFixed(2)})` : ''));
    }
  }

  function applyPersonalityPressure(scored, k){
    // Preferences add a nudge so individuals feel different.
    // Effective autonomy controls how strongly likes/dislikes pull vs colony policy.
    const p = k.personality ?? genPersonality(k.id ?? 0);
    const a = effectiveAutonomy01(state);

    const likeBonus = 6 + 10 * a;      // 6..16
    const dislikePenalty = 4 + 8 * a;  // 4..12
    const doc = doctrineKey(state);
    const boreDoc = (doc === 'Rotate') ? 1.35 : (doc === 'Specialize') ? 0.75 : 1.00;
    const boreMul = (0.6 + 0.8 * a) * boreDoc;     // 0.6..1.4 (then doctrine scales it)

    for (const row of scored) {
      if (p.likes?.includes(row.action)) {
        row.score += likeBonus;
        row.reasons.push(`likes ${row.action} → +${likeBonus.toFixed(0)}`);
      }
      if (p.dislikes?.includes(row.action)) {
        row.score -= dislikePenalty;
        row.reasons.push(`dislikes ${row.action} → -${dislikePenalty.toFixed(0)}`);
      }

      if (row.action === (k.task ?? '')) {
        // Boredom pushes natural rotation, but don't sabotage long build projects.
        const streak = Number(k.taskStreak ?? 0);
        const noBore = ['BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary'];
        if (!noBore.includes(row.action) && streak > 8) {
          const sub = Math.min(18, (streak - 8) * 2) * boreMul;
          row.score -= sub;
          row.reasons.push(`bored of ${row.action} (${streak}s) → -${sub.toFixed(0)}`);
        }
      }
    }
  }

  function applyTraitPressure(scored, k){
    // Traits are a steady bias (unlike likes/dislikes which scale with Autonomy).
    const traits = Array.isArray(k?.traits) ? k.traits : [];
    if (!traits.length) return;

    for (const id of traits) {
      const def = TRAIT_DEFS.find(t => t.id === id);
      if (!def?.bias) continue;
      for (const row of scored) {
        const add = Number(def.bias[row.action] ?? 0);
        if (!add) continue;
        row.score += add;
        row.reasons.push(`trait ${def.id} → +${add.toFixed(0)}`);
      }
    }
  }

  // --- Colony-wide effects (simple timers)
  function festivalActive(s){
    return Number(s.effects?.festivalUntil ?? 0) > Number(s.t ?? 0);
  }

  function festivalSecondsLeft(s){
    return Math.max(0, Number(s.effects?.festivalUntil ?? 0) - Number(s.t ?? 0));
  }

  function festivalCost(s){
    const n = Math.max(1, s.kittens?.length ?? 1);
    return { food: 50 + 12*n, wood: 8 + 2*n };
  }

  function canHoldFestival(s){
    const c = festivalCost(s);
    return availableAboveReserve(s,'food') >= c.food && availableAboveReserve(s,'wood') >= c.wood;
  }

  function holdFestival(s){
    s.effects = s.effects ?? { festivalUntil: 0 };
    if (!('festivalUntil' in s.effects)) s.effects.festivalUntil = 0;

    const c = festivalCost(s);
    if (!canHoldFestival(s)) return { ok:false, msg:`Need ${c.food} food + ${c.wood} wood above reserves.` };

    // Spend (respecting reserves). Should be exact since canHoldFestival checked.
    const gotFood = spendUpToReserve(s,'food',c.food);
    const gotWood = spendUpToReserve(s,'wood',c.wood);
    if (gotFood < c.food || gotWood < c.wood) {
      // Safety: refund partial spends (should be rare; protects against edge-case ordering).
      s.res.food = Number(s.res.food ?? 0) + gotFood;
      s.res.wood = Number(s.res.wood ?? 0) + gotWood;
      return { ok:false, msg:`Festival blocked by reserves/inputs (try lowering reserves).` };
    }

    const base = Math.max(Number(s.effects.festivalUntil ?? 0), Number(s.t ?? 0));
    s.effects.festivalUntil = base + 50; // seconds

    // Tiny immediate happiness bump.
    for (const k of (s.kittens ?? [])) k.mood = clamp01(Number(k.mood ?? 0.55) + 0.05);

    return { ok:true, msg:`Festival held (-${c.food} food, -${c.wood} wood). Mood rises for ~50s.` };
  }

  // Council: cohesion lever (spend resources to reduce dissent / improve compliance temporarily)
  function councilActive(s){
    return Number(s.effects?.councilUntil ?? 0) > Number(s.t ?? 0);
  }

  function councilSecondsLeft(s){
    return Math.max(0, Number(s.effects?.councilUntil ?? 0) - Number(s.t ?? 0));
  }

  function councilCost(s){
    const n = Math.max(1, s.kittens?.length ?? 1);
    return { food: 20 + 5*n, science: 40 + 10*n };
  }

  function canHoldCouncil(s){
    const c = councilCost(s);
    return availableAboveReserve(s,'food') >= c.food && availableAboveReserve(s,'science') >= c.science;
  }

  function holdCouncil(s){
    s.effects = s.effects ?? { festivalUntil: 0, councilUntil: 0 };
    if (!('festivalUntil' in s.effects)) s.effects.festivalUntil = 0;
    if (!('councilUntil' in s.effects)) s.effects.councilUntil = 0;

    s.social = s.social ?? { dissent: 0 };
    if (!('dissent' in s.social)) s.social.dissent = 0;

    const c = councilCost(s);
    if (!canHoldCouncil(s)) return { ok:false, msg:`Need ${c.food} food + ${c.science} science above reserves.` };

    // Spend (respecting reserves). Should be exact since canHoldCouncil checked.
    const gotFood = spendUpToReserve(s,'food',c.food);
    const gotSci  = spendUpToReserve(s,'science',c.science);
    if (gotFood < c.food || gotSci < c.science) {
      // Safety: refund partial spends.
      s.res.food = Number(s.res.food ?? 0) + gotFood;
      s.res.science = Number(s.res.science ?? 0) + gotSci;
      return { ok:false, msg:`Council blocked by reserves/inputs (try lowering reserves).` };
    }

    const base = Math.max(Number(s.effects.councilUntil ?? 0), Number(s.t ?? 0));
    s.effects.councilUntil = base + 45; // seconds

    // Immediate cohesion boost: reduce dissent quickly (policy is "heard").
    s.social.dissent = clamp01(Number(s.social.dissent ?? 0) * 0.70);

    // Tiny immediate morale bump + grievance relief.
    for (const k of (s.kittens ?? [])) {
      k.mood = clamp01(Number(k.mood ?? 0.55) + 0.03);
      k.grievance = clamp01(Number(k.grievance ?? 0) * 0.75);
    }

    return { ok:true, msg:`Council held (-${c.food} food, -${c.science} science). Dissent falls for ~45s.` };
  }

  // Drills: defense training lever (spend resources for a short window of better security)
  function drillActive(s){
    return Number(s.effects?.drillUntil ?? 0) > Number(s.t ?? 0);
  }

  function drillSecondsLeft(s){
    return Math.max(0, Number(s.effects?.drillUntil ?? 0) - Number(s.t ?? 0));
  }

  function drillCost(s){
    const n = Math.max(1, s.kittens?.length ?? 1);
    // Scales with pop so it stays relevant, but is cheaper than a festival.
    return { food: 28 + 7*n, wood: 14 + 4*n };
  }

  function canRunDrills(s){
    const c = drillCost(s);
    return availableAboveReserve(s,'food') >= c.food && availableAboveReserve(s,'wood') >= c.wood;
  }

  function runDrills(s){
    s.effects = s.effects ?? { festivalUntil: 0, councilUntil: 0, drillUntil: 0 };
    if (!('festivalUntil' in s.effects)) s.effects.festivalUntil = 0;
    if (!('councilUntil' in s.effects)) s.effects.councilUntil = 0;
    if (!('drillUntil' in s.effects)) s.effects.drillUntil = 0;

    const c = drillCost(s);
    if (!canRunDrills(s)) return { ok:false, msg:`Need ${c.food} food + ${c.wood} wood above reserves.` };

    const gotFood = spendUpToReserve(s,'food',c.food);
    const gotWood = spendUpToReserve(s,'wood',c.wood);
    if (gotFood < c.food || gotWood < c.wood) {
      s.res.food = Number(s.res.food ?? 0) + gotFood;
      s.res.wood = Number(s.res.wood ?? 0) + gotWood;
      return { ok:false, msg:`Drills blocked by reserves/inputs (try lowering reserves).` };
    }

    const base = Math.max(Number(s.effects.drillUntil ?? 0), Number(s.t ?? 0));
    s.effects.drillUntil = base + 40; // seconds

    // Tiny immediate effect: feels like "we're getting organized".
    s.res.threat = Math.max(0, Number(s.res.threat ?? 0) - 3);

    return { ok:true, msg:`Defense drills run (-${c.food} food, -${c.wood} wood). Threat grows slower and Guard training improves for ~40s.` };
  }

  function updateMoodPerSecond(s, k, task){
    // Mood is "how good this minute feels": alignment with personality + basic stressors.
    // It intentionally moves slowly and has small effects.
    let m = clamp01(Number(k.mood ?? 0.55));
    const p = k.personality ?? genPersonality(k.id ?? 0);
    const a = effectiveAutonomy01(s);

    // Autonomy makes personality alignment matter more (good *and* bad).
    if (p.likes?.includes(task)) m += (0.010 + 0.020 * a);
    if (p.dislikes?.includes(task)) m -= (0.012 + 0.030 * a);

    // Comfort actions feel good.
    if (task === 'Eat' || task === 'Rest' || task === 'Loaf') m += 0.010;

    // Aptitude: feels good to do what you're good at; feels bad to be forced far off your strengths.
    // This is intentionally subtle; policy + emergencies can still override.
    const aSkill = skillForAction(task);
    if (aSkill) {
      const top = topSkillInfo(k);
      const lvl = Number(k.skills?.[aSkill] ?? 1);
      if (top.skill && aSkill === top.skill && task !== 'Eat' && task !== 'Rest') m += 0.010;
      else if (top.skill && (top.level - lvl) >= 3) m -= 0.006;
    }

    // Festivals: colony-wide morale boost (purely a timed policy lever).
    if (festivalActive(s)) m += 0.012;

    // Council: cohesion boost (less grumbling while it lasts).
    if (councilActive(s)) m += 0.006;

    // Background stress.
    if ((k.hunger ?? 0) > 0.85) m -= 0.010;
    const season = seasonAt(s.t);
    if (season.name === 'Winter' && (s.res?.warmth ?? 0) < 35) m -= 0.008;
    const brave = Array.isArray(k.traits) && k.traits.includes('Brave');
    if (s.signals?.ALARM) m -= brave ? 0.002 : 0.005;

    // Work pace policy: pushing hard makes the colony a bit grumpier over time; relaxed pace is a small morale relief.
    const wp = workPaceMul(s);
    if (wp > 1.02) m -= (wp - 1) * 0.018; // at 1.20 → -0.0036 / sec
    if (wp < 0.98) m += (1 - wp) * 0.010; // at 0.80 → +0.0020 / sec

    // Discipline (cohesion) has a small, steady morale cost.
    // It's intentionally subtle so it's a strategic lever, not a "never use" trap.
    const d = discipline01(s);
    m -= d * 0.0018; // at 100% → -0.0018 / sec

    // Curfew (governance lever): makes the colony safer, but costs morale.
    // Discipline amplifies the felt harshness slightly (more enforcement).
    if (s.director?.curfew) m -= (0.0012 + 0.0010 * d);

    // Values mismatch (emergent civ-sim pressure):
    // When effective autonomy is low (strong central planning), forcing kittens away from their values
    // slowly reduces mood. High discipline amplifies that "resentment" a bit.
    const align = valuesAlignment01(s, k);
    const planPressure = (1 - effectiveAutonomy01(s));
    const mismatch = (1 - align);
    let stress = mismatch * planPressure;
    stress *= (1 + 0.60 * d);
    if (festivalActive(s)) stress *= 0.70;
    if (councilActive(s)) stress *= 0.85;
    m -= stress * 0.0035; // max-ish ~ -0.0035/sec in extreme mismatch/low autonomy

    // Buddy separation stress: if they haven't "seen" their buddy in a while,
    // mood slowly drifts down (tiny, but noticeable under high discipline/low autonomy).
    const need = clamp01(Number(k.buddyNeed ?? 0));
    if (need > 0.65) {
      const addStress = (need - 0.65) * (0.0045 + 0.0035 * d) * (1 + 0.35 * (1 - a));
      m -= addStress;
    }

    k.mood = clamp01(m);
  }

  function updateGrievancePerSecond(s, k, task){
    // Grievance is a slow-burn "resentment" meter (0..1).
    // It rises when kittens are repeatedly pushed into disliked / misaligned work under strong central planning,
    // and falls when they feel heard (liked work, rest, social/care) or when you hold Council.
    let g = clamp01(Number(k.grievance ?? 0));
    const p = k.personality ?? genPersonality(k.id ?? 0);
    const likes = Array.isArray(p.likes) ? p.likes : [];
    const dislikes = Array.isArray(p.dislikes) ? p.dislikes : [];

    const effA = effectiveAutonomy01(s);
    const planPressure = (1 - effA); // high when central planning is strong
    const disPol = discipline01(s);

    // Baseline natural decay (grievances fade if conditions improve).
    g = Math.max(0, g - 0.004);

    let delta = 0;

    // Doing disliked work while under strong planning increases resentment.
    if (dislikes.includes(task) && planPressure > 0.25) {
      delta += (0.010 + 0.020 * planPressure) * (1 + 0.50 * disPol);
    }

    // Values mismatch is a broader "I don't like where this society is headed" pressure.
    const align = valuesAlignment01(s, k);
    const mismatch = (1 - align) * planPressure;
    delta += mismatch * (0.006 + 0.004 * disPol);

    // Feeling heard reduces grievance.
    if (likes.includes(task)) delta -= (0.006 + 0.010 * effA);

    // Comfort + relationship actions cool things down.
    if (task === 'Eat' || task === 'Rest' || task === 'Loaf' || task === 'Socialize' || task === 'Care') delta -= 0.010;

    // Timed colony-wide relief.
    if (festivalActive(s)) delta *= 0.70;
    if (councilActive(s)) delta *= 0.80;

    // Buddy separation can also translate into low-grade resentment under strong planning.
    const need = clamp01(Number(k.buddyNeed ?? 0));
    if (need > 0.70) {
      delta += (need - 0.70) * (0.006 + 0.006 * planPressure) * (1 + 0.35 * disPol);
    }

    g = clamp01(g + delta);
    k.grievance = g;
  }

  // --- AI
  // Colony-level coordination: we compute a lightweight "plan" (desired worker counts per task)
  // and then each kitten picks actions with a congestion/need modifier.
  //
  // Director levers that affect coordination:
  // - Higher Discipline = kittens stick to a chosen task longer (less thrash)
  // - Higher Autonomy   = kittens switch tasks more readily (more emergent wandering/preferences)
  function coordinationMul(s){
    const dis = discipline01(s);           // 0..1
    const effA = effectiveAutonomy01(s);  // 0..1
    // 0.90..~1.85 (kept tame; commitment must stay short to remain responsive).
    return 0.90 + 0.70 * dis + 0.25 * (1 - effA);
  }

  function commitSecondsForTask(s, task){
    // Keep it short so the AI is still responsive.
    // Safety rules + emergencies can always override.
    let base = 2;
    if (['BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary'].includes(task)) base = 4;
    else if (['CraftTools','Research','Forage','Farm','ChopWood'].includes(task)) base = 3;
    else if (['Guard','StokeFire'].includes(task)) base = 2;
    else if (['Eat','Rest','Loaf'].includes(task)) base = 1;

    const secs = Math.round(base * coordinationMul(s));
    return Math.max(1, Math.min(6, secs));
  }

  // --- Planning-time reservations (coordination)
  // We decide tasks sequentially once per second. Without reservations, multiple kittens can all
  // choose the same wood/science sink (CraftTools/BuildWorkshop/etc), then execution hard-stops
  // on reserves and they all fallback - looks like "thrash".
  // This is a lightweight, explainable fix: during the 1s planning pass, we reserve an estimated
  // amount of scarce inputs so later kittens see reduced "avail" and pick complementary work.
  function makeShadowAvail(s){
    return {
      food: availableAboveReserve(s,'food'),
      wood: availableAboveReserve(s,'wood'),
      science: availableAboveReserve(s,'science'),
      tools: availableAboveReserve(s,'tools'),
    };
  }

  function reserveForTask(shadowAvail, task){
    if (!shadowAvail) return;
    const sub = (k, amt) => { shadowAvail[k] = Math.max(0, Number(shadowAvail[k] ?? 0) - Math.max(0, amt)); };

    // Numbers are "per 1s" coarse estimates (not exact spending). Prefer conservative so we don't
    // over-reserve and starve sinks completely.
    if (task === 'BuildHut') sub('wood', 0.9);
    else if (task === 'BuildPalisade') sub('wood', 1.0);
    else if (task === 'BuildGranary') sub('wood', 0.85);
    else if (task === 'StokeFire') sub('wood', 0.8);
    else if (task === 'PreserveFood') { sub('food', 0.95); sub('wood', 0.22); }
    else if (task === 'BuildWorkshop') { sub('wood', 0.85); sub('science', 0.55); }
    else if (task === 'BuildLibrary') { sub('wood', 0.75); sub('science', 0.65); sub('tools', 0.35); }
    else if (task === 'Mentor') { sub('science', 0.42); }
    else if (task === 'CraftTools') { sub('wood', 0.55); sub('science', 0.40); }
  }

  function decideTask(s, k, plan, ctx){
    // Safety rules first
    for (let i=0;i<s.rules.length;i++) {
      const r = s.rules[i];
      if (!r.enabled) continue;
      if (r.act.type in taskDefs && !taskDefs[r.act.type].enabled(s)) continue;
      if (evalCond(r.cond, s, k)) {
        // Transient explainability: show that a hard override fired (not the score picker).
        k._lastDecision = { kind:'rule', at:s.t, task:r.act.type, ruleIndex:i+1, rule: shortRule(r) };
        return { task: r.act.type, why: `rule #${i+1}: ${shortRule(r)}` };
      }
    }

    // emergency
    if (k.hunger > 0.92 && edibleFood(s) > 0) {
      k._lastDecision = { kind:'emergency', at:s.t, task:'Eat', note:'starving' };
      return { task:'Eat', why:'emergency: starving' };
    }
    if (k.energy < 0.08) {
      k._lastDecision = { kind:'emergency', at:s.t, task:'Rest', note:'exhausted' };
      return { task:'Rest', why:'emergency: exhausted' };
    }

    // Commitment: if a kitten recently switched tasks, keep them on it briefly.
    // This prevents flapping and makes specialization/build-projects feel stable.
    if ((k.taskLock ?? 0) > 0) {
      const cur = k.task ?? 'Rest';
      if (cur in taskDefs && taskDefs[cur].enabled(s)) {
        k._lastDecision = { kind:'commit', at:s.t, task:cur, lock:Number(k.taskLock ?? 0), coord: coordinationMul(s) };
        const cm = coordinationMul(s);
        return { task: cur, why: `commit ${k.taskLock}s (coord x${cm.toFixed(2)}) | ${k.why ?? ''}`.trim() };
      }
    }

    const eff = efficiency(s, k);
    const scored = scoreActions(s, k, ctx);
    applyPlanPressure(scored, plan);
    applyRolePressure(scored, k);
    applyPersonalityPressure(scored, k);
    applyTraitPressure(scored, k);
    scored.sort((a,b)=>b.score-a.score);

    const pick = pickWithAutonomy(scored, effectiveAutonomy01(s));
    const top = pick.row;

    // Surface autonomy sampling in the UI (tiny "emergence" flag).
    k._autonomyPickNote = pick.note || '';
    k._autonomyPickAt = s.t;

    const mom = momentumMul(k, top.action);
    const momNote = (mom > 1.0001) ? ` | mom x${mom.toFixed(2)}` : '';
    const autoNote = pick.note ? ` | ${pick.note}` : '';
    const planNote = plan ? ` | plan: ${top.action} ${plan.assigned[top.action] ?? 0}/${plan.desired[top.action] ?? 0}` : '';
    const blockedNote = k._blockedMsg ? ` | last: ${k._blockedMsg}` : '';
    // Snapshot the scoring breakdown for UI inspection (transient; stripped on save)
    // Keep this small so we don't bloat memory: top few actions + their reason strings.
    k._lastScores = scored.slice(0, Math.min(10, scored.length)).map(r => ({ action: r.action, score: r.score, reasons: (r.reasons ?? []).slice(0, 12) }));
    k._lastScoredAt = s.t;

    // Clear after surfacing once (keeps UI readable).
    k._blockedMsg = '';
    k._blockedAction = null;

    // Mark how this decision was made (rule/emergency/commit/score).
    // Useful when autonomy sampling makes them *not* pick the strict top score.
    const best = scored?.[0]?.action ?? top.action;
    k._lastDecision = { kind:'score', at:s.t, task:top.action, best, autonomyNote:(pick.note || '') };

    return { task: top.action, why: `eff=${(eff*100).toFixed(0)}%${momNote}${autoNote} | role=${k.role ?? '-'} | score: ${top.action}=${top.score.toFixed(1)}${planNote}${blockedNote} | ${top.reasons.slice(0,3).join(' ; ')}` };
  }

  function shortRule(r){
    const c = r.cond.type;
    const v = r.cond.v;
    if (c === 'hungry_gt') return `hungry>${v}`;
    if (c === 'tired_gt') return `tired>${v}`;
    if (c === 'health_lt') return `health<${v}`;
    if (c === 'signal') return `signal(${v})`;
    if (c === 'warmth_lt') return `warmth<${v}`;
    if (c === 'threat_gt_or_alarm') return `threat>${v} OR ALARM`;
    return r.name.replace(/\s+/g,' ').slice(0,42);
  }

  function scoreActions(s, k, ctx){
    const season = seasonAt(s.t);
    const targets = seasonTargets(s);
    const foodPerKitten = ediblePerKitten(s);
    const foodRes = getReserve(s,'food');
    const tired = (1 - k.energy);
    const mood = clamp01(Number(k.mood ?? 0.55));
    const mode = s.mode;
    const pfInfo = getEffectiveProjectFocus(s);
    const pf = String(pfInfo.focus ?? 'Auto');
    const topSkill = topSkillInfo(k);

    // Director priorities (policy weights)
    const pFood = prioMul(s,'prioFood');
    const pSafety = prioMul(s,'prioSafety');
    const pProg = prioMul(s,'prioProgress');
    const FOOD_ACT = new Set(['Forage','Farm','PreserveFood']);
    const SAFETY_ACT = new Set(['Guard','StokeFire']);
    const PROG_ACT = new Set(['Research','Mentor','CraftTools','BuildWorkshop','BuildLibrary']);
    // Builders are special: they are both "safety" (palisade/huts/granary) and "progress" (infrastructure).

    // Availability above reserves (execution layer hard-stops spending below reserve; scoring should reflect this)
    // ctx.shadowAvail is a 1s planning-time reservation system so multiple kittens don't all pick the same
    // wood/science sink and then bounce off reserves.
    const _foodAvail = availableAboveReserve(s,'food');
    const _woodAvail = availableAboveReserve(s,'wood');
    const _sciAvail  = availableAboveReserve(s,'science');
    const _toolsAvail = availableAboveReserve(s,'tools');

    const foodAvail = Number(ctx?.shadowAvail?.food ?? _foodAvail);
    const woodAvail = Number(ctx?.shadowAvail?.wood ?? _woodAvail);
    const sciAvail  = Number(ctx?.shadowAvail?.science ?? _sciAvail);
    const toolsAvail = Number(ctx?.shadowAvail?.tools ?? _toolsAvail);

    const actions = ['Eat','Rest','Loaf','Socialize','Care','Forage','PreserveFood','ChopWood','StokeFire','Guard','Research'];
    if (s.unlocked.library) actions.push('Mentor');
    if (s.unlocked.workshop) actions.push('CraftTools');
    if (s.unlocked.construction && s.unlocked.workshop) actions.push('BuildWorkshop');
    if (s.unlocked.construction && s.unlocked.library) actions.push('BuildLibrary');
    if (s.unlocked.farm) actions.push('Farm');
    if (s.unlocked.construction) {
      actions.push('BuildHut','BuildPalisade');
      if (s.unlocked.granary) actions.push('BuildGranary');
    }

    const base = (a) => {
      if (mode === 'Survive') return ({ Eat:20, Rest:14, Loaf:2, Socialize:4, Care:3, Forage:14, PreserveFood:6, Farm:18, ChopWood:8, StokeFire:18, Guard:6, BuildHut:2, BuildPalisade:3, BuildGranary:6, BuildWorkshop:4, CraftTools:0, Research:4 })[a] ?? 0;
      if (mode === 'Expand') return ({ Eat:16, Rest:10, Loaf:1, Socialize:2, Care:2, Forage:10, PreserveFood:6, Farm:12, ChopWood:18, StokeFire:10, Guard:6, BuildHut:20, BuildPalisade:10, BuildGranary:10, BuildWorkshop:12, CraftTools:6, Research:4 })[a] ?? 0;
      if (mode === 'Defend') return ({ Eat:16, Rest:10, Loaf:1, Socialize:2, Care:1, Forage:10, PreserveFood:5, Farm:12, ChopWood:12, StokeFire:10, Guard:22, BuildHut:4, BuildPalisade:20, BuildGranary:6, BuildWorkshop:6, CraftTools:3, Research:4 })[a] ?? 0;
      return ({ Eat:16, Rest:10, Loaf:1, Socialize:2, Care:2, Forage:10, PreserveFood:7, Farm:12, ChopWood:10, StokeFire:10, Guard:10, BuildHut:6, BuildPalisade:8, BuildGranary:8, BuildWorkshop:14, CraftTools:16, Research:22 })[a] ?? 0;
    };

    const out = [];
    for (const a of actions) {
      if (!taskDefs[a].enabled(s)) continue;
      let score = base(a);
      const reasons = [`mode=${mode} base +${base(a)}`];

      // Director priorities bias individual scoring (not a hard lock).
      // We apply it as an additive bump proportional to the mode base so it stays readable and doesn't dominate emergencies.
      if (FOOD_ACT.has(a)) {
        const add = base(a) * (pFood - 1);
        if (Math.abs(add) >= 0.05) { score += add; reasons.push(`prio Food x${pFood.toFixed(2)} → ${add>=0?'+':''}${add.toFixed(1)}`); }
      }
      if (SAFETY_ACT.has(a)) {
        const add = base(a) * (pSafety - 1);
        if (Math.abs(add) >= 0.05) { score += add; reasons.push(`prio Safety x${pSafety.toFixed(2)} → ${add>=0?'+':''}${add.toFixed(1)}`); }
      }
      if (PROG_ACT.has(a)) {
        const add = base(a) * (pProg - 1);
        if (Math.abs(add) >= 0.05) { score += add; reasons.push(`prio Progress x${pProg.toFixed(2)} → ${add>=0?'+':''}${add.toFixed(1)}`); }
      }
      if (a === 'BuildHut' || a === 'BuildGranary' || a === 'BuildPalisade') {
        // Infrastructure: treat as a blend of Safety + Progress, so you can push building without always pushing research.
        const mul = (0.55 * pSafety + 0.45 * pProg);
        const add = base(a) * (mul - 1);
        if (Math.abs(add) >= 0.05) { score += add; reasons.push(`prio Infra x${mul.toFixed(2)} (S/P) → ${add>=0?'+':''}${add.toFixed(1)}`); }
      }

      // Mood: unhappy kittens are more likely to seek rest; happy kittens tolerate productive work better.
      // (Still overridden by safety rules + emergencies.)
      if (a === 'Rest' && mood < 0.35) {
        const add = (0.35 - mood) * 45;
        score += add;
        reasons.push(`low mood ${mood.toFixed(2)} → +${add.toFixed(1)} Rest`);
      }

      // Loafing is a "soft strike" / morale recovery action.
      // It becomes attractive when mood is low and especially when dissent is high.
      if (a === 'Loaf') {
        if (mood < 0.55) {
          const add = (0.55 - mood) * 55;
          score += add;
          reasons.push(`needs morale (${mood.toFixed(2)}) → +${add.toFixed(1)}`);
        }
        const dis = dissent01(s);
        if (dis > 0.45) {
          // Under murmurs/strike, some kittens idle/drag their paws unless you restore cohesion.
          const disAdj = (dis - 0.45) * 85 * (1 - 0.55 * discipline01(s));
          score += disAdj;
          reasons.push(`dissent ${(dis*100).toFixed(0)}% → +${disAdj.toFixed(1)}`);
        }
        // If we're actually starving or freezing, loafing should lose hard.
        if (foodPerKitten < targets.foodPerKitten * 0.80) { score -= 45; reasons.push('food emergency → -45'); }
        if (season.name === 'Winter' && s.res.warmth < 35) { score -= 25; reasons.push('winter + cold → -25'); }
      }

      // Socialize is an active cohesion action: lowers dissent (improves plan compliance) and boosts mood.
      // It's strongest when dissent is high, but should lose to real emergencies.
      if (a === 'Socialize') {
        const dis = dissent01(s);
        if (dis > 0.35) {
          const add = Math.min(60, 12 + (dis - 0.35) * 110);
          score += add;
          reasons.push(`dissent ${(dis*100).toFixed(0)}% → +${add.toFixed(1)}`);
        } else {
          score -= 8;
          reasons.push('low dissent → -8');
        }
        if (mood < 0.55) {
          const add = (0.55 - mood) * 40;
          score += add;
          reasons.push(`needs morale (${mood.toFixed(2)}) → +${add.toFixed(1)}`);
        }

        // Buddy need: if you're missing your buddy, Socialize becomes more attractive.
        const need = clamp01(Number(k.buddyNeed ?? 0));
        if (need > 0.55 && buddyOf(s, k)) {
          const add = (need - 0.55) * 48;
          score += add;
          reasons.push(`misses buddy (${Math.round(need*100)}%) → +${add.toFixed(1)}`);
        }

        // If we're in danger, don't chat.
        if (foodPerKitten < targets.foodPerKitten * 0.85) { score -= 40; reasons.push('food pressure → -40'); }
        if (season.name === 'Winter' && s.res.warmth < 35) { score -= 25; reasons.push('winter + cold → -25'); }
        if (s.res.threat > targets.maxThreat * 1.05 || s.signals.ALARM) { score -= 28; reasons.push('threat pressure → -28'); }
        // Small synergy: Discipline makes organizing more effective (less chaotic).
        const dpol = discipline01(s);
        if (dpol > 0.35) {
          const add = (dpol - 0.35) * 18;
          score += add;
          reasons.push(`discipline ${(dpol*100).toFixed(0)}% → +${add.toFixed(1)}`);
        }
      }

      // Care is a paid stability action: trades food+wood for faster mood recovery + dissent reduction.
      // It should only win when you have surplus AND cohesion is the bottleneck.
      if (a === 'Care') {
        const dis = dissent01(s);
        if (dis > 0.30) {
          const add = Math.min(75, 10 + (dis - 0.30) * 120);
          score += add;
          reasons.push(`dissent ${(dis*100).toFixed(0)}% → +${add.toFixed(1)}`);
        } else {
          score -= 10;
          reasons.push('low dissent → -10');
        }

        if (mood < 0.60) {
          const add = (0.60 - mood) * 55;
          score += add;
          reasons.push(`needs morale (${mood.toFixed(2)}) → +${add.toFixed(1)}`);
        }

        // Resource gating: don't burn buffers.
        const fA = Number(foodAvail ?? 0);
        const wA = Number(woodAvail ?? 0);
        if (fA < 10) { score -= 18; reasons.push(`low spare food (${fA.toFixed(1)}) → -18`); }
        if (wA < 6) { score -= 16; reasons.push(`low spare wood (${wA.toFixed(1)}) → -16`); }

        // If we're in danger, stop spending.
        if (foodPerKitten < targets.foodPerKitten * 0.92) { score -= 50; reasons.push('food pressure → -50'); }
        if (season.name === 'Winter' && s.res.warmth < 35) { score -= 28; reasons.push('winter + cold → -28'); }
        if (s.res.threat > targets.maxThreat * 1.05 || s.signals.ALARM) { score -= 25; reasons.push('threat pressure → -25'); }

        // Discipline synergy: institutions make aid more organized.
        const dpol = discipline01(s);
        if (dpol > 0.35) {
          const add = (dpol - 0.35) * 22;
          score += add;
          reasons.push(`discipline ${(dpol*100).toFixed(0)}% → +${add.toFixed(1)}`);
        }
      }

      if (a !== 'Eat' && a !== 'Rest' && a !== 'Loaf' && a !== 'Socialize' && a !== 'Care') {
        const add = (mood - 0.55) * 10; // small
        if (Math.abs(add) >= 1) {
          score += add;
          reasons.push(`mood ${mood.toFixed(2)} → ${add >= 0 ? '+' : ''}${add.toFixed(1)}`);
        }
      }

      // If we were blocked on this exact action very recently (usually due to reserves), penalize it hard
      // so the kitten doesn't keep "trying" a no-op sink.
      if (k._blockedAction === a) {
        score -= 35;
        reasons.push(`blocked last tick → -35`);
      }

      // Anti-thrash: if we recently learned this action is blocked, keep a short cooldown.
      const cd = Number(k.blockedCooldown?.[a] ?? 0) || 0;
      if (cd > 0) {
        const sub = Math.min(38, 18 + cd * 6);
        score -= sub;
        reasons.push(`cooldown(${cd}s) after block → -${sub.toFixed(0)}`);
      }

      // Momentum: staying on a productive task gets a small bonus (pairs with throughput bonus).
      if (a === (k.task ?? '') && a !== 'Eat' && a !== 'Rest' && a !== 'Loaf' && a !== 'Socialize' && a !== 'Care') {
        const mom = momentumMul(k, a);
        if (mom > 1.0001) {
          const add = Math.min(12, (mom - 1) * 55);
          score += add;
          reasons.push(`momentum x${mom.toFixed(2)} → +${add.toFixed(1)}`);
        }
      }

      // Aptitude bias: kittens prefer tasks they are skilled at (emergent specialization).
      // This is a *bias*, not a lock: safety rules, quotas, and shortages can still override.
      const aSkill = skillForAction(a);
      if (aSkill) {
        const lvl = Number(k.skills?.[aSkill] ?? 1);
        const add = Math.min(12, Math.max(0, (lvl - 1) * 1.4));
        if (add >= 0.5) {
          score += add;
          reasons.push(`skill ${aSkill}=${lvl} → +${add.toFixed(1)}`);
        }
        if (topSkill.skill && topSkill.skill === aSkill && topSkill.level >= 3) {
          const add2 = Math.min(6, 1.2 * (topSkill.level - 2));
          score += add2;
          reasons.push(`top skill match → +${add2.toFixed(1)}`);
        }
      }

      // food pressure
      if (a === 'Forage' || a === 'Farm') {
        if (foodPerKitten < targets.foodPerKitten) {
          const deficit = (targets.foodPerKitten - foodPerKitten) / Math.max(1, targets.foodPerKitten);
          const add = clamp01(deficit) * 65;
          score += add;
          reasons.push(`food/kitten ${foodPerKitten.toFixed(1)}<${targets.foodPerKitten} → +${add.toFixed(1)}`);
        }
        if (s.signals.FOOD) { score += 45; reasons.push('FOOD CRISIS → +45'); }
        if (season.name === 'Winter' && a === 'Forage') { score -= 10; reasons.push('winter forage penalty → -10'); }
      }

      // preservation (turn surplus into non-spoiling rations)
      if (a === 'PreserveFood') {
        const n = Math.max(1, s.kittens.length);
        const surplus = s.res.food - targets.foodPerKitten * n * 1.25;
        if (surplus > 0) {
          const add = clamp01(surplus / (targets.foodPerKitten * n)) * 55;
          score += add;
          reasons.push(`surplus food ${surplus.toFixed(1)} → +${add.toFixed(1)}`);
        } else {
          score -= 25;
          reasons.push('no surplus to preserve → -25');
        }
        // Seasonal push: late Fall + Winter want preserved buffers.
        if (season.name === 'Fall' && season.phase >= 0.55) { score += 14; reasons.push('late-Fall stockpile → +14'); }
        if (season.name === 'Winter') { score += 18; reasons.push('winter stability → +18'); }
        // Needs wood, so don't do it when wood is critically low.
        if (s.res.wood < 10) { score -= 22; reasons.push('low wood → -22'); }
        const woodRes = getReserve(s,'wood');
        const foodRes = getReserve(s,'food');
        if (woodRes > 0 && woodAvail <= 0.05) { score -= 65; reasons.push(`blocked by wood reserve (avail ${woodAvail.toFixed(1)}) → -65`); }
        if (foodRes > 0 && foodAvail <= 0.05) { score -= 55; reasons.push(`blocked by food reserve (avail ${foodAvail.toFixed(1)}) → -55`); }
      }

      // warmth pressure
      if (a === 'StokeFire') {
        const winter = season.name === 'Winter';
        const target = targets.warmth + (winter ? 15 : 0);
        if (s.res.warmth < target) {
          const deficit = (target - s.res.warmth) / Math.max(1, target);
          const add = clamp01(deficit) * (winter ? 85 : 55);
          score += add;
          reasons.push(`warmth ${s.res.warmth.toFixed(1)}<${target} → +${add.toFixed(1)}`);
        }
        if (s.res.wood <= 0.5) { score -= 30; reasons.push('no wood → -30'); }
      }

      // threat pressure
      if (a === 'Guard') {
        const tdef = targets.maxThreat;
        if (s.res.threat > tdef) {
          const over = (s.res.threat - tdef) / Math.max(1, tdef);
          const add = clamp01(over) * 90;
          score += add;
          reasons.push(`threat ${s.res.threat.toFixed(1)}>${tdef} → +${add.toFixed(1)}`);
        }
        if (s.signals.ALARM) { score += 40; reasons.push('ALARM → +40'); }
      }

      // construction
      if (a === 'BuildHut') {
        if (pf === 'Housing') { score += 22; reasons.push('project focus: Housing → +22'); }
        else if (pf !== 'Auto' && ['Defense','Industry','Storage'].includes(pf)) { score -= 10; reasons.push('project focus elsewhere → -10'); }
        const cap = housingCap(s);
        if (s.kittens.length >= cap) {
          score += 60;
          reasons.push(`housing cap ${cap} hit → +60`);
        }
        if (foodRes > 0 && s.res.food < foodRes) { score -= 40; reasons.push(`food reserve ${s.res.food.toFixed(1)}<${foodRes} → -40`); }
        // Project focus: finishing a started hut is usually better than swapping off.
        const prog = Number(s._hutProgress ?? 0);
        if (prog > 0 && k.task === 'BuildHut') {
          const remain = Math.max(0, 12 - prog);
          const add = remain <= 4 ? 34 : 16;
          score += add;
          reasons.push(`continue hut (${prog.toFixed(1)}/12) → +${add}`);
        }
        if (s.signals.BUILD) { score += 28; reasons.push('BUILD PUSH → +28'); }
        if (s.res.wood <= 0.5) { score -= 35; reasons.push('no wood → -35'); }
        const woodRes = getReserve(s,'wood');
        // IMPORTANT: if we're at/below reserve, execution will spend 0 wood; penalize so builders don't idle on blocked tasks.
        if (woodRes > 0 && woodAvail <= 0.05) { score -= 55; reasons.push(`blocked by wood reserve (avail ${woodAvail.toFixed(1)}) → -55`); }
        else if (woodRes > 0 && s.res.wood < woodRes) { score -= 45; reasons.push(`wood reserve ${s.res.wood.toFixed(1)}<${woodRes} → -45`); }
      }

      if (a === 'BuildPalisade') {
        if (pf === 'Defense') { score += 22; reasons.push('project focus: Defense → +22'); }
        else if (pf !== 'Auto' && ['Housing','Industry','Storage'].includes(pf)) { score -= 10; reasons.push('project focus elsewhere → -10'); }
        // Project focus: keep a builder on the wall once started.
        const prog = Number(s._palProgress ?? 0);
        if (foodRes > 0 && s.res.food < foodRes) { score -= 40; reasons.push(`food reserve ${s.res.food.toFixed(1)}<${foodRes} → -40`); }
        if (prog > 0 && k.task === 'BuildPalisade') {
          const remain = Math.max(0, 16 - prog);
          const add = remain <= 5 ? 32 : 14;
          score += add;
          reasons.push(`continue palisade (${prog.toFixed(1)}/16) → +${add}`);
        }
        if (s.res.threat > s.targets.maxThreat * 0.9) { score += 40; reasons.push('threat rising → +40'); }
        if (s.signals.ALARM) { score += 20; reasons.push('ALARM → +20'); }
        if (s.res.wood <= 0.5) { score -= 35; reasons.push('no wood → -35'); }
        const woodRes = getReserve(s,'wood');
        if (woodRes > 0 && woodAvail <= 0.05) { score -= 55; reasons.push(`blocked by wood reserve (avail ${woodAvail.toFixed(1)}) → -55`); }
        else if (woodRes > 0 && s.res.wood < woodRes) { score -= 45; reasons.push(`wood reserve ${s.res.wood.toFixed(1)}<${woodRes} → -45`); }
      }

      // storage (granaries): reduces spoilage, makes stockpiling meaningful
      if (a === 'BuildGranary') {
        if (pf === 'Storage') { score += 22; reasons.push('project focus: Storage → +22'); }
        else if (pf !== 'Auto' && ['Housing','Defense','Industry'].includes(pf)) { score -= 10; reasons.push('project focus elsewhere → -10'); }
        const g = s.res.granaries ?? 0;
        if (foodRes > 0 && s.res.food < foodRes) { score -= 35; reasons.push(`food reserve ${s.res.food.toFixed(1)}<${foodRes} → -35`); }
        const want = Math.max(1, Math.floor(s.kittens.length / 6) + 1);
        // Only really matters once you have surplus food to protect.
        const surplus = s.res.food - targets.foodPerKitten * Math.max(1, s.kittens.length) * 1.35;

        // Project focus: if you're already building one, please just finish it.
        const prog = Number(s._granProgress ?? 0);
        if (prog > 0 && k.task === 'BuildGranary') {
          const remain = Math.max(0, 22 - prog);
          const add = remain <= 6 ? 30 : 12;
          score += add;
          reasons.push(`continue granary (${prog.toFixed(1)}/22) → +${add}`);
        }

        if (g < want && surplus > 0) {
          const deficit = (want - g) / Math.max(1, want);
          const add = clamp01(deficit) * 55;
          score += add;
          reasons.push(`granaries ${g}<${want} w/ surplus → +${add.toFixed(1)}`);
        }
        if (season.name === 'Winter') { score += 6; reasons.push('winter stockpile value → +6'); }
        if (s.res.wood < 18) { score -= 18; reasons.push('need wood buffer → -18'); }
        const woodRes = getReserve(s,'wood');
        if (woodRes > 0 && woodAvail <= 0.05) { score -= 55; reasons.push(`blocked by wood reserve (avail ${woodAvail.toFixed(1)}) → -55`); }
        else if (woodRes > 0 && s.res.wood < woodRes) { score -= 45; reasons.push(`wood reserve ${s.res.wood.toFixed(1)}<${woodRes} → -45`); }
      }

      // Workshops: persistent industry building that amplifies crafting + global productivity.
      if (a === 'BuildWorkshop') {
        if (pf === 'Industry') { score += 22; reasons.push('project focus: Industry → +22'); }
        else if (pf !== 'Auto' && ['Housing','Defense','Storage'].includes(pf)) { score -= 10; reasons.push('project focus elsewhere → -10'); }
        const w = s.res.workshops ?? 0;
        const want = Math.max(1, Math.floor(s.kittens.length / 5));

        if (foodRes > 0 && s.res.food < foodRes) { score -= 35; reasons.push(`food reserve ${s.res.food.toFixed(1)}<${foodRes} → -35`); }

        // Only push workshops when we have enough science to not stall unlocks completely.
        const nextUnlockAt = unlockDefs.find(u => !s.seenUnlocks[u.id])?.at ?? Infinity;
        if (s.res.science < Math.min(120, nextUnlockAt * 0.35)) {
          score -= 18;
          reasons.push('science too low to divert to workshop → -18');
        }

        // Project focus: if you're already building one, finish it.
        const prog = Number(s._workProgress ?? 0);
        if (prog > 0 && k.task === 'BuildWorkshop') {
          const remain = Math.max(0, 26 - prog);
          const add = remain <= 7 ? 32 : 14;
          score += add;
          reasons.push(`continue workshop (${prog.toFixed(1)}/26) → +${add}`);
        }

        if (w < want && s.res.wood > 18 && s.res.science > 35) {
          const deficit = (want - w) / Math.max(1, want);
          const add = clamp01(deficit) * 60;
          score += add;
          reasons.push(`workshops ${w}<${want} → +${add.toFixed(1)}`);
        }

        const woodRes = getReserve(s,'wood');
        const sciRes = getReserve(s,'science');
        if (woodRes > 0 && woodAvail <= 0.05) { score -= 65; reasons.push(`blocked by wood reserve (avail ${woodAvail.toFixed(1)}) → -65`); }
        else if (woodRes > 0 && s.res.wood < woodRes) { score -= 55; reasons.push(`wood reserve ${s.res.wood.toFixed(1)}<${woodRes} → -55`); }

        if (sciRes > 0 && sciAvail <= 0.05) { score -= 65; reasons.push(`blocked by science reserve (avail ${sciAvail.toFixed(1)}) → -65`); }
        else if (sciRes > 0 && s.res.science < sciRes) { score -= 55; reasons.push(`science reserve ${s.res.science.toFixed(1)}<${sciRes} → -55`); }

        if (s.res.wood <= 0.5 || s.res.science <= 0.5) { score -= 35; reasons.push('missing wood/science → -35'); }
      }

      // Libraries: persistent research building that amplifies science output.
      if (a === 'BuildLibrary') {
        if (pf === 'Knowledge') { score += 22; reasons.push('project focus: Knowledge → +22'); }
        else if (pf !== 'Auto' && ['Housing','Defense','Industry','Storage'].includes(pf)) { score -= 10; reasons.push('project focus elsewhere → -10'); }

        const l = s.res.libraries ?? 0;
        const want = Math.max(1, Math.floor(s.kittens.length / 7));

        if (foodRes > 0 && s.res.food < foodRes) { score -= 35; reasons.push(`food reserve ${s.res.food.toFixed(1)}<${foodRes} → -35`); }

        // Project focus: if you're already building one, finish it.
        const prog = Number(s._libProgress ?? 0);
        if (prog > 0 && k.task === 'BuildLibrary') {
          const remain = Math.max(0, 30 - prog);
          const add = remain <= 8 ? 34 : 14;
          score += add;
          reasons.push(`continue library (${prog.toFixed(1)}/30) → +${add}`);
        }

        // Only consider libraries when science is healthy (otherwise we should just Research).
        if (s.res.science < 200) {
          score -= 18;
          reasons.push('science too low to divert to library → -18');
        }

        if (l < want && s.res.wood > 22 && s.res.science > 140 && (s.res.tools ?? 0) > 8) {
          const deficit = (want - l) / Math.max(1, want);
          const add = clamp01(deficit) * 58;
          score += add;
          reasons.push(`libraries ${l}<${want} → +${add.toFixed(1)}`);
        }

        const woodRes = getReserve(s,'wood');
        const sciRes = getReserve(s,'science');
        const toolsRes = getReserve(s,'tools');
        if (woodRes > 0 && woodAvail <= 0.05) { score -= 65; reasons.push(`blocked by wood reserve (avail ${woodAvail.toFixed(1)}) → -65`); }
        else if (woodRes > 0 && s.res.wood < woodRes) { score -= 55; reasons.push(`wood reserve ${s.res.wood.toFixed(1)}<${woodRes} → -55`); }

        if (sciRes > 0 && sciAvail <= 0.05) { score -= 65; reasons.push(`blocked by science reserve (avail ${sciAvail.toFixed(1)}) → -65`); }
        else if (sciRes > 0 && s.res.science < sciRes) { score -= 55; reasons.push(`science reserve ${s.res.science.toFixed(1)}<${sciRes} → -55`); }

        if (toolsRes > 0 && toolsAvail <= 0.05) { score -= 65; reasons.push(`blocked by tools reserve (avail ${toolsAvail.toFixed(1)}) → -65`); }
        else if (toolsRes > 0 && (s.res.tools ?? 0) < toolsRes) { score -= 55; reasons.push(`tools reserve ${(s.res.tools ?? 0).toFixed(1)}<${toolsRes} → -55`); }

        if ((s.res.tools ?? 0) < 3) { score -= 35; reasons.push('missing tools → -35'); }
        if (s.res.wood <= 0.5 || s.res.science <= 0.5) { score -= 35; reasons.push('missing wood/science → -35'); }
      }

      // Mentoring: spend science to accelerate skill growth (long-run compounding).
      // This is intentionally a "stable times" task; it should lose to food/warmth/threat emergencies.
      if (a === 'Mentor') {
        const sciRes = getReserve(s,'science');
        if (sciRes > 0 && sciAvail <= 0.05) {
          score -= 65;
          reasons.push(`blocked by science reserve (avail ${sciAvail.toFixed(1)}) → -65`);
        }

        const stableFood = foodPerKitten >= targets.foodPerKitten * 1.02;
        const stableWarmth = (Number(s.res.warmth ?? 0) >= targets.warmth);
        const stableThreat = (Number(s.res.threat ?? 0) <= targets.maxThreat * 0.95);

        // Only do it when you have spare science above reserve.
        if (s.res.science < (sciRes + 40)) {
          score -= 22;
          reasons.push('science buffer too low for mentoring → -22');
        }

        if (mode === 'Advance' && stableFood && stableWarmth && stableThreat) {
          score += 38;
          reasons.push('stable basics + Advance → +38');
        } else if (stableFood && stableWarmth && stableThreat) {
          score += 18;
          reasons.push('stable basics → +18');
        } else {
          score -= 18;
          reasons.push('not stable enough to mentor → -18');
        }

        // Winter: mentoring is indoor and safe, but still avoid it if warmth is low.
        if (season.name === 'Winter' && s.res.warmth >= 45) { score += 8; reasons.push('winter indoor work → +8'); }
      }

      // tools pressure (new midgame sink)
      if (a === 'CraftTools') {
        const t = s.res.tools ?? 0;
        if (foodRes > 0 && s.res.food < foodRes) { score -= 25; reasons.push(`food reserve ${s.res.food.toFixed(1)}<${foodRes} → -25`); }
        const want = s.kittens.length * 10; // tools wear over time; keep a healthier buffer
        if (t < want) {
          const deficit = (want - t) / Math.max(1, want);
          const add = clamp01(deficit) * 65;
          score += add;
          reasons.push(`tools ${t.toFixed(1)}<${want.toFixed(0)} → +${add.toFixed(1)}`);
        }
        if (s.res.wood < 10) { score -= 18; reasons.push('low wood → -18'); }
        if (s.res.science < 15) { score -= 18; reasons.push('low science → -18'); }
        const woodRes = getReserve(s,'wood');
        const sciRes = getReserve(s,'science');
        if (woodRes > 0 && woodAvail <= 0.05) { score -= 65; reasons.push(`blocked by wood reserve (avail ${woodAvail.toFixed(1)}) → -65`); }
        else if (woodRes > 0 && s.res.wood < woodRes) { score -= 55; reasons.push(`wood reserve ${s.res.wood.toFixed(1)}<${woodRes} → -55`); }
        if (sciRes > 0 && sciAvail <= 0.05) { score -= 65; reasons.push(`blocked by science reserve (avail ${sciAvail.toFixed(1)}) → -65`); }
        else if (sciRes > 0 && s.res.science < sciRes) { score -= 55; reasons.push(`science reserve ${s.res.science.toFixed(1)}<${sciRes} → -55`); }
        // In winter, crafting is safer than over-foraging.
        if (season.name === 'Winter') { score += 6; reasons.push('winter indoor work → +6'); }
      }

      // generic needs
      if (a === 'Eat') {
        score += k.hunger * 90;
        reasons.push(`hunger ${k.hunger.toFixed(2)} → +${(k.hunger*90).toFixed(1)}`);
        if (edibleFood(s) <= 0) { score -= 60; reasons.push('no edible food → -60'); }
      }

      if (a === 'Rest') {
        score += tired * 70;
        reasons.push(`tired ${tired.toFixed(2)} → +${(tired*70).toFixed(1)}`);
        if (season.name === 'Winter') { score += 6; reasons.push('winter rest bonus → +6'); }
      }

      if (a === 'ChopWood') {
        // wood pressure: warmth + construction
        let want = 0;
        if (season.name === 'Winter' && s.res.warmth < s.targets.warmth + 10) want += 20;
        if (s.signals.BUILD) want += 15;
        if (s.unlocked.construction && (s.kittens.length >= housingCap(s))) want += 25;
        if (want > 0) { score += want; reasons.push(`wood needed → +${want}`); }
        if (s.res.wood > 80) { score -= 10; reasons.push('wood already high → -10'); }
      }

      if (a !== 'Eat') {
        const pen = Math.max(0, k.hunger - 0.78) * 55;
        if (pen > 0) { score -= pen; reasons.push(`very hungry → -${pen.toFixed(1)}`); }
      }

      // if winter & warmth low, deprioritize research
      if (season.name === 'Winter' && s.res.warmth < 40 && a === 'Research') {
        score -= 25;
        reasons.push('winter + low warmth → -25');
      }

      // food reserve: if we're below buffer, stop "nice to have" tasks
      if (foodRes > 0 && s.res.food < foodRes && (a === 'Research' || a === 'CraftTools')) {
        score -= 45;
        reasons.push(`below food reserve → -45`);
      }

      out.push({ action: a, score, reasons });
    }
    return out;
  }

  function applyPolicyToDesired(s, desired){
    const n = s.kittens.length;
    const m = s.policyMult ?? {};
    const mul = (a) => {
      const v = Number(m[a] ?? 1);
      if (!Number.isFinite(v)) return 1;
      return Math.max(0, Math.min(2, v));
    };

    for (const a of Object.keys(desired)) {
      // Eat/Rest are personal needs; policy doesn't touch them.
      if (a === 'Eat' || a === 'Rest' || a === 'Loaf') continue;
      desired[a] = Math.round(desired[a] * mul(a));
    }

    // Clamp to [0,n]
    for (const a of Object.keys(desired)) desired[a] = Math.max(0, Math.min(n, desired[a] | 0));

    // If over budget, shave least-critical first.
    const shaveOrder = ['Care','Socialize','Research','Mentor','CraftTools','BuildLibrary','BuildWorkshop','BuildGranary','BuildPalisade','BuildHut','PreserveFood','Guard','StokeFire','ChopWood','Farm','Forage'];
    let sum = Object.values(desired).reduce((a,b)=>a+b,0);
    let guard = 0;
    while (sum > n && guard++ < 99) {
      let changed = false;
      for (const a of shaveOrder) {
        if (sum <= n) break;
        if ((desired[a] ?? 0) > 0) {
          desired[a] -= 1;
          sum -= 1;
          changed = true;
        }
      }
      if (!changed) break;
    }

    // If under budget, spend leftovers mostly on Research (unless player set Research multiplier to 0).
    const left = Math.max(0, n - sum);
    const resMul = Number((s.policyMult ?? {}).Research ?? 1);
    if (left > 0 && (Number.isFinite(resMul) ? resMul : 1) > 0) {
      desired.Research = Math.min(n, (desired.Research ?? 0) + left);
    }

    return desired;
  }

  function desiredWorkerPlan(s){
    const n = s.kittens.length;
    const season = seasonAt(s.t);
    const targets = seasonTargets(s);
    const foodPerKitten = ediblePerKitten(s);

    // Director: project focus (a transparent build order nudge)
    const pfInfo = getEffectiveProjectFocus(s);
    const pf = String(pfInfo.focus ?? 'Auto');

    // Start with gentle defaults; plan is *advisory* and can be overridden by scores/rules.
    const desired = {
      Eat: 0,
      Rest: 0,
      Loaf: 0,
      Socialize: 0,
      Care: 0,
      Forage: 0,
      Farm: 0,
      PreserveFood: 0,
      ChopWood: 0,
      StokeFire: 0,
      Guard: 0,
      BuildHut: 0,
      BuildPalisade: 0,
      BuildGranary: 0,
      BuildWorkshop: 0,
      BuildLibrary: 0,
      CraftTools: 0,
      Mentor: 0,
      Research: 0,
    };

    // Food always gets at least 1 worker once pop grows.
    if (n >= 2) {
      const deficit = (targets.foodPerKitten - foodPerKitten) / Math.max(1, targets.foodPerKitten);
      const wantFood = clamp01(deficit);
      const maxFood = Math.max(1, Math.ceil(n * 0.65));
      const baseFood = (foodPerKitten < targets.foodPerKitten) ? (1 + Math.ceil(wantFood * (maxFood-1))) : 1;
      if (s.unlocked.farm) desired.Farm = Math.min(maxFood, Math.max(0, Math.floor(baseFood * 0.55)));
      desired.Forage = Math.min(maxFood, baseFood - desired.Farm);
      if (s.signals.FOOD) desired.Forage = Math.min(maxFood, desired.Forage + 1);
    }

    // Preservation: when we have real surplus, start converting it into jerky (doesn't spoil).
    // This is mainly a winter-prep lever and creates a nice "bank food now, eat later" loop.
    if (s.unlocked.construction) {
      const prep = (season.name === 'Fall' && season.phase >= 0.55) || (season.name === 'Winter');
      const surplus = s.res.food - targets.foodPerKitten * Math.max(1, n) * 1.25;
      if (prep && surplus > 0 && s.res.wood > 10) desired.PreserveFood = Math.min(n, 1);
      if (surplus > targets.foodPerKitten * Math.max(1, n) * 0.55 && s.res.wood > 18) desired.PreserveFood = Math.min(n, Math.max(desired.PreserveFood, 1));
    }

    // Warmth: in winter, keep someone on wood+fire if we're under target.
    const winter = season.name === 'Winter';
    const warmTarget = targets.warmth + (winter ? 15 : 0);
    const warmDef = (warmTarget - s.res.warmth) / Math.max(1, warmTarget);
    if (s.res.warmth < warmTarget) {
      desired.ChopWood = Math.max(desired.ChopWood, 1);
      desired.StokeFire = Math.max(desired.StokeFire, winter ? 1 : 0);
      if (warmDef > 0.4) desired.StokeFire = Math.max(desired.StokeFire, 1);
      if (warmDef > 0.7) desired.ChopWood = Math.max(desired.ChopWood, 2);
    }

    // Threat: keep at least 1 guard once threat is non-trivial; scale up when alarm or over target.
    if (s.res.threat > 25 || s.signals.ALARM) desired.Guard = 1;
    if (s.res.threat > targets.maxThreat || s.signals.ALARM) desired.Guard = Math.min(n, 1 + Math.ceil((s.res.threat - targets.maxThreat) / 30));

    // Cohesion: if dissent is high, plan for 1 kitten to actively socialize/organize.
    // (Trades throughput for compliance; helps prevent slow-motion strikes.)
    const dis = dissent01(s);
    const basicsOk = (foodPerKitten >= targets.foodPerKitten * 0.92) && (Number(s.res.warmth ?? 0) >= targets.warmth - 6) && (Number(s.res.threat ?? 0) <= targets.maxThreat * 1.10);
    if (basicsOk && dis > 0.50) {
      // Prefer paid stability (Care) only when we clearly have surplus.
      const foodSurplus = (s.res.food - getReserve(s,'food')) > targets.foodPerKitten * Math.max(1, n) * 0.15;
      const woodSurplus = (s.res.wood - getReserve(s,'wood')) > 10;
      if (foodSurplus && woodSurplus && dis < 0.72) desired.Care = Math.min(n, 1);
      else desired.Socialize = Math.min(n, 1);
    }

    // Housing/building: if capped or build push, try to allocate builders.
    if (s.unlocked.construction) {
      const cap = housingCap(s);
      if (s.kittens.length >= cap || s.signals.BUILD) desired.BuildHut = Math.min(n, 1 + (s.signals.BUILD ? 1 : 0));
      if (s.signals.ALARM || s.res.threat > s.targets.maxThreat * 0.9) desired.BuildPalisade = Math.min(n, 1);

      // Granary: only allocate labor when we have surplus worth protecting.
      if (s.unlocked.granary) {
        const g = s.res.granaries ?? 0;
        const want = Math.max(1, Math.floor(n / 6) + 1);
        const surplus = s.res.food - targets.foodPerKitten * Math.max(1, n) * 1.35;
        if (g < want && surplus > 0) desired.BuildGranary = Math.min(n, 1);
      }

      // Project Focus: bias toward completing ONE build track.
      // This reduces "half-built everything" and makes emergent specialization (Builder role) feel stickier.
      if (pf !== 'Auto') {
        // Keep emergency defense regardless of focus.
        const emergencyDefense = (s.signals.ALARM || s.res.threat > s.targets.maxThreat * 0.9);

        // Default: stop allocating to other build sinks; scoring/rules can still pick them.
        desired.BuildHut = (pf === 'Housing') ? Math.max(desired.BuildHut, 1) : 0;
        desired.BuildPalisade = (pf === 'Defense' || emergencyDefense) ? Math.max(desired.BuildPalisade, 1) : 0;
        desired.BuildGranary = (pf === 'Storage') ? Math.max(desired.BuildGranary, 1) : 0;
        desired.BuildWorkshop = (pf === 'Industry') ? Math.max(desired.BuildWorkshop, 1) : 0;
        desired.BuildLibrary = (pf === 'Knowledge') ? Math.max(desired.BuildLibrary, 1) : 0;

        // If focus is Housing, keep 2 builders only when hard-capped.
        if (pf === 'Housing' && s.kittens.length >= cap) desired.BuildHut = Math.min(n, Math.max(desired.BuildHut, 2));

        // If focus is Storage but granary not yet unlocked, do nothing special.
        if (pf === 'Storage' && !s.unlocked.granary) desired.BuildGranary = 0;
      }
    }

    // Workshops (persistent building): allocate a builder occasionally in Advance mode.
    if (s.unlocked.construction && s.unlocked.workshop) {
      const w = s.res.workshops ?? 0;
      const want = Math.max(1, Math.floor(n / 5));
      if (w < want && s.mode === 'Advance' && s.res.wood > 28 && s.res.science > 80) desired.BuildWorkshop = Math.min(n, 1);
      // If we're already mid-project, try not to abandon it.
      if ((s._workProgress ?? 0) > 0 && s.mode === 'Advance') desired.BuildWorkshop = Math.min(n, Math.max(desired.BuildWorkshop, 1));

      // Project focus: Industry
      if (pf === 'Industry') desired.BuildWorkshop = Math.min(n, Math.max(desired.BuildWorkshop, 1));
      if (pf !== 'Auto' && pf !== 'Industry') desired.BuildWorkshop = 0;
    }

    // Libraries (persistent building): allocate a builder occasionally in Advance mode.
    if (s.unlocked.construction && s.unlocked.library) {
      const l = s.res.libraries ?? 0;
      const want = Math.max(1, Math.floor(n / 7));
      if (l < want && s.mode === 'Advance' && s.res.wood > 30 && s.res.science > 220 && (s.res.tools ?? 0) > 10) desired.BuildLibrary = Math.min(n, 1);
      // If we're already mid-project, try not to abandon it.
      if ((s._libProgress ?? 0) > 0 && s.mode === 'Advance') desired.BuildLibrary = Math.min(n, Math.max(desired.BuildLibrary, 1));

      // Project focus: Knowledge
      if (pf === 'Knowledge') desired.BuildLibrary = Math.min(n, Math.max(desired.BuildLibrary, 1));
      if (pf !== 'Auto' && pf !== 'Knowledge') desired.BuildLibrary = 0;
    }

    // Workshop/tools: in Advance mode, spend some spare labor turning science+wood into tools (global compounding).
    if (s.unlocked.workshop) {
      const t = s.res.tools ?? 0;
      const want = n * 10;
      if (t < want && s.res.wood > 12 && s.res.science > 25) desired.CraftTools = Math.min(n, 1);
      if (t < want * 0.55 && s.mode === 'Advance' && s.res.wood > 25 && s.res.science > 60) desired.CraftTools = Math.min(n, 2);
    }

    // Mentoring: during stable periods with Library tech, spend science to train lagging skills.
    // This is a long-run compounding lever (specialists get better at the jobs you keep leaning on).
    if (s.unlocked.library && s.mode === 'Advance') {
      const sciRes = getReserve(s,'science');
      const stableWarmth = Number(s.res.warmth ?? 0) >= targets.warmth;
      const stableThreat = Number(s.res.threat ?? 0) <= targets.maxThreat;
      if (stableWarmth && stableThreat && Number(s.res.science ?? 0) > sciRes + 80) {
        desired.Mentor = Math.min(n, 1);
      }
    }

    // Research: fill leftover workers into research in Advance mode; otherwise keep it modest.
    const hardReserved = Object.entries(desired).filter(([a,v]) => ['Forage','Farm','PreserveFood','ChopWood','StokeFire','Guard','BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary','CraftTools','Mentor','Socialize'].includes(a)).reduce((acc,[,v])=>acc+(v||0),0);
    const leftover = Math.max(0, n - hardReserved);
    desired.Research = (s.mode === 'Advance') ? leftover : Math.floor(leftover * 0.5);

    // Reserves: don't allocate workers to sinks if we're below buffer.
    const foodRes = getReserve(s, 'food');
    const woodRes = getReserve(s, 'wood');
    const sciRes = getReserve(s, 'science');
    const toolsRes = getReserve(s, 'tools');

    // If we're below food reserve, prioritize stabilization and pause discretionary sinks.
    if (s.res.food <= foodRes) {
      desired.PreserveFood = 0;
      desired.BuildHut = 0;
      desired.BuildPalisade = 0;
      desired.BuildGranary = 0;
      desired.BuildWorkshop = 0;
      desired.BuildLibrary = 0;
      desired.CraftTools = 0;
      desired.Mentor = 0;
      desired.Research = 0;
      // Nudge extra labor toward food if possible.
      if (s.unlocked.farm) desired.Farm = Math.min(n, Math.max(desired.Farm, 1));
      desired.Forage = Math.min(n, Math.max(desired.Forage, 1));
    }

    if (s.res.wood <= woodRes) {
      desired.PreserveFood = 0;
      desired.BuildHut = 0;
      desired.BuildPalisade = 0;
      desired.BuildGranary = 0;
      desired.BuildWorkshop = 0;
      desired.BuildLibrary = 0;
      desired.CraftTools = 0;
    }
    if (s.res.science <= sciRes) {
      desired.BuildWorkshop = 0;
      desired.BuildLibrary = 0;
      desired.CraftTools = 0;
      desired.Mentor = 0;
    }
    if ((s.res.tools ?? 0) <= toolsRes) {
      desired.BuildLibrary = 0;
    }

    // Clamp everything to [0,n]
    for (const k of Object.keys(desired)) desired[k] = Math.max(0, Math.min(n, desired[k] | 0));

    // Ensure we don't exceed n total by shaving research first.
    let sum = Object.values(desired).reduce((a,b)=>a+b,0);
    if (sum > n) {
      const over = sum - n;
      desired.Research = Math.max(0, desired.Research - over);
      sum = Object.values(desired).reduce((a,b)=>a+b,0);
      if (sum > n) {
        // still over? shave forage next
        const over2 = sum - n;
        desired.Forage = Math.max(0, desired.Forage - over2);
      }
    }

    // Remove invalid actions (locked content)
    if (!s.unlocked.farm) desired.Farm = 0;
    if (!s.unlocked.workshop) desired.CraftTools = 0;
    if (!s.unlocked.library) desired.Mentor = 0;
    if (!(s.unlocked.construction && s.unlocked.workshop)) desired.BuildWorkshop = 0;
    if (!(s.unlocked.construction && s.unlocked.library)) desired.BuildLibrary = 0;
    if (!s.unlocked.granary) desired.BuildGranary = 0;
    if (!s.unlocked.construction) { desired.PreserveFood = 0; desired.BuildHut = 0; desired.BuildPalisade = 0; desired.BuildGranary = 0; desired.BuildWorkshop = 0; desired.BuildLibrary = 0; }

    const desiredBase = { ...desired }; // before policy multipliers
    applyPolicyToDesired(s, desired);
    return { desired, desiredBase, assigned: Object.create(null) };
  }

  function applyPlanPressure(scored, plan){
    if (!plan) return;

    // Social layer: dissent reduces obedience to the central plan; discipline restores it.
    const comp = compliance01(state);

    for (const row of scored) {
      const a = row.action;
      const want = plan.desired[a] ?? 0;
      const have = plan.assigned[a] ?? 0;
      if (want <= 0) continue;

      const need = want - have;
      // Underfilled tasks get a strong but bounded bonus; overfilled get a mild penalty.
      if (need > 0) {
        const add0 = Math.min(26, 10 + need * 9);
        const add = add0 * comp;
        row.score += add;
        row.reasons.push(`plan need ${have}/${want} → +${add.toFixed(0)}` + (comp < 0.95 ? ` (compliance x${comp.toFixed(2)})` : ''));
      } else {
        const sub0 = Math.min(18, 6 + (-need) * 6);
        const sub = sub0 * comp;
        row.score -= sub;
        row.reasons.push(`plan full ${have}/${want} → -${sub.toFixed(0)}` + (comp < 0.95 ? ` (compliance x${comp.toFixed(2)})` : ''));
      }
    }
  }

  function housingCap(s){
    return 3 + s.res.huts * 2;
  }

  function foodStorageCap(s){
    // Soft cap: above this, spoilage accelerates (see tickPressures).
    // Purpose: make Granaries + PreserveFood (jerky) an actual midgame loop.
    const huts = Math.max(0, Number(s.res?.huts ?? 0));
    const gran = Math.max(0, Number(s.res?.granaries ?? 0));
    const base = 260;
    return base + huts * 90 + gran * 260;
  }

  // --- Civ pressures
  function applyUnlocks(){
    for (const u of unlockDefs) {
      if (state.seenUnlocks[u.id]) continue;
      if (state.res.science >= u.at) {
        state.seenUnlocks[u.id] = true;
        u.apply(state);
        log(`UNLOCK: ${u.name} (science ≥ ${u.at})`);
      }
    }
  }

  function tickPressures(dt){
    const season = seasonAt(state.t);

    // Season transition log (explainability): one clean ping when the season flips.
    // This helps players connect "why did outputs change" to the seasonal model.
    state._lastSeasonName = state._lastSeasonName ?? season.name;
    if (state._lastSeasonName !== season.name) {
      const from = state._lastSeasonName;
      state._lastSeasonName = season.name;

      const msg = (season.name === 'Winter')
        ? 'Season change → Winter. Warmth decays faster and Forage output drops; keep warmth ≥ target and consider PreserveFood (jerky) + Granaries.'
        : (season.name === 'Spring')
          ? 'Season change → Spring. Forage penalties ease; you can pivot back toward Research/Industry once stable.'
          : (season.name === 'Fall')
            ? 'Season change → Fall. Late-Fall increases prep targets (food+warmth); start stockpiling before Winter.'
            : 'Season change → Summer. Best time to build up science and long-run infrastructure.';

      log(msg + (from ? ` (from ${from})` : ''));
    }

    // Seasonal telegraphing (warnings you can react to)
    state._seasonWarn = state._seasonWarn ?? { winterPrep:false, springSoon:false };
    if (season.name === 'Fall' && season.phase >= 0.70) {
      if (!state._seasonWarn.winterPrep) {
        state._seasonWarn.winterPrep = true;
        log('Winter is coming soon. Consider stockpiling food/wood and raising warmth (Fall prep targets engage).');
      }
    } else {
      state._seasonWarn.winterPrep = false;
    }
    if (season.name === 'Winter' && season.phase >= 0.70) {
      if (!state._seasonWarn.springSoon) {
        state._seasonWarn.springSoon = true;
        log('Spring is near. Forage penalties ease soon; you can shift back toward research/expansion.');
      }
    } else {
      state._seasonWarn.springSoon = false;
    }

    // Director automation: optional auto-toggle for Winter Prep.
    // Goal: reduce micro without hiding the policy changes (it literally presses the same Winter Prep toggle).
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, curfew:false, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoBuildPush:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', autoRecruit:false, autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    if (!('crisis' in state.director)) state.director.crisis = false;
    if (!('crisisSaved' in state.director)) state.director.crisisSaved = null;
    if (!('curfew' in state.director)) state.director.curfew = false;
    if (!('autoWinterPrep' in state.director)) state.director.autoWinterPrep = false;
    if (!('autoFoodCrisis' in state.director)) state.director.autoFoodCrisis = false;
    if (!('autoReserves' in state.director)) state.director.autoReserves = false;
    if (!('autoBuildPush' in state.director)) state.director.autoBuildPush = false;
    if (!('autoMode' in state.director)) state.director.autoMode = false;
    if (!('autoModeNextChangeAt' in state.director)) state.director.autoModeNextChangeAt = 0;
    if (!('autoModeWhy' in state.director)) state.director.autoModeWhy = '';
    if (!('autoDoctrine' in state.director)) state.director.autoDoctrine = false;
    if (!('autoDoctrineNextChangeAt' in state.director)) state.director.autoDoctrineNextChangeAt = 0;
    if (!('autoDoctrineWhy' in state.director)) state.director.autoDoctrineWhy = '';
    if (!('autoRations' in state.director)) state.director.autoRations = false;
    if (!('autoRationsNextChangeAt' in state.director)) state.director.autoRationsNextChangeAt = 0;
    if (!('autoRationsWhy' in state.director)) state.director.autoRationsWhy = '';
    if (!('autoRecruit' in state.director)) state.director.autoRecruit = false;
    if (!('autoCrisis' in state.director)) state.director.autoCrisis = false;
    if (!('autoCrisisTriggered' in state.director)) state.director.autoCrisisTriggered = false;
    if (!('autoCrisisNextChangeAt' in state.director)) state.director.autoCrisisNextChangeAt = 0;
    if (!('autoCrisisWhy' in state.director)) state.director.autoCrisisWhy = '';
    if (!('recruitYear' in state.director)) state.director.recruitYear = -1;
    if (!('projectFocus' in state.director)) state.director.projectFocus = 'Auto';
    if (!('autonomy' in state.director)) state.director.autonomy = 0.60;
    if (!('discipline' in state.director)) state.director.discipline = 0.40;
    if (!('workPace' in state.director)) state.director.workPace = 1.00;
    if (!('doctrine' in state.director)) state.director.doctrine = 'Balanced';
    if (!('prioFood' in state.director)) state.director.prioFood = 1.00;
    if (!('prioSafety' in state.director)) state.director.prioSafety = 1.00;
    if (!('prioProgress' in state.director)) state.director.prioProgress = 1.00;
    state.director.autonomy = clamp01(Number(state.director.autonomy ?? 0.60));
    state.director.discipline = clamp01(Number(state.director.discipline ?? 0.40));
    state.director.workPace = Math.max(0.8, Math.min(1.2, Number(state.director.workPace ?? 1.00) || 1.00));
    state.director.prioFood = Math.max(0.50, Math.min(1.50, Number(state.director.prioFood ?? 1.00) || 1.00));
    state.director.prioSafety = Math.max(0.50, Math.min(1.50, Number(state.director.prioSafety ?? 1.00) || 1.00));
    state.director.prioProgress = Math.max(0.50, Math.min(1.50, Number(state.director.prioProgress ?? 1.00) || 1.00));

    // --- Social pressure: Dissent
    // Emergent behavior layer: when mood is low and policy is harsh, kittens become less compliant.
    // Discipline restores compliance but has a morale cost (see updateMoodPerSecond).
    state.social = state.social ?? { dissent: 0, band: 'calm', lastLogBand: '', lastLogAt: 0 };
    if (!('dissent' in state.social)) state.social.dissent = 0;
    if (!('band' in state.social)) state.social.band = 'calm';
    if (!('lastLogBand' in state.social)) state.social.lastLogBand = '';
    if (!('lastLogAt' in state.social)) state.social.lastLogAt = 0;

    state._dissentTimer = (state._dissentTimer ?? 0) + dt;
    if (state._dissentTimer >= 1) {
      state._dissentTimer = 0;

      const n = Math.max(1, state.kittens.length);
      const avgMood = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc + clamp01(Number(k.mood ?? 0.55)),0) / n) : 0.55;
      const wp = workPaceMul(state);
      const rat = getRations(state);
      const hungerStress = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc + clamp01(Number(k.hunger ?? 0)),0) / n) : 0;
      const avgGriev = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc + clamp01(Number(k.grievance ?? 0)),0) / n) : 0;
      const alarmStress = state.signals?.ALARM ? 1 : 0;

      // Desired dissent is intentionally coarse: it responds to "this feels bad" signals.
      // avgMood below ~0.55 drives it up; higher work pace + tight rations drive it up.
      // Track a breakdown for explainability (shown in Social Inspector).
      // NOTE: these are *pressures* that get smoothed into the actual dissent meter.
      const moodPressure = Math.max(0, 0.55 - avgMood) * 1.6;      // mood is the biggest driver
      const workPressure = Math.max(0, (wp - 1)) * 0.9;            // overwork
      const rationPressure = (rat.foodUse < 0.95 ? 0.08 : rat.foodUse > 1.05 ? -0.06 : 0);
      const hungerPressure = Math.max(0, hungerStress - 0.55) * 0.25; // persistent hunger
      const grievancePressure = Math.max(0, avgGriev - 0.20) * 0.65; // resentment spills into politics
      const alarmPressure = alarmStress * 0.06;
      const curfewPressure = (state.director?.curfew ? 0.045 : 0);

      let desire = 0;
      desire += moodPressure;
      desire += workPressure;
      desire += rationPressure;
      desire += hungerPressure;
      desire += grievancePressure;
      desire += alarmPressure;
      desire += curfewPressure;

      const rawDesire = desire;

      // Discipline reduces how quickly dissent forms (but never to zero).
      const disPol = discipline01(state);
      desire *= (1 - 0.45 * disPol);

      // Doctrine: specialization can feel "rigid" (a bit more grumbling); rotation tends to relieve pressure.
      const doc = doctrineKey(state);
      if (doc === 'Specialize') desire += 0.03;
      if (doc === 'Rotate') desire -= 0.05;

      const desireAfterPolicy = desire;

      const target = clamp01(desire);
      const cur = clamp01(Number(state.social.dissent ?? 0));
      const next = cur + (target - cur) * 0.045; // smoothing (≈ 20-25s to swing hard)
      state.social.dissent = clamp01(next);

      // Snapshot for Social Inspector (transient, not saved).
      state._dissentDrivers = {
        at: state.t,
        avgMood, hungerStress, avgGriev,
        workPace: wp,
        rationsLabel: String(rat.label ?? state.rations ?? 'Normal'),
        alarmStress,
        curfew: !!state.director?.curfew,
        moodPressure, workPressure, rationPressure, hungerPressure, grievancePressure, alarmPressure, curfewPressure,
        rawDesire,
        desireAfterPolicy,
        cur, next,
      };

      // Council effect: during a council, dissent decays faster (cohesion boost).
      if (councilActive(state)) state.social.dissent = clamp01(state.social.dissent * 0.93);

      // Banding + explainable log events on crossing.
      const dis = state.social.dissent;
      const band = (dis >= 0.70) ? 'strike' : (dis >= 0.45) ? 'murmur' : 'calm';
      state.social.band = band;

      const now = Number(state.t ?? 0);
      const cooldown = 22;
      if (band !== state.social.lastLogBand && (now - Number(state.social.lastLogAt ?? 0)) > cooldown) {
        state.social.lastLogBand = band;
        state.social.lastLogAt = now;
        if (band === 'murmur') log('Murmurs of dissent: kittens are less compliant with the plan (consider easing work pace, improving rations, or raising Discipline).');
        if (band === 'strike') log('Work slowdown: dissent is high - kittens wander/rotate more and central planning weakens until conditions improve.');
        if (band === 'calm') log('Cohesion restored: dissent falls; the colony follows the plan more reliably again.');
      }
    }

    if (state.director.autoWinterPrep) {
      // Turn ON in late Fall (stockpile window) and keep it through Winter.
      if (!state.director.winterPrep && season.name === 'Fall' && season.phase >= 0.60) {
        log('Auto Winter Prep: turning ON (late Fall).');
        setWinterPrep(true);
      }
      // Turn OFF once Spring is underway (so you naturally shift back to growth policies).
      if (state.director.winterPrep && season.name === 'Spring' && season.phase >= 0.15) {
        log('Auto Winter Prep: turning OFF (Spring).');
        setWinterPrep(false);
      }
    }

    // Director automation: optional auto FOOD CRISIS.
    // Goal: prevent silent starvation spirals by raising the FOOD signal when food/kitten drops too low.
    // It toggles OFF once the colony is clearly stabilized.
    if (state.director.autoFoodCrisis) {
      const targets = seasonTargets(state);
      const foodPerKitten = ediblePerKitten(state);
      const onAt = targets.foodPerKitten * 0.75;
      const offAt = targets.foodPerKitten * 0.95;
      if (!state.signals.FOOD && foodPerKitten < onAt) {
        state.signals.FOOD = true;
        log(`Auto Food Crisis: ON (food/kitten ${foodPerKitten.toFixed(1)} < ${onAt.toFixed(1)})`);
      }
      if (state.signals.FOOD && foodPerKitten > offAt) {
        state.signals.FOOD = false;
        log(`Auto Food Crisis: OFF (food/kitten ${foodPerKitten.toFixed(1)} > ${offAt.toFixed(1)})`);
      }
    }

    // Director automation: optional auto RATIONS.
    // Goal: reduce micro by switching Tight/Normal/Feast based on obvious stability + cohesion signals.
    // Uses a cooldown so it doesn't flap every second.
    if (state.director.autoRations) {
      state._autoRationsTimer = (state._autoRationsTimer ?? 0) + dt;
      if (state._autoRationsTimer >= 1) {
        state._autoRationsTimer = 0;

        state.director.autoRationsNextChangeAt = Number(state.director.autoRationsNextChangeAt ?? 0) || 0;
        if (state.t >= state.director.autoRationsNextChangeAt) {
          const choice = chooseAutoRations(state);
          const cur = String(state.rations ?? 'Normal');
          if (choice?.rations && choice.rations !== cur) {
            state.rations = choice.rations;
            state.director.autoRationsWhy = choice.why || '';
            log(`Auto Rations: ${choice.rations} (${choice.why || 'auto'})`);
            state.director.autoRationsNextChangeAt = state.t + 14;
          } else {
            // Keep reason fresh even if we didn't change.
            state.director.autoRationsWhy = choice?.why || state.director.autoRationsWhy || '';
          }
        }
      }
    }

    // Director automation: optional auto CRISIS.
    // Goal: in real spirals, hit the big red button for you, then let you recover back to your prior policy stack.
    // Important: auto-crisis will only auto-disable if *it* enabled crisis (so manual crisis doesn't get turned off behind your back).
    if (state.director.autoCrisis) {
      state._autoCrisisTimer = (state._autoCrisisTimer ?? 0) + dt;
      if (state._autoCrisisTimer >= 1) {
        state._autoCrisisTimer = 0;

        state.director.autoCrisisNextChangeAt = Number(state.director.autoCrisisNextChangeAt ?? 0) || 0;
        if (state.t >= state.director.autoCrisisNextChangeAt) {
          const targets = seasonTargets(state);
          const n = Math.max(1, state.kittens.length);
          const foodPerKitten = ediblePerKitten(state);
          const warmth = Number(state.res.warmth ?? 0);
          const threat = Number(state.res.threat ?? 0);
          const season = seasonAt(state.t);

          // Clear, explainable triggers (avoid hair-trigger flips).
          const starving = foodPerKitten < targets.foodPerKitten * 0.70;
          const coldSpiral = (season.name === 'Winter') ? (warmth < targets.warmth - 14) : (warmth < targets.warmth - 22);
          const raidSpiral = threat > targets.maxThreat * 1.35;

          const bad = starving || coldSpiral || raidSpiral;
          const why = starving ? `food/kitten ${foodPerKitten.toFixed(1)} < ${(targets.foodPerKitten * 0.70).toFixed(0)}`
            : coldSpiral ? `warmth ${fmt(warmth)} < ${(targets.warmth - (season.name === 'Winter' ? 14 : 22)).toFixed(0)}`
            : raidSpiral ? `threat ${fmt(threat)} > ${(targets.maxThreat * 1.35).toFixed(0)}`
            : '';

          const good = (foodPerKitten >= targets.foodPerKitten * 0.98) && (warmth >= targets.warmth - 2) && (threat <= targets.maxThreat * 0.92);

          if (!state.director.crisis && bad) {
            state.director.autoCrisisWhy = why;
            log(`Auto Crisis: ON (${why})`);
            setCrisisProtocol(true);
            state.director.autoCrisisTriggered = true;
            state.director.autoCrisisNextChangeAt = state.t + 22;
          }

          if (state.director.crisis && state.director.autoCrisisTriggered && good) {
            log('Auto Crisis: OFF (stabilized).');
            setCrisisProtocol(false);
            state.director.autoCrisisTriggered = false;
            state.director.autoCrisisWhy = '';
            state.director.autoCrisisNextChangeAt = state.t + 22;
          }
        }
      }
    }

    // Director automation: optional auto RECRUIT (Spring immigration).
    // Goal: make growth feel more like a civ sim (kittens show up when things are going well) without making it "free".
    if (state.director.autoRecruit) {
      state._autoRecruitTimer = (state._autoRecruitTimer ?? 0) + dt;
      if (state._autoRecruitTimer >= 1) {
        state._autoRecruitTimer = 0;

        const yr = yearAt(state.t);
        const cap = housingCap(state);
        const hasHousing = state.kittens.length < cap;
        const targets = seasonTargets(state);
        const foodPerKitten = ediblePerKitten(state);
        const avgMood = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc + clamp01(Number(k.mood ?? 0.55)),0) / state.kittens.length) : 0.55;

        // Conditions are intentionally strict to avoid "win-more" runaway:
        // - Only once per year, during Spring
        // - Must be stable on basics (surplus food, low threat, decent mood)
        const inSpring = (season.name === 'Spring' && season.phase >= 0.06 && season.phase <= 0.80);
        const stableFood = (foodPerKitten >= targets.foodPerKitten * 1.08);
        const stableThreat = (state.res.threat <= targets.maxThreat * 0.92);
        const stableMood = (avgMood >= 0.56);

        // Cost scales lightly with population so manual kitten-buy stays relevant.
        const pop = Math.max(1, state.kittens.length);
        const cost = Math.round((28 + Math.floor(pop / 5) * 4) / 2) * 2; // 28,32,36,...

        if (inSpring && hasHousing && yr !== Number(state.director.recruitYear ?? -1) && stableFood && stableThreat && stableMood) {
          // Respect food reserve (director won't "immigrate" below your buffer).
          const minFoodAfter = getReserve(state,'food');
          if ((state.res.food - cost) >= minFoodAfter) {
            state.res.food -= cost;
            const id = state.kittens.length ? Math.max(...state.kittens.map(k=>k.id))+1 : 1;
            state.kittens.push(makeKitten(id));
            state.director.recruitYear = yr;
            log(`A stray kitten joined this Spring! (-${cost} food) Population: ${state.kittens.length}/${cap}`);
          }
        }
      }
    }

    // Director automation: optional auto-tuning for reserves.
    // Goal: make the "Reserves" system usable without constant babysitting.
    // We adjust buffers slowly (1s cadence) based on season + population + unlocked sinks.
    if (state.director.autoReserves) {
      state._autoResTimer = (state._autoResTimer ?? 0) + dt;
      if (state._autoResTimer >= 1) {
        state._autoResTimer = 0;

        const rec = recommendedReserves(state);
        const recFood = rec.food;
        const recWood = rec.wood;
        const recSci = rec.science;
        const recTools = rec.tools;

        state.reserve = state.reserve ?? { food:0, wood:18, science:25, tools:0 };

        const prev = { food: getReserve(state,'food'), wood: getReserve(state,'wood'), science: getReserve(state,'science'), tools: getReserve(state,'tools') };

        state.reserve.food = recFood;
        state.reserve.wood = recWood;
        state.reserve.science = recSci;
        state.reserve.tools = recTools;

        // Only log when it actually changed meaningfully (avoid spam).
        const changed = (Math.abs(prev.food - recFood) >= 10) || (Math.abs(prev.wood - recWood) >= 2) || (Math.abs(prev.science - recSci) >= 5) || (Math.abs(prev.tools - recTools) >= 5);
        if (changed) {
          log(`Auto Reserves: food≥${recFood}, wood≥${recWood}, science≥${recSci}, tools≥${recTools}`);
        }
      }
    }

    // Director automation: optional auto BUILD PUSH.
    // Goal: when housing-capped, keep huts moving without constant manual toggling.
    if (state.director.autoBuildPush) {
      state._autoBuildTimer = (state._autoBuildTimer ?? 0) + dt;
      if (state._autoBuildTimer >= 1) {
        state._autoBuildTimer = 0;

        const cap = housingCap(state);
        const pop = state.kittens?.length ?? 0;
        const should = pop >= cap;
        if (should && !state.signals.BUILD) {
          state.signals.BUILD = true;
          log(`Auto Build Push: ON (housing capped ${pop}/${cap})`);
        }
        if (!should && state.signals.BUILD) {
          state.signals.BUILD = false;
          log('Auto Build Push: OFF (housing available).');
        }
      }
    }

    // Director automation: optional auto DRILLS.
    // Goal: reduce micro by running Defense Drills when threat is trending toward dangerous levels,
    // but only if the colony is otherwise stable and you can afford the spend above reserves.
    // Drills are timed, so auto-drills simply fires them when appropriate (no toggle-off needed).
    if (state.director.autoDrills) {
      state._autoDrillsTimer = (state._autoDrillsTimer ?? 0) + dt;
      if (state._autoDrillsTimer >= 1) {
        state._autoDrillsTimer = 0;

        state.director.autoDrillsNextAt = Number(state.director.autoDrillsNextAt ?? 0) || 0;
        if (!drillActive(state) && state.t >= state.director.autoDrillsNextAt) {
          const targets = seasonTargets(state);
          const season = seasonAt(state.t);
          const foodPerKitten = ediblePerKitten(state);
          const warmth = Number(state.res.warmth ?? 0);
          const threat = Number(state.res.threat ?? 0);

          const basicsOk = (foodPerKitten >= targets.foodPerKitten * 0.92) && (warmth >= targets.warmth - (season.name === 'Winter' ? 6 : 10));
          const threatRising = (threat >= targets.maxThreat * 0.88) || (state.signals?.ALARM) || (threat >= 85);

          // Only drill when it's a *good idea* and not in the middle of a collapse.
          if (basicsOk && threatRising && canRunDrills(state)) {
            const res = runDrills(state);
            if (res?.ok) {
              state.director.autoDrillsWhy = `trigger: threat ${fmt(threat)} / max ${targets.maxThreat}`;
              log(`Auto Drills: ON (${state.director.autoDrillsWhy})`);
            }
            // Cooldown either way; don't spam attempts every second.
            state.director.autoDrillsNextAt = state.t + 55;
          } else {
            // Keep a readable why for the Season panel.
            if (!basicsOk) state.director.autoDrillsWhy = 'waiting: basics not stable (food/warmth)';
            else if (!threatRising) state.director.autoDrillsWhy = 'waiting: threat not high';
            else if (!canRunDrills(state)) state.director.autoDrillsWhy = 'waiting: not enough food+wood above reserves';
          }
        }
      }
    }

    // Director automation: optional auto-mode switching.
    // Goal: reduce micro by picking Survive/Expand/Defend/Advance based on obvious stability signals.
    // It respects Crisis Protocol (manual) and only changes occasionally to avoid flapping.
    if (state.director.autoMode && !state.director.crisis) {
      state._autoModeTimer = (state._autoModeTimer ?? 0) + dt;
      if (state._autoModeTimer >= 1) {
        state._autoModeTimer = 0;

        // Guard against mode-flapping: require a small cooldown between switches.
        state.director.autoModeNextChangeAt = Number(state.director.autoModeNextChangeAt ?? 0) || 0;
        if (state.t >= state.director.autoModeNextChangeAt) {
          const choice = chooseAutoMode(state);
          state.director.autoModeWhy = choice.why;
          if (choice.mode && choice.mode !== state.mode) {
            setModeCore(choice.mode, `Auto Mode: ${choice.why}`);
            state.director.autoModeNextChangeAt = state.t + 15;
          }
        }
      }
    }

    // Director automation: optional auto-doctrine switching.
    // Goal: let the colony "self-correct" its specialization/rotation based on cohesion.
    // Rotate when dissent is high; Specialize when calm (more momentum + output); otherwise Balanced.
    if (state.director.autoDoctrine && !state.director.crisis) {
      state._autoDocTimer = (state._autoDocTimer ?? 0) + dt;
      if (state._autoDocTimer >= 1) {
        state._autoDocTimer = 0;

        state.director.autoDoctrineNextChangeAt = Number(state.director.autoDoctrineNextChangeAt ?? 0) || 0;
        if (state.t >= state.director.autoDoctrineNextChangeAt) {
          const choice = chooseAutoDoctrine(state);
          state.director.autoDoctrineWhy = choice.why;
          const cur = doctrineKey(state);
          if (choice.doctrine && choice.doctrine !== cur) {
            state.director.doctrine = choice.doctrine;
            log(`Auto Doctrine: ${choice.doctrine} (${choice.why})`);
            state.director.autoDoctrineNextChangeAt = state.t + 18;
          }
        }
      }
    }

    // Security gate: ALARM can't exist before the unlock (prevents hidden magic-buffs).
    if (!state.unlocked.security) state.signals.ALARM = false;

    // Food spoilage (reduced by granary tech + built granaries)
    // NEW: soft storage cap. If food is far above storage capacity, spoilage accelerates.
    // This makes granaries + jerky preservation feel meaningfully incremental.
    const baseSpoil = 0.006;
    const techReduce = state.unlocked.granary ? 0.15 : 0; // small baseline improvement
    const built = Math.max(0, state.res.granaries ?? 0);
    const builtReduce = Math.min(0.60, built * 0.18); // stacking reduction
    let spoil = Math.max(0.0015, baseSpoil * (1 - techReduce - builtReduce));

    const foodCap = foodStorageCap(state);
    const food = Number(state.res.food ?? 0);
    if (foodCap > 0 && food > foodCap) {
      const over = (food - foodCap) / foodCap; // 0..∞
      const mult = Math.min(4.0, 1 + over * 2.2); // up to 4× spoil
      spoil *= mult;
      state._lastFoodOvercap = { cap: foodCap, food, mult };
    } else {
      state._lastFoodOvercap = { cap: foodCap, food, mult: 1 };
    }

    state.res.food = Math.max(0, food - food * spoil * dt);

    // Warmth decay; faster in winter
    const decay = season.name === 'Winter' ? 0.55 : 0.28;
    state.res.warmth = Math.max(0, state.res.warmth - decay * dt);

    // Threat growth; reduced by palisade, by security unlock, and optionally by Curfew policy.
    const baseGrowth = state.unlocked.security ? 0.34 : 0.44;
    const palReduce = Math.min(0.28, state.res.palisade * 0.02);
    const curfewMul = state.director?.curfew ? 0.75 : 1.00;
    const drillMul = drillActive(state) ? 0.86 : 1.00;
    state.res.threat = Math.min(120, state.res.threat + (baseGrowth * (1 - palReduce) * curfewMul * drillMul) * dt);

    // Tools wear (adds a maintenance loop once Workshop exists)
    // Tools represent shared implements; they get dull/break over time.
    // This keeps CraftTools relevant and creates a natural "maintain vs expand" tension.
    if (state.unlocked.workshop) {
      const n = state.kittens.length;
      const winter = season.name === 'Winter';
      const wearPerKitten = winter ? 0.008 : 0.006; // tools / sec / kitten
      const wear = wearPerKitten * n * dt;
      state.res.tools = Math.max(0, (state.res.tools ?? 0) - wear);
    }

    // If warmth is low in winter, everyone gets more tired/hungry (makes winter real)
    if (season.name === 'Winter' && state.res.warmth < 35) {
      // Cold stress causes sickness/injury over time.
      // Explainability: this is the main driver of "health" decline.
      const cold = clamp01((35 - state.res.warmth) / 35);
      for (const k of state.kittens) {
        k.energy = clamp01(k.energy - dt * 0.008);
        k.hunger = clamp01(k.hunger + dt * 0.010);
        k.health = clamp01((k.health ?? 1) - dt * (0.004 + 0.010 * cold));
      }
    }

    // Housing overcrowding tax
    const cap = housingCap(state);
    if (state.kittens.length > cap) {
      for (const k of state.kittens) {
        k.energy = clamp01(k.energy - dt * 0.010);
        k.hunger = clamp01(k.hunger + dt * 0.006);
      }
    }

    // Threat telegraphing (helps explainability + makes "security" feel real)
    // One-time warning when raiders are gathering; auto-raises ALARM only after Security is unlocked.
    if (state.res.threat >= 85 && !state._threatWarned) {
      state._threatWarned = true;
      log('Scouts report raiders gathering nearby (threat ≥ 85).');
      if (state.unlocked.security) state.signals.ALARM = true;
    }
    if (state.res.threat < 60) state._threatWarned = false;

    // Raid event
    state._raidTimer = (state._raidTimer ?? 0) + dt;
    if (state._raidTimer >= 1) {
      state._raidTimer = 0;
      if (state.res.threat >= 100) {
        state.res.threat = Math.max(20, state.res.threat - 35);
        const stealFood = Math.min(state.res.food, 35 + Math.random()*30);
        const stealWood = Math.min(state.res.wood, 15 + Math.random()*20);
        state.res.food -= stealFood;
        state.res.wood -= stealWood;
        // hurt: raise hunger a bit + add injury (health)
        for (const k of state.kittens) {
          k.hunger = clamp01(k.hunger + 0.08);
          k.health = clamp01((k.health ?? 1) - (0.07 + Math.random()*0.06));
        }
        log(`RAID! Lost ${fmt(stealFood)} food + ${fmt(stealWood)} wood. Injuries reported.`);
        // auto alarm (only once you know what "ALARM" means)
        state.signals.ALARM = state.unlocked.security ? true : false;
      }
    }

    // Auto-clear alarm if safe
    if (state.signals.ALARM && state.res.threat < state.targets.maxThreat * 0.7) {
      state.signals.ALARM = false;
    }
  }

  // --- Simulation
  function step(dt){
    state.t += dt;

    applyUnlocks();
    tickPressures(dt);

    state._decTimer = (state._decTimer ?? 0) + dt;
    if (state._decTimer >= 1) {
      state._decTimer -= 1;
      ensureBuddies(state);

      // Explainability: reset per-second blocked-action counters (populated by doFallback during execution).
      state._blockedThisSecond = Object.create(null);
      state._blockedMsgThisSecond = Object.create(null);

      const plan = desiredWorkerPlan(state);
      updateRoles(state, plan);

      // Planning-time reservations: keep later kittens from piling onto the same scarce-input sink.
      const shadowAvail = makeShadowAvail(state);
      const ctx = { shadowAvail };

      // Explainability: track what kind of decision dominated lately (rules vs emergencies vs commits vs normal scoring).
      const decisionKinds = { rule:0, emergency:0, commit:0, score:0 };

      // Decide in a stable order, but let needs/emergencies override plan.
      for (const k of state.kittens) {
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
        const d = decideTask(state, k, plan, ctx);

        // Mood update (1s cadence) so the colony feels a bit more "alive".
        updateMoodPerSecond(state, k, d.task);

        // Grievance update (1s cadence): slow-burn resentment that can translate into dissent.
        updateGrievancePerSecond(state, k, d.task);

        // Relationship pressure (buddy system): small emergent social texture.
        updateBuddyNeedPerSecond(state, k, d.task);

        // Memory: track how long we've been doing the same job (1s resolution)
        k.taskStreak = (prevTask === d.task) ? ((k.taskStreak ?? 0) + 1) : 0;

        // If we switched tasks, start a short commitment window.
        if (prevTask !== d.task) {
          k.taskLock = commitSecondsForTask(state, d.task);
        }

        k.task = d.task;
        k.why = d.why;
        plan.assigned[d.task] = (plan.assigned[d.task] ?? 0) + 1;

        // Decision mix (explainability)
        const kind = String(k._lastDecision?.kind ?? 'score');
        if (kind in decisionKinds) decisionKinds[kind] += 1;
        else decisionKinds.score += 1;

        // Reserve estimated scarce inputs for this task so later kittens see reduced availability.
        reserveForTask(shadowAvail, d.task);
      }
      plan.decisionKinds = decisionKinds;

      // Attach last-second execution blockers so Plan debug can surface reserve/input stalls.
      plan.blocked = { ...(state._blockedThisSecond ?? {}) };
      plan.blockedMsg = { ...(state._blockedMsgThisSecond ?? {}) };

      // Activity history (explainability): keep a rolling window of what actually happened.
      // This helps answer: "why does the colony *feel* off-plan?" (autonomy, needs, dissent).
      state._actHist = state._actHist ?? [];
      state._actHist.push({ t: state.t, assigned: { ...(plan.assigned ?? {}) } });
      if (state._actHist.length > 30) state._actHist.splice(0, state._actHist.length - 30);

      // Decision mix history (explainability): why the plan is being overridden.
      state._decHist = state._decHist ?? [];
      state._decHist.push({ t: state.t, kinds: { ...(plan.decisionKinds ?? {}) } });
      if (state._decHist.length > 30) state._decHist.splice(0, state._decHist.length - 30);

      state._lastPlan = plan;
    }

    for (const k of state.kittens) {
      // Per-tick execution marker for blocked sink actions that fallback to a different task.
      // Cleared every tick; set by doFallback(...).
      k._fallbackTo = null;
      // Per-tick mentoring target (only set when the Mentor action runs).
      k._mentor = null;

      const def = taskDefs[k.task] ?? taskDefs.Rest;
      def.tick(state, k, dt);

      // passive regen from warmth and shelter
      const comfort = (state.res.warmth / 100) * 0.004 + state.res.huts * 0.0007;
      k.energy = clamp01(k.energy + dt * comfort);
      if (k.hunger > 0.82) k.energy = clamp01(k.energy - dt * 0.01);

      // Starvation/sickness spiral: extreme hunger slowly damages health (even before death).
      // Jerky counts as edible food; only apply the harsh spiral when *nothing edible* remains.
      if (k.hunger > 0.92 && edibleFood(state) <= 0) {
        k.health = clamp01((k.health ?? 1) - dt * 0.020);
      } else if (k.hunger > 0.92) {
        k.health = clamp01((k.health ?? 1) - dt * 0.006);
      }

      // hard fail: starvation (only if *no edible food* remains)
      if (edibleFood(state) <= 0 && k.hunger >= 0.98) {
        // lose a kitten (rare, but makes it a civ sim)
        state.kittens = state.kittens.filter(x => x.id !== k.id);
        log(`A kitten starved. Population: ${state.kittens.length}`);
        break;
      }
    }

    // Explainability: maintain smoothed deltas (not saved)
    updateRates(state, dt);

    // Autosave
    state._saveTimer = (state._saveTimer ?? 0) + dt;
    if (state._saveTimer >= 2) { state._saveTimer = 0; save(); }
  }

  // --- Offline gains (incremental QoL)
  // On load, simulate some time passage based on last real-world save timestamp.
  // Cap is intentionally small to prevent huge log spam or runaway spirals.
  function applyOfflineProgressOnce(){
    state.meta = state.meta ?? { version: GAME_VERSION, seenVersion: '', lastTs: 0 };
    const lastTs = Number(state.meta.lastTs ?? 0) || 0;
    const nowTs = Date.now();
    if (!lastTs || nowTs <= lastTs) return;

    const away = (nowTs - lastTs) / 1000;
    const cap = 180; // seconds to simulate (kept small + safe)
    const sim = Math.min(cap, Math.max(0, away));

    if (sim < 2) return;

    const wasPaused = !!state.paused;
    state.paused = false;

    let rem = sim;
    while (rem > 0) {
      const d = Math.min(0.25, rem);
      step(d);
      rem -= d;
    }

    state.paused = wasPaused;
    log(`Offline gains: simulated ${fmt(sim)}s (away ${fmt(away)}s).`);
    save();
  }

  // Run once at boot.
  applyOfflineProgressOnce();

  // --- UI
  const el = (id) => document.getElementById(id);
  const statsEl = el('stats');
  const kittensEl = el('kittens');
  const rulesEl = el('rules');
  const logEl = el('log');
  const goalsEl = el('goals');
  const advisorEl = el('advisor');
  const councilPanelEl = el('council');
  const factionsEl = el('factions');
  const unlocksEl = el('unlocks');
  const seasonEl = el('season');
  const policyEl = el('policy');
  const roleQuotasEl = el('roleQuotas');
  const planDebugEl = el('planDebug');
  const projectsEl = el('projects');
  const profilesEl = el('profiles');
  const profilesHintEl = el('profilesHint');

  // Clickable stat cards (explainability)
  if (statsEl) statsEl.addEventListener('click', (e) => {
    const card = e.target?.closest?.('[data-stat]');
    if (!card) return;
    const key = String(card.dataset.stat || '');
    if (key === 'dissent' || key === 'compliance') openSocial();
  });

  // Advisor: quick actions (wired via render-time recommendations)
  let advisorRecs = [];
  if (advisorEl) advisorEl.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button[data-advice]');
    if (!btn) return;
    const id = String(btn.dataset.advice || '');
    const rec = advisorRecs.find(r => r.id === id);
    if (!rec || typeof rec.apply !== 'function') return;
    rec.apply(state);
    log(`Advisor applied: ${rec.label}`);
    save();
    render();
  });

  // Kitten Council: bottom-up policy suggestions
  let councilRecs = [];
  function policyDiff(before, after){
    const out = [];
    const keys = new Set([...
      Object.keys(before || {}),
      Object.keys(after || {})
    ]);
    for (const k of keys) {
      const a = Number(before?.[k] ?? 1);
      const b = Number(after?.[k] ?? 1);
      if (Math.abs(b - a) > 0.0005) out.push({ key:k, from:a, to:b, d:(b-a) });
    }
    out.sort((x,y) => Math.abs(y.d) - Math.abs(x.d));
    return out;
  }
  function fmtPolicyChange(ch){
    const sign = ch.d >= 0 ? '+' : '';
    return `${ch.key} x${ch.from.toFixed(2)}→x${ch.to.toFixed(2)} (${sign}${ch.d.toFixed(2)})`;
  }
  if (councilPanelEl) councilPanelEl.addEventListener('click', (e) => {
    // Undo last accepted Council suggestion (short window, policy multipliers only).
    const undoBtn = e.target?.closest?.('button[data-council-undo]');
    if (undoBtn) {
      const undo = state.director?.council?.undo ?? null;
      const fresh = undo && Number.isFinite(Number(undo.at ?? 0)) && (state.t - Number(undo.at ?? 0)) <= 120;
      if (fresh && undo?.policyMult) {
        state.policyMult = { ...(undo.policyMult ?? {}) };
        state.director = state.director ?? {};
        state.director.council = state.director.council ?? {};
        state.director.council.undo = null;
        log('Council undo: restored previous policy multipliers.');
        save();
        render();
      } else {
        log('Council undo expired (or nothing to undo).');
      }
      return;
    }

    const btn = e.target?.closest?.('button[data-council]');
    if (!btn) return;
    const id = String(btn.dataset.council || '');
    const rec = councilRecs.find(r => r.id === id);
    if (!rec || typeof rec.apply !== 'function') return;

    const before = { ...(state.policyMult ?? {}) };

    // Store an undo snapshot (policy multipliers only) before applying.
    state.director = state.director ?? {};
    state.director.council = state.director.council ?? {};
    state.director.council.undo = { at: state.t, policyMult: before };

    rec.apply(state);
    const after = { ...(state.policyMult ?? {}) };
    const diff = policyDiff(before, after);
    const diffMsg = diff.length ? diff.slice(0, 6).map(fmtPolicyChange).join('; ') : 'No policy changes.';

    log(`Council accepted: ${rec.label} — ${diffMsg}`);

    // Remember last applied message for panel explainability.
    state.director = state.director ?? {};
    state.director.council = state.director.council ?? {};
    state.director.council.lastAppliedAt = state.t;
    state.director.council.lastAppliedMsg = diffMsg;

    // Put a small cooldown so it doesn't immediately re-spam new advice.
    state.director.council.nextAt = Math.max(Number(state.director.council.nextAt ?? 0) || 0, state.t + 60);
    save();
    render();
  });

  // Factions: values blocs
  if (factionsEl) factionsEl.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button[data-faction]');
    if (!btn) return;
    const axis = String(btn.dataset.faction || '');
    const res = negotiateWithFaction(state, axis);
    if (res?.msg) log(res.msg);
    save();
    render();
  });

  // Projects panel: quick actions
  // - Focus: sets Project focus (build order nudge)
  // - Unblock: lowers reserve(s) that are currently stalling an in-progress project (safe small steps)
  if (projectsEl) projectsEl.addEventListener('click', (e) => {
    const ub = e.target?.closest?.('button[data-unblock]');
    if (ub) {
      const raw = String(ub.dataset.unblock || '');
      const keys = raw.split(',').map(x => x.trim()).filter(Boolean);
      if (keys.length) {
        const step = { food:10, wood:2, science:5, tools:5 };
        for (const k of keys) lowerReserve(state, k, step[k] ?? 5);
        const focus = String(ub.dataset.focus || 'Auto');
        state.director = state.director ?? { projectFocus:'Auto' };
        state.director.projectFocus = focus;
        log(`Unblocked project: lowered ${keys.join('+')} reserve; focus → ${focus}`);
        save();
        render();
      }
      return;
    }

    const btn = e.target?.closest?.('button[data-focus]');
    if (!btn) return;
    const focus = String(btn.dataset.focus || 'Auto');
    state.director = state.director ?? { projectFocus:'Auto' };
    state.director.projectFocus = focus;
    log(`Project focus → ${focus}`);
    save();
    render();
  });

  // Director profiles: save/load policy stacks
  function ensureProfiles(s){
    s.director = s.director ?? { projectFocus:'Auto', autonomy:0.60, workPace:1.00 };
    if (!('profiles' in s.director) || !s.director.profiles) s.director.profiles = { A:null, B:null, C:null };
    for (const k of ['A','B','C']) if (!(k in s.director.profiles)) s.director.profiles[k] = null;
  }

  if (profilesEl) profilesEl.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button[data-prof]');
    if (!btn) return;
    const slot = String(btn.dataset.prof || '');
    const act = String(btn.dataset.pact || '');
    if (!['A','B','C'].includes(slot)) return;

    ensureProfiles(state);

    if (act === 'save') {
      state.director.profiles[slot] = {
        savedAt: Date.now(),
        snap: snapshotDirectorSettings(),
      };
      log(`Saved profile ${slot}.`);
    } else if (act === 'load') {
      const p = state.director.profiles[slot];
      if (!p?.snap) { log(`Profile ${slot} is empty.`); render(); return; }
      applyDirectorSettings(p.snap);
      log(`Loaded profile ${slot}.`);
    } else if (act === 'clear') {
      state.director.profiles[slot] = null;
      log(`Cleared profile ${slot}.`);
    }

    save();
    render();
  });

  // --- Patch notes modal (explainability)
  const patchModalEl = el('patchModal');
  const patchTitleEl = el('patchTitle');
  const patchSubEl = el('patchSub');
  const patchBodyEl = el('patchBody');
  const btnPatchNotesEl = el('btnPatchNotes');
  const btnPatchCloseEl = el('btnPatchClose');
  const uiPatch = { open:false, fromVersion:'' };

  function verCmp(a,b){
    const pa = String(a||'').split('.').map(x=>parseInt(x,10)).filter(n=>Number.isFinite(n));
    const pb = String(b||'').split('.').map(x=>parseInt(x,10)).filter(n=>Number.isFinite(n));
    for (let i=0;i<Math.max(pa.length,pb.length);i++) {
      const da = pa[i] ?? 0;
      const db = pb[i] ?? 0;
      if (da !== db) return da < db ? -1 : 1;
    }
    return 0;
  }

  // Patch notes are cumulative: when you open them after an update, you see everything since your last seen version.
  // Keep this list small + player-facing.
  const PATCH_HISTORY = [
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
        'Explainability: COMMIT decisions now display the current coord multiplier, and the Discipline hint shows "commitment x…".',
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
        'NEW: Grievance (per-kitten + colony avg) — a slow-burn resentment meter that rises when kittens are pushed into disliked/misaligned work under strong central planning.',
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
        'Food stat tooltip now explains the soft-cap → spoilage mechanic in one place.',
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
        'QoL: keyboard shortcuts (when not typing): Space = Pause/Resume, 1–4 = Modes (Survive/Expand/Defend/Advance).',
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
        'NEW: Kitten Council — occasional bottom-up policy suggestions from individual kittens (based on likes/traits + colony status).',
        'Accepting a council suggestion applies a small policy multiplier nudge (no hard locks).',
        'Explainability: the council panel shows who is speaking and why (mood/dissent/traits).',
        'No save-breaking changes.'
      ]
    },
    {
      v: '0.9.38',
      notes: [
        'NEW: Director Priorities sliders (Food / Safety / Progress) — high-level policy weights that bias individual kitten scoring (not just the colony plan).',
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
        'NEW: Buddy bonds — each kitten gets a buddy (shown as b#id in the Traits column tooltip).',
        'When a kitten and their buddy Socialize at the same time, dissent drops a bit faster and their mood recovers slightly faster.',
        'Explainability: Buddy is shown in the Decision Inspector header.'
      ]
    },
    {
      v: '0.9.35',
      notes: [
        'Advisor: new quick actions for social stability — it can recommend (and one-click) Hold Council to reduce dissent and Hold Festival to boost mood when you can afford them.',
        'Explainability: makes the "colony is grumbling" fix path more discoverable without adding hidden automation.'
      ]
    },
    {
      v: '0.9.34',
      notes: [
        'NEW: Auto Rations toggle — the Director can automatically switch Tight/Normal/Feast based on food stability and dissent (with a cooldown to avoid flapping).',
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

  function closePatchNotes(){
    uiPatch.open = false;
    if (patchModalEl) patchModalEl.classList.add('hidden');
  }

  function openPatchNotes(){
    uiPatch.open = true;
    if (patchModalEl) patchModalEl.classList.remove('hidden');
    renderPatchNotes();
  }

  function renderPatchNotes(){
    if (!patchModalEl || !patchTitleEl || !patchSubEl || !patchBodyEl) return;
    if (!uiPatch.open) return;

    const from = String(uiPatch.fromVersion || '');
    const items = PATCH_HISTORY
      .slice()
      .sort((a,b) => verCmp(a.v, b.v))
      .filter(e => (from ? (verCmp(e.v, from) > 0) : (e.v === GAME_VERSION)) && verCmp(e.v, GAME_VERSION) <= 0);

    patchTitleEl.textContent = `v${GAME_VERSION} - Patch notes`;
    patchSubEl.textContent = from
      ? `Changes since v${from} (you can always reopen this from the header).`
      : 'Changes in this version.';

    const lines = [];
    for (const entry of items.length ? items : PATCH_HISTORY.filter(e => e.v === GAME_VERSION)) {
      lines.push(`v${entry.v}`);
      for (const n of (entry.notes ?? [])) lines.push(`• ${n}`);
      lines.push('');
    }

    patchBodyEl.textContent = lines.join('\n').trim();
  }

  if (btnPatchNotesEl) btnPatchNotesEl.addEventListener('click', openPatchNotes);
  if (btnPatchCloseEl) btnPatchCloseEl.addEventListener('click', closePatchNotes);
  if (patchModalEl) patchModalEl.addEventListener('click', (e) => {
    if (e.target === patchModalEl) closePatchNotes();
  });

  // --- Inspect modal (explainability)
  const inspectModalEl = el('inspectModal');
  const inspectTitleEl = el('inspectTitle');
  const inspectSubEl = el('inspectSub');
  const inspectBodyEl = el('inspectBody');
  const btnInspectClose = el('btnInspectClose');

  // --- Social inspector modal (explainability)
  const socialModalEl = el('socialModal');
  const socialTitleEl = el('socialTitle');
  const socialSubEl = el('socialSub');
  const socialBodyEl = el('socialBody');
  const btnSocialClose = el('btnSocialClose');

  const ui = { inspectOpen:false, inspectKidx: -1, socialOpen:false };

  function closeInspect(){
    ui.inspectOpen = false;
    ui.inspectKidx = -1;
    if (inspectModalEl) inspectModalEl.classList.add('hidden');
  }

  function openInspect(kidx){
    ui.inspectOpen = true;
    ui.inspectKidx = kidx;
    if (inspectModalEl) inspectModalEl.classList.remove('hidden');
    renderInspect();
  }

  function renderInspect(){
    if (!inspectModalEl || !inspectTitleEl || !inspectSubEl || !inspectBodyEl) return;
    if (!ui.inspectOpen || ui.inspectKidx < 0 || ui.inspectKidx >= state.kittens.length) {
      inspectModalEl.classList.add('hidden');
      return;
    }

    const k = state.kittens[ui.inspectKidx];
    const p = k.personality ?? genPersonality(k.id ?? 0);
    inspectTitleEl.textContent = `Kitten #${k.id} - ${k.role ?? 'Generalist'} (${k.task ?? '-'})`;

    const likes = (p.likes ?? []).join(', ') || '-';
    const hates = (p.dislikes ?? []).join(', ') || '-';
    const at = (typeof k._lastScoredAt === 'number') ? `t=${fmt(k._lastScoredAt)}s` : '';
    const autoFresh = (k._autonomyPickNote && (state.t - Number(k._autonomyPickAt ?? 0)) < 2) ? k._autonomyPickNote : '';
    const traits = Array.isArray(k.traits) ? k.traits.join(', ') : '-';
    const buddy = buddyOf(state, k);
    const buddyNote = buddy ? ` | buddy: #${buddy.id}` : '';
    const needNote = buddy ? ` | buddy-need: ${Math.round(clamp01(Number(k.buddyNeed ?? 0))*100)}%` : '';
    const align = valuesAlignment01(state, k);
    inspectSubEl.textContent = `traits: ${traits} | values: ${valuesShort(k)} | focus-fit: ${Math.round(align*100)}% | likes: ${likes} | hates: ${hates}${buddyNote}${needNote}${autoFresh ? ' | ' + autoFresh : ''}${at ? ' | ' + at : ''}`;

    const rows = Array.isArray(k._lastScores) ? k._lastScores : [];
    if (!rows.length) {
      inspectBodyEl.textContent = 'No scoring snapshot yet (tick once).';
      return;
    }

    const lines = [];

    const d = (k && typeof k === 'object') ? (k._lastDecision ?? null) : null;
    if (d && typeof d === 'object') {
      const kind = String(d.kind ?? '').toUpperCase() || 'UNKNOWN';
      const task = String(d.task ?? k.task ?? '-');
      const age = (typeof d.at === 'number') ? (state.t - d.at) : null;
      const ageNote = (age !== null && Number.isFinite(age)) ? ` (age ${fmt(age)}s)` : '';

      if (d.kind === 'rule') {
        lines.push(`Decision: RULE → ${task}${ageNote}`);
        lines.push(`  - rule #${d.ruleIndex ?? '?'}: ${d.rule ?? '-'}`);
        lines.push('  - scoring below is informational (last computed top scores)');
      } else if (d.kind === 'emergency') {
        lines.push(`Decision: EMERGENCY → ${task}${ageNote}`);
        lines.push(`  - note: ${d.note ?? '-'}`);
        lines.push('  - scoring below is informational (last computed top scores)');
      } else if (d.kind === 'commit') {
        lines.push(`Decision: COMMIT → ${task}${ageNote}`);
        lines.push(`  - remaining lock: ${Number(d.lock ?? 0).toFixed(0)}s`);
        lines.push('  - scoring below is informational (last computed top scores)');
      } else {
        lines.push(`Decision: SCORE → ${task}${ageNote}`);
        if (d.best && d.best !== task) lines.push(`  - top score was ${d.best} (autonomy sampled)`);
        if (d.autonomyNote) lines.push(`  - ${d.autonomyNote}`);
      }
      lines.push('');
    }

    // Execution explainability: show the last blocked sink → fallback (if it happened very recently).
    const lb = k._lastBlocked;
    if (lb && typeof lb === 'object') {
      const age = (typeof lb.at === 'number') ? (state.t - lb.at) : null;
      if (age !== null && Number.isFinite(age) && age <= 6) {
        const msg = String(lb.msg ?? '').replace(/\s+/g,' ').trim();
        lines.push(`Execution: ${String(lb.action ?? '')} blocked → ${String(lb.to ?? '')} (age ${fmt(age)}s)`);
        if (msg) lines.push(`  - ${msg}`);
        lines.push('');
      }
    }

    for (let i=0;i<Math.min(10, rows.length);i++) {
      const r = rows[i];
      lines.push(`${String(i+1).padStart(2,' ')}. ${String(r.action).padEnd(14)} ${Number(r.score).toFixed(1)}`);
      const reasons = Array.isArray(r.reasons) ? r.reasons : [];
      for (const why of reasons.slice(0, 12)) lines.push(`    - ${why}`);
      if (i < Math.min(10, rows.length)-1) lines.push('');
    }
    inspectBodyEl.textContent = lines.join('\n');
  }

  function closeSocial(){
    ui.socialOpen = false;
    if (socialModalEl) socialModalEl.classList.add('hidden');
  }

  function openSocial(){
    ui.socialOpen = true;
    if (socialModalEl) socialModalEl.classList.remove('hidden');
    renderSocial();
  }

  function renderSocial(){
    if (!socialModalEl || !socialTitleEl || !socialSubEl || !socialBodyEl) return;
    if (!ui.socialOpen) { socialModalEl.classList.add('hidden'); return; }

    const dis = dissent01(state);
    const band = String(state.social?.band ?? (dis >= 0.70 ? 'strike' : dis >= 0.45 ? 'murmur' : 'calm'));
    const comp = compliance01(state);
    const drivers = state._dissentDrivers ?? null;

    socialTitleEl.textContent = `Dissent: ${Math.round(dis*100)}% (${band}) — Compliance x${comp.toFixed(2)}`;

    const season = seasonAt(state.t);
    const rat = getRations(state);
    const doc = doctrineKey(state);
    const wp = workPaceMul(state);
    const dpol = discipline01(state);

    socialSubEl.textContent = `Season: ${season.name} | Rations: ${String(state.rations ?? 'Normal')} | Work pace: ${(wp*100).toFixed(0)}% | Discipline: ${(dpol*100).toFixed(0)}% | Doctrine: ${doc}`;

    const lines = [];
    lines.push('How dissent works (1s cadence):');
    lines.push('• We compute a "desire" value from stressors (mood, overwork, rations, hunger, grievance, alarm).');
    lines.push('• Discipline reduces how fast desire forms (but adds a small morale cost elsewhere).');
    lines.push('• Doctrine nudges it: Rotate lowers buildup a bit; Specialize raises it a bit.');
    lines.push('• Dissent is then smoothed toward that desire (~20–25s to swing hard).');
    lines.push('');

    if (drivers && typeof drivers === 'object') {
      lines.push('Current inputs (last computed):');
      lines.push(`• avg mood: ${(drivers.avgMood*100).toFixed(0)}%  (mood pressure: +${drivers.moodPressure.toFixed(3)})`);
      lines.push(`• work pace: ${(drivers.workPace*100).toFixed(0)}%  (overwork pressure: +${drivers.workPressure.toFixed(3)})`);
      lines.push(`• rations: ${drivers.rationsLabel}  (ration pressure: ${drivers.rationPressure>=0?'+':''}${drivers.rationPressure.toFixed(3)})`);
      lines.push(`• avg hunger: ${(drivers.hungerStress*100).toFixed(0)}%  (hunger pressure: +${drivers.hungerPressure.toFixed(3)})`);
      if (typeof drivers.avgGriev === 'number') lines.push(`• avg grievance: ${(drivers.avgGriev*100).toFixed(0)}%  (grievance pressure: +${Number(drivers.grievancePressure ?? 0).toFixed(3)})`);
      lines.push(`• alarm: ${drivers.alarmStress ? 'ON' : 'OFF'}  (alarm pressure: +${drivers.alarmPressure.toFixed(3)})`);
      lines.push('');
      lines.push(`Raw desire (pre-discipline/doctrine): ${drivers.rawDesire.toFixed(3)}`);
      lines.push(`After discipline/doctrine: ${drivers.desireAfterPolicy.toFixed(3)} (target)`);
      lines.push(`Current dissent: ${drivers.cur.toFixed(3)} → next ${drivers.next.toFixed(3)}`);
      lines.push('');
    } else {
      lines.push('No driver snapshot yet (tick once).');
      lines.push('');
    }

    // Values mismatch: an explicit readout tying governance knobs (Mode + priorities) to population values.
    // This is intentionally simple: average kitten Values vs current colony focus vector.
    try {
      const n = Math.max(1, (state.kittens ?? []).length);
      const avg = { Food:0, Safety:0, Progress:0, Social:0 };
      let avgAlign = 0;
      for (const k of (state.kittens ?? [])) {
        ensureValues(k);
        for (const ax of VALUE_AXES) avg[ax] += Number(k?.values?.[ax] ?? 0);
        avgAlign += valuesAlignment01(state, k);
      }
      for (const ax of VALUE_AXES) avg[ax] /= n;
      const focus = colonyFocusVec(state);
      avgAlign /= n;

      const pct = (x)=>Math.round(100 * (Number(x) || 0));
      const vecLine = (v)=>`Food ${pct(v.Food)}% | Safety ${pct(v.Safety)}% | Progress ${pct(v.Progress)}% | Social ${pct(v.Social)}%`;

      // Biggest mismatch axis (signed, in percentage points).
      let mm = { ax:'Food', d:0 };
      for (const ax of VALUE_AXES) {
        const d = (Number(focus?.[ax] ?? 0) - Number(avg?.[ax] ?? 0));
        if (Math.abs(d) > Math.abs(mm.d)) mm = { ax, d };
      }
      const pp = Math.round(mm.d * 100);
      const dir = pp >= 0 ? 'over' : 'under';

      lines.push('');
      lines.push('Governance: Values vs Focus (bottom-up vs top-down):');
      lines.push(`• avg kitten Values:  ${vecLine(avg)}`);
      lines.push(`• your current Focus: ${vecLine(focus)}   (avg focus-fit: ${Math.round(avgAlign*100)}%)`);
      lines.push(`• biggest mismatch: ${mm.ax} (${Math.abs(pp)}pp ${dir} colony preference)`);

      if (Math.abs(pp) >= 8) {
        const hint = (pp > 0)
          ? `You are pushing ${mm.ax} harder than the colony wants. Expect mood drag (esp. with low autonomy).`
          : `You are under-investing in ${mm.ax} vs what the colony wants. Expect grumbling if stressors appear.`;
        lines.push(`• note: ${hint}`);
      }
      lines.push('');
    } catch (e) {
      // Never break the inspector.
    }

    lines.push('What to do (policy knobs):');
    lines.push('• If mood is low: Feast rations, hold Festival, lower Work pace, or let Socialize/Care run.');
    lines.push('• If overwork is high: lower Work pace or switch doctrine to Rotate temporarily.');
    lines.push('• If hunger stress is high: stabilize food/kitten first (dissent will follow).');
    lines.push('• If you need obedience NOW: raise Discipline (but expect small morale drift down).');

    socialBodyEl.textContent = lines.join('\n');
  }

  if (btnInspectClose) btnInspectClose.addEventListener('click', closeInspect);
  if (inspectModalEl) inspectModalEl.addEventListener('click', (e) => {
    if (e.target === inspectModalEl) closeInspect();
  });

  if (btnSocialClose) btnSocialClose.addEventListener('click', closeSocial);
  if (socialModalEl) socialModalEl.addEventListener('click', (e) => {
    if (e.target === socialModalEl) closeSocial();
  });

  function uiIsTypingTarget(t){
    const tag = String(t?.tagName ?? '').toUpperCase();
    return !!(t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
  }

  function togglePause(){
    state.paused = !state.paused;
    const btn = el('btnPause');
    if (btn) btn.textContent = state.paused ? 'Resume' : 'Pause';
    save();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeInspect();
      closePatchNotes();
      closeSocial();
      return;
    }

    // Keyboard shortcuts (QoL). Ignore when typing in inputs.
    if (uiIsTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = String(e.key || '');

    if (key === ' ') {
      e.preventDefault();
      togglePause();
      return;
    }

    if (key === '1') { setMode('Survive'); return; }
    if (key === '2') { setMode('Expand'); return; }
    if (key === '3') { setMode('Defend'); return; }
    if (key === '4') { setMode('Advance'); return; }

    if (key === 'w' || key === 'W') { setWinterPrep(!state.director?.winterPrep); return; }
    if (key === 'c' || key === 'C') { setCrisisProtocol(!state.director?.crisis); return; }
    if (key === 'q' || key === 'Q') { setCurfew(!state.director?.curfew); return; }

    if (key === 'f' || key === 'F') {
      // Festival (only when not already active)
      state.effects = state.effects ?? { festivalUntil: 0, councilUntil: 0 };
      if (!festivalActive(state)) {
        const res = holdFestival(state);
        log(res.msg);
        save();
        render();
      }
      return;
    }

    if (key === 'v' || key === 'V') {
      // Council (only when not already active)
      state.effects = state.effects ?? { festivalUntil: 0, councilUntil: 0 };
      if (!councilActive(state)) {
        const res = holdCouncil(state);
        log(res.msg);
        save();
        render();
      }
      return;
    }
  });

  if (kittensEl) kittensEl.addEventListener('click', (e) => {
    const tr = e.target?.closest?.('tr');
    if (!tr) return;
    const kidx = Number(tr.dataset.kidx ?? -1);
    if (!Number.isFinite(kidx) || kidx < 0) return;
    openInspect(kidx);
  });

  // --- Advisor (explainable, non-binding suggestions)
  // Reads current targets + trends and recommends which *policy knobs* to nudge.
  // Now also emits "quick actions" you can click to apply a small policy nudge.
  function clampPolicyMult(v){
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.max(0, Math.min(2, n));
  }
  function nudgePolicyMult(s, key, delta){
    s.policyMult = s.policyMult ?? { Socialize:1, Care:1, Forage:1, PreserveFood:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Mentor:1, Research:1 };
    const cur = Number(s.policyMult[key] ?? 1);
    s.policyMult[key] = clampPolicyMult(cur + delta);
  }

  // Director priorities are 0.50..1.50 multipliers (1.00 = neutral). Council can nudge these too.
  function clampPrio(v){
    const n = Number(v);
    if (!Number.isFinite(n)) return 1.00;
    return Math.max(0.50, Math.min(1.50, n));
  }
  function nudgeDirectorPrio(s, key, delta){
    s.director = s.director ?? {};
    const cur = Number(s.director[key] ?? 1.00);
    s.director[key] = clampPrio(cur + delta);
  }

  function raiseReserve(s, key, min){
    s.reserve = s.reserve ?? { food:0, wood:18, science:25, tools:0 };
    s.reserve[key] = Math.max(getReserve(s, key), Math.max(0, Number(min) || 0));
  }

  function lowerReserve(s, key, by){
    s.reserve = s.reserve ?? { food:0, wood:18, science:25, tools:0 };
    const cur = getReserve(s, key);
    const dec = Math.max(0, Number(by) || 0);
    s.reserve[key] = Math.max(0, cur - dec);
  }

  function buildAdvisor(s, targets){
    ensureRateState(s);
    const r = s._rate ?? {};

    const season = seasonAt(s.t);
    const pop = Math.max(1, s.kittens?.length ?? 1);
    const foodPerKitten = ediblePerKitten(s);
    const avgMood = (s.kittens && s.kittens.length)
      ? (s.kittens.reduce((acc,k)=>acc + clamp01(Number(k.mood ?? 0.55)), 0) / pop)
      : 0.55;

    const foodRate = Number(r.food ?? 0);
    const warmthRate = Number(r.warmth ?? 0);
    const threatRate = Number(r.threat ?? 0);
    const scienceRate = Number(r.science ?? 0);

    const lines = [];
    const recs = [];

    // 0) Storage cap / spoilage pressure (new player-visible midgame problem)
    const overcap = s._lastFoodOvercap ?? { cap: foodStorageCap(s), food: Number(s.res.food ?? 0), mult: 1 };
    const spoilMult = Number(overcap.mult ?? 1);
    const storageBad = Number.isFinite(spoilMult) && spoilMult > 1.05;
    if (storageBad) {
      lines.push(`• storage over-cap: spoilage x${spoilMult.toFixed(2)} (cap ${fmt(overcap.cap)}; food ${fmt(overcap.food)})`);
      lines.push(`  - Nudge: build Granary / preserve surplus into Jerky (PreserveFood) / stop overstocking`);

      recs.push({
        id: 'storage',
        label: 'Storage fix',
        tip: 'Set Project focus → Storage, boost BuildGranary + PreserveFood, and raise wood reserve a bit so granary builds don\'t stall.',
        apply: (st) => {
          st.director = st.director ?? { projectFocus:'Auto' };
          st.director.projectFocus = (st.unlocked?.granary ? 'Storage' : 'Auto');
          nudgePolicyMult(st,'BuildGranary', 0.5);
          nudgePolicyMult(st,'PreserveFood', 0.5);
          raiseReserve(st,'wood', 22);
        }
      });
    }

    // 0.5) Build progress blocked by reserves
    // Common early confusion: "why won't they finish the workshop/library?" → reserves are protecting inputs.
    const avail = {
      food: availableAboveReserve(s,'food'),
      wood: availableAboveReserve(s,'wood'),
      science: availableAboveReserve(s,'science'),
      tools: availableAboveReserve(s,'tools'),
    };
    const projDefs = [
      { key:'_hutProgress',  req:12, name:'Hut',      focus:'Housing',  show: () => !!s.unlocked?.construction, inputs:['wood'] },
      { key:'_palProgress',  req:16, name:'Palisade', focus:'Defense',  show: () => !!s.unlocked?.construction, inputs:['wood'] },
      { key:'_granProgress', req:22, name:'Granary',  focus:'Storage',  show: () => !!s.unlocked?.construction && !!s.unlocked?.granary, inputs:['wood'] },
      { key:'_workProgress', req:26, name:'Workshop', focus:'Industry', show: () => !!s.unlocked?.construction && !!s.unlocked?.workshop, inputs:['wood','science'] },
      { key:'_libProgress',  req:30, name:'Library',  focus:'Knowledge',show: () => !!s.unlocked?.construction && !!s.unlocked?.library, inputs:['wood','science','tools'] },
    ];

    let blockedProj = null;
    for (const pd of projDefs) {
      if (!pd.show()) continue;
      const prog = Number(s[pd.key] ?? 0);
      if (!Number.isFinite(prog) || prog <= 0.05) continue;
      const blockedBy = (pd.inputs || []).filter(k => Number(avail[k] ?? 0) <= 0.01);
      if (blockedBy.length) {
        blockedProj = { ...pd, prog, blockedBy };
        break;
      }
    }

    if (blockedProj) {
      lines.push(`• ${blockedProj.name} progress stalled: ${blockedProj.prog.toFixed(1)}/${blockedProj.req} (blocked by ${blockedProj.blockedBy.join('+')} reserve)`);
      lines.push(`  - Nudge: lower that reserve slightly or produce more ${blockedProj.blockedBy.join('+')}`);

      recs.push({
        id: 'unblock',
        label: 'Loosen reserve',
        tip: `Lower reserves blocking ${blockedProj.name} so builders stop bouncing off protected inputs (safe: small steps).`,
        apply: (st) => {
          const step = { food:10, wood:2, science:5, tools:5 };
          for (const k of (blockedProj.blockedBy ?? [])) lowerReserve(st, k, step[k] ?? 5);
          st.director = st.director ?? { projectFocus:'Auto' };
          // Optional: focus the blocked project so the colony actually resumes it.
          st.director.projectFocus = blockedProj.focus;
        }
      });
    }

    // Winter prep discoverability (seasonal overlay)
    // If Winter is soon and the player hasn't enabled Winter Prep, suggest it explicitly.
    // This is a *policy* action (not auto), so it keeps the game about management choices.
    const winterSoon = secondsToNextWinter(s);
    const lateFall = (season.name === 'Fall' && season.phase >= 0.55);
    const canPrep = !s.director?.winterPrep && (lateFall || (winterSoon > 0 && winterSoon <= 45));
    if (canPrep) {
      const eta = fmtEtaSeconds(winterSoon);
      lines.push(`• Winter soon (${eta}) — consider Winter Prep (stockpile food/wood/warmth; raise reserves)`);

      recs.push({
        id: 'winterprep',
        label: 'Winter Prep',
        tip: 'Toggle the Winter Prep overlay: raises targets/reserves and shifts labor toward food/wood/fire (reversible).',
        apply: (st) => {
          // Uses the same overlay logic as the UI button, but is pure for preview sims.
          setWinterPrep(true, st);
        }
      });
    }

    // 1) Food stability
    const foodBad = (foodPerKitten < (targets.foodPerKitten - 5)) || (foodRate < -0.15);
    if (foodBad) {
      const howBad = (foodRate < -0.15) ? `food trending down (${fmtRate(foodRate)})` : `food/kitten low (${fmt(foodPerKitten)} < ${targets.foodPerKitten})`;
      lines.push(`• ${howBad}`);
      lines.push(`  - Nudge: +Forage / +Farm / +PreserveFood (policy) or toggle FOOD signal`);
      if (secondsToNextWinter(s) < 40 && season.name !== 'Winter') lines.push(`  - Winter soon: consider Winter Prep or raise Food reserve`);

      recs.push({
        id: 'food',
        label: 'Food stabilize',
        tip: 'Boost Forage/Farm/Preserve, toggle FOOD crisis, and raise food reserve a bit (soft nudge).',
        apply: (st) => {
          nudgePolicyMult(st,'Forage', 0.5);
          nudgePolicyMult(st,'Farm', 0.5);
          nudgePolicyMult(st,'PreserveFood', 0.5);
          st.signals = st.signals ?? { BUILD:false, FOOD:false, ALARM:false };
          st.signals.FOOD = true;
          raiseReserve(st,'food', Math.ceil(pop * targets.foodPerKitten * 0.35));
        }
      });
    }

    // 2) Warmth
    const warmthBad = (Number(s.res.warmth ?? 0) < (targets.warmth - 6)) || (season.name === 'Winter' && warmthRate < -0.08);
    if (warmthBad) {
      lines.push(`• warmth pressure (now ${fmt(s.res.warmth)}; trend ${fmtRate(warmthRate)})`);
      lines.push(`  - Nudge: +StokeFire (policy), keep wood reserve ≥ 10-20`);

      recs.push({
        id: 'warmth',
        label: 'Warmth push',
        tip: 'Boost StokeFire and raise wood reserve (prevents stoke thrash when building).',
        apply: (st) => {
          nudgePolicyMult(st,'StokeFire', 0.5);
          raiseReserve(st,'wood', 18);
        }
      });
    }

    // 3) Threat / raids
    const threat = Number(s.res.threat ?? 0);
    const threatBad = (threat > targets.maxThreat + 5) || (threatRate > 0.10 && threat > 70);
    if (threatBad) {
      lines.push(`• raids risk (threat ${fmt(threat)}; trend ${fmtRate(threatRate)})`);
      lines.push(`  - Nudge: +Guard / +BuildPalisade (policy) or toggle ALARM (requires Security)`);

      recs.push({
        id: 'defense',
        label: 'Defense posture',
        tip: 'Boost Guard + BuildPalisade, and toggle ALARM if Security is unlocked.',
        apply: (st) => {
          nudgePolicyMult(st,'Guard', 0.5);
          nudgePolicyMult(st,'BuildPalisade', 0.5);
          st.signals = st.signals ?? { BUILD:false, FOOD:false, ALARM:false };
          if (st.unlocked?.security) st.signals.ALARM = true;
        }
      });
    }

    // 3.5) Social stability (discoverability for civ-sim layer)
    // If dissent is high and you can afford it, Council is the cleanest "push the colony back into compliance" lever.
    const disNow = dissent01(s);
    if (disNow > 0.55 && !councilActive(s) && canHoldCouncil(s)) {
      lines.push(`• high dissent (${Math.round(disNow*100)}%) — Council can reduce grumbling quickly`);
      recs.push({
        id: 'council',
        label: 'Hold Council',
        tip: 'Spend food+science to reduce dissent and temporarily boost compliance (good when the colony is murmuring/striking).',
        apply: (st) => {
          const r = holdCouncil(st);
          if (r?.msg) log(`Advisor: ${r.msg}`);
        }
      });
    }

    // If mood is low and you can afford it, Festival is the fastest morale lever.
    if (avgMood < 0.48 && !festivalActive(s) && canHoldFestival(s)) {
      lines.push(`• low mood (avg ${(avgMood*100).toFixed(0)}%) — Festival can boost morale + output`);
      recs.push({
        id: 'festival',
        label: 'Hold Festival',
        tip: 'Spend food+wood to boost mood for ~50s (happy kittens work a bit better and loaf less).',
        apply: (st) => {
          const r = holdFestival(st);
          if (r?.msg) log(`Advisor: ${r.msg}`);
        }
      });
    }

    // 4) Overcrowding / growth
    const cap = housingCap(s);
    if ((s.kittens?.length ?? 0) >= cap) {
      lines.push(`• overcrowded (${s.kittens.length}/${cap})`);
      lines.push(`  - Nudge: +BuildHut (policy) or set Project focus → Housing`);

      recs.push({
        id: 'housing',
        label: 'Housing build',
        tip: 'Set Project focus → Housing and boost BuildHut.',
        apply: (st) => {
          st.director = st.director ?? { projectFocus:'Auto' };
          st.director.projectFocus = 'Housing';
          nudgePolicyMult(st,'BuildHut', 0.5);
          st.signals = st.signals ?? { BUILD:false, FOOD:false, ALARM:false };
          st.signals.BUILD = true;
        }
      });
    }

    // 5) Tech pacing (only if basics ok)
    const basicsOk = !foodBad && !warmthBad && !threatBad;
    if (basicsOk) {
      const wantsIndustry = (s.unlocked?.workshop && (Number(s.res.tools ?? 0) < pop * 10));
      if (wantsIndustry) {
        lines.push(`• tools behind (now ${fmt(s.res.tools ?? 0)}/${(pop*10).toFixed(0)})`);
        lines.push(`  - Nudge: +CraftTools (policy); if blocked, prioritize Workshop inputs (wood+science)`);

        recs.push({
          id: 'tools',
          label: 'Tools catch-up',
          tip: 'Boost CraftTools and set a small tools reserve so tools don\'t get instantly spent.',
          apply: (st) => {
            nudgePolicyMult(st,'CraftTools', 0.5);
            raiseReserve(st,'tools', Math.ceil(pop * 2));
          }
        });
      } else if (scienceRate < 0.25) {
        lines.push(`• slow science (trend ${fmtRate(scienceRate)})`);
        lines.push(`  - Nudge: +Research (policy); consider Library focus once unlocked`);

        recs.push({
          id: 'science',
          label: 'Research push',
          tip: 'Boost Research and (if available) bias Project focus toward Knowledge.',
          apply: (st) => {
            nudgePolicyMult(st,'Research', 0.5);
            st.director = st.director ?? { projectFocus:'Auto' };
            if (st.unlocked?.library) st.director.projectFocus = 'Knowledge';
          }
        });
      }
    }

    if (!lines.length) {
      return {
        text: 'All green. Now you can push growth/tech:\n• Try Preset: Expand or Advance\n• Or set Project focus → (Auto) and watch the plan debug',
        recs: []
      };
    }

    return { text: lines.slice(0, 10).join('\n'), recs };
  }

  function renderAdvisor(s, targets){
    if (!advisorEl) return;
    const a = buildAdvisor(s, targets);
    advisorRecs = Array.isArray(a.recs) ? a.recs : [];

    if (!advisorRecs.length) {
      advisorEl.textContent = String(a.text ?? '');
      return;
    }

    const btns = advisorRecs
      .slice(0, 4)
      .map(r => `<button class=\"btn\" data-advice=\"${escapeHtml(r.id)}\" title=\"${escapeHtml(r.tip || '')}\">${escapeHtml(r.label || r.id)}</button>`)
      .join(' ');

    advisorEl.innerHTML = `<div class=\"row\" style=\"gap:6px; margin-bottom:6px\">${btns}</div>` +
      `<div class=\"why\">${escapeHtml(String(a.text ?? ''))}</div>`;
  }

  function pickCouncilKitten(s){
    const ks = Array.isArray(s.kittens) ? s.kittens : [];
    if (!ks.length) return null;

    // Bias toward kittens who are unhappy / low mood (they're more likely to complain) but keep some randomness.
    let best = null;
    const colonyDis = dissent01(s);
    for (const k of ks) {
      const mood = clamp01(Number(k.mood ?? 0.55));
      // No per-kitten dissent; use colony-wide dissent as the "political atmosphere".
      const w = 0.55 + (0.55 - mood) * 0.9 + colonyDis * 0.6 + Math.random() * 0.35;
      if (!best || w > best.w) best = { k, w };
    }
    return best?.k ?? ks[Math.floor(Math.random() * ks.length)];
  }

  function buildCouncil(s, targets){
    s.director = s.director ?? {};
    s.director.council = s.director.council ?? { nextAt: 0, lastKey: '' };
    if (!('nextAt' in s.director.council)) s.director.council.nextAt = 0;
    if (!('lastKey' in s.director.council)) s.director.council.lastKey = '';

    const cool = Number(s.director.council.nextAt ?? 0) || 0;
    if (s.t < cool) return { text: `Next council in ~${Math.ceil(cool - s.t)}s.`, recs: [] };

    const k = pickCouncilKitten(s);
    if (!k) return { text: 'No kittens yet.', recs: [] };

    const season = seasonAt(s.t);
    const foodPerKitten = ediblePerKitten(s);
    const warmth = Number(s.res.warmth ?? 0);
    const threat = Number(s.res.threat ?? 0);

    const m = s.policyMult ?? {};
    // Use the live personality system (likes/dislikes). Older council code used k.prefs (no longer exists).
    const p = k.personality ?? genPersonality(k.id ?? 0);
    const likes = Array.isArray(p?.likes) ? p.likes : [];
    const hates = Array.isArray(p?.dislikes) ? p.dislikes : [];

    const recs = [];

    // 1) Situation-driven (stability)
    if (foodPerKitten < targets.foodPerKitten * 0.92) {
      recs.push({
        id: `food-${k.id}`,
        label: `+Food work` ,
        effects: `Forage +0.25, Farm +0.25, PreserveFood +0.10`,
        tip: `Food/kitten is low (${fmt(foodPerKitten)}/${targets.foodPerKitten}).`,
        apply: (st) => { nudgePolicyMult(st, 'Forage', 0.25); nudgePolicyMult(st, 'Farm', 0.25); nudgePolicyMult(st, 'PreserveFood', 0.10); }
      });
    } else if (season.name === 'Winter' && warmth < targets.warmth - 6) {
      recs.push({
        id: `warm-${k.id}`,
        label: `+Warmth` ,
        effects: `StokeFire +0.30, ChopWood +0.15`,
        tip: `Winter + cold (warmth ${fmt(warmth)}/${targets.warmth}).`,
        apply: (st) => { nudgePolicyMult(st, 'StokeFire', 0.30); nudgePolicyMult(st, 'ChopWood', 0.15); }
      });
    } else if (threat > targets.maxThreat * 0.95 || s.signals?.ALARM) {
      recs.push({
        id: `threat-${k.id}`,
        label: `+Security`,
        effects: `Guard +0.30, BuildPalisade +0.20`,
        tip: `Threat is rising (now ${fmt(threat)} / target ≤${targets.maxThreat}).`,
        apply: (st) => { nudgePolicyMult(st, 'Guard', 0.30); nudgePolicyMult(st, 'BuildPalisade', 0.20); }
      });
    }

    // 2) Preference-driven (emergent)
    // If the kitten likes something the Director is under-weighting, they may push for it.
    const like = likes.find(a => Number(m[a] ?? 1) <= 0.95);
    if (like) {
      recs.push({
        id: `like-${k.id}-${like}`,
        label: `Let me do more ${like}`,
        effects: `${like} +0.25`,
        tip: `Kitten #${k.id} likes ${like}; policy is x${Number(m[like] ?? 1).toFixed(2)}.`,
        apply: (st) => { nudgePolicyMult(st, like, 0.25); }
      });
    }

    // If the kitten hates something that is strongly demanded, they push back (small softening).
    const hate = hates.find(a => Number(m[a] ?? 1) >= 1.25);
    if (hate) {
      recs.push({
        id: `hate-${k.id}-${hate}`,
        label: `Ease off ${hate}`,
        effects: `${hate} -0.20`,
        tip: `Kitten #${k.id} dislikes ${hate}; policy is x${Number(m[hate] ?? 1).toFixed(2)}.`,
        apply: (st) => { nudgePolicyMult(st, hate, -0.20); }
      });
    }

    // 3) Values-driven (civ-sim): if a kitten's Values mismatch the colony focus *and* central planning is strong,
    // they push for a policy shift (or more autonomy).
    const align = valuesAlignment01(s, k);
    const effAuto = effectiveAutonomy01(s);
    if (align < 0.66 && effAuto < 0.55) {
      ensureValues(k);
      const kv = k.values ?? null;
      const cv = colonyFocusVec(s);

      if (kv && cv) {
        // Find the kitten's top value axis.
        let topAx = 'Food';
        let topV = -1;
        for (const ax of VALUE_AXES) {
          const v = Number(kv[ax] ?? 0);
          if (v > topV) { topV = v; topAx = ax; }
        }

        // If the colony under-weights that axis meaningfully, ask for a nudge.
        const gap = (Number(kv[topAx] ?? 0) - Number(cv[topAx] ?? 0));
        if (gap > 0.10) {
          if (topAx === 'Food') {
            recs.push({
              id: `values-${k.id}-food`,
              label: 'Values: more Food focus',
              effects: 'Priority Food +10%',
              tip: `Kitten #${k.id} values Food; focus-fit is ${Math.round(align*100)}%.`,
              apply: (st) => { nudgeDirectorPrio(st, 'prioFood', 0.10); }
            });
          } else if (topAx === 'Safety') {
            recs.push({
              id: `values-${k.id}-safety`,
              label: 'Values: more Safety focus',
              effects: 'Priority Safety +10%',
              tip: `Kitten #${k.id} values Safety; focus-fit is ${Math.round(align*100)}%.`,
              apply: (st) => { nudgeDirectorPrio(st, 'prioSafety', 0.10); }
            });
          } else if (topAx === 'Progress') {
            recs.push({
              id: `values-${k.id}-progress`,
              label: 'Values: more Progress focus',
              effects: 'Priority Progress +10%',
              tip: `Kitten #${k.id} values Progress; focus-fit is ${Math.round(align*100)}%.`,
              apply: (st) => { nudgeDirectorPrio(st, 'prioProgress', 0.10); }
            });
          } else if (topAx === 'Social') {
            recs.push({
              id: `values-${k.id}-social`,
              label: 'Values: more Social focus',
              effects: 'Socialize +0.25',
              tip: `Kitten #${k.id} values Social; focus-fit is ${Math.round(align*100)}%.`,
              apply: (st) => { nudgePolicyMult(st, 'Socialize', 0.25); }
            });
          }
        }
      }

      // Alternate response: loosen central planning so mismatched kittens can self-select work.
      if (align < 0.58 && effAuto < 0.40) {
        recs.push({
          id: `values-${k.id}-autonomy`,
          label: 'Values: loosen planning',
          effects: 'Autonomy +5%',
          tip: `Low focus-fit (${Math.round(align*100)}%) under strong planning. Raising Autonomy increases emergent self-selection.`,
          apply: (st) => {
            st.director = st.director ?? {};
            const cur = clamp01(Number(st.director.autonomy ?? 0.60));
            st.director.autonomy = clamp01(cur + 0.05);
          }
        });
      }
    }

    // Keep it tight.
    const out = recs.slice(0, 3);

    if (!out.length) {
      // No strong opinions/situations → small cooldown anyway.
      s.director.council.nextAt = s.t + 45;
      return { text: 'Council is quiet (no urgent pushes).', recs: [] };
    }

    // Avoid identical spam.
    const key = out.map(r => r.id).join('|');
    if (key && key === String(s.director.council.lastKey || '')) {
      s.director.council.nextAt = s.t + 45;
      return { text: 'Council has nothing new right now.', recs: [] };
    }
    s.director.council.lastKey = key;

    const traits = (k.traits ?? []).join(', ') || '-';
    const mood = Math.round(clamp01(Number(k.mood ?? 0.55)) * 100);
    const dis = Math.round(dissent01(s) * 100);

    const header = `Spokeskitten: #${k.id} (mood ${mood}%, dissent ${dis}%) | traits: ${traits}`;
    return { text: header, recs: out };
  }

  function renderCouncil(s, targets){
    if (!councilPanelEl) return;
    const c = buildCouncil(s, targets);
    councilRecs = Array.isArray(c.recs) ? c.recs : [];

    if (!councilRecs.length) {
      councilPanelEl.textContent = String(c.text ?? '');
      return;
    }

    const items = councilRecs
      .slice(0, 3)
      .map(r => {
        // Preview the exact multiplier diff in the tooltip (explainability).
        const before = { ...(s.policyMult ?? {}) };
        const tmp = { policyMult: { ...before } };
        try { if (typeof r.apply === 'function') r.apply(tmp); } catch(e) {}
        const diff = policyDiff(before, tmp.policyMult);
        const diffShort = diff.length ? diff.slice(0, 2).map(fmtPolicyChange).join('; ') : '';
        const diffTip = diff.length ? diff.slice(0, 6).map(fmtPolicyChange).join('; ') : 'No policy change.';

        const tip = [r.tip, r.effects, diffTip].filter(Boolean).join(' ');
        const eff = r.effects ? `<span class=\"small\" style=\"opacity:.85\">${escapeHtml(String(r.effects))}</span>` : '';
        const prev = diffShort ? `<span class=\"small\" style=\"opacity:.75\">preview: ${escapeHtml(diffShort)}</span>` : '';

        return `<div class=\"row\" style=\"gap:8px; margin-bottom:6px; align-items:baseline; flex-wrap:wrap\">` +
          `<button class=\"btn\" data-council=\"${escapeHtml(r.id)}\" title=\"${escapeHtml(tip)}\">${escapeHtml(r.label || r.id)}</button>` +
          eff +
          (prev ? ` ${prev}` : '') +
        `</div>`;
      })
      .join('');

    const lastAt = Number(s.director?.council?.lastAppliedAt ?? -9999);
    const lastMsg = String(s.director?.council?.lastAppliedMsg ?? '');
    const showLast = lastMsg && (s.t - lastAt) <= 120;

    const undo = s.director?.council?.undo ?? null;
    const undoAt = Number(undo?.at ?? -9999);
    const showUndo = undo && Number.isFinite(undoAt) && (s.t - undoAt) <= 120;
    const undoLeft = showUndo ? Math.max(0, Math.ceil(120 - (s.t - undoAt))) : 0;
    const undoHtml = showUndo
      ? `<div class=\"row\" style=\"margin-top:6px; gap:8px; align-items:center; flex-wrap:wrap\">` +
          `<button class=\"btn bad\" data-council-undo=\"1\" title=\"Undo the last accepted council suggestion (policy multipliers only).\">Undo last</button>` +
          `<span class=\"small\" style=\"opacity:.8\">(${undoLeft}s window)</span>` +
        `</div>`
      : '';

    councilPanelEl.innerHTML = `${items}` +
      `<div class=\"why\">${escapeHtml(String(c.text ?? ''))}</div>` +
      (showLast ? `<div class=\"small\" style=\"margin-top:6px; opacity:.85\">Last accepted: ${escapeHtml(lastMsg)}</div>` : '') +
      undoHtml;
  }

  function dominantValueAxis(k){
    ensureValues(k);
    const v = k?.values;
    if (!v) return 'Food';
    let best = 'Food';
    let bestV = -1;
    for (const ax of VALUE_AXES) {
      const x = Number(v?.[ax] ?? 0);
      if (x > bestV) { bestV = x; best = ax; }
    }
    return best;
  }

  function negotiateWithFaction(s, axis){
    const ax = String(axis || '').trim();
    if (!['Food','Safety','Progress','Social'].includes(ax)) return { ok:false, msg:'Unknown faction.' };

    s.director = s.director ?? {};
    s.policyMult = s.policyMult ?? {};
    s.social = s.social ?? { dissent: 0 };

    // Cooldown: negotiations are a *politics* lever, not a spam button.
    // Save-safe: fields are optional and default to 0.
    const nextAt = Number(s.director.factionsNextAt ?? 0) || 0;
    if (Number(s.t ?? 0) < nextAt) {
      const left = Math.max(0, nextAt - Number(s.t ?? 0));
      return { ok:false, msg:`Faction talks need time. Try again in ~${Math.ceil(left)}s.` };
    }

    const before = {
      prioFood: Number(s.director.prioFood ?? 1) || 1,
      prioSafety: Number(s.director.prioSafety ?? 1) || 1,
      prioProgress: Number(s.director.prioProgress ?? 1) || 1,
      workPace: Number(s.director.workPace ?? 1) || 1,
      discipline: Number(s.director.discipline ?? 0.4) || 0.4,
      policyMult: { ...(s.policyMult ?? {}) },
      dissent: clamp01(Number(s.social.dissent ?? 0)),
    };

    // Small, bounded policy nudges. These are meant to be *minor course corrections*, not one-click wins.
    if (ax === 'Food') {
      s.director.prioFood = Math.min(1.5, before.prioFood + 0.10);
      s.director.prioProgress = Math.max(0.5, before.prioProgress - 0.05);
    } else if (ax === 'Safety') {
      s.director.prioSafety = Math.min(1.5, before.prioSafety + 0.10);
      s.director.prioProgress = Math.max(0.5, before.prioProgress - 0.05);
    } else if (ax === 'Progress') {
      s.director.prioProgress = Math.min(1.5, before.prioProgress + 0.10);
      s.director.prioSafety = Math.max(0.5, before.prioSafety - 0.05);
    } else if (ax === 'Social') {
      // Social isn't a priority slider; it expresses through pacing + cohesion actions.
      s.director.workPace = Math.max(0.8, before.workPace - 0.05);
      s.director.discipline = clamp01(before.discipline - 0.03);
      s.policyMult.Socialize = Math.min(2, Math.max(0, Number(s.policyMult.Socialize ?? 1) + 0.15));
      s.policyMult.Care = Math.min(2, Math.max(0, Number(s.policyMult.Care ?? 1) + 0.15));
      s.policyMult.Research = Math.min(2, Math.max(0, Number(s.policyMult.Research ?? 1) - 0.05));
    }

    // Tiny immediate cohesion boost (representing "being heard").
    s.social.dissent = clamp01(before.dissent * 0.965);

    // Start cooldown.
    s.director.factionsNextAt = Number(s.t ?? 0) + 45;
    s.director.factionsLast = { at: Number(s.t ?? 0), axis: ax };

    const after = {
      prioFood: Number(s.director.prioFood ?? 1) || 1,
      prioSafety: Number(s.director.prioSafety ?? 1) || 1,
      prioProgress: Number(s.director.prioProgress ?? 1) || 1,
      workPace: Number(s.director.workPace ?? 1) || 1,
      discipline: Number(s.director.discipline ?? 0.4) || 0.4,
      policyMult: { ...(s.policyMult ?? {}) },
      dissent: clamp01(Number(s.social.dissent ?? 0)),
    };

    const fmtDelta = (label, a, b, digits=2) => {
      const da = Number(a); const db = Number(b);
      if (!Number.isFinite(da) || !Number.isFinite(db)) return '';
      const d = db - da;
      if (Math.abs(d) < 0.0001) return '';
      const sign = d >= 0 ? '+' : '';
      return `${label} ${da.toFixed(digits)}→${db.toFixed(digits)} (${sign}${d.toFixed(digits)})`;
    };

    const polDiff = [];
    const keys = new Set([ ...Object.keys(before.policyMult || {}), ...Object.keys(after.policyMult || {}) ]);
    for (const k of keys) {
      const a = Number(before.policyMult?.[k] ?? 1);
      const b = Number(after.policyMult?.[k] ?? 1);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (Math.abs(b - a) > 0.0005) {
        const sign = (b - a) >= 0 ? '+' : '';
        polDiff.push(`${k} x${a.toFixed(2)}→x${b.toFixed(2)} (${sign}${(b-a).toFixed(2)})`);
      }
    }

    const changes = [
      fmtDelta('prioFood', before.prioFood, after.prioFood),
      fmtDelta('prioSafety', before.prioSafety, after.prioSafety),
      fmtDelta('prioProgress', before.prioProgress, after.prioProgress),
      fmtDelta('workPace', before.workPace, after.workPace),
      fmtDelta('discipline', before.discipline, after.discipline),
      ...polDiff,
    ].filter(Boolean);

    const dissMsg = `${Math.round(before.dissent*100)}%→${Math.round(after.dissent*100)}%`;
    const changeMsg = changes.length ? changes.slice(0, 6).join('; ') : 'no policy deltas';

    return { ok:true, msg:`Negotiated with the ${ax} bloc: ${changeMsg}. Dissent ${dissMsg}. (cooldown ~45s)` };
  }

  function renderFactions(s){
    if (!factionsEl) return;

    s.director = s.director ?? {};
    const nextAt = Number(s.director.factionsNextAt ?? 0) || 0;
    const can = Number(s.t ?? 0) >= nextAt;
    const left = Math.max(0, nextAt - Number(s.t ?? 0));

    const preview = (ax) => {
      if (ax === 'Food') return 'Concession: +prioFood, -prioProgress';
      if (ax === 'Safety') return 'Concession: +prioSafety, -prioProgress';
      if (ax === 'Progress') return 'Concession: +prioProgress, -prioSafety';
      if (ax === 'Social') return 'Concession: -workPace, -discipline, +Socialize/Care policy, -Research policy';
      return '';
    };

    const groups = Object.create(null);
    for (const ax of ['Food','Safety','Progress','Social']) groups[ax] = { axis: ax, n:0, mood:0, griev:0, align:0 };

    const kittens = Array.isArray(s?.kittens) ? s.kittens : [];
    for (const k of kittens) {
      const ax = dominantValueAxis(k);
      const g = groups[ax] ?? (groups[ax] = { axis: ax, n:0, mood:0, griev:0, align:0 });
      g.n += 1;
      g.mood += clamp01(Number(k.mood ?? 0.55));
      g.griev += clamp01(Number(k.grievance ?? 0));
      g.align += valuesAlignment01(s, k);
    }

    const arr = Object.values(groups).filter(g => g.n > 0).sort((a,b)=>b.n-a.n);
    if (!arr.length) { factionsEl.textContent = '-'; return; }

    const lines = arr.map(g => {
      const mood = g.mood / g.n;
      const griev = g.griev / g.n;
      const align = g.align / g.n;
      const pct = (x)=>Math.round(100*x);

      const tip = preview(g.axis);
      const cd = can ? '' : ` (cooldown ~${Math.ceil(left)}s)`;
      const title = `Make a small policy concession to this bloc (reduces dissent slightly). ${tip}${cd}`.trim();

      const btn = `<button class="btn" data-faction="${g.axis}" ${can ? '' : 'disabled'} title="${title}">Negotiate</button>`;
      const sub = `<div class="small" style="opacity:.78; margin-top:2px">${tip}${can ? '' : ` — cooldown ${Math.ceil(left)}s`}</div>`;

      return `<div style="padding:4px 0">` +
        `<div class="row" style="justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap">` +
          `<div><span class="tag">${g.axis}</span> <span class="small">x${g.n}</span> <span class="small" style="opacity:.85">mood ${pct(mood)}% | griev ${pct(griev)}% | fit ${pct(align)}%</span>${sub}</div>` +
          `<div>${btn}</div>` +
        `</div>` +
      `</div>`;
    }).join('');

    factionsEl.innerHTML = lines + `<div class="small" style="margin-top:6px; opacity:.75">Tip: if dissent is creeping up and focus-fit is low, negotiating with the largest bloc is a quick stabilization lever (at the cost of drifting priorities). Now with a short cooldown so you don’t accidentally drift too far.</div>`;
  }

  function render(){
    const season = seasonAt(state.t);
    const targets = seasonTargets(state);
    const verEl = el('ver');
    if (verEl) verEl.textContent = `v${GAME_VERSION}`;
    el('clock').textContent = `t=${fmt(state.t)}s | pop=${state.kittens.length}/${housingCap(state)} | mode=${state.mode}`;

    const avgEff = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc+efficiency(state,k),0) / state.kittens.length) : 1;
    const avgHealth = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc+clamp01(Number(k.health ?? 1)),0) / state.kittens.length) : 1;
    const avgMood = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc+clamp01(Number(k.mood ?? 0.55)),0) / state.kittens.length) : 0.55;

    // Policy fit (values alignment): how much the colony's current focus (Mode + priority sliders)
    // matches what kittens *want*. Low fit under low autonomy tends to drag mood and raise dissent.
    const _aligns = state.kittens.map(k => valuesAlignment01(state, k));
    const avgAlign = _aligns.length ? (_aligns.reduce((a,b)=>a+b,0) / _aligns.length) : 0.75;
    const minAlign = _aligns.length ? Math.min(..._aligns) : 0.75;
    const lowAlignCt = _aligns.filter(a => a < 0.55).length;

    const avgGriev = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc+clamp01(Number(k.grievance ?? 0)),0) / state.kittens.length) : 0;

    el('modeSurvive').classList.toggle('active', state.mode==='Survive');
    el('modeExpand').classList.toggle('active', state.mode==='Expand');
    el('modeDefend').classList.toggle('active', state.mode==='Defend');
    el('modeResearch').classList.toggle('active', state.mode==='Advance');

    // Seasonal one-click director toggle (pure UI/policy; doesn't change core sim)
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, curfew:false, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoBuildPush:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', autoRecruit:false, autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    if (!('crisis' in state.director)) state.director.crisis = false;
    if (!('crisisSaved' in state.director)) state.director.crisisSaved = null;
    if (!('curfew' in state.director)) state.director.curfew = false;
    if (!('autoWinterPrep' in state.director)) state.director.autoWinterPrep = false;
    if (!('autoFoodCrisis' in state.director)) state.director.autoFoodCrisis = false;
    if (!('autoReserves' in state.director)) state.director.autoReserves = false;
    if (!('autoBuildPush' in state.director)) state.director.autoBuildPush = false;
    if (!('autoMode' in state.director)) state.director.autoMode = false;
    if (!('autoModeNextChangeAt' in state.director)) state.director.autoModeNextChangeAt = 0;
    if (!('autoModeWhy' in state.director)) state.director.autoModeWhy = '';
    if (!('autoDoctrine' in state.director)) state.director.autoDoctrine = false;
    if (!('autoDoctrineNextChangeAt' in state.director)) state.director.autoDoctrineNextChangeAt = 0;
    if (!('autoDoctrineWhy' in state.director)) state.director.autoDoctrineWhy = '';
    if (!('autoRations' in state.director)) state.director.autoRations = false;
    if (!('autoRationsNextChangeAt' in state.director)) state.director.autoRationsNextChangeAt = 0;
    if (!('autoRationsWhy' in state.director)) state.director.autoRationsWhy = '';
    if (!('autoRecruit' in state.director)) state.director.autoRecruit = false;
    if (!('autoCrisis' in state.director)) state.director.autoCrisis = false;
    if (!('autoCrisisTriggered' in state.director)) state.director.autoCrisisTriggered = false;
    if (!('autoCrisisNextChangeAt' in state.director)) state.director.autoCrisisNextChangeAt = 0;
    if (!('autoCrisisWhy' in state.director)) state.director.autoCrisisWhy = '';
    if (!('recruitYear' in state.director)) state.director.recruitYear = -1;
    if (!('projectFocus' in state.director)) state.director.projectFocus = 'Auto';
    if (!('autonomy' in state.director)) state.director.autonomy = 0.60;
    if (!('discipline' in state.director)) state.director.discipline = 0.40;
    if (!('workPace' in state.director)) state.director.workPace = 1.00;
    if (!('doctrine' in state.director)) state.director.doctrine = 'Balanced';
    if (!('prioFood' in state.director)) state.director.prioFood = 1.00;
    if (!('prioSafety' in state.director)) state.director.prioSafety = 1.00;
    if (!('prioProgress' in state.director)) state.director.prioProgress = 1.00;
    state.director.autonomy = clamp01(Number(state.director.autonomy ?? 0.60));
    state.director.discipline = clamp01(Number(state.director.discipline ?? 0.40));
    state.director.workPace = Math.max(0.8, Math.min(1.2, Number(state.director.workPace ?? 1.00) || 1.00));
    state.director.prioFood = Math.max(0.50, Math.min(1.50, Number(state.director.prioFood ?? 1.00) || 1.00));
    state.director.prioSafety = Math.max(0.50, Math.min(1.50, Number(state.director.prioSafety ?? 1.00) || 1.00));
    state.director.prioProgress = Math.max(0.50, Math.min(1.50, Number(state.director.prioProgress ?? 1.00) || 1.00));

    const wp = !!state.director.winterPrep;
    const wpBtn = el('btnWinterPrep');
    if (wpBtn) {
      wpBtn.classList.toggle('active', wp);
      wpBtn.textContent = wp ? 'Winter Prep: ON' : 'Winter Prep';
    }

    const cp = !!state.director.crisis;
    const cpBtn = el('btnCrisis');
    if (cpBtn) {
      cpBtn.classList.toggle('active', cp);
      cpBtn.textContent = cp ? 'Crisis: ON' : 'Crisis Protocol';
    }

    const cur = !!state.director.curfew;
    const curBtn = el('btnCurfew');
    if (curBtn) {
      curBtn.classList.toggle('active', cur);
      curBtn.textContent = cur ? 'Curfew: ON' : 'Curfew';
    }

    const autoWp = el('autoWinterPrep');
    if (autoWp) autoWp.checked = !!state.director.autoWinterPrep;
    const autoFood = el('autoFoodCrisis');
    if (autoFood) autoFood.checked = !!state.director.autoFoodCrisis;
    const autoRes = el('autoReserves');
    if (autoRes) autoRes.checked = !!state.director.autoReserves;
    const autoBuild = el('autoBuildPush');
    if (autoBuild) autoBuild.checked = !!state.director.autoBuildPush;
    const autoMode = el('autoMode');
    if (autoMode) autoMode.checked = !!state.director.autoMode;
    const autoDoc = el('autoDoctrine');
    if (autoDoc) autoDoc.checked = !!state.director.autoDoctrine;
    const autoRat = el('autoRations');
    if (autoRat) autoRat.checked = !!state.director.autoRations;
    const autoRec = el('autoRecruit');
    if (autoRec) autoRec.checked = !!state.director.autoRecruit;
    const autoCrisis = el('autoCrisis');
    if (autoCrisis) autoCrisis.checked = !!state.director.autoCrisis;
    const autoDrills = el('autoDrills');
    if (autoDrills) autoDrills.checked = !!state.director.autoDrills;

    // Timed effects (for old saves)
    state.effects = state.effects ?? { festivalUntil: 0, councilUntil: 0, drillUntil: 0 };
    if (!('festivalUntil' in state.effects)) state.effects.festivalUntil = 0;
    if (!('councilUntil' in state.effects)) state.effects.councilUntil = 0;
    if (!('drillUntil' in state.effects)) state.effects.drillUntil = 0;

    // Festival (morale lever)
    const festBtn = el('btnFestival');
    if (festBtn) {
      const left = festivalSecondsLeft(state);
      const c = festivalCost(state);
      festBtn.classList.toggle('active', left > 0);
      festBtn.disabled = (left <= 0) && !canHoldFestival(state);
      festBtn.textContent = (left > 0)
        ? `Festival: ${Math.ceil(left)}s`
        : `Hold Festival (${c.food}f, ${c.wood}w)`;
    }

    // Council (cohesion lever)
    const councilBtn = el('btnCouncil');
    if (councilBtn) {
      const left = councilSecondsLeft(state);
      const c = councilCost(state);
      councilBtn.classList.toggle('active', left > 0);
      councilBtn.disabled = (left <= 0) && !canHoldCouncil(state);
      councilBtn.textContent = (left > 0)
        ? `Council: ${Math.ceil(left)}s`
        : `Hold Council (${c.food}f, ${c.science}sci)`;
    }

    // Drills (defense training lever)
    const drillBtn = el('btnDrill');
    if (drillBtn) {
      const left = drillSecondsLeft(state);
      const c = drillCost(state);
      drillBtn.classList.toggle('active', left > 0);
      drillBtn.disabled = (left <= 0) && !canRunDrills(state);
      drillBtn.textContent = (left > 0)
        ? `Drills: ${Math.ceil(left)}s`
        : `Run Drills (${c.food}f, ${c.wood}w)`;
    }

    // Project focus (build order nudge)
    const pfSel = el('projectFocus');
    if (pfSel) pfSel.value = String(state.director.projectFocus ?? 'Auto');
    const pfHint = el('projectFocusHint');
    if (pfHint) {
      const setPf = String(state.director.projectFocus ?? 'Auto');
      const eff = getEffectiveProjectFocus(state);
      const pf = String(eff.focus ?? 'Auto');

      const desc = (x) => (x === 'Housing') ? 'push huts until housing is comfy'
        : (x === 'Defense') ? 'keep a builder on palisade'
        : (x === 'Industry') ? 'try to finish a workshop / keep tools maintained (needs wood+science)'
        : (x === 'Storage') ? 'try to finish a granary (needs wood)'
        : (x === 'Knowledge') ? 'try to finish a library (needs wood+science+tools)'
        : '';

      if (setPf === 'Auto') {
        pfHint.textContent = (pf === 'Auto') ? `(auto) no focus - ${eff.why}` : `(auto) ${pf}: ${desc(pf)} - ${eff.why}`;
      } else {
        pfHint.textContent = `${desc(setPf)} (manual)`;
      }
    }

    // Director profiles UI
    if (profilesEl) {
      ensureProfiles(state);
      const fmtTime = (ts) => {
        if (!ts) return '';
        try {
          return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        } catch { return ''; }
      };

      const slotBtn = (slot) => {
        const p = state.director.profiles?.[slot];
        const has = !!(p && p.snap);
        const when = has ? fmtTime(p.savedAt) : '';
        const label = has ? `saved ${when}` : 'empty';
        return `
          <div class="row" style="gap:6px; margin-right:10px">
            <span class="tag">${slot}</span>
            <button class="btn" data-prof="${slot}" data-pact="load" ${has?'':'disabled'}>Load</button>
            <button class="btn" data-prof="${slot}" data-pact="save">Save</button>
            <button class="btn bad" data-prof="${slot}" data-pact="clear" ${has?'':'disabled'}>Clear</button>
            <span class="small" style="opacity:.8">${label}</span>
          </div>`;
      };

      profilesEl.innerHTML = ['A','B','C'].map(slotBtn).join('');
      if (profilesHintEl) profilesHintEl.textContent = 'Tip: save a Winter Prep setup in A, an Expand setup in B, and an Advance setup in C.';
    }

    const freshPerKitten = (Number(state.res.food ?? 0) / Math.max(1, state.kittens.length));
    const foodPerKitten = ediblePerKitten(state);
    const foodCapNow = foodStorageCap(state);
    const addCost = kittenCost();
    el('kittenCost').textContent = String(addCost);
    const popCapEl = el('kittenPopCap');
    if (popCapEl) popCapEl.textContent = `${state.kittens.length}/${housingCap(state)}`;

    // QoL: disable the +Kitten button when you can't afford it or you're at the housing cap.
    const addBtn = el('btnAddKitten');
    if (addBtn) {
      const cap = housingCap(state);
      const noFood = Number(state.res.food ?? 0) < addCost;
      const noHousing = (state.kittens.length >= cap);
      addBtn.disabled = noFood || noHousing;
      addBtn.title = noHousing
        ? `Housing full (${state.kittens.length}/${cap}). Build huts to raise cap.`
        : noFood
          ? `Need ${addCost} food to recruit a kitten.`
          : 'Recruit a kitten (costs food; requires free housing).';
    }

    // Social visibility (explainability): dissent directly weakens central planning.
    // Putting it in the top stats makes the "why are they loafing/ignoring plan?" moment instantly legible.
    const diss = dissent01(state);
    const dissBand = String(state.social?.band ?? (diss >= 0.70 ? 'strike' : diss >= 0.45 ? 'murmur' : 'calm'));
    const compMul = compliance01(state);

    statsEl.innerHTML = '';

    const spoilMult = (() => {
      const m = Number(state._lastFoodOvercap?.mult ?? 1);
      return Number.isFinite(m) ? Math.max(1, Math.min(4, m)) : 1;
    })();

    // Rates/ETAs shown as a tiny second line under key stats.
    // This makes "why is this collapsing?" legible without opening the inspector panels.
    ensureRateState(state);
    const r = state._rate ?? {};
    const foodRate = Number(r.food ?? 0);
    const woodRate = Number(r.wood ?? 0);
    const warmthRate = Number(r.warmth ?? 0);
    const threatRate = Number(r.threat ?? 0);
    const scienceRate = Number(r.science ?? 0);
    const toolsRate = Number(r.tools ?? 0);
    const jerkyRate = Number(r.jerky ?? 0);

    const raidEta = (threatRate > 0.02 && state.res.threat < 100)
      ? fmtEtaSeconds(etaToTarget(state.res.threat, 100, threatRate))
      : '-';
    const threatTargetEta = (threatRate > 0.02 && state.res.threat < targets.maxThreat)
      ? fmtEtaSeconds(etaToTarget(state.res.threat, targets.maxThreat, threatRate))
      : '-';
    const warmthToTargetEta = fmtEtaSeconds(etaToTarget(state.res.warmth, targets.warmth, warmthRate));
    const nextUnlock = unlockDefs.find(u => !state.seenUnlocks[u.id]);
    const nextUnlockEta = nextUnlock ? fmtEtaSeconds(etaToTarget(state.res.science, nextUnlock.at, scienceRate)) : '-';

    // Danger forecasts (explainability): if a trend is negative, show time-to-zero.
    // IMPORTANT: starvation risk depends on *edible* stores (food + jerky), not just fresh food.
    const edibleRate = foodRate + jerkyRate;
    const starveEtaFresh = (foodRate < -0.02) ? fmtEtaSeconds((state.res.food) / (-foodRate)) : '-';
    const starveEtaEdible = (edibleRate < -0.02) ? fmtEtaSeconds((edibleFood(state)) / (-edibleRate)) : '-';
    const freezeEta = (warmthRate < -0.02) ? fmtEtaSeconds((state.res.warmth) / (-warmthRate)) : '-';

    const statSub = (key) => {
      if (key === 'Food') {
        const spoilNote = (spoilMult > 1.05) ? ` | spoil x${spoilMult.toFixed(2)}` : '';
        const capNote = ` | cap ${fmt(foodCapNow)}`;
        return `fresh ${fmtRate(foodRate)} | edible ${fmtRate(edibleRate)} | 0 in ${starveEtaEdible}${spoilNote}${capNote}`;
      }
      if (key === 'Jerky') return `${fmtRate(jerkyRate)}`;
      if (key === 'Wood') return `${fmtRate(woodRate)}`;
      if (key === 'Warmth') return `${fmtRate(warmthRate)} | tgt in ${warmthToTargetEta} | 0 in ${freezeEta}`;
      if (key === 'Threat') return `${fmtRate(threatRate)} | tgt in ${threatTargetEta} | raid in ${raidEta}`;
      if (key === 'Science') return `${fmtRate(scienceRate)} | next unlock in ${nextUnlockEta}`;
      if (key === 'Tools') return `${fmtRate(toolsRate)}`;
      if (key === 'Focus-fit') return `min ${Math.round(minAlign*100)}% | low ${lowAlignCt}/${Math.max(1,state.kittens.length)}`;
      return '';
    };

    const stats = [
      ['Food', fmt(state.res.food)],
      ['Jerky', fmt(state.res.jerky ?? 0)],
      ['Wood', fmt(state.res.wood)],
      ['Warmth', fmt(state.res.warmth)],
      ['Threat', fmt(state.res.threat)],
      ['Science', fmt(state.res.science)],
      ['Tools', fmt(state.res.tools ?? 0)],
      ['Prod x', fmt(toolsBonus(state)) + 'x'],
      ['Huts', fmt(state.res.huts)],
      ['Palisade', fmt(state.res.palisade)],
      ['Granaries', fmt(state.res.granaries ?? 0)],
      ['Workshops', fmt(state.res.workshops ?? 0)],
      ['Libraries', fmt(state.res.libraries ?? 0)],
      ['Industry x', fmt(workshopBonus(state)) + 'x'],
      ['Research x', fmt(libraryBonus(state)) + 'x'],
      ['Food Cap', fmt(foodStorageCap(state))],
      ['Spoilage', `x${spoilMult.toFixed(2)}`],
      ['Edible/Kitten', fmt(foodPerKitten)],
      ['Fresh/Kitten', fmt(freshPerKitten)],
      ['Dissent', `${Math.round(diss*100)}% (${dissBand})`],
      ['Compliance', `x${compMul.toFixed(2)}`],
      ['Grievance', `${Math.round(avgGriev*100)}%`],
      ['Autonomy', `${Math.round(autonomy01(state)*100)}%`],
      ['Eff Auto', `${Math.round(effectiveAutonomy01(state)*100)}%`],
      ['Discipline', `${Math.round(discipline01(state)*100)}%`],
      ['Work pace', `${Math.round(workPaceMul(state)*100)}%`],
      ['Focus-fit', `${Math.round(avgAlign*100)}%`],
    ];

    for (const [k,v] of stats) {
      const d = document.createElement('div');
      d.className = 'stat';
      if (k === 'Dissent') {
        d.dataset.stat = 'dissent';
        d.title = 'Click to inspect what is driving dissent/compliance';
        d.style.cursor = 'pointer';
      }
      if (k === 'Compliance') {
        d.dataset.stat = 'compliance';
        d.title = 'Click to inspect what is driving dissent/compliance (compliance scales how strongly the colony follows the plan)';
        d.style.cursor = 'pointer';
      }
      if (k === 'Grievance') {
        d.title = 'Average grievance (slow-burn resentment). It rises when kittens are pushed into disliked/misaligned work under strong central planning, and it contributes to dissent pressure.';
      }
      if (k === 'Autonomy') {
        d.title = 'Director Autonomy policy (0–100%). Higher autonomy makes individual likes/dislikes matter more, increasing emergent behavior (and reducing perfect compliance).';
      }
      if (k === 'Eff Auto') {
        d.title = 'Effective autonomy (felt autonomy). Starts from Autonomy, then shifts with Discipline (down) and Dissent (up). Higher effective autonomy = more individual variation and less plan obedience.';
      }
      if (k === 'Discipline') {
        d.title = 'Director Discipline policy (0–100%). Higher discipline increases compliance and reduces dissent formation, but has a small steady mood cost.';
      }
      if (k === 'Work pace') {
        d.title = 'Director Work pace policy. Higher pace increases output but increases fatigue/hunger and slowly drags mood; lower pace is steadier but slower.';
      }
      if (k === 'Focus-fit') {
        d.title = 'Values alignment: avg match between kittens\' values and colony focus (Mode + priority sliders). Low fit can drag mood and raise dissent, especially with low autonomy/high discipline.';
      }
      if (k === 'Food') {
        const oc = state._lastFoodOvercap ?? { cap: foodCapNow, food: Number(state.res.food ?? 0), mult: 1 };
        const cap = Number(oc.cap ?? foodCapNow);
        const mult = Number(oc.mult ?? spoilMult);
        d.title = `Food storage soft cap: ${fmt(cap)}. If food is above cap, spoilage accelerates (shown as Spoilage x1..x4). Current spoilage: x${(Number.isFinite(mult)?mult:1).toFixed(2)}.`;
      }
      const sub = statSub(k);
      const subHtml = sub ? `<div class="small" style="margin-top:4px; opacity:.85">${escapeHtml(sub)}</div>` : '';
      d.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>${subHtml}`;
      statsEl.appendChild(d);
    }

    const plan = state._lastPlan?.desired;
    const planLine = plan ? ('\nAI plan: ' + summarizePlan(plan)) : '';

    // (rates/ETAs are computed above for the stat cards)

    // Projects (build progress)
    const projDefs = [
      { key:'_hutProgress',  req:12, name:'Hut',      owned: () => state.res.huts,          focus:'Housing',  show: () => !!state.unlocked?.construction },
      { key:'_palProgress',  req:16, name:'Palisade', owned: () => state.res.palisade,      focus:'Defense',  show: () => !!state.unlocked?.construction },
      { key:'_granProgress', req:22, name:'Granary',  owned: () => state.res.granaries??0,  focus:'Storage',  show: () => !!state.unlocked?.construction && !!state.unlocked?.granary },
      { key:'_workProgress', req:26, name:'Workshop', owned: () => state.res.workshops??0,  focus:'Industry', show: () => !!state.unlocked?.construction && !!state.unlocked?.workshop },
      { key:'_libProgress',  req:30, name:'Library',  owned: () => state.res.libraries??0,  focus:'Knowledge',show: () => !!state.unlocked?.construction && !!state.unlocked?.library },
    ];

    const proj = []; // season summary line
    const projHtml = [];

    // Project blocking (explainability): show which *reserve-protected input* is preventing build progress.
    // Previously we only surfaced wood blocks; but workshops/libraries can also be gated by science/tools reserves.
    const avail = {
      food: availableAboveReserve(state,'food'),
      wood: availableAboveReserve(state,'wood'),
      science: availableAboveReserve(state,'science'),
      tools: availableAboveReserve(state,'tools'),
    };
    const blockKeys = (keys) => (keys || []).filter(k => Number(avail[k] ?? 0) <= 0.01);
    const projInputs = (name) => {
      if (name === 'Hut') return ['wood'];
      if (name === 'Palisade') return ['wood'];
      if (name === 'Granary') return ['wood'];
      if (name === 'Workshop') return ['wood','science'];
      if (name === 'Library') return ['wood','science','tools'];
      return ['wood'];
    };

    for (const pd of projDefs) {
      if (!pd.show()) continue;
      const prog = Number(state[pd.key] ?? 0);
      const req = Number(pd.req);
      const pct = clamp01(req > 0 ? prog / req : 0);
      const owned = Number(pd.owned?.() ?? 0);

      if (prog > 0.0001) proj.push(`${pd.name} ${prog.toFixed(1)}/${req}`);

      const blockedBy = blockKeys(projInputs(pd.name));
      const blocked = blockedBy.length ? ` (blocked by ${blockedBy.join('+')} reserve)` : '';

      projHtml.push(`
        <div style="margin-bottom:10px">
          <div class="row" style="justify-content:space-between; gap:10px">
            <div class="small" style="flex:1 1 auto">${pd.name}: owned ${owned} - ${prog.toFixed(1)}/${req} (${Math.round(pct*100)}%)${blocked}</div>
            <div class="row" style="gap:6px">
              ${blockedBy.length ? `<button class=\"btn\" data-unblock=\"${blockedBy.join(',')}\" data-focus=\"${pd.focus}\" title=\"Lowers only the reserve(s) currently blocking this project (safe small steps), then sets focus\">Unblock</button>` : ''}
              <button class="btn" data-focus="${pd.focus}" title="Sets Project focus → ${pd.focus} (a build-order nudge)">Focus</button>
            </div>
          </div>
          <div class="bar" style="margin-top:6px"><div style="width:${Math.round(pct*100)}%"></div></div>
        </div>
      `);
    }

    if (projectsEl) {
      projectsEl.innerHTML = projHtml.length
        ? projHtml.join('')
        : `<span class="small">No active build projects yet. Unlock Construction via Science, then nudge build tasks with policy or Project focus.</span>`;
    }

    const projLine = proj.length ? (`Projects: ${proj.join(' | ')}\n`) : '';

    const nextSeasonEta = fmtEtaSeconds(secondsToNextSeason(state));
    const winterEta = fmtEtaSeconds(secondsToNextWinter(state));
    const seasonalNote = (targets.why !== 'baseline') ? `Seasonal targets: food/kitten=${targets.foodPerKitten}, warmth=${targets.warmth}, threat≤${targets.maxThreat} (${targets.why})\n` : '';

    const pfSet = String(state.director?.projectFocus ?? 'Auto');
    const pfEff = getEffectiveProjectFocus(state);
    const pfLine = (pfSet === 'Auto')
      ? `Project focus (auto): ${pfEff.focus}${pfEff.focus === 'Auto' ? '' : ` - ${pfEff.why}`}\n`
      : `Project focus (manual): ${pfSet}\n`;

    const festLeft = festivalSecondsLeft(state);
    const festLine = (festLeft > 0) ? `Festival: active (${Math.ceil(festLeft)}s) - morale drifting up\n` : '';

    const councilLeft = councilSecondsLeft(state);
    const councilLine = (councilLeft > 0) ? `Council: active (${Math.ceil(councilLeft)}s) - dissent decays faster\n` : '';

    const drillLeft = drillSecondsLeft(state);
    const drillLine = (drillLeft > 0) ? `Drills: active (${Math.ceil(drillLeft)}s) - threat growth slowed; Guard trains faster\n` : '';

    const amOn = !!state.director?.autoMode;
    const amWhy = String(state.director?.autoModeWhy ?? '').trim();
    const amLine = amOn ? `Auto mode: ON${amWhy ? ` - ${amWhy}` : ''}\n` : '';

    const abOn = !!state.director?.autoBuildPush;
    const abLine = abOn ? `Auto build push: ON (manages BUILD PUSH when housing-capped)\n` : '';

    const adOn = !!state.director?.autoDoctrine;
    const adWhy = String(state.director?.autoDoctrineWhy ?? '').trim();
    const adLine = adOn ? `Auto doctrine: ON (${doctrineKey(state)})${adWhy ? ` - ${adWhy}` : ''}\n` : '';

    const aRatOn = !!state.director?.autoRations;
    const aRatWhy = String(state.director?.autoRationsWhy ?? '').trim();
    const aRatLine = aRatOn ? `Auto rations: ON (${String(state.rations ?? 'Normal')})${aRatWhy ? ` - ${aRatWhy}` : ''}\n` : '';

    const arOn = !!state.director?.autoRecruit;
    const arYear = Number(state.director?.recruitYear ?? -1);
    const curYear = yearAt(state.t);
    const arLine = arOn ? `Auto recruit: ON (Spring; ${arYear === curYear ? 'already recruited this year' : 'eligible'})\n` : '';

    const acOn = !!state.director?.autoCrisis;
    const acWhy = String(state.director?.autoCrisisWhy ?? '').trim();
    const acLine = acOn ? `Auto crisis: ON${acWhy ? ` - last trigger: ${acWhy}` : ''}\n` : '';

    const aDrillOn = !!state.director?.autoDrills;
    const aDrillWhy = String(state.director?.autoDrillsWhy ?? '').trim();
    const aDrillLine = aDrillOn ? `Auto drills: ON${aDrillWhy ? ` - ${aDrillWhy}` : ''}\n` : '';

    const aut = autonomy01(state);
    const disPol = discipline01(state);
    const dis = dissent01(state);
    const effAut = effectiveAutonomy01(state);
    const comp = compliance01(state);
    const autLine = `Autonomy: ${Math.round(aut*100)}% (effective ${Math.round(effAut*100)}%) | Discipline: ${Math.round(disPol*100)}% | Dissent: ${Math.round(dis*100)}% (compliance x${comp.toFixed(2)})\n`;

    // Simple projections (explainability): "if the last ~8s trend holds, where will we be by season change / Winter?"
    const nPop = Math.max(1, state.kittens.length);
    const remSeason = secondsToNextSeason(state);
    const remWinter = secondsToNextWinter(state);
    const projFoodSeason = Math.max(0, Number(state.res.food ?? 0) + foodRate * remSeason);
    const projWarmSeason = Math.max(0, Number(state.res.warmth ?? 0) + warmthRate * remSeason);
    const projFoodWinter = Math.max(0, Number(state.res.food ?? 0) + foodRate * remWinter);
    const projWarmWinter = Math.max(0, Number(state.res.warmth ?? 0) + warmthRate * remWinter);
    const forecastLine = `Forecast (trends hold): end-season food ${fmt(projFoodSeason)} (${fmt(projFoodSeason/nPop)}/kitten), warmth ${fmt(projWarmSeason)} | at Winter food ${fmt(projFoodWinter)} (${fmt(projFoodWinter/nPop)}/kitten), warmth ${fmt(projWarmWinter)}\n`;

    seasonEl.textContent = `${season.name} - ${(season.phase*100).toFixed(0)}% (next season in ${nextSeasonEta}; winter in ${winterEta})\n` +
      seasonalNote +
      pfLine +
      autLine +
      amLine +
      abLine +
      adLine +
      aRatLine +
      arLine +
      acLine +
      aDrillLine +
      festLine +
      councilLine +
      drillLine +
      `Colony efficiency: ${(avgEff*100).toFixed(0)}% (hungry/tired/cold/health/mood slows work) | avg health ${(avgHealth*100).toFixed(0)}% | avg mood ${(avgMood*100).toFixed(0)}%\n` +
      `Trends: food ${fmtRate(foodRate)} | warmth ${fmtRate(warmthRate)} | threat ${fmtRate(threatRate)} | science ${fmtRate(scienceRate)}\n` +
      forecastLine +
      `Danger forecast: edible→0 in ${starveEtaEdible} | warmth→0 in ${freezeEta}\n` +
      `Preserved: jerky ${fmt(state.res.jerky ?? 0)} (no spoilage)\n` +
      (() => {
        const oc = state._lastFoodOvercap ?? { cap: foodStorageCap(state), food: state.res.food, mult: 1 };
        const mult = Number(oc.mult ?? 1);
        if (mult > 1.01) return `Storage: food cap ${fmt(oc.cap)} (overcap: spoilage x${mult.toFixed(2)})\n`;
        return `Storage: food cap ${fmt(oc.cap)}\n`;
      })() +
      `ETAs: to warmth target ${warmthToTargetEta} | to threat target ${threatTargetEta} | to RAID (100) ${raidEta}\n` +
      (nextUnlock ? `Next unlock: ${nextUnlock.name} @ ${nextUnlock.at} science (ETA ${nextUnlockEta})\n` : 'All unlocks achieved.\n') +
      projLine +
      `Reserves: food≥${getReserve(state,'food')} | wood≥${getReserve(state,'wood')} | science≥${getReserve(state,'science')} | tools≥${getReserve(state,'tools')} (AI avoids spending below)\n` +
      `Housing cap: ${housingCap(state)} | Palisade reduces threat growth.\n` +
      `Raid at threat ≥ 100.` + planLine;

    // Goals that actually matter
    const goals = [
      { ok: foodPerKitten >= targets.foodPerKitten, txt:`Stabilize food/kitten ≥ ${targets.foodPerKitten} (now ${fmt(foodPerKitten)})` },
      { ok: state.res.warmth >= targets.warmth, txt:`Maintain warmth ≥ ${targets.warmth} (now ${fmt(state.res.warmth)})` },
      { ok: state.res.threat <= targets.maxThreat, txt:`Keep threat ≤ ${targets.maxThreat} (now ${fmt(state.res.threat)})` },
      { ok: state.kittens.length < housingCap(state), txt:`Stay under housing cap (${state.kittens.length}/${housingCap(state)})` },
      { ok: state.res.science >= 200, txt:`Reach 200 science for Workshop (now ${fmt(state.res.science)})` },
      { ok: (state.res.tools ?? 0) >= state.kittens.length * 10, txt:`Build Tools ≥ 10×pop (now ${fmt(state.res.tools ?? 0)}/${(state.kittens.length*10).toFixed(0)})` },
      { ok: (state.res.jerky ?? 0) >= state.kittens.length * 20, txt:`Preserve Jerky ≥ 20×pop (now ${fmt(state.res.jerky ?? 0)}/${(state.kittens.length*20).toFixed(0)})` },
      { ok: !state.unlocked.granary || ((state.res.granaries ?? 0) >= 1), txt:`Build 1 granary (unlocks at 900 science; now ${(state.res.granaries ?? 0)})` },
      { ok: !state.unlocked.library || ((state.res.libraries ?? 0) >= 1), txt:`Build 1 library (unlocks at 1400 science; now ${(state.res.libraries ?? 0)})` },
      { ok: state.res.science >= 350, txt:`Reach 350 science for Farming (now ${fmt(state.res.science)})` },
    ];
    goalsEl.textContent = goals.map(g => `${g.ok?'[x]':'[ ]'} ${g.txt}`).join('\n');

    renderAdvisor(state, targets);
    renderCouncil(state, targets);
    renderFactions(state);

    unlocksEl.textContent = unlockDefs.map(u => `${state.seenUnlocks[u.id]?'[x]':'[ ]'} ${u.name} @ ${u.at} - ${u.desc}`).join('\n');

    // inputs
    state.rations = state.rations ?? 'Normal';
    el('rations').value = state.rations;
    const rat = getRations(state);
    el('rationsHint').textContent = `food use x${rat.foodUse.toFixed(2)} | hunger relief x${rat.hungerRelief.toFixed(2)}`;

    // Autonomy (central planning vs individual preference)
    const a = autonomy01(state);
    const effA = effectiveAutonomy01(state);
    const disNow = dissent01(state);
    const compNow = compliance01(state);

    const aPct = Math.round(a * 100);
    const aEl = el('autonomy');
    if (aEl) aEl.value = String(Math.round(aPct/5)*5);
    const ah = el('autonomyHint');
    if (ah) {
      const likeBonus = 6 + 10 * effA;
      const dislikePenalty = 4 + 8 * effA;
      const doc = doctrineKey(state);
      const docMul = (doc === 'Specialize') ? 1.18 : (doc === 'Rotate') ? 0.78 : 1.00;
      const roleMul = (1.10 - 0.35 * effA) * docMul;
      ah.textContent = `${aPct}% (effective ${Math.round(effA*100)}%) | likes +${likeBonus.toFixed(0)} / dislikes -${dislikePenalty.toFixed(0)} | role pressure x${roleMul.toFixed(2)} (${doc}) | dissent ${Math.round(disNow*100)}% (comp x${compNow.toFixed(2)})`;
    }

    // Discipline (cohesion / compliance)
    const d = discipline01(state);
    const dPct = Math.round(d * 100);
    const dEl = el('discipline');
    if (dEl) dEl.value = String(Math.round(dPct/5)*5);
    const dh = el('disciplineHint');
    if (dh) {
      const effAut = effectiveAutonomy01(state);
      const compNow = compliance01(state);
      dh.textContent = `${dPct}% | compliance x${compNow.toFixed(2)} | effective autonomy ${Math.round(effAut*100)}% | commitment x${coordinationMul(state).toFixed(2)} | morale cost (small)`;
    }

    // Work pace (global throughput vs fatigue lever)
    const wpMul = workPaceMul(state);
    const wpPct = Math.round(wpMul * 100);
    const wpEl = el('workPace');
    if (wpEl) wpEl.value = String(Math.round(wpPct/5)*5);
    const wph = el('workPaceHint');
    if (wph) {
      const moodDrift = wpMul > 1.02 ? `mood drift ↓` : (wpMul < 0.98 ? `mood drift ↑` : `mood steady`);
      wph.textContent = `${wpPct}% | output x${wpMul.toFixed(2)} | fatigue x${wpMul.toFixed(2)} | ${moodDrift}`;
    }

    // Director priorities (high-level policy weights)
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood:1.00, prioSafety:1.00, prioProgress:1.00 };
    if (!('prioFood' in state.director)) state.director.prioFood = 1.00;
    if (!('prioSafety' in state.director)) state.director.prioSafety = 1.00;
    if (!('prioProgress' in state.director)) state.director.prioProgress = 1.00;

    const prFoodMul = prioMul(state,'prioFood');
    const prSafetyMul = prioMul(state,'prioSafety');
    const prProgMul = prioMul(state,'prioProgress');

    const prFoodEl = el('prioFood');
    if (prFoodEl) prFoodEl.value = String(Math.round(prFoodMul*100/5)*5);
    const prFoodH = el('prioFoodHint');
    if (prFoodH) prFoodH.textContent = `${Math.round(prFoodMul*100)}% | biases Forage/Farm/PreserveFood scores`;

    const prSafetyEl = el('prioSafety');
    if (prSafetyEl) prSafetyEl.value = String(Math.round(prSafetyMul*100/5)*5);
    const prSafetyH = el('prioSafetyHint');
    if (prSafetyH) prSafetyH.textContent = `${Math.round(prSafetyMul*100)}% | biases Guard/StokeFire (+build infra blend)`;

    const prProgEl = el('prioProgress');
    if (prProgEl) prProgEl.value = String(Math.round(prProgMul*100/5)*5);
    const prProgH = el('prioProgressHint');
    if (prProgH) prProgH.textContent = `${Math.round(prProgMul*100)}% | biases Research/Tools/Workshop/Library (+infra blend)`;

    // Labor doctrine (specialization vs rotation)
    const doc = doctrineKey(state);
    const docSel = el('doctrine');
    if (docSel) docSel.value = doc;
    const docHint = el('doctrineHint');
    if (docHint) {
      const roleMul = (doc === 'Specialize') ? '↑ role pressure, ↓ boredom' : (doc === 'Rotate') ? '↓ role pressure, ↑ boredom, ↓ dissent' : 'baseline';
      docHint.textContent = roleMul;
    }

    el('sigBuild').checked = !!state.signals.BUILD;
    el('sigFood').checked = !!state.signals.FOOD;

    // Security unlock gates the ALARM director signal (otherwise it feels like a magic button).
    const alarmEnabled = !!state.unlocked.security;
    el('sigAlarm').disabled = !alarmEnabled;
    el('sigAlarm').checked = alarmEnabled ? !!state.signals.ALARM : false;
    el('alarmHint').textContent = alarmEnabled ? '' : '(unlock: Security @ 650 science)';
    el('targetFood').value = String(state.targets.foodPerKitten);
    el('targetWarmth').value = String(state.targets.warmth);
    el('targetThreat').value = String(state.targets.maxThreat);

    state.reserve = state.reserve ?? { food:0, wood:18, science:25, tools:0 };
    el('reserveFood').value = String(getReserve(state,'food'));
    el('reserveWood').value = String(getReserve(state,'wood'));
    el('reserveScience').value = String(getReserve(state,'science'));
    el('reserveTools').value = String(getReserve(state,'tools'));

    // Reserves hint: show current recommended seasonal values (even if Auto Reserves is OFF).
    const rr = recommendedReserves(state);
    const rrEl = el('reserveRecHint');
    if (rrEl) {
      const sn = String(rr?.season?.name ?? '');
      rrEl.textContent = `Recommended (${sn}): food≥${rr.food} | wood≥${rr.wood} | science≥${rr.science} | tools≥${rr.tools}`;
    }

    renderPolicy();
    renderRoleQuotas();

    // Plan debug (explainability for coordination)
    if (planDebugEl) {
      const p = state._lastPlan;
      if (!p) {
        planDebugEl.textContent = '-';
      } else {
        const order = ['Forage','Farm','PreserveFood','ChopWood','StokeFire','Guard','BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary','CraftTools','Research','Socialize','Loaf','Eat','Rest'];
        const lines = [];
        for (const a of order) {
          const want = p.desired?.[a] ?? 0;
          const have = p.assigned?.[a] ?? 0;
          if ((want|0) === 0 && (have|0) === 0) continue;
          const mark = have < want ? '!' : (have > want ? '~' : ' ');
          lines.push(`${mark} ${a.padEnd(12)} ${String(have).padStart(2)}/${String(want).padStart(2)}`);
        }

        // If sinks were blocked by reserves/inputs, surface a compact summary.
        const blocked = p.blocked ?? null;
        const blockedMsg = p.blockedMsg ?? null;
        const bKeys = blocked ? Object.keys(blocked).filter(k => (blocked[k] ?? 0) > 0) : [];
        if (bKeys.length) {
          lines.push('');
          lines.push('Blocked sinks (last second):');
          // Prefer showing blockers that the plan actually wanted, so the mismatch reads clearly.
          bKeys.sort((a,b)=> (p.desired?.[b] ?? 0) - (p.desired?.[a] ?? 0));
          const top = bKeys.slice(0, 6);
          for (const a of top) {
            const ct = blocked[a] ?? 0;
            const msg = String(blockedMsg?.[a] ?? '').trim();
            const short = msg ? msg.replace(/\s+/g,' ').slice(0, 64) : '';
            lines.push(`- ${a} x${ct}${short ? ` — ${short}` : ''}`);
          }
          if (bKeys.length > top.length) lines.push(`- (+${bKeys.length - top.length} more)`);
        }

        // Activity history: what actually happened recently (not what the plan wanted).
        // Rolling window of the last ~30 decision ticks.
        const hist = Array.isArray(state._actHist) ? state._actHist : [];
        if (hist.length >= 3) {
          const totals = Object.create(null);
          let totalKs = 0;
          for (const row of hist) {
            const asg = row?.assigned ?? {};
            for (const [a,ctRaw] of Object.entries(asg)) {
              const ct = Number(ctRaw ?? 0) || 0;
              if (ct <= 0) continue;
              totals[a] = (totals[a] ?? 0) + ct;
              totalKs += ct;
            }
          }

          const items = Object.entries(totals)
            .map(([a,ct]) => ({ a, ct, share: totalKs > 0 ? (ct / totalKs) : 0 }))
            .filter(x => x.ct > 0)
            .sort((x,y) => y.ct - x.ct);

          if (items.length) {
            lines.push('');
            lines.push(`Activity (last ${hist.length}s):`);
            const top = items.slice(0, 7);
            for (const it of top) {
              const pct = Math.round(it.share * 100);
              lines.push(`- ${it.a.padEnd(12)} ${pct.toString().padStart(3)}% (${it.ct})`);
            }
            if (items.length > top.length) lines.push(`- (+${items.length - top.length} more)`);
          }
        }

        // Decision mix history: how often the plan was overridden by hard rules/emergencies/commitment.
        const dh = Array.isArray(state._decHist) ? state._decHist : [];
        if (dh.length >= 3) {
          const tot = { rule:0, emergency:0, commit:0, score:0 };
          for (const row of dh) {
            const k = row?.kinds ?? {};
            tot.rule += Number(k.rule ?? 0) || 0;
            tot.emergency += Number(k.emergency ?? 0) || 0;
            tot.commit += Number(k.commit ?? 0) || 0;
            tot.score += Number(k.score ?? 0) || 0;
          }
          const sum = tot.rule + tot.emergency + tot.commit + tot.score;
          if (sum > 0) {
            const pct = (x)=>Math.round(100 * x / sum);
            lines.push('');
            lines.push(`Decision mix (last ${dh.length}s): rule ${pct(tot.rule)}% | emergency ${pct(tot.emergency)}% | commit ${pct(tot.commit)}% | score ${pct(tot.score)}%`);
          }
        }

        planDebugEl.textContent = lines.length ? lines.join('\n') : '-';
      }
    }

    // kittens
    kittensEl.innerHTML = '';
    for (let kidx=0; kidx<state.kittens.length; kidx++) {
      const k = state.kittens[kidx];
      const tr = document.createElement('tr');
      tr.dataset.kidx = String(kidx);
      tr.style.cursor = 'pointer';
      const top = topSkillInfo(k);
      const topSkills = Object.entries(k.skills).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,l])=>`${s}:${l}`).join(' ');
      const eff = efficiency(state, k);
      const mood = clamp01(Number(k.mood ?? 0.55));
      const griev = clamp01(Number(k.grievance ?? 0));
      const p = k.personality ?? genPersonality(k.id ?? 0);
      const likes = Array.isArray(p.likes) ? p.likes : [];
      const dislikes = Array.isArray(p.dislikes) ? p.dislikes : [];

      // Traits: a steady identity tag (kept short in-table; details in tooltip).
      const traits = Array.isArray(k.traits) ? k.traits : [];
      const buddy = buddyOf(state, k);
      const buddyShort = buddy ? `b#${buddy.id}` : '';
      const traitsShortBase = traits.length ? traits.join(',') : '-';
      const traitsShort = buddyShort ? `${traitsShortBase} · ${buddyShort}` : traitsShortBase;
      const traitLines = traitInfoList(k);
      const buddyLine = buddyShort ? `\nBuddy: #${buddy.id}` : '';
      const traitsTitle = traitLines.length
        ? `${traitLines.join(' | ')}${buddyLine}\nPrefs: ${likes.join(',') || '-'}${dislikes.length ? ` | hates ${dislikes.join(',')}` : ''}\nValues: ${valuesShort(k)}`
        : `Prefs: ${likes.join(',') || '-'}${dislikes.length ? ` | hates ${dislikes.join(',')}` : ''}${buddyLine}\nValues: ${valuesShort(k)}`;

      // Pref: show whether the current task aligns with the kitten's likes/dislikes.
      // Always show value-alignment vs current colony focus (explains mood/dissent drift under planning).
      // Also surface an "Autonomy sampled" tag if they didn't pick the #1 scored action this tick.
      const align = valuesAlignment01(state, k);
      const vals = valuesShort(k);
      const prefParts = [];
      if (likes.includes(k.task)) prefParts.push('Like');
      if (dislikes.includes(k.task)) prefParts.push('Dislike');
      prefParts.push(`Align ${Math.round(align*100)}%`);
      const autoFresh = (k._autonomyPickNote && (state.t - Number(k._autonomyPickAt ?? 0)) < 2);
      if (autoFresh) prefParts.push('Autonomy');
      const pref = prefParts.join(' / ');

      const d = (k && typeof k === 'object') ? (k._lastDecision ?? null) : null;
      const kind = String(d?.kind ?? 'score');
      const decLabel = (kind === 'rule') ? 'RULE' : (kind === 'emergency') ? 'EMERG' : (kind === 'commit') ? 'COMMIT' : '';
      const decHtml = decLabel ? `<span class="tag" title="Decision override (${decLabel})">${decLabel}</span> ` : '';

      const taskTitleParts = [];
      if (decLabel) taskTitleParts.push(`decision: ${decLabel}`);
      if (k._fallbackTo) taskTitleParts.push(`fallback → ${k._fallbackTo}`);
      // If we have a recent blocked snapshot, include the short reason in tooltip.
      const lb = k._lastBlocked;
      if (lb && typeof lb === 'object' && (state.t - Number(lb.at ?? -9999)) <= 6) {
        const msg = String(lb.msg ?? '').replace(/\s+/g,' ').slice(0, 80);
        if (msg) taskTitleParts.push(`blocked: ${msg}`);
      }
      if (d?.best && d.best !== k.task) taskTitleParts.push(`top score was ${d.best} (autonomy sampled)`);
      const taskTitle = taskTitleParts.join(' | ');

      tr.innerHTML = `
        <td>${k.id}</td>
        <td title="${escapeHtml(k.roleWhy ?? '')}">${escapeHtml(k.role ?? '-')}</td>
        <td title="${escapeHtml(taskTitle)}${(k._mentor && k.task==='Mentor' && k._mentor.why) ? (' | ' + escapeHtml(String(k._mentor.why))) : ''}">${decHtml}${k.task}${(k._mentor && k.task==='Mentor') ? (' → #' + k._mentor.id + ' ' + escapeHtml(k._mentor.skill)) : ''}${k._fallbackTo ? (' → ' + escapeHtml(k._fallbackTo)) : ''}</td>
        <td>${fmt(k.energy*100)}%</td>
        <td>${fmt(k.hunger*100)}%</td>
        <td title="Health (sickness/injury reduces efficiency)">${fmt((k.health ?? 1)*100)}%</td>
        <td title="Mood (personality alignment + stress + aptitude fit; small effect on efficiency)">${fmt(mood*100)}%</td>
        <td title="Grievance (slow-burn resentment; contributes to dissent pressure)">${fmt(griev*100)}%</td>
        <td title="Work effectiveness (hungry/tired/cold/health/mood)">${fmt(eff*100)}%</td>
        <td title="Aptitude (highest skill level) - kittens tend to prefer this kind of work">${escapeHtml(`${top.skill ?? '-'}`)}:${top.level}</td>
        <td>${topSkills}</td>
        <td title="${escapeHtml(traitsTitle)}">${escapeHtml(traitsShort)}</td>
        <td title="Preference + policy fit. Values: ${escapeHtml(vals)} | focus-fit ${Math.round(align*100)}% | (plus autonomy sampling flag)">${escapeHtml(pref)}</td>
        <td class="why">${escapeHtml(k.why ?? '')}</td>
      `;
      kittensEl.appendChild(tr);
    }

    // safety rules
    rulesEl.innerHTML = '';
    state.rules.forEach((r, idx) => {
      const box = document.createElement('div');
      box.className = 'rule';
      box.innerHTML = `
        <div class="top">
          <div class="row">
            <label class="small"><input type="checkbox" data-act="toggle" data-i="${idx}"> enabled</label>
            <span class="tag">#${idx+1}</span>
          </div>
          <div class="row">
            <button class="btn" data-act="up" data-i="${idx}">↑</button>
            <button class="btn" data-act="down" data-i="${idx}">↓</button>
            <button class="btn bad" data-act="del" data-i="${idx}">Delete</button>
          </div>
        </div>
        <div style="height:8px"></div>
        <div class="row">
          <span class="small">IF</span>
          ${condEditor(r.cond, idx)}
          <span class="small">THEN</span>
          ${actEditor(r.act, idx)}
        </div>
      `;
      rulesEl.appendChild(box);
      box.querySelector('input[data-act="toggle"]').checked = !!r.enabled;
    });

    logEl.textContent = state.log.slice(-40).join('\n');
    logEl.scrollTop = logEl.scrollHeight;

    // Keep inspectors in sync with latest snapshots.
    renderInspect();
    renderPatchNotes();
    renderSocial();
  }

  function escapeHtml(s){
    return String(s)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#39;');
  }
  function kittenCost(){ const n = state.kittens.length; return Math.floor(60 * Math.pow(1.27, Math.max(0, n-3))); }
  function log(msg){ state.log.push(`[${fmt(state.t)}] ${msg}`); }

  function summarizePlan(desired){
    const order = ['Care','Socialize','Forage','Farm','PreserveFood','ChopWood','StokeFire','Guard','BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary','CraftTools','Mentor','Research'];
    return order
      .map(a => ({ a, n: desired[a] ?? 0 }))
      .filter(x => x.n > 0)
      .map(x => `${x.a}×${x.n}`)
      .join('  ');
  }

  function renderPolicy(){
    // Migration safety
    state.policyMult = state.policyMult ?? { Socialize:1, Care:1, Forage:1, PreserveFood:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Mentor:1, Research:1 };

    const rows = [
      ['Socialize','Socialize'],
      ['Care','Care'],
      ['Forage','Forage'],
      ['Preserve','PreserveFood'],
      ['Farm','Farm'],
      ['ChopWood','ChopWood'],
      ['StokeFire','StokeFire'],
      ['Guard','Guard'],
      ['BuildHut','BuildHut'],
      ['BuildPalisade','BuildPalisade'],
      ['BuildGranary','BuildGranary'],
      ['BuildWorkshop','BuildWorkshop'],
      ['BuildLibrary','BuildLibrary'],
      ['CraftTools','CraftTools'],
      ['Mentor','Mentor'],
      ['Research','Research'],
    ];

    const lock = (a) =>
      (a === 'Farm' && !state.unlocked.farm) ||
      (a === 'PreserveFood' && !state.unlocked.construction) ||
      (a === 'CraftTools' && !state.unlocked.workshop) ||
      (a === 'Mentor' && !state.unlocked.library) ||
      (a === 'BuildWorkshop' && (!state.unlocked.construction || !state.unlocked.workshop)) ||
      (a === 'BuildLibrary' && (!state.unlocked.construction || !state.unlocked.library)) ||
      (a === 'BuildGranary' && (!state.unlocked.construction || !state.unlocked.granary)) ||
      ((a === 'BuildHut' || a === 'BuildPalisade') && !state.unlocked.construction);

    const line = (label, a) => {
      const v = Number(state.policyMult[a] ?? 1);
      const val = Math.max(0, Math.min(2, Number.isFinite(v)?v:1));
      state.policyMult[a] = val;
      const disabled = lock(a);
      return `
        <div class="row" style="justify-content:space-between; gap:10px; margin-bottom:6px">
          <span class="small" style="min-width:110px">${label}</span>
          <div class="row" style="gap:6px">
            <button class="btn" data-pol="dec" data-a="${a}" ${disabled?'disabled':''}>-</button>
            <span class="small" style="display:inline-block; width:44px; text-align:center">${val.toFixed(2)}</span>
            <button class="btn" data-pol="inc" data-a="${a}" ${disabled?'disabled':''}>+</button>
            <span class="small" style="opacity:.85">(0..2)</span>
          </div>
        </div>`;
    };

    const plan = state._lastPlan ?? null;
    const desiredNow = plan?.desired ? summarizePlan(plan.desired) : '';
    const desiredBase = plan?.desiredBase ? summarizePlan(plan.desiredBase) : '';

    const head = (desiredNow || desiredBase) ? `
      <div class="small" style="margin-bottom:8px; opacity:.9">
        <b>Plan preview</b>
        <div class="why" style="margin-top:6px">${escapeHtml(desiredNow ? ('with policy: ' + desiredNow) : 'with policy: -')}${desiredBase ? ('\nwithout policy: ' + desiredBase) : ''}</div>
        <div class="small" style="opacity:.8; margin-top:6px">Tip: policy multipliers bias the colony plan; individual kittens may still diverge due to Autonomy, traits, and needs.</div>
      </div>
    ` : '';

    policyEl.innerHTML = head + rows.map(([label,a]) => line(label,a)).join('');
  }

  function renderRoleQuotas(){
    if (!roleQuotasEl) return;
    // Migration safe
    state.roleQuota = state.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
    for (const k of ['Forager','Farmer','Woodcutter','Firekeeper','Guard','Builder','Scholar','Toolsmith']) {
      const v = Number(state.roleQuota[k] ?? 0);
      state.roleQuota[k] = (Number.isFinite(v) ? Math.max(0, Math.min(99, v|0)) : 0);
    }

    const n = state.kittens.length;
    // Count current roles for display (post-update each frame).
    const counts = Object.create(null);
    for (const k of state.kittens) counts[k.role] = (counts[k.role] ?? 0) + 1;

    const rows = [
      ['Forager','Forager', () => true],
      ['Farmer','Farmer', () => !!state.unlocked.farm],
      ['Woodcutter','Woodcutter', () => true],
      ['Firekeeper','Firekeeper', () => true],
      ['Guard','Guard', () => true],
      ['Builder','Builder', () => !!state.unlocked.construction],
      ['Scholar','Scholar', () => true],
      ['Toolsmith','Toolsmith', () => !!state.unlocked.workshop],
    ];

    const line = (label, roleId, okFn) => {
      const locked = !okFn();
      const quota = state.roleQuota[roleId] ?? 0;
      const have = counts[roleId] ?? 0;
      return `
        <div class="row" style="justify-content:space-between; gap:10px; margin-bottom:6px">
          <span class="small" style="min-width:110px" title="Current in role">${label}</span>
          <div class="row" style="gap:6px">
            <span class="small" style="opacity:.85; width:70px; text-align:right">have ${have}/${n}</span>
            <button class="btn" data-rq="dec" data-role="${roleId}" ${locked?'disabled':''}>-</button>
            <span class="small" style="display:inline-block; width:44px; text-align:center">${String(quota).padStart(2,'0')}</span>
            <button class="btn" data-rq="inc" data-role="${roleId}" ${locked?'disabled':''}>+</button>
            <span class="small" style="opacity:.85">quota</span>
          </div>
        </div>`;
    };

    const footer = `<div class="row" style="margin-top:8px; justify-content:space-between">
      <span class="small" style="opacity:.9">Tip: quotas work best with policy multipliers (e.g., set Builder quota=1 + BuildHut mult=1.5).</span>
      <button class="btn" id="btnRoleQuotaReset">Reset</button>
    </div>`;

    roleQuotasEl.innerHTML = rows.map(([label,id,ok]) => line(label,id,ok)).join('') + footer;

    // One-off bind for the reset button inside this panel.
    const rb = roleQuotasEl.querySelector('#btnRoleQuotaReset');
    if (rb) rb.onclick = () => {
      state.roleQuota = { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
      log('Role quotas reset (all 0).');
      save();
      render();
    };
  }

  function condEditor(cond, idx){
    const type = cond.type;
    const opts = [
      ['always','always'],
      ['hungry_gt','hungry >'],
      ['tired_gt','tired >'],
      ['health_lt','health <'],
      ['food_lt','food <'],
      ['wood_lt','wood <'],
      ['warmth_lt','warmth <'],
      ['threat_gt','threat >'],
      ['foodperkitten_lt','food/kitten <'],
      ['signal','signal(...)'],
      ['threat_gt_or_alarm','threat> OR ALARM'],
    ];
    const sel = `<select data-act="condType" data-i="${idx}">${opts.map(([v,l])=>`<option value="${v}" ${v===type?'selected':''}>${l}</option>`).join('')}</select>`;
    let extra = '';
    if (['hungry_gt','tired_gt','health_lt'].includes(type)) extra = `<input type="number" min="0" max="1" step="0.05" value="${cond.v}" data-act="condV" data-i="${idx}" style="width:90px">`;
    else if (['food_lt','wood_lt','warmth_lt','threat_gt','foodperkitten_lt'].includes(type)) extra = `<input type="number" min="0" step="1" value="${cond.v}" data-act="condV" data-i="${idx}" style="width:90px">`;
    else if (type === 'signal') extra = `<select data-act="condV" data-i="${idx}">${['BUILD','FOOD','ALARM'].map(s=>`<option value="${s}" ${String(cond.v)===s?'selected':''}>${s}</option>`).join('')}</select>`;
    return sel + extra;
  }

  function actEditor(act, idx){
    const opts = ['Eat','Rest','Loaf','Socialize','Care','Forage','PreserveFood','ChopWood','StokeFire','Guard','Research'];
    if (state.unlocked.library) opts.push('Mentor');
    if (state.unlocked.workshop) opts.push('CraftTools');
    if (state.unlocked.construction && state.unlocked.workshop) opts.push('BuildWorkshop');
    if (state.unlocked.construction && state.unlocked.library) opts.push('BuildLibrary');
    if (state.unlocked.farm) opts.push('Farm');
    if (state.unlocked.construction) {
      opts.push('BuildHut','BuildPalisade');
      if (state.unlocked.granary) opts.push('BuildGranary');
    }
    return `<select data-act="actType" data-i="${idx}">${opts.map(v=>`<option value="${v}" ${act.type===v?'selected':''}>${v}</option>`).join('')}</select>`;
  }

  // --- Buttons / Inputs
  document.getElementById('btnPause').addEventListener('click', () => {
    state.paused = !state.paused;
    document.getElementById('btnPause').textContent = state.paused ? 'Resume' : 'Pause';
    save();
  });

  document.getElementById('btnReset').addEventListener('click', () => {
    if (!confirm('Hard reset?')) return;
    localStorage.removeItem(SAVE_KEY);
    state = defaultState();
    render();
  });

  document.getElementById('btnTick').addEventListener('click', () => { for (let i=0;i<100;i++) step(0.1); render(); });

  // --- Save export/import (quality-of-life; makes it easy to share saves + reproduce bugs)
  function getSaveString(){
    // Force a clean snapshot first.
    save();
    return localStorage.getItem(SAVE_KEY) ?? '';
  }

  async function copyToClipboard(text){
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}

    // Fallback (older browsers / insecure context)
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch { return false; }
  }

  function downloadText(filename, text){
    const blob = new Blob([text], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }

  document.getElementById('btnExport').addEventListener('click', async () => {
    const txt = getSaveString();
    if (!txt) { log('No save data found to export.'); render(); return; }

    const ok = await copyToClipboard(txt);
    if (ok) log('Save exported: copied to clipboard. (Also downloading a .json file)');
    else log('Save exported: clipboard copy failed (downloaded a .json file instead).');

    const stamp = new Date().toISOString().replaceAll(':','-');
    downloadText(`kitten-knight-civ-save-${stamp}.json`, txt);
    render();
  });

  document.getElementById('btnImport').addEventListener('click', () => {
    const pasted = prompt('Paste a save string (JSON). This will overwrite your current save.');
    if (!pasted) return;
    try {
      const obj = JSON.parse(pasted);
      if (!obj || !obj.res || !obj.kittens || !obj.rules) throw new Error('Missing required keys.');
      localStorage.setItem(SAVE_KEY, JSON.stringify(obj));
      state = load() ?? defaultState();
      log('Save imported successfully.');
      render();
    } catch (e) {
      log(`Import failed: ${(e && e.message) ? e.message : 'invalid JSON'}`);
      render();
    }
  });

  function snapshotDirectorSettings(){
    state.director = state.director ?? { projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    return {
      mode: state.mode,
      rations: state.rations,
      targets: structuredClone(state.targets ?? { foodPerKitten:120, warmth:60, maxThreat:70 }),
      reserve: structuredClone(state.reserve ?? { food:0, wood:18, science:25, tools:0 }),
      policyMult: structuredClone(state.policyMult ?? {}),
      roleQuota: structuredClone(state.roleQuota ?? {}),
      signals: structuredClone(state.signals ?? { BUILD:false, FOOD:false, ALARM:false }),
      director: {
        projectFocus: String(state.director.projectFocus ?? 'Auto'),
        curfew: !!state.director.curfew,
        autonomy: clamp01(Number(state.director.autonomy ?? 0.60)),
        discipline: clamp01(Number(state.director.discipline ?? 0.40)),
        workPace: Math.max(0.8, Math.min(1.2, Number(state.director.workPace ?? 1.00) || 1.00)),
        doctrine: doctrineKey(state),
        prioFood: prioMul(state,'prioFood'),
        prioSafety: prioMul(state,'prioSafety'),
        prioProgress: prioMul(state,'prioProgress'),
      },
    };
  }

  function applyDirectorSettings(snap){
    if (!snap) return;
    state.mode = snap.mode ?? state.mode;
    state.rations = snap.rations ?? state.rations;
    state.targets = snap.targets ?? state.targets;
    state.reserve = snap.reserve ?? state.reserve;
    state.policyMult = snap.policyMult ?? state.policyMult;
    state.roleQuota = snap.roleQuota ?? state.roleQuota;
    state.signals = snap.signals ?? state.signals;

    // Restore director knobs (project focus + autonomy/discipline/work pace) if present.
    state.director = state.director ?? { projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    if (snap.director) {
      if ('projectFocus' in snap.director) state.director.projectFocus = String(snap.director.projectFocus ?? 'Auto');
      if ('curfew' in snap.director) state.director.curfew = !!snap.director.curfew;
      if ('autonomy' in snap.director) state.director.autonomy = clamp01(Number(snap.director.autonomy ?? 0.60));
      if ('discipline' in snap.director) state.director.discipline = clamp01(Number(snap.director.discipline ?? 0.40));
      if ('workPace' in snap.director) state.director.workPace = Math.max(0.8, Math.min(1.2, Number(snap.director.workPace ?? 1.00) || 1.00));
      if ('prioFood' in snap.director) state.director.prioFood = Math.max(0.50, Math.min(1.50, Number(snap.director.prioFood ?? 1.00) || 1.00));
      if ('prioSafety' in snap.director) state.director.prioSafety = Math.max(0.50, Math.min(1.50, Number(snap.director.prioSafety ?? 1.00) || 1.00));
      if ('prioProgress' in snap.director) state.director.prioProgress = Math.max(0.50, Math.min(1.50, Number(snap.director.prioProgress ?? 1.00) || 1.00));
      if ('doctrine' in snap.director) {
        const v = String(snap.director.doctrine ?? 'Balanced');
        state.director.doctrine = (v === 'Specialize' || v === 'Rotate' || v === 'Balanced') ? v : 'Balanced';
      }
    }

    // Safety: ALARM is gated by Security unlock.
    if (!state.unlocked.security) state.signals.ALARM = false;
  }

  // --- "On-state" helpers
  // These let us preview policy toggles on cloned states (used by Council/Advisor) without mutating global state or saving.
  function snapshotDirectorSettingsOn(st){
    const prev = state;
    try { state = st; return snapshotDirectorSettings(); }
    finally { state = prev; }
  }

  function applyDirectorSettingsOn(st, snap){
    const prev = state;
    try { state = st; applyDirectorSettings(snap); }
    finally { state = prev; }
  }

  function setPolicyOn(st, mult, note){
    // Same structure as setPolicy(), but does NOT log/save/render (safe for previews).
    st.policyMult = {
      Socialize: mult.Socialize ?? 1,
      Care: mult.Care ?? 1,
      Forage: mult.Forage ?? 1,
      Farm: mult.Farm ?? 1,
      PreserveFood: mult.PreserveFood ?? 1,
      ChopWood: mult.ChopWood ?? 1,
      StokeFire: mult.StokeFire ?? 1,
      Guard: mult.Guard ?? 1,
      BuildHut: mult.BuildHut ?? 1,
      BuildPalisade: mult.BuildPalisade ?? 1,
      BuildGranary: mult.BuildGranary ?? 1,
      BuildWorkshop: mult.BuildWorkshop ?? 1,
      BuildLibrary: mult.BuildLibrary ?? 1,
      CraftTools: mult.CraftTools ?? 1,
      Mentor: mult.Mentor ?? 1,
      Research: mult.Research ?? 1,
    };
    // Keep note for debugging on cloned states if desired.
    if (note) st._lastPolicyNote = String(note);
  }

  function setWinterPrep(on, st = state){
    // NOTE: this is intentionally "pure-able" so we can preview it on cloned states (Council/Advisor).
    // When st === global state, we also save + re-render; otherwise we just mutate the passed object.
    const isGlobal = (st === state);

    st.director = st.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto' };
    if (on && !st.director.winterPrep) {
      // Save current director knobs so the player can cleanly revert.
      st.director.saved = snapshotDirectorSettingsOn(st);

      const n = st.kittens.length;
      // Mode stays as-is; Winter Prep is intended as an overlay (so you can prep while in Expand/Advance).
      // But we do gently bias the targets + reserves so the plan/scoring naturally shifts.
      st.targets.foodPerKitten = Math.max(st.targets.foodPerKitten ?? 120, 155);
      st.targets.warmth = Math.max(st.targets.warmth ?? 60, 72);

      // Reserves: don't let builders/crafters drain the winter lifelines.
      st.reserve = st.reserve ?? { food:0, wood:18, science:25, tools:0 };
      st.reserve.food = Math.max(st.reserve.food ?? 0, 70 * n);
      st.reserve.wood = Math.max(st.reserve.wood ?? 0, 28);
      st.reserve.science = Math.max(st.reserve.science ?? 0, 25);
      // Keep a small tool buffer so library building doesn't nuke productivity during winter.
      st.reserve.tools = Math.max(st.reserve.tools ?? 0, st.unlocked.workshop ? (5 * n) : 0);

      // Policy: prioritize food + warmth + threat control, pause shiny projects.
      // (Players can still override with multipliers or safety rules.)
      setPolicyOn(st, { Forage:1.35, Farm:1.35, PreserveFood:1.30, ChopWood:1.25, StokeFire:1.55, Guard:1.15, BuildHut:0.55, BuildPalisade:1.00, BuildGranary:1.10, BuildWorkshop:0.55, BuildLibrary:0.45, CraftTools:0.65, Research:0.55 }, 'Winter Prep ON: raise buffers + shift labor to food/wood/fire (and preserve surplus) so you do not spiral in Winter.');

      // Gentle specialization target: keep at least 1 Firekeeper once pop grows.
      st.roleQuota = st.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
      if (n >= 4) st.roleQuota.Firekeeper = Math.max(st.roleQuota.Firekeeper ?? 0, 1);

      st.director.winterPrep = true;
      if (isGlobal) {
        save();
        render();
      }
    } else if (!on && st.director.winterPrep) {
      // Revert all director knobs back to snapshot.
      const snap = st.director.saved;
      applyDirectorSettingsOn(st, snap);
      st.director.saved = null;
      st.director.winterPrep = false;
      if (isGlobal) {
        log('Winter Prep OFF: restored previous director settings.');
        save();
        render();
      }
    }
  }

  function setCrisisProtocol(on, st = state){
    const isGlobal = (st === state);

    st.director = st.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto' };
    if (on && !st.director.crisis) {
      st.director.crisisSaved = snapshotDirectorSettingsOn(st);

      const n = Math.max(1, st.kittens.length);
      st.mode = 'Survive';
      st.rations = 'Tight';

      // Targets: stabilize before anything else.
      st.targets.foodPerKitten = Math.max(st.targets.foodPerKitten ?? 120, 140);
      st.targets.warmth = Math.max(st.targets.warmth ?? 60, 66);
      st.targets.maxThreat = Math.min(st.targets.maxThreat ?? 70, 60);

      // Signals: force food focus; raise ALARM if the tech exists.
      st.signals = st.signals ?? { BUILD:false, FOOD:false, ALARM:false };
      st.signals.FOOD = true;
      st.signals.BUILD = false;
      st.signals.ALARM = st.unlocked.security ? true : false;

      // Reserves: clamp spending so the colony can't "eat" its own lifelines.
      st.reserve = st.reserve ?? { food:0, wood:18, science:25, tools:0 };
      st.reserve.food = Math.max(getReserve(st,'food'), Math.round((90 * n) / 10) * 10);
      st.reserve.wood = Math.max(getReserve(st,'wood'), 26);
      st.reserve.science = Math.max(getReserve(st,'science'), 25);
      st.reserve.tools = Math.max(getReserve(st,'tools'), 0);

      // Policy: heavy stabilization, almost no shiny sinks.
      setPolicyOn(st, { Forage:1.65, Farm:1.55, PreserveFood:0.60, ChopWood:1.15, StokeFire:1.70, Guard:1.45, BuildHut:0.10, BuildPalisade:0.65, BuildGranary:0.10, BuildWorkshop:0.00, BuildLibrary:0.00, CraftTools:0.00, Research:0.10 }, 'Crisis Protocol ON: clamp spending + force stabilization (food/warmth/threat). Toggle OFF once stable.');

      // Gentle role steering: keep at least one guard + firekeeper if population supports it.
      st.roleQuota = st.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
      if (n >= 4) st.roleQuota.Firekeeper = Math.max(st.roleQuota.Firekeeper ?? 0, 1);
      if (n >= 5) st.roleQuota.Guard = Math.max(st.roleQuota.Guard ?? 0, 1);

      st.director.crisis = true;
      if (isGlobal) {
        save();
        render();
      }
    } else if (!on && st.director.crisis) {
      const snap = st.director.crisisSaved;
      applyDirectorSettingsOn(st, snap);
      st.director.crisisSaved = null;
      st.director.crisis = false;
      if (isGlobal) {
        log('Crisis Protocol OFF: restored previous director settings.');
        save();
        render();
      }
    }
  }

  function setCurfew(on, st = state){
    // Simple governance lever: reduces threat growth but costs morale.
    const isGlobal = (st === state);
    st.director = st.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, curfew:false, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto' };
    const prev = !!st.director.curfew;
    st.director.curfew = !!on;
    if (isGlobal && prev !== !!on) {
      log(`Curfew → ${on ? 'ON' : 'OFF'} (${on ? 'threat grows slower, morale drifts down' : 'normal civic life resumes'})`);
      save();
      render();
    }
  }

  const curBtn = document.getElementById('btnCurfew');
  if (curBtn) curBtn.addEventListener('click', () => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, curfew:false, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    setCurfew(!state.director.curfew);
  });

  document.getElementById('btnWinterPrep').addEventListener('click', () => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    setWinterPrep(!state.director.winterPrep);
  });

  document.getElementById('btnCrisis').addEventListener('click', () => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    setCrisisProtocol(!state.director.crisis);
  });

  const festEl = document.getElementById('btnFestival');
  if (festEl) festEl.addEventListener('click', () => {
    state.effects = state.effects ?? { festivalUntil: 0, councilUntil: 0 };
    const res = holdFestival(state);
    log(res.msg);
    save();
    render();
  });

  const councilEl = document.getElementById('btnCouncil');
  if (councilEl) councilEl.addEventListener('click', () => {
    state.effects = state.effects ?? { festivalUntil: 0, councilUntil: 0, drillUntil: 0 };
    const res = holdCouncil(state);
    log(res.msg);
    save();
    render();
  });

  const drillEl = document.getElementById('btnDrill');
  if (drillEl) drillEl.addEventListener('click', () => {
    state.effects = state.effects ?? { festivalUntil: 0, councilUntil: 0, drillUntil: 0 };
    const res = runDrills(state);
    log(res.msg);
    save();
    render();
  });

  const autoWpEl = document.getElementById('autoWinterPrep');
  if (autoWpEl) autoWpEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoWinterPrep = !!e.target.checked;
    log(`Auto Winter Prep → ${state.director.autoWinterPrep ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoFoodEl = document.getElementById('autoFoodCrisis');
  if (autoFoodEl) autoFoodEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoFoodCrisis = !!e.target.checked;
    log(`Auto Food Crisis → ${state.director.autoFoodCrisis ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoResEl = document.getElementById('autoReserves');
  if (autoResEl) autoResEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoBuildPush:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoReserves = !!e.target.checked;
    log(`Auto Reserves → ${state.director.autoReserves ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoBuildEl = document.getElementById('autoBuildPush');
  if (autoBuildEl) autoBuildEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoBuildPush:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoBuildPush = !!e.target.checked;
    log(`Auto Build Push → ${state.director.autoBuildPush ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoModeEl = document.getElementById('autoMode');
  if (autoModeEl) autoModeEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoMode = !!e.target.checked;
    // Allow an immediate switch when toggled on.
    if (state.director.autoMode) state.director.autoModeNextChangeAt = 0;
    log(`Auto Mode → ${state.director.autoMode ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoDoctrineEl = document.getElementById('autoDoctrine');
  if (autoDoctrineEl) autoDoctrineEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', projectFocus:'Auto', autonomy: 0.60, workPace: 1.00, doctrine:'Balanced' };
    state.director.autoDoctrine = !!e.target.checked;
    // Allow an immediate switch when toggled on.
    if (state.director.autoDoctrine) state.director.autoDoctrineNextChangeAt = 0;
    log(`Auto Doctrine → ${state.director.autoDoctrine ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoRationsEl = document.getElementById('autoRations');
  if (autoRationsEl) autoRationsEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', projectFocus:'Auto', autonomy: 0.60, workPace: 1.00, doctrine:'Balanced' };
    state.director.autoRations = !!e.target.checked;
    // Allow an immediate change when toggled on.
    if (state.director.autoRations) state.director.autoRationsNextChangeAt = 0;
    if (!state.director.autoRations) state.director.autoRationsWhy = '';
    log(`Auto Rations → ${state.director.autoRations ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoRecruitEl = document.getElementById('autoRecruit');
  if (autoRecruitEl) autoRecruitEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoRecruit:false, recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, workPace: 1.00 };
    state.director.autoRecruit = !!e.target.checked;
    log(`Auto Recruit → ${state.director.autoRecruit ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoCrisisEl = document.getElementById('autoCrisis');
  if (autoCrisisEl) autoCrisisEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRecruit:false, autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, workPace: 1.00 };
    state.director.autoCrisis = !!e.target.checked;
    // Reset trigger state so toggling on doesn't unexpectedly auto-disable a manual crisis.
    if (!state.director.autoCrisis) {
      state.director.autoCrisisTriggered = false;
      state.director.autoCrisisWhy = '';
    }
    log(`Auto Crisis → ${state.director.autoCrisis ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoDrillsEl = document.getElementById('autoDrills');
  if (autoDrillsEl) autoDrillsEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRecruit:false, autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, workPace: 1.00 };
    state.director.autoDrills = !!e.target.checked;
    if (state.director.autoDrills) state.director.autoDrillsNextAt = 0;
    state.director.autoDrillsWhy = '';
    log(`Auto Drills → ${state.director.autoDrills ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const pfEl = document.getElementById('projectFocus');
  if (pfEl) pfEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.projectFocus = String(e.target.value || 'Auto');
    log(`Project focus → ${state.director.projectFocus}`);
    save();
    render();
  });

  document.getElementById('btnAddKitten').addEventListener('click', () => {
    const cost = kittenCost();
    if (state.res.food < cost) { log(`Need ${cost} food for a kitten.`); render(); return; }
    if (state.kittens.length >= housingCap(state)) { log(`No housing. Build huts.`); render(); return; }
    state.res.food -= cost;
    const id = state.kittens.length ? Math.max(...state.kittens.map(k=>k.id))+1 : 1;
    state.kittens.push(makeKitten(id));
    log(`New kitten joined! (#${id})`);
    render();
  });

  document.getElementById('modeSurvive').addEventListener('click', () => setMode('Survive'));
  document.getElementById('modeExpand').addEventListener('click', () => setMode('Expand'));
  document.getElementById('modeDefend').addEventListener('click', () => setMode('Defend'));
  document.getElementById('modeResearch').addEventListener('click', () => setMode('Advance'));

  function chooseAutoMode(s){
    const season = seasonAt(s.t);
    const targets = seasonTargets(s);
    const n = Math.max(1, s.kittens?.length ?? 1);
    const foodPerKitten = ediblePerKitten(s);
    const warmth = Number(s.res?.warmth ?? 0);
    const threat = Number(s.res?.threat ?? 0);
    const cap = housingCap(s);

    // Threat spikes should get immediate attention.
    if (s.signals?.ALARM || threat > targets.maxThreat * 1.15) {
      return { mode: 'Defend', why: s.signals?.ALARM ? 'ALARM active' : `threat high (${fmt(threat)} > ${(targets.maxThreat*1.15).toFixed(0)})` };
    }

    // Hard survival checks.
    if (season.name === 'Winter' && warmth < (targets.warmth - 8)) {
      return { mode: 'Survive', why: `winter warmth low (${fmt(warmth)} < ${targets.warmth-8})` };
    }
    if (foodPerKitten < targets.foodPerKitten * 0.75) {
      return { mode: 'Survive', why: `food/kitten low (${fmt(foodPerKitten)} < ${(targets.foodPerKitten*0.75).toFixed(0)})` };
    }

    // Housing pressure: expand.
    if ((s.kittens?.length ?? 0) >= cap || s.signals?.BUILD) {
      return { mode: 'Expand', why: (s.kittens?.length ?? 0) >= cap ? `housing cap (${s.kittens.length}/${cap})` : 'BUILD push' };
    }

    // If stable, push tech/industry.
    const stableFood = foodPerKitten >= targets.foodPerKitten * 1.02;
    const stableWarmth = warmth >= targets.warmth;
    const stableThreat = threat <= targets.maxThreat * 0.95;

    if (stableFood && stableWarmth && stableThreat) {
      // If tools are lagging, Advance tends to self-correct via workshop/craft/research.
      if (s.unlocked?.workshop && (Number(s.res?.tools ?? 0) < n * 8) && (Number(s.res?.science ?? 0) > 120)) {
        return { mode: 'Advance', why: `stable + tools behind (${fmt(s.res.tools ?? 0)}/${(n*8).toFixed(0)})` };
      }
      return { mode: 'Advance', why: 'stable basics → push tech' };
    }

    // Default: Survive (keeps buffers healthy without overcommitting).
    return { mode: 'Survive', why: 'not clearly stable yet' };
  }

  function chooseAutoRations(s){
    const targets = seasonTargets(s);
    const n = Math.max(1, s.kittens?.length ?? 1);
    const foodPerKitten = ediblePerKitten(s);
    const dis = dissent01(s);

    // Tight: when food is genuinely scary.
    if (foodPerKitten < targets.foodPerKitten * 0.82) {
      return { rations: 'Tight', why: `food/kitten ${fmt(foodPerKitten)} < ${(targets.foodPerKitten*0.82).toFixed(0)}` };
    }

    // Feast: when food is stable but cohesion is failing.
    // (Feeding well is a civ-sim lever to buy compliance back.)
    const stableFood = foodPerKitten >= targets.foodPerKitten * 1.05;
    if (stableFood && dis >= 0.58) {
      return { rations: 'Feast', why: `stable food + dissent ${Math.round(dis*100)}%` };
    }

    // Default: Normal.
    return { rations: 'Normal', why: 'steady' };
  }

  function chooseAutoDoctrine(s){
    const dis = dissent01(s);
    const band = String(s.social?.band ?? (dis >= 0.70 ? 'strike' : dis >= 0.45 ? 'murmur' : 'calm'));
    const comp = compliance01(s);
    const effAut = effectiveAutonomy01(s);

    // High dissent: prioritize rotation (reduces boredom/rigidity and slightly reduces dissent buildup).
    if (band === 'strike' || dis >= 0.60) {
      return { doctrine: 'Rotate', why: `dissent ${Math.round(dis*100)}% (${band})` };
    }

    // Calm + reasonably compliant: let specialists stick and build momentum.
    if (band === 'calm' && dis <= 0.22 && comp >= 0.92 && effAut <= 0.55) {
      return { doctrine: 'Specialize', why: `calm (dissent ${Math.round(dis*100)}%, comp x${comp.toFixed(2)})` };
    }

    // Default: balanced (don't oversteer).
    return { doctrine: 'Balanced', why: `steady (dissent ${Math.round(dis*100)}%, comp x${comp.toFixed(2)})` };
  }

  function setModeCore(m, note){
    if (state.mode === m) return;
    state.mode = m;

    // Keep mode effects centralized so Auto Mode + manual clicks behave identically.
    if (m === 'Survive') { state.targets.foodPerKitten = Math.max(state.targets.foodPerKitten, 130); state.targets.warmth = Math.max(state.targets.warmth, 65); state.signals.BUILD = false; }
    if (m === 'Expand') { state.targets.foodPerKitten = Math.max(115, Math.min(145, state.targets.foodPerKitten)); state.targets.warmth = Math.max(55, state.targets.warmth); state.signals.BUILD = true; }
    if (m === 'Defend') { state.targets.maxThreat = Math.min(55, state.targets.maxThreat); state.signals.ALARM = !!state.unlocked.security; }
    if (m === 'Advance') { state.targets.foodPerKitten = Math.max(state.targets.foodPerKitten, 120); state.signals.BUILD = false; }

    // Security gate
    if (!state.unlocked.security) state.signals.ALARM = false;

    log(note || `Mode → ${m}`);
    save();
  }

  function setMode(m){
    setModeCore(m, `Mode → ${m}`);
    render();
  }

  document.getElementById('sigBuild').addEventListener('change', (e)=>{ state.signals.BUILD = e.target.checked; save(); render(); });
  document.getElementById('sigFood').addEventListener('change', (e)=>{ state.signals.FOOD = e.target.checked; save(); render(); });
  document.getElementById('sigAlarm').addEventListener('change', (e)=>{
    // Manual ALARM is only available after the Security unlock.
    if (!state.unlocked.security) { state.signals.ALARM = false; save(); render(); return; }
    state.signals.ALARM = e.target.checked;
    save();
    render();
  });

  document.getElementById('rations').addEventListener('change', (e)=>{
    state.rations = e.target.value;
    log(`Rations → ${state.rations}`);
    save();
    render();
  });

  const autEl = document.getElementById('autonomy');
  if (autEl) autEl.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    if (!('discipline' in state.director)) state.director.discipline = 0.40;
    const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    state.director.autonomy = clamp01(pct / 100);
    save();
    render();
  });

  const disEl = document.getElementById('discipline');
  if (disEl) disEl.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    state.director.discipline = clamp01(pct / 100);
    log(`Discipline → ${Math.round(state.director.discipline * 100)}%`);
    save();
    render();
  });

  const wpEl = document.getElementById('workPace');
  if (wpEl) wpEl.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced' };
    if (!('discipline' in state.director)) state.director.discipline = 0.40;
    if (!('doctrine' in state.director)) state.director.doctrine = 'Balanced';
    const pct = Math.max(80, Math.min(120, Number(e.target.value) || 100));
    state.director.workPace = Math.max(0.8, Math.min(1.2, pct / 100));
    log(`Work pace → ${Math.round(state.director.workPace * 100)}%`);
    save();
    render();
  });

  // Director priorities (Food/Safety/Progress)
  const prioFoodInput = document.getElementById('prioFood');
  if (prioFoodInput) prioFoodInput.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00 };
    const pct = Math.max(50, Math.min(150, Number(e.target.value) || 100));
    state.director.prioFood = Math.max(0.50, Math.min(1.50, pct / 100));
    log(`Priority (Food) → ${Math.round(state.director.prioFood * 100)}%`);
    save();
    render();
  });

  const prioSafetyInput = document.getElementById('prioSafety');
  if (prioSafetyInput) prioSafetyInput.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00 };
    const pct = Math.max(50, Math.min(150, Number(e.target.value) || 100));
    state.director.prioSafety = Math.max(0.50, Math.min(1.50, pct / 100));
    log(`Priority (Safety) → ${Math.round(state.director.prioSafety * 100)}%`);
    save();
    render();
  });

  const prioProgressInput = document.getElementById('prioProgress');
  if (prioProgressInput) prioProgressInput.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00 };
    const pct = Math.max(50, Math.min(150, Number(e.target.value) || 100));
    state.director.prioProgress = Math.max(0.50, Math.min(1.50, pct / 100));
    log(`Priority (Progress) → ${Math.round(state.director.prioProgress * 100)}%`);
    save();
    render();
  });

  function setPriorities(pFood, pSafety, pProg, why){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00 };
    state.director.prioFood = Math.max(0.50, Math.min(1.50, Number(pFood) || 1.00));
    state.director.prioSafety = Math.max(0.50, Math.min(1.50, Number(pSafety) || 1.00));
    state.director.prioProgress = Math.max(0.50, Math.min(1.50, Number(pProg) || 1.00));
    log(`Priority preset → ${why}: Food ${(state.director.prioFood*100).toFixed(0)}% | Safety ${(state.director.prioSafety*100).toFixed(0)}% | Progress ${(state.director.prioProgress*100).toFixed(0)}%`);
    save();
    render();
  }

  const prBal = document.getElementById('btnPrioBalanced');
  if (prBal) prBal.addEventListener('click', ()=> setPriorities(1.00, 1.00, 1.00, 'Balanced'));

  const prFoodBtn = document.getElementById('btnPrioFood');
  if (prFoodBtn) prFoodBtn.addEventListener('click', ()=> setPriorities(1.25, 1.00, 0.90, 'Food'));

  const prSafeBtn = document.getElementById('btnPrioSafety');
  if (prSafeBtn) prSafeBtn.addEventListener('click', ()=> setPriorities(1.00, 1.25, 0.90, 'Safety'));

  const prProgBtn = document.getElementById('btnPrioProgress');
  if (prProgBtn) prProgBtn.addEventListener('click', ()=> setPriorities(0.95, 0.90, 1.25, 'Progress'));

  function consensusPrioritiesFromValues(s){
    const ks = Array.isArray(s?.kittens) ? s.kittens : [];
    const n = Math.max(1, ks.length);

    let f = 0, sa = 0, pr = 0, so = 0;
    for (const k of ks) {
      ensureValues(k);
      const v = k?.values ?? {};
      f += Number(v.Food ?? 0.25);
      sa += Number(v.Safety ?? 0.25);
      pr += Number(v.Progress ?? 0.25);
      so += Number(v.Social ?? 0.25);
    }
    f /= n; sa /= n; pr /= n; so /= n;

    // Map value share (~0.25 neutral) into a priority multiplier.
    // Keep it in a conservative range so this is a "steer" button, not a hard build order.
    const map = (v) => Math.max(0.50, Math.min(1.50, 1 + (v - 0.25) * 1.8)); // ~0.80..1.20 typical

    return {
      pFood: map(f),
      pSafety: map(sa),
      pProg: map(pr),
      avg: { Food:f, Safety:sa, Progress:pr, Social:so }
    };
  }

  const prConBtn = document.getElementById('btnPrioConsensus');
  if (prConBtn) prConBtn.addEventListener('click', ()=>{
    const c = consensusPrioritiesFromValues(state);
    setPriorities(c.pFood, c.pSafety, c.pProg, 'Consensus');
    // Listening moment: a tiny, immediate dissent reduction.
    state.social = state.social ?? { dissent: 0 };
    state.social.dissent = clamp01(Number(state.social.dissent ?? 0) * 0.90);
    log(`Consensus priorities (avg values F${Math.round(c.avg.Food*100)} S${Math.round(c.avg.Safety*100)} P${Math.round(c.avg.Progress*100)} So${Math.round(c.avg.Social*100)}): Food ${(c.pFood*100).toFixed(0)}% | Safety ${(c.pSafety*100).toFixed(0)}% | Progress ${(c.pProg*100).toFixed(0)}%`);
    save();
    render();
  });

  const docEl = document.getElementById('doctrine');
  if (docEl) docEl.addEventListener('change', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced' };
    const v = String(e.target.value || 'Balanced');
    state.director.doctrine = (v === 'Specialize' || v === 'Rotate' || v === 'Balanced') ? v : 'Balanced';
    log(`Labor doctrine → ${state.director.doctrine}`);
    save();
    render();
  });

  document.getElementById('targetFood').addEventListener('change', (e)=>{ state.targets.foodPerKitten = Number(e.target.value)||0; save(); render(); });
  document.getElementById('targetWarmth').addEventListener('change', (e)=>{ state.targets.warmth = Number(e.target.value)||0; save(); render(); });
  document.getElementById('targetThreat').addEventListener('change', (e)=>{ state.targets.maxThreat = Number(e.target.value)||0; save(); render(); });

  document.getElementById('reserveFood').addEventListener('change', (e)=>{ state.reserve = state.reserve ?? { food:0, wood:18, science:25, tools:0 }; state.reserve.food = Number(e.target.value)||0; save(); render(); });
  document.getElementById('reserveWood').addEventListener('change', (e)=>{ state.reserve = state.reserve ?? { food:0, wood:18, science:25, tools:0 }; state.reserve.wood = Number(e.target.value)||0; save(); render(); });
  document.getElementById('reserveScience').addEventListener('change', (e)=>{ state.reserve = state.reserve ?? { food:0, wood:18, science:25, tools:0 }; state.reserve.science = Number(e.target.value)||0; save(); render(); });
  document.getElementById('reserveTools').addEventListener('change', (e)=>{ state.reserve = state.reserve ?? { food:0, wood:18, science:25, tools:0 }; state.reserve.tools = Number(e.target.value)||0; save(); render(); });

  const applyRec = document.getElementById('btnApplyReserveRec');
  if (applyRec) applyRec.addEventListener('click', ()=>{
    const rr = recommendedReserves(state);
    state.reserve = state.reserve ?? { food:0, wood:18, science:25, tools:0 };
    state.reserve.food = rr.food;
    state.reserve.wood = rr.wood;
    state.reserve.science = rr.science;
    state.reserve.tools = rr.tools;
    log(`Reserves set to recommended (${String(rr?.season?.name ?? '')}): food≥${rr.food}, wood≥${rr.wood}, science≥${rr.science}, tools≥${rr.tools}`);
    save();
    render();
  });

  policyEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const a = btn.dataset.a;
    const pol = btn.dataset.pol;
    if (!a || !pol) return;
    state.policyMult = state.policyMult ?? {};
    const cur = Number(state.policyMult[a] ?? 1);
    const step = 0.25;
    const next = pol === 'inc' ? (cur + step) : (cur - step);
    state.policyMult[a] = Math.max(0, Math.min(2, Math.round(next * 100) / 100));
    save();
    render();
  });

  if (roleQuotasEl) roleQuotasEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const role = btn.dataset.role;
    const rq = btn.dataset.rq;
    if (!role || !rq) return;

    state.roleQuota = state.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
    const cur = Number(state.roleQuota[role] ?? 0);
    const next = (rq === 'inc') ? (cur + 1) : (cur - 1);
    state.roleQuota[role] = Math.max(0, Math.min(99, next|0));
    log(`Role quota → ${role}=${state.roleQuota[role]}`);
    save();
    render();
  });

  function setPolicy(mult, note){
    // Migration-safe: always keep all keys so older saves don't explode.
    state.policyMult = {
      Socialize: mult.Socialize ?? 1,
      Care: mult.Care ?? 1,
      Forage: mult.Forage ?? 1,
      Farm: mult.Farm ?? 1,
      PreserveFood: mult.PreserveFood ?? 1,
      ChopWood: mult.ChopWood ?? 1,
      StokeFire: mult.StokeFire ?? 1,
      Guard: mult.Guard ?? 1,
      BuildHut: mult.BuildHut ?? 1,
      BuildPalisade: mult.BuildPalisade ?? 1,
      BuildGranary: mult.BuildGranary ?? 1,
      BuildWorkshop: mult.BuildWorkshop ?? 1,
      BuildLibrary: mult.BuildLibrary ?? 1,
      CraftTools: mult.CraftTools ?? 1,
      Mentor: mult.Mentor ?? 1,
      Research: mult.Research ?? 1,
    };
    log(note);
    save();
    render();
  }

  function applyPolicyPreset(name){
    // Presets are *nudges*; safety rules still override and scoring still matters.
    if (name === 'Survive') {
      setPolicy({ Socialize:1.05, Care:0.95, Forage:1.25, Farm:1.25, PreserveFood:1.10, ChopWood:1.10, StokeFire:1.35, Guard:1.05, BuildHut:0.75, BuildPalisade:0.85, BuildGranary:1.20, BuildWorkshop:0.85, BuildLibrary:0.75, CraftTools:0.75, Mentor:0.80, Research:0.85 }, 'Policy preset → Survive (food + warmth first).');
    } else if (name === 'Expand') {
      setPolicy({ Socialize:0.90, Care:0.85, Forage:1.00, Farm:1.00, ChopWood:1.35, StokeFire:1.00, Guard:0.90, BuildHut:1.50, BuildPalisade:1.05, BuildGranary:1.25, BuildWorkshop:1.10, BuildLibrary:0.95, CraftTools:1.00, Mentor:0.90, Research:0.85 }, 'Policy preset → Expand (wood + building).');
    } else if (name === 'Defend') {
      setPolicy({ Socialize:0.85, Care:0.70, Forage:1.00, Farm:1.00, ChopWood:1.10, StokeFire:1.00, Guard:1.60, BuildHut:0.85, BuildPalisade:1.55, BuildGranary:1.00, BuildWorkshop:0.80, BuildLibrary:0.70, CraftTools:0.75, Mentor:0.70, Research:0.75 }, 'Policy preset → Defend (guard + palisade).');
    } else if (name === 'Advance') {
      setPolicy({ Socialize:0.95, Care:0.90, Forage:0.90, Farm:1.00, ChopWood:1.00, StokeFire:0.95, Guard:0.95, BuildHut:0.70, BuildPalisade:0.80, BuildGranary:1.05, BuildWorkshop:1.35, BuildLibrary:1.45, CraftTools:1.45, Mentor:1.35, Research:1.60 }, 'Policy preset → Advance (research + tools).');
    }
  }

  document.getElementById('btnPolicyPresetSurvive').addEventListener('click', () => applyPolicyPreset('Survive'));
  document.getElementById('btnPolicyPresetExpand').addEventListener('click', () => applyPolicyPreset('Expand'));
  document.getElementById('btnPolicyPresetDefend').addEventListener('click', () => applyPolicyPreset('Defend'));
  document.getElementById('btnPolicyPresetAdvance').addEventListener('click', () => applyPolicyPreset('Advance'));

  document.getElementById('btnPolicyReset').addEventListener('click', () => {
    setPolicy({ Socialize:1, Care:1, Forage:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Mentor:1, Research:1 }, 'Policy reset to defaults (all 1.0).');
  });

  document.getElementById('btnAddRule').addEventListener('click', () => { state.rules.push(rule('New safety rule', {type:'always', v:0}, {type:'Rest'})); render(); });
  document.getElementById('btnDefaultRules').addEventListener('click', () => { if (!confirm('Restore defaults?')) return; state.rules = defaultRules(); render(); });

  rulesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const act = btn.dataset.act;
    if (!(i >= 0)) return;
    if (act === 'del') state.rules.splice(i,1);
    else if (act === 'up' && i > 0) [state.rules[i-1], state.rules[i]] = [state.rules[i], state.rules[i-1]];
    else if (act === 'down' && i < state.rules.length-1) [state.rules[i+1], state.rules[i]] = [state.rules[i], state.rules[i+1]];
    save();
    render();
  });

  rulesEl.addEventListener('change', (e) => {
    const t = e.target;
    const i = Number(t.dataset.i);
    const act = t.dataset.act;
    if (!(i >= 0)) return;
    const r = state.rules[i];

    if (act === 'toggle') r.enabled = t.checked;
    else if (act === 'condType') {
      r.cond.type = t.value;
      if (t.value === 'signal') r.cond.v = 'FOOD';
      else if (t.value === 'hungry_gt') r.cond.v = 0.75;
      else if (t.value === 'tired_gt') r.cond.v = 0.88;
      else if (t.value === 'health_lt') r.cond.v = 0.45;
      else if (t.value === 'food_lt') r.cond.v = 40;
      else if (t.value === 'wood_lt') r.cond.v = 10;
      else if (t.value === 'warmth_lt') r.cond.v = 35;
      else if (t.value === 'threat_gt') r.cond.v = 85;
      else if (t.value === 'foodperkitten_lt') r.cond.v = 100;
      else if (t.value === 'threat_gt_or_alarm') r.cond.v = 85;
      else r.cond.v = 0;
    } else if (act === 'condV') {
      r.cond.v = (t.tagName === 'SELECT') ? t.value : Number(t.value);
    } else if (act === 'actType') {
      r.act.type = t.value;
    }

    save();
    render();
  });

  // --- Save/Load
  function save(){
    const s = structuredClone(state);
    // Persist long-running simulation progress so the civ loop survives refresh.
    // (Keep these keys forward-compatible; old saves simply won't have them.)
    delete s._decTimer; delete s._saveTimer; delete s._lastPlan;
    delete s._rate; delete s._prevRes;
    delete s._lastFoodOvercap;
    delete s._actHist;
    delete s._decHist;
    delete s._dissentDrivers;
    delete s._dissentTimer;
    delete s._autoRationsTimer;
    delete s._autoCrisisTimer;
    delete s._autoRecruitTimer;
    delete s._autoResTimer;
    delete s._autoBuildTimer;
    delete s._autoModeTimer;
    delete s._autoDocTimer;
    delete s._raidTimer;
    delete s._seasonWarn;
    delete s._lastSeasonName;
    delete s._threatWarned;
    delete s._blockedThisSecond;
    delete s._blockedMsgThisSecond;

    // Strip transient UI/debug keys (avoid save bloat)
    if (Array.isArray(s.kittens)) {
      for (const k of s.kittens) {
        delete k._lastScores;
        delete k._lastScoredAt;
        delete k._autonomyPickNote;
        delete k._autonomyPickAt;
        delete k._lastDecision;
        delete k._lastBlocked;
      }
    }

    // Stamp version for patch-note gating.
    s.meta = s.meta ?? {};
    s.meta.version = GAME_VERSION;
    s.meta.lastTs = Date.now();

    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  }

  function load(){
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s.res || !s.kittens || !s.rules) return null;
      s.mode = s.mode ?? 'Survive';
      s.rations = s.rations ?? 'Normal';
      s.targets = s.targets ?? { foodPerKitten: 120, warmth: 60, maxThreat: 70 };
      s.reserve = s.reserve ?? { food:0, wood:18, science:25, tools:0 };
      // Migration: older saves may have reserve stored inside targets (experimental) or missing keys.
      if ('reserveWood' in s.targets) {
        s.reserve.wood = Number(s.targets.reserveWood ?? s.reserve.wood) || s.reserve.wood;
        s.reserve.science = Number(s.targets.reserveScience ?? s.reserve.science) || s.reserve.science;
        s.reserve.food = Number(s.targets.reserveFood ?? s.reserve.food) || s.reserve.food;
        delete s.targets.reserveWood; delete s.targets.reserveScience; delete s.targets.reserveFood;
      }
      for (const [k,v] of Object.entries({ food:0, wood:18, science:25, tools:0 })) if (!(k in s.reserve)) s.reserve[k] = v;
      s.res.tools = s.res.tools ?? 0;
      s.res.jerky = s.res.jerky ?? 0;
      s.res.granaries = s.res.granaries ?? 0;
      s.res.workshops = s.res.workshops ?? 0;
      s.res.libraries = s.res.libraries ?? 0;
      s.signals = s.signals ?? { BUILD:false, FOOD:false, ALARM:false };
      s.director = s.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60 };
      s.effects = s.effects ?? { festivalUntil: 0, councilUntil: 0 };

      // Meta/version (used to show patch notes once per version; safe for old saves)
      s.meta = s.meta ?? { version: '', seenVersion: '', lastTs: 0 };
      if (!('version' in s.meta)) s.meta.version = '';
      if (!('seenVersion' in s.meta)) s.meta.seenVersion = '';
      if (!('lastTs' in s.meta)) s.meta.lastTs = 0;
      s.meta.version = String(s.meta.version ?? '');
      s.meta.seenVersion = String(s.meta.seenVersion ?? '');
      s.meta.lastTs = Number(s.meta.lastTs ?? 0) || 0;
      // Migration safety: if older saves stored these separately
      if (!('winterPrep' in s.director)) s.director.winterPrep = false;
      if (!('saved' in s.director)) s.director.saved = null;
      if (!('crisis' in s.director)) s.director.crisis = false;
      if (!('crisisSaved' in s.director)) s.director.crisisSaved = null;
      if (!('autoWinterPrep' in s.director)) s.director.autoWinterPrep = false;
      if (!('autoFoodCrisis' in s.director)) s.director.autoFoodCrisis = false;
      if (!('autoReserves' in s.director)) s.director.autoReserves = false;
      if (!('autoMode' in s.director)) s.director.autoMode = false;
      if (!('autoModeNextChangeAt' in s.director)) s.director.autoModeNextChangeAt = 0;
      if (!('autoModeWhy' in s.director)) s.director.autoModeWhy = '';
      if (!('projectFocus' in s.director)) s.director.projectFocus = 'Auto';
      if (!('autonomy' in s.director)) s.director.autonomy = 0.60;
      if (!('workPace' in s.director)) s.director.workPace = 1.00;
      s.director.autonomy = clamp01(Number(s.director.autonomy ?? 0.60));
      s.director.workPace = Math.max(0.8, Math.min(1.2, Number(s.director.workPace ?? 1.00) || 1.00));

      // Director profile slots (save/load policy stacks)
      if (!('profiles' in s.director) || !s.director.profiles) s.director.profiles = { A:null, B:null, C:null };
      for (const k of ['A','B','C']) if (!(k in s.director.profiles)) s.director.profiles[k] = null;

      // Effects migration
      s.effects = s.effects ?? { festivalUntil: 0, councilUntil: 0 };
      if (!('festivalUntil' in s.effects)) s.effects.festivalUntil = 0;
      if (!('councilUntil' in s.effects)) s.effects.councilUntil = 0;
      s.effects.festivalUntil = Number(s.effects.festivalUntil ?? 0) || 0;
      s.effects.councilUntil = Number(s.effects.councilUntil ?? 0) || 0;

      s.policyMult = s.policyMult ?? { Socialize:1, Care:1, Forage:1, PreserveFood:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Mentor:1, Research:1 };
      // Add any missing keys for forward-compatible saves
      for (const [k, v] of Object.entries({ Socialize:1, Care:1, Forage:1, PreserveFood:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Mentor:1, Research:1 })) {
        if (!(k in s.policyMult)) s.policyMult[k] = v;
      }

      // Role quota migration
      s.roleQuota = s.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
      for (const [k,v] of Object.entries({ Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 })) {
        if (!(k in s.roleQuota)) s.roleQuota[k] = v;
      }

      s.unlocked = s.unlocked ?? { construction:false, workshop:false, farm:false, security:false, granary:false, library:false };
      if (!('library' in s.unlocked)) s.unlocked.library = false;
      s.seenUnlocks = s.seenUnlocks ?? {};

      // Persisted project/raid timers (older saves may not have these)
      s._hutProgress = Number(s._hutProgress ?? 0) || 0;
      s._palProgress = Number(s._palProgress ?? 0) || 0;
      s._granProgress = Number(s._granProgress ?? 0) || 0;
      s._workProgress = Number(s._workProgress ?? 0) || 0;
      s._libProgress = Number(s._libProgress ?? 0) || 0;
      s._raidTimer = Number(s._raidTimer ?? 0) || 0;
      s._threatWarned = !!s._threatWarned;

      // Migration: ALARM signal is gated behind the Security unlock.
      if (!s.unlocked.security) s.signals.ALARM = false;

      for (const k of s.kittens) {
        k.why = k.why ?? '';
        k.role = k.role ?? 'Generalist';
        k.roleWhy = k.roleWhy ?? '';
        k.personality = k.personality ?? genPersonality(k.id ?? 0);
        k.traits = Array.isArray(k.traits) ? k.traits : genTraits(k.id ?? 0);
        k.skills = k.skills ?? { Foraging:1, Farming:1, Woodcutting:1, Building:1, Scholarship:1, Combat:1, Cooking:1 };
        k.xp = k.xp ?? { Foraging:0, Farming:0, Woodcutting:0, Building:0, Scholarship:0, Combat:0, Cooking:0 };
        for (const [sk,lv] of Object.entries({ Foraging:1, Farming:1, Woodcutting:1, Building:1, Scholarship:1, Combat:1, Cooking:1 })) if (!(sk in k.skills)) k.skills[sk] = lv;
        for (const [sk,xp] of Object.entries({ Foraging:0, Farming:0, Woodcutting:0, Building:0, Scholarship:0, Combat:0, Cooking:0 })) if (!(sk in k.xp)) k.xp[sk] = xp;
        k.health = clamp01(Number(k.health ?? 1));
        k.mood = clamp01(Number(k.mood ?? 0.55));
        k.grievance = clamp01(Number(k.grievance ?? 0));
        k.taskStreak = k.taskStreak ?? 0;
        k.taskLock = k.taskLock ?? 0;
        k._blockedAction = k._blockedAction ?? null;
        k._blockedMsg = k._blockedMsg ?? '';
        k._autonomyPickNote = k._autonomyPickNote ?? '';
        k._autonomyPickAt = Number(k._autonomyPickAt ?? 0) || 0;
        k._fallbackTo = null;
        k._mentor = null;
        k.blockedCooldown = k.blockedCooldown ?? {};
      }
      return s;
    } catch { return null; }
  }

  // --- Loop
  // QoL: auto-pause when the tab is hidden. This prevents background CPU burn and
  // avoids players accidentally running the sim for a long time while away.
  // It will NOT override a manual Pause (only resumes if *it* paused).
  const autoPause = { active:false };
  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden;
    if (hidden) {
      if (!state.paused) {
        autoPause.active = true;
        state.paused = true;
        log('Auto-paused (tab hidden).');
        save();
      }
    } else {
      if (autoPause.active) {
        autoPause.active = false;
        state.paused = false;
        last = now(); // prevent a huge dt burst
        log('Resumed (tab visible).');
        save();
      }
    }
  });

  let last = now();
  function frame(){
    const t = now();
    const dt = Math.min(0.25, (t-last)/1000);
    last = t;
    if (!state.paused) step(dt);
    render();
    requestAnimationFrame(frame);
  }

  function maybeShowPatchNotes(){
    state.meta = state.meta ?? { version: GAME_VERSION, seenVersion: '', lastTs: 0 };
    const seen = String(state.meta.seenVersion ?? '');
    if (seen === GAME_VERSION) return;

    // Capture "from" version so patch notes can be cumulative.
    uiPatch.fromVersion = seen;

    // Mark seen FIRST so a refresh won't loop-pop the modal.
    state.meta.seenVersion = GAME_VERSION;
    save();

    // Then show UI.
    openPatchNotes();
  }

  render();
  requestAnimationFrame(frame);
  maybeShowPatchNotes();
})();
