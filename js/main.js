(() => {
  const GAME_VERSION = '0.9.14';
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
    if (!a || a === 'Eat' || a === 'Rest' || a === 'Loaf') return 1;
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
    StokeFire: null,
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
    policyMult: { Forage:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, PreserveFood:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Research:1 },
    // Optional role quotas: "try to keep N kittens in this role" (0 = no quota).
    roleQuota: { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 },
    rules: defaultRules(),
    // Director helpers (not required for core sim; safe to ignore in old saves)
    director: { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoRecruit:false, recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 },
    // Social layer (emergence): dissent reduces plan compliance; discipline restores it.
    social: { dissent: 0, band: 'calm', lastLogBand: '', lastLogAt: 0 },
    // Lightweight timed colony-wide effects (kept simple + transparent)
    effects: { festivalUntil: 0 },
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
    const pool = ['Forage','PreserveFood','ChopWood','StokeFire','Guard','Research','Farm','BuildHut','BuildGranary','BuildWorkshop','BuildLibrary','CraftTools'];
    const likes = pickDistinct(rng, pool, 2);
    const remaining = pool.filter(x => !likes.includes(x));
    const dislikes = pickDistinct(rng, remaining, 1);
    return { likes, dislikes };
  }

  function makeKitten(id){
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
      // Mood: 0..1. Softly affects efficiency + preferences (adds “civ sim” texture without hard locks).
      mood: 0.55,
      skills: { Foraging:1, Farming:1, Woodcutting:1, Building:1, Scholarship:1, Combat:1, Cooking:1 },
      xp: { Foraging:0, Farming:0, Woodcutting:0, Building:0, Scholarship:0, Combat:0, Cooking:0 },
      // Personality: soft preferences that bias scoring (adds emergent specialization)
      personality: genPersonality(id),
      // Memory: how long they've been stuck doing the same thing (adds natural rotation)
      taskStreak: 0,
      // Commitment: reduces 1s task-flapping; will only break for safety rules/emergencies.
      taskLock: 0,

      // Execution debugging: if a sink task was blocked by reserves/missing inputs, we surface it in "Why".
      _blockedAction: null,
      _blockedMsg: '',
      _fallbackTo: null,
      _mentor: null,

      // Anti-thrash: short per-action cooldown if we just discovered an action is blocked.
      // Prevents kittens from repeatedly "trying" the same no-op sink every 1s.
      blockedCooldown: {},
    };
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
      }
    },
    Guard: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const mult = 1 + 0.10*(k.skills.Combat-1);
        const base = s.unlocked.security ? 2.6 : 2.1;
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Guard');
        const wp = workPaceMul(s);
        s.res.threat = Math.max(0, s.res.threat - base * mult * dt * eff * mom * wp);
        k.energy = clamp01(k.energy - dt * 0.03 * wp);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp);
        gainXP(k,'Combat', dt * 1.0 * efficiency(s,k));
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

        // Choose a skill to teach: mentor's top skill (excluding Cooking) if it exists; otherwise Scholarship.
        const top = topSkillInfo(k);
        const teachSkill = (top.skill && top.skill !== 'Cooking') ? top.skill : 'Scholarship';

        // Pick a target: someone else with the lowest level in that skill (so mentoring actually balances the colony).
        const others = (s.kittens ?? []).filter(x => x && x.id !== k.id);
        if (!others.length) {
          taskDefs.Research.tick(s,k,dt);
          return;
        }
        let target = others[0];
        let bestLvl = Number(target.skills?.[teachSkill] ?? 1);
        for (const o of others) {
          const lvl = Number(o.skills?.[teachSkill] ?? 1);
          if (lvl < bestLvl) { bestLvl = lvl; target = o; }
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
        k._mentor = { id: target.id, skill: teachSkill };

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
    const foodPerKitten = s.res.food / Math.max(1, s.kittens.length);
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
    const c = 1 - dis * (0.35 + 0.35*a) + d * 0.35;
    return Math.max(0.45, Math.min(1.15, c));
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
    const roleMul = 1.10 - 0.35 * a; // 1.10 @ 0% autonomy → 0.75 @ 100%

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
    const boreMul = 0.6 + 0.8 * a;     // 0.6..1.4

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

  function updateMoodPerSecond(s, k, task){
    // Mood is “how good this minute feels”: alignment with personality + basic stressors.
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

    // Background stress.
    if ((k.hunger ?? 0) > 0.85) m -= 0.010;
    const season = seasonAt(s.t);
    if (season.name === 'Winter' && (s.res?.warmth ?? 0) < 35) m -= 0.008;
    if (s.signals?.ALARM) m -= 0.005;

    // Work pace policy: pushing hard makes the colony a bit grumpier over time; relaxed pace is a small morale relief.
    const wp = workPaceMul(s);
    if (wp > 1.02) m -= (wp - 1) * 0.018; // at 1.20 → -0.0036 / sec
    if (wp < 0.98) m += (1 - wp) * 0.010; // at 0.80 → +0.0020 / sec

    // Discipline (cohesion) has a small, steady morale cost.
    // It's intentionally subtle so it's a strategic lever, not a "never use" trap.
    const d = discipline01(s);
    m -= d * 0.0018; // at 100% → -0.0018 / sec

    k.mood = clamp01(m);
  }

  // --- AI
  // Colony-level coordination: we compute a lightweight "plan" (desired worker counts per task)
  // and then each kitten picks actions with a congestion/need modifier.
  function commitSecondsForTask(task){
    // Keep it short so the AI is still responsive.
    // Safety rules + emergencies can always override.
    if (['BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary'].includes(task)) return 4;
    if (['CraftTools','Research','Forage','Farm','ChopWood'].includes(task)) return 3;
    if (['Guard','StokeFire'].includes(task)) return 2;
    if (['Eat','Rest','Loaf'].includes(task)) return 1;
    return 2;
  }

  // --- Planning-time reservations (coordination)
  // We decide tasks sequentially once per second. Without reservations, multiple kittens can all
  // choose the same wood/science sink (CraftTools/BuildWorkshop/etc), then execution hard-stops
  // on reserves and they all fallback — looks like "thrash".
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
      if (evalCond(r.cond, s, k)) return { task: r.act.type, why: `rule #${i+1}: ${shortRule(r)}` };
    }

    // emergency
    if (k.hunger > 0.92 && s.res.food > 0) return { task:'Eat', why:'emergency: starving' };
    if (k.energy < 0.08) return { task:'Rest', why:'emergency: exhausted' };

    // Commitment: if a kitten recently switched tasks, keep them on it briefly.
    // This prevents flapping and makes specialization/build-projects feel stable.
    if ((k.taskLock ?? 0) > 0) {
      const cur = k.task ?? 'Rest';
      if (cur in taskDefs && taskDefs[cur].enabled(s)) {
        return { task: cur, why: `commit ${k.taskLock}s | ${k.why ?? ''}`.trim() };
      }
    }

    const eff = efficiency(s, k);
    const scored = scoreActions(s, k, ctx);
    applyPlanPressure(scored, plan);
    applyRolePressure(scored, k);
    applyPersonalityPressure(scored, k);
    scored.sort((a,b)=>b.score-a.score);

    const pick = pickWithAutonomy(scored, effectiveAutonomy01(s));
    const top = pick.row;

    // Surface autonomy sampling in the UI (tiny “emergence” flag).
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
    const foodPerKitten = s.res.food / Math.max(1, s.kittens.length);
    const foodRes = getReserve(s,'food');
    const tired = (1 - k.energy);
    const mood = clamp01(Number(k.mood ?? 0.55));
    const mode = s.mode;
    const pfInfo = getEffectiveProjectFocus(s);
    const pf = String(pfInfo.focus ?? 'Auto');
    const topSkill = topSkillInfo(k);

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

    const actions = ['Eat','Rest','Loaf','Forage','PreserveFood','ChopWood','StokeFire','Guard','Research'];
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
      if (mode === 'Survive') return ({ Eat:20, Rest:14, Loaf:2, Forage:14, PreserveFood:6, Farm:18, ChopWood:8, StokeFire:18, Guard:6, BuildHut:2, BuildPalisade:3, BuildGranary:6, BuildWorkshop:4, CraftTools:0, Research:4 })[a] ?? 0;
      if (mode === 'Expand') return ({ Eat:16, Rest:10, Loaf:1, Forage:10, PreserveFood:6, Farm:12, ChopWood:18, StokeFire:10, Guard:6, BuildHut:20, BuildPalisade:10, BuildGranary:10, BuildWorkshop:12, CraftTools:6, Research:4 })[a] ?? 0;
      if (mode === 'Defend') return ({ Eat:16, Rest:10, Loaf:1, Forage:10, PreserveFood:5, Farm:12, ChopWood:12, StokeFire:10, Guard:22, BuildHut:4, BuildPalisade:20, BuildGranary:6, BuildWorkshop:6, CraftTools:3, Research:4 })[a] ?? 0;
      return ({ Eat:16, Rest:10, Loaf:1, Forage:10, PreserveFood:7, Farm:12, ChopWood:10, StokeFire:10, Guard:10, BuildHut:6, BuildPalisade:8, BuildGranary:8, BuildWorkshop:14, CraftTools:16, Research:22 })[a] ?? 0;
    };

    const out = [];
    for (const a of actions) {
      if (!taskDefs[a].enabled(s)) continue;
      let score = base(a);
      const reasons = [`mode=${mode} base +${base(a)}`];

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

      if (a !== 'Eat' && a !== 'Rest' && a !== 'Loaf') {
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
      if (a === (k.task ?? '') && a !== 'Eat' && a !== 'Rest' && a !== 'Loaf') {
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
        if (s.res.food <= 0) { score -= 60; reasons.push('no food → -60'); }
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
    const shaveOrder = ['Research','CraftTools','BuildLibrary','BuildWorkshop','BuildGranary','BuildPalisade','BuildHut','PreserveFood','Guard','StokeFire','ChopWood','Farm','Forage'];
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
    const foodPerKitten = s.res.food / Math.max(1, n);

    // Director: project focus (a transparent build order nudge)
    const pfInfo = getEffectiveProjectFocus(s);
    const pf = String(pfInfo.focus ?? 'Auto');

    // Start with gentle defaults; plan is *advisory* and can be overridden by scores/rules.
    const desired = {
      Eat: 0,
      Rest: 0,
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
    // This is mainly a winter-prep lever and creates a nice “bank food now, eat later” loop.
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
    const hardReserved = Object.entries(desired).filter(([a,v]) => ['Forage','Farm','PreserveFood','ChopWood','StokeFire','Guard','BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary','CraftTools','Mentor'].includes(a)).reduce((acc,[,v])=>acc+(v||0),0);
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

    applyPolicyToDesired(s, desired);
    return { desired, assigned: Object.create(null) };
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
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoRecruit:false, recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    if (!('crisis' in state.director)) state.director.crisis = false;
    if (!('crisisSaved' in state.director)) state.director.crisisSaved = null;
    if (!('autoWinterPrep' in state.director)) state.director.autoWinterPrep = false;
    if (!('autoFoodCrisis' in state.director)) state.director.autoFoodCrisis = false;
    if (!('autoReserves' in state.director)) state.director.autoReserves = false;
    if (!('autoMode' in state.director)) state.director.autoMode = false;
    if (!('autoModeNextChangeAt' in state.director)) state.director.autoModeNextChangeAt = 0;
    if (!('autoModeWhy' in state.director)) state.director.autoModeWhy = '';
    if (!('autoRecruit' in state.director)) state.director.autoRecruit = false;
    if (!('recruitYear' in state.director)) state.director.recruitYear = -1;
    if (!('projectFocus' in state.director)) state.director.projectFocus = 'Auto';
    if (!('autonomy' in state.director)) state.director.autonomy = 0.60;
    if (!('discipline' in state.director)) state.director.discipline = 0.40;
    if (!('workPace' in state.director)) state.director.workPace = 1.00;
    state.director.autonomy = clamp01(Number(state.director.autonomy ?? 0.60));
    state.director.discipline = clamp01(Number(state.director.discipline ?? 0.40));
    state.director.workPace = Math.max(0.8, Math.min(1.2, Number(state.director.workPace ?? 1.00) || 1.00));

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
      const alarmStress = state.signals?.ALARM ? 1 : 0;

      // Desired dissent is intentionally coarse: it responds to "this feels bad" signals.
      // avgMood below ~0.55 drives it up; higher work pace + tight rations drive it up.
      let desire = 0;
      desire += Math.max(0, 0.55 - avgMood) * 1.6;      // mood is the biggest driver
      desire += Math.max(0, (wp - 1)) * 0.9;            // overwork
      // Rations proxy: Tight (<1.0) increases dissent; Feast (>1.0) reduces it a bit.
      desire += (rat.foodUse < 0.95 ? 0.08 : rat.foodUse > 1.05 ? -0.06 : 0);
      desire += Math.max(0, hungerStress - 0.55) * 0.25; // persistent hunger
      desire += alarmStress * 0.06;

      // Discipline reduces how quickly dissent forms (but never to zero).
      const disPol = discipline01(state);
      desire *= (1 - 0.45 * disPol);

      const target = clamp01(desire);
      const cur = clamp01(Number(state.social.dissent ?? 0));
      const next = cur + (target - cur) * 0.045; // smoothing (≈ 20-25s to swing hard)
      state.social.dissent = clamp01(next);

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
        if (band === 'strike') log('Work slowdown: dissent is high — kittens wander/rotate more and central planning weakens until conditions improve.');
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
      const foodPerKitten = state.res.food / Math.max(1, state.kittens.length);
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
        const foodPerKitten = state.res.food / Math.max(1, state.kittens.length);
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

        const n = Math.max(1, state.kittens.length);
        const winter = season.name === 'Winter';
        const lateFall = (season.name === 'Fall' && season.phase >= 0.55);

        // Food reserve: scaled by pop; higher in winter/late-fall so the colony banks stability.
        let recFood = n * (winter ? 85 : lateFall ? 72 : 55);
        // If you're explicitly in Advance mode, allow a slightly leaner buffer.
        if (state.mode === 'Advance') recFood *= 0.88;

        // Wood reserve: enough to keep warmth + a little building online.
        let recWood = (winter ? 32 : 20);
        if (state.unlocked.construction && state.signals.BUILD) recWood = Math.max(recWood, 26);
        if (lateFall) recWood = Math.max(recWood, 28);

        // Science reserve: prevents Tools/Workshops from consuming ALL science.
        // Keep it low early so you still reach unlock thresholds.
        let recSci = 25;
        if (state.unlocked.workshop) recSci = 32;

        // Tools reserve: prevents Library building from consuming all tools (and crashing productivity).
        let recTools = 0;
        if (state.unlocked.workshop) recTools = Math.round((n * 6) / 5) * 5; // ~6 per kitten, rounded to 5s
        if (winter || lateFall) recTools = Math.round((recTools * 1.10) / 5) * 5;

        // Round to readable steps.
        recFood = Math.round(recFood / 10) * 10;
        recWood = Math.round(recWood / 2) * 2;
        recSci = Math.round(recSci / 5) * 5;

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

    // Threat growth; reduced by palisade, and by security unlock
    const baseGrowth = state.unlocked.security ? 0.34 : 0.44;
    const palReduce = Math.min(0.28, state.res.palisade * 0.02);
    state.res.threat = Math.min(120, state.res.threat + (baseGrowth * (1 - palReduce)) * dt);

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
      const plan = desiredWorkerPlan(state);
      updateRoles(state, plan);

      // Planning-time reservations: keep later kittens from piling onto the same scarce-input sink.
      const shadowAvail = makeShadowAvail(state);
      const ctx = { shadowAvail };

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

        // Mood update (1s cadence) so the colony feels a bit more “alive”.
        updateMoodPerSecond(state, k, d.task);

        // Memory: track how long we've been doing the same job (1s resolution)
        k.taskStreak = (prevTask === d.task) ? ((k.taskStreak ?? 0) + 1) : 0;

        // If we switched tasks, start a short commitment window.
        if (prevTask !== d.task) {
          k.taskLock = commitSecondsForTask(d.task);
        }

        k.task = d.task;
        k.why = d.why;
        plan.assigned[d.task] = (plan.assigned[d.task] ?? 0) + 1;

        // Reserve estimated scarce inputs for this task so later kittens see reduced availability.
        reserveForTask(shadowAvail, d.task);
      }
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
      if (k.hunger > 0.92 && state.res.food <= 0) {
        k.health = clamp01((k.health ?? 1) - dt * 0.020);
      } else if (k.hunger > 0.92) {
        k.health = clamp01((k.health ?? 1) - dt * 0.006);
      }

      // hard fail: starvation
      if (state.res.food <= 0 && k.hunger >= 0.98) {
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
  const unlocksEl = el('unlocks');
  const seasonEl = el('season');
  const policyEl = el('policy');
  const roleQuotasEl = el('roleQuotas');
  const planDebugEl = el('planDebug');
  const projectsEl = el('projects');
  const profilesEl = el('profiles');
  const profilesHintEl = el('profilesHint');

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

  // Projects panel: quick "focus this" buttons
  if (projectsEl) projectsEl.addEventListener('click', (e) => {
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

  // --- Inspect modal (explainability)
  const inspectModalEl = el('inspectModal');
  const inspectTitleEl = el('inspectTitle');
  const inspectSubEl = el('inspectSub');
  const inspectBodyEl = el('inspectBody');
  const btnInspectClose = el('btnInspectClose');
  const ui = { inspectOpen:false, inspectKidx: -1 };

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
    inspectTitleEl.textContent = `Kitten #${k.id} — ${k.role ?? 'Generalist'} (${k.task ?? '-'})`;

    const likes = (p.likes ?? []).join(', ') || '-';
    const hates = (p.dislikes ?? []).join(', ') || '-';
    const at = (typeof k._lastScoredAt === 'number') ? `t=${fmt(k._lastScoredAt)}s` : '';
    const autoFresh = (k._autonomyPickNote && (state.t - Number(k._autonomyPickAt ?? 0)) < 2) ? k._autonomyPickNote : '';
    inspectSubEl.textContent = `likes: ${likes} | hates: ${hates}${autoFresh ? ' | ' + autoFresh : ''}${at ? ' | ' + at : ''}`;

    const rows = Array.isArray(k._lastScores) ? k._lastScores : [];
    if (!rows.length) {
      inspectBodyEl.textContent = 'No scoring snapshot yet (tick once).';
      return;
    }

    const lines = [];
    for (let i=0;i<Math.min(10, rows.length);i++) {
      const r = rows[i];
      lines.push(`${String(i+1).padStart(2,' ')}. ${String(r.action).padEnd(14)} ${Number(r.score).toFixed(1)}`);
      const reasons = Array.isArray(r.reasons) ? r.reasons : [];
      for (const why of reasons.slice(0, 12)) lines.push(`    - ${why}`);
      if (i < Math.min(10, rows.length)-1) lines.push('');
    }
    inspectBodyEl.textContent = lines.join('\n');
  }

  if (btnInspectClose) btnInspectClose.addEventListener('click', closeInspect);
  if (inspectModalEl) inspectModalEl.addEventListener('click', (e) => {
    if (e.target === inspectModalEl) closeInspect();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeInspect();
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
    s.policyMult = s.policyMult ?? { Forage:1, PreserveFood:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Research:1 };
    const cur = Number(s.policyMult[key] ?? 1);
    s.policyMult[key] = clampPolicyMult(cur + delta);
  }
  function raiseReserve(s, key, min){
    s.reserve = s.reserve ?? { food:0, wood:18, science:25, tools:0 };
    s.reserve[key] = Math.max(getReserve(s, key), Math.max(0, Number(min) || 0));
  }

  function buildAdvisor(s, targets){
    ensureRateState(s);
    const r = s._rate ?? {};

    const season = seasonAt(s.t);
    const pop = Math.max(1, s.kittens?.length ?? 1);
    const foodPerKitten = Number(s.res.food ?? 0) / pop;

    const foodRate = Number(r.food ?? 0);
    const warmthRate = Number(r.warmth ?? 0);
    const threatRate = Number(r.threat ?? 0);
    const scienceRate = Number(r.science ?? 0);

    const lines = [];
    const recs = [];

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
      lines.push(`  - Nudge: +StokeFire (policy), keep wood reserve ≥ 10–20`);

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

  function render(){
    const season = seasonAt(state.t);
    const targets = seasonTargets(state);
    const verEl = el('ver');
    if (verEl) verEl.textContent = `v${GAME_VERSION}`;
    el('clock').textContent = `t=${fmt(state.t)}s | pop=${state.kittens.length}/${housingCap(state)} | mode=${state.mode}`;

    const avgEff = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc+efficiency(state,k),0) / state.kittens.length) : 1;
    const avgHealth = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc+clamp01(Number(k.health ?? 1)),0) / state.kittens.length) : 1;
    const avgMood = state.kittens.length ? (state.kittens.reduce((acc,k)=>acc+clamp01(Number(k.mood ?? 0.55)),0) / state.kittens.length) : 0.55;

    el('modeSurvive').classList.toggle('active', state.mode==='Survive');
    el('modeExpand').classList.toggle('active', state.mode==='Expand');
    el('modeDefend').classList.toggle('active', state.mode==='Defend');
    el('modeResearch').classList.toggle('active', state.mode==='Advance');

    // Seasonal one-click director toggle (pure UI/policy; doesn't change core sim)
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoRecruit:false, recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    if (!('crisis' in state.director)) state.director.crisis = false;
    if (!('crisisSaved' in state.director)) state.director.crisisSaved = null;
    if (!('autoWinterPrep' in state.director)) state.director.autoWinterPrep = false;
    if (!('autoFoodCrisis' in state.director)) state.director.autoFoodCrisis = false;
    if (!('autoReserves' in state.director)) state.director.autoReserves = false;
    if (!('autoMode' in state.director)) state.director.autoMode = false;
    if (!('autoModeNextChangeAt' in state.director)) state.director.autoModeNextChangeAt = 0;
    if (!('autoModeWhy' in state.director)) state.director.autoModeWhy = '';
    if (!('autoRecruit' in state.director)) state.director.autoRecruit = false;
    if (!('recruitYear' in state.director)) state.director.recruitYear = -1;
    if (!('projectFocus' in state.director)) state.director.projectFocus = 'Auto';
    if (!('autonomy' in state.director)) state.director.autonomy = 0.60;
    if (!('discipline' in state.director)) state.director.discipline = 0.40;
    if (!('workPace' in state.director)) state.director.workPace = 1.00;
    state.director.autonomy = clamp01(Number(state.director.autonomy ?? 0.60));
    state.director.discipline = clamp01(Number(state.director.discipline ?? 0.40));
    state.director.workPace = Math.max(0.8, Math.min(1.2, Number(state.director.workPace ?? 1.00) || 1.00));

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
    const autoWp = el('autoWinterPrep');
    if (autoWp) autoWp.checked = !!state.director.autoWinterPrep;
    const autoFood = el('autoFoodCrisis');
    if (autoFood) autoFood.checked = !!state.director.autoFoodCrisis;
    const autoRes = el('autoReserves');
    if (autoRes) autoRes.checked = !!state.director.autoReserves;
    const autoMode = el('autoMode');
    if (autoMode) autoMode.checked = !!state.director.autoMode;
    const autoRec = el('autoRecruit');
    if (autoRec) autoRec.checked = !!state.director.autoRecruit;

    // Timed effects (for old saves)
    state.effects = state.effects ?? { festivalUntil: 0 };
    if (!('festivalUntil' in state.effects)) state.effects.festivalUntil = 0;

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
        pfHint.textContent = (pf === 'Auto') ? `(auto) no focus — ${eff.why}` : `(auto) ${pf}: ${desc(pf)} — ${eff.why}`;
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

    const foodPerKitten = state.res.food / Math.max(1, state.kittens.length);
    el('kittenCost').textContent = String(kittenCost());

    // Social visibility (explainability): dissent directly weakens central planning.
    // Putting it in the top stats makes the "why are they loafing/ignoring plan?" moment instantly legible.
    const diss = dissent01(state);
    const dissBand = String(state.social?.band ?? (diss >= 0.70 ? 'strike' : diss >= 0.45 ? 'murmur' : 'calm'));
    const compMul = compliance01(state);

    statsEl.innerHTML = '';
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
      ['Food/Kitten', fmt(foodPerKitten)],
      ['Dissent', `${Math.round(diss*100)}% (${dissBand})`],
      ['Compliance', `x${compMul.toFixed(2)}`],
    ];
    for (const [k,v] of stats) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`;
      statsEl.appendChild(d);
    }

    const plan = state._lastPlan?.desired;
    const planLine = plan ? ('\nAI plan: ' + summarizePlan(plan)) : '';

    ensureRateState(state);
    const r = state._rate ?? {};
    const foodRate = Number(r.food ?? 0);
    const warmthRate = Number(r.warmth ?? 0);
    const threatRate = Number(r.threat ?? 0);
    const scienceRate = Number(r.science ?? 0);

    const raidEta = fmtEtaSeconds(etaToTarget(state.res.threat, 100, threatRate));
    const threatTargetEta = fmtEtaSeconds(etaToTarget(state.res.threat, targets.maxThreat, threatRate));
    const warmthToTargetEta = fmtEtaSeconds(etaToTarget(state.res.warmth, targets.warmth, warmthRate));

    // Danger forecasts (explainability): if a trend is negative, show time-to-zero.
    const starveEta = (foodRate < -0.02) ? fmtEtaSeconds((state.res.food) / (-foodRate)) : '-';
    const freezeEta = (warmthRate < -0.02) ? fmtEtaSeconds((state.res.warmth) / (-warmthRate)) : '-';

    // Next unlock ETA (explainability: "what should I aim for?")
    const nextUnlock = unlockDefs.find(u => !state.seenUnlocks[u.id]);
    const nextUnlockEta = nextUnlock ? fmtEtaSeconds(etaToTarget(state.res.science, nextUnlock.at, scienceRate)) : '-';

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
            <div class="small" style="flex:1 1 auto">${pd.name}: owned ${owned} — ${prog.toFixed(1)}/${req} (${Math.round(pct*100)}%)${blocked}</div>
            <button class="btn" data-focus="${pd.focus}" title="Sets Project focus → ${pd.focus} (a build-order nudge)">Focus</button>
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
      ? `Project focus (auto): ${pfEff.focus}${pfEff.focus === 'Auto' ? '' : ` — ${pfEff.why}`}\n`
      : `Project focus (manual): ${pfSet}\n`;

    const festLeft = festivalSecondsLeft(state);
    const festLine = (festLeft > 0) ? `Festival: active (${Math.ceil(festLeft)}s) — morale drifting up\n` : '';

    const amOn = !!state.director?.autoMode;
    const amWhy = String(state.director?.autoModeWhy ?? '').trim();
    const amLine = amOn ? `Auto mode: ON${amWhy ? ` — ${amWhy}` : ''}\n` : '';

    const arOn = !!state.director?.autoRecruit;
    const arYear = Number(state.director?.recruitYear ?? -1);
    const curYear = yearAt(state.t);
    const arLine = arOn ? `Auto recruit: ON (Spring; ${arYear === curYear ? 'already recruited this year' : 'eligible'})\n` : '';

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
      arLine +
      festLine +
      `Colony efficiency: ${(avgEff*100).toFixed(0)}% (hungry/tired/cold/health/mood slows work) | avg health ${(avgHealth*100).toFixed(0)}% | avg mood ${(avgMood*100).toFixed(0)}%\n` +
      `Trends: food ${fmtRate(foodRate)} | warmth ${fmtRate(warmthRate)} | threat ${fmtRate(threatRate)} | science ${fmtRate(scienceRate)}\n` +
      forecastLine +
      `Danger forecast: food→0 in ${starveEta} | warmth→0 in ${freezeEta}\n` +
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
      const roleMul = 1.10 - 0.35 * effA;
      ah.textContent = `${aPct}% (effective ${Math.round(effA*100)}%) | likes +${likeBonus.toFixed(0)} / dislikes -${dislikePenalty.toFixed(0)} | role pressure x${roleMul.toFixed(2)} | dissent ${Math.round(disNow*100)}% (comp x${compNow.toFixed(2)})`;
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
      dh.textContent = `${dPct}% | compliance x${compNow.toFixed(2)} | effective autonomy ${Math.round(effAut*100)}% | morale cost (small)`;
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

    renderPolicy();
    renderRoleQuotas();

    // Plan debug (explainability for coordination)
    if (planDebugEl) {
      const p = state._lastPlan;
      if (!p) {
        planDebugEl.textContent = '-';
      } else {
        const order = ['Forage','Farm','PreserveFood','ChopWood','StokeFire','Guard','BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary','CraftTools','Research','Eat','Rest'];
        const lines = [];
        for (const a of order) {
          const want = p.desired?.[a] ?? 0;
          const have = p.assigned?.[a] ?? 0;
          if ((want|0) === 0 && (have|0) === 0) continue;
          const mark = have < want ? '!' : (have > want ? '~' : ' ');
          lines.push(`${mark} ${a.padEnd(12)} ${String(have).padStart(2)}/${String(want).padStart(2)}`);
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
      const p = k.personality ?? genPersonality(k.id ?? 0);
      const likes = Array.isArray(p.likes) ? p.likes : [];
      const dislikes = Array.isArray(p.dislikes) ? p.dislikes : [];

      // Traits: keep the table readable; put the full list in a tooltip.
      const traitsShort = `likes:${likes.length}${dislikes.length ? ` hates:${dislikes.length}` : ''}`;
      const traitsTitle = `${likes.join(',')}${dislikes.length ? ` | hates ${dislikes.join(',')}` : ''}`;

      // Pref: show whether the current task aligns with the kitten's likes/dislikes.
      // Also surface an “Autonomy sampled” tag if they didn’t pick the #1 scored action this tick.
      const prefParts = [];
      if (likes.includes(k.task)) prefParts.push('Like');
      if (dislikes.includes(k.task)) prefParts.push('Dislike');
      const autoFresh = (k._autonomyPickNote && (state.t - Number(k._autonomyPickAt ?? 0)) < 2);
      if (autoFresh) prefParts.push('Autonomy');
      const pref = prefParts.length ? prefParts.join(' / ') : '-';

      tr.innerHTML = `
        <td>${k.id}</td>
        <td title="${escapeHtml(k.roleWhy ?? '')}">${escapeHtml(k.role ?? '-')}</td>
        <td title="${k._fallbackTo ? escapeHtml('fallback → ' + k._fallbackTo) : ''}">${k.task}${(k._mentor && k.task==='Mentor') ? (' → #' + k._mentor.id + ' ' + escapeHtml(k._mentor.skill)) : ''}${k._fallbackTo ? (' → ' + escapeHtml(k._fallbackTo)) : ''}</td>
        <td>${fmt(k.energy*100)}%</td>
        <td>${fmt(k.hunger*100)}%</td>
        <td title="Health (sickness/injury reduces efficiency)">${fmt((k.health ?? 1)*100)}%</td>
        <td title="Mood (personality alignment + stress + aptitude fit; small effect on efficiency)">${fmt(mood*100)}%</td>
        <td title="Work effectiveness (hungry/tired/cold/health/mood)">${fmt(eff*100)}%</td>
        <td title="Aptitude (highest skill level) — kittens tend to prefer this kind of work">${escapeHtml(`${top.skill ?? '-'}`)}:${top.level}</td>
        <td>${topSkills}</td>
        <td title="${escapeHtml(traitsTitle)}">${escapeHtml(traitsShort)}</td>
        <td title="Preference alignment for current task (plus autonomy sampling flag)">${escapeHtml(pref)}</td>
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

    // Keep inspector in sync with latest snapshots.
    renderInspect();
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
    const order = ['Forage','Farm','PreserveFood','ChopWood','StokeFire','Guard','BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary','CraftTools','Research'];
    return order
      .map(a => ({ a, n: desired[a] ?? 0 }))
      .filter(x => x.n > 0)
      .map(x => `${x.a}×${x.n}`)
      .join('  ');
  }

  function renderPolicy(){
    // Migration safety
    state.policyMult = state.policyMult ?? { Forage:1, PreserveFood:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Research:1 };

    const rows = [
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
      ['Research','Research'],
    ];

    const lock = (a) =>
      (a === 'Farm' && !state.unlocked.farm) ||
      (a === 'PreserveFood' && !state.unlocked.construction) ||
      (a === 'CraftTools' && !state.unlocked.workshop) ||
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

    policyEl.innerHTML = rows.map(([label,a]) => line(label,a)).join('');
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
    const opts = ['Eat','Rest','Loaf','Forage','PreserveFood','ChopWood','StokeFire','Guard','Research'];
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
        autonomy: clamp01(Number(state.director.autonomy ?? 0.60)),
        discipline: clamp01(Number(state.director.discipline ?? 0.40)),
        workPace: Math.max(0.8, Math.min(1.2, Number(state.director.workPace ?? 1.00) || 1.00)),
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
      if ('autonomy' in snap.director) state.director.autonomy = clamp01(Number(snap.director.autonomy ?? 0.60));
      if ('discipline' in snap.director) state.director.discipline = clamp01(Number(snap.director.discipline ?? 0.40));
      if ('workPace' in snap.director) state.director.workPace = Math.max(0.8, Math.min(1.2, Number(snap.director.workPace ?? 1.00) || 1.00));
    }

    // Safety: ALARM is gated by Security unlock.
    if (!state.unlocked.security) state.signals.ALARM = false;
  }

  function setWinterPrep(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto' };
    if (on && !state.director.winterPrep) {
      // Save current director knobs so the player can cleanly revert.
      state.director.saved = snapshotDirectorSettings();

      const n = state.kittens.length;
      // Mode stays as-is; Winter Prep is intended as an overlay (so you can prep while in Expand/Advance).
      // But we do gently bias the targets + reserves so the plan/scoring naturally shifts.
      state.targets.foodPerKitten = Math.max(state.targets.foodPerKitten ?? 120, 155);
      state.targets.warmth = Math.max(state.targets.warmth ?? 60, 72);

      // Reserves: don't let builders/crafters drain the winter lifelines.
      state.reserve = state.reserve ?? { food:0, wood:18, science:25, tools:0 };
      state.reserve.food = Math.max(state.reserve.food ?? 0, 70 * n);
      state.reserve.wood = Math.max(state.reserve.wood ?? 0, 28);
      state.reserve.science = Math.max(state.reserve.science ?? 0, 25);
      // Keep a small tool buffer so library building doesn't nuke productivity during winter.
      state.reserve.tools = Math.max(state.reserve.tools ?? 0, state.unlocked.workshop ? (5 * n) : 0);

      // Policy: prioritize food + warmth + threat control, pause shiny projects.
      // (Players can still override with multipliers or safety rules.)
      setPolicy({ Forage:1.35, Farm:1.35, PreserveFood:1.30, ChopWood:1.25, StokeFire:1.55, Guard:1.15, BuildHut:0.55, BuildPalisade:1.00, BuildGranary:1.10, BuildWorkshop:0.55, BuildLibrary:0.45, CraftTools:0.65, Research:0.55 }, 'Winter Prep ON: raise buffers + shift labor to food/wood/fire (and preserve surplus) so you don’t spiral in Winter.');

      // Gentle specialization target: keep at least 1 Firekeeper once pop grows.
      state.roleQuota = state.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
      if (n >= 4) state.roleQuota.Firekeeper = Math.max(state.roleQuota.Firekeeper ?? 0, 1);

      state.director.winterPrep = true;
      save();
      render();
    } else if (!on && state.director.winterPrep) {
      // Revert all director knobs back to snapshot.
      const snap = state.director.saved;
      applyDirectorSettings(snap);
      state.director.saved = null;
      state.director.winterPrep = false;
      log('Winter Prep OFF: restored previous director settings.');
      save();
      render();
    }
  }

  function setCrisisProtocol(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto' };
    if (on && !state.director.crisis) {
      state.director.crisisSaved = snapshotDirectorSettings();

      const n = Math.max(1, state.kittens.length);
      state.mode = 'Survive';
      state.rations = 'Tight';

      // Targets: stabilize before anything else.
      state.targets.foodPerKitten = Math.max(state.targets.foodPerKitten ?? 120, 140);
      state.targets.warmth = Math.max(state.targets.warmth ?? 60, 66);
      state.targets.maxThreat = Math.min(state.targets.maxThreat ?? 70, 60);

      // Signals: force food focus; raise ALARM if the tech exists.
      state.signals = state.signals ?? { BUILD:false, FOOD:false, ALARM:false };
      state.signals.FOOD = true;
      state.signals.BUILD = false;
      state.signals.ALARM = state.unlocked.security ? true : false;

      // Reserves: clamp spending so the colony can't "eat" its own lifelines.
      state.reserve = state.reserve ?? { food:0, wood:18, science:25, tools:0 };
      state.reserve.food = Math.max(getReserve(state,'food'), Math.round((90 * n) / 10) * 10);
      state.reserve.wood = Math.max(getReserve(state,'wood'), 26);
      state.reserve.science = Math.max(getReserve(state,'science'), 25);
      state.reserve.tools = Math.max(getReserve(state,'tools'), 0);

      // Policy: heavy stabilization, almost no shiny sinks.
      setPolicy({ Forage:1.65, Farm:1.55, PreserveFood:0.60, ChopWood:1.15, StokeFire:1.70, Guard:1.45, BuildHut:0.10, BuildPalisade:0.65, BuildGranary:0.10, BuildWorkshop:0.00, BuildLibrary:0.00, CraftTools:0.00, Research:0.10 }, 'Crisis Protocol ON: clamp spending + force stabilization (food/warmth/threat). Toggle OFF once stable.');

      // Gentle role steering: keep at least one guard + firekeeper if population supports it.
      state.roleQuota = state.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
      if (n >= 4) state.roleQuota.Firekeeper = Math.max(state.roleQuota.Firekeeper ?? 0, 1);
      if (n >= 5) state.roleQuota.Guard = Math.max(state.roleQuota.Guard ?? 0, 1);

      state.director.crisis = true;
      save();
      render();
    } else if (!on && state.director.crisis) {
      const snap = state.director.crisisSaved;
      applyDirectorSettings(snap);
      state.director.crisisSaved = null;
      state.director.crisis = false;
      log('Crisis Protocol OFF: restored previous director settings.');
      save();
      render();
    }
  }

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
    state.effects = state.effects ?? { festivalUntil: 0 };
    const res = holdFestival(state);
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
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoReserves = !!e.target.checked;
    log(`Auto Reserves → ${state.director.autoReserves ? 'ON' : 'OFF'}`);
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

  const autoRecruitEl = document.getElementById('autoRecruit');
  if (autoRecruitEl) autoRecruitEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoRecruit:false, recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, workPace: 1.00 };
    state.director.autoRecruit = !!e.target.checked;
    log(`Auto Recruit → ${state.director.autoRecruit ? 'ON' : 'OFF'}`);
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
    const foodPerKitten = Number(s.res?.food ?? 0) / n;
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
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    if (!('discipline' in state.director)) state.director.discipline = 0.40;
    const pct = Math.max(80, Math.min(120, Number(e.target.value) || 100));
    state.director.workPace = Math.max(0.8, Math.min(1.2, pct / 100));
    log(`Work pace → ${Math.round(state.director.workPace * 100)}%`);
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
      Research: mult.Research ?? 1,
    };
    log(note);
    save();
    render();
  }

  function applyPolicyPreset(name){
    // Presets are *nudges*; safety rules still override and scoring still matters.
    if (name === 'Survive') {
      setPolicy({ Forage:1.25, Farm:1.25, PreserveFood:1.10, ChopWood:1.10, StokeFire:1.35, Guard:1.05, BuildHut:0.75, BuildPalisade:0.85, BuildGranary:1.20, BuildWorkshop:0.85, BuildLibrary:0.75, CraftTools:0.75, Research:0.85 }, 'Policy preset → Survive (food + warmth first).');
    } else if (name === 'Expand') {
      setPolicy({ Forage:1.00, Farm:1.00, ChopWood:1.35, StokeFire:1.00, Guard:0.90, BuildHut:1.50, BuildPalisade:1.05, BuildGranary:1.25, BuildWorkshop:1.10, BuildLibrary:0.95, CraftTools:1.00, Research:0.85 }, 'Policy preset → Expand (wood + building).');
    } else if (name === 'Defend') {
      setPolicy({ Forage:1.00, Farm:1.00, ChopWood:1.10, StokeFire:1.00, Guard:1.60, BuildHut:0.85, BuildPalisade:1.55, BuildGranary:1.00, BuildWorkshop:0.80, BuildLibrary:0.70, CraftTools:0.75, Research:0.75 }, 'Policy preset → Defend (guard + palisade).');
    } else if (name === 'Advance') {
      setPolicy({ Forage:0.90, Farm:1.00, ChopWood:1.00, StokeFire:0.95, Guard:0.95, BuildHut:0.70, BuildPalisade:0.80, BuildGranary:1.05, BuildWorkshop:1.35, BuildLibrary:1.45, CraftTools:1.45, Research:1.60 }, 'Policy preset → Advance (research + tools).');
    }
  }

  document.getElementById('btnPolicyPresetSurvive').addEventListener('click', () => applyPolicyPreset('Survive'));
  document.getElementById('btnPolicyPresetExpand').addEventListener('click', () => applyPolicyPreset('Expand'));
  document.getElementById('btnPolicyPresetDefend').addEventListener('click', () => applyPolicyPreset('Defend'));
  document.getElementById('btnPolicyPresetAdvance').addEventListener('click', () => applyPolicyPreset('Advance'));

  document.getElementById('btnPolicyReset').addEventListener('click', () => {
    setPolicy({ Forage:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Research:1 }, 'Policy reset to defaults (all 1.0).');
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

    // Strip transient UI/debug keys (avoid save bloat)
    if (Array.isArray(s.kittens)) {
      for (const k of s.kittens) {
        delete k._lastScores;
        delete k._lastScoredAt;
        delete k._autonomyPickNote;
        delete k._autonomyPickAt;
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
      s.effects = s.effects ?? { festivalUntil: 0 };

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
      s.effects = s.effects ?? { festivalUntil: 0 };
      if (!('festivalUntil' in s.effects)) s.effects.festivalUntil = 0;
      s.effects.festivalUntil = Number(s.effects.festivalUntil ?? 0) || 0;

      s.policyMult = s.policyMult ?? { Forage:1, PreserveFood:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Research:1 };
      // Add any missing keys for forward-compatible saves
      for (const [k, v] of Object.entries({ Forage:1, PreserveFood:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Research:1 })) {
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
        k.skills = k.skills ?? { Foraging:1, Farming:1, Woodcutting:1, Building:1, Scholarship:1, Combat:1, Cooking:1 };
        k.xp = k.xp ?? { Foraging:0, Farming:0, Woodcutting:0, Building:0, Scholarship:0, Combat:0, Cooking:0 };
        for (const [sk,lv] of Object.entries({ Foraging:1, Farming:1, Woodcutting:1, Building:1, Scholarship:1, Combat:1, Cooking:1 })) if (!(sk in k.skills)) k.skills[sk] = lv;
        for (const [sk,xp] of Object.entries({ Foraging:0, Farming:0, Woodcutting:0, Building:0, Scholarship:0, Combat:0, Cooking:0 })) if (!(sk in k.xp)) k.xp[sk] = xp;
        k.health = clamp01(Number(k.health ?? 1));
        k.mood = clamp01(Number(k.mood ?? 0.55));
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

    log(`Patch notes v${GAME_VERSION}:`);
    log('- Added Dissent + Compliance to the top stat cards (so "why are they loafing/ignoring plan?" is obvious).');
    log('- Dissent band (calm/murmur/strike) is now always visible without scrolling into the Season panel.');
    log('- No save changes: existing saves load cleanly.');

    state.meta.seenVersion = GAME_VERSION;
    // Save immediately so refresh won’t repeat.
    save();
  }

  render();
  requestAnimationFrame(frame);
  maybeShowPatchNotes();
})();
