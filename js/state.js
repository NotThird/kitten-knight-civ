// state.js — save/load + migrations
// Kept as a small module boundary while main.js is gradually decomposed.

export function saveGame(state, { GAME_VERSION, SAVE_KEY } = {}) {
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
  delete s._spoilWarned;
  delete s._blockedThisSecond;
  delete s._blockedMsgThisSecond;
  delete s._buddyBeatCooldown;
  delete s._trendEvents;
  delete s._sharedWorkEdges;
  delete s._coterieInfluence;
  delete s._coterieTraditions;
  delete s._coterieEthos;
  delete s._coterieEthosBand;
  delete s._coterieEthosByKid;
  delete s._coterieIdByKid;
  delete s._coteriePressure;
  delete s._coteriePressureGate;

  // Strip transient UI/debug keys (avoid save bloat)
  if (Array.isArray(s.kittens)) {
    for (const k of s.kittens) {
      delete k._lastScores;
      delete k._lastScoredAt;
      delete k._autonomyPickNote;
      delete k._autonomyPickAt;
      delete k._lastDecision;
      delete k._lastBlocked;
      delete k._buddyBeatBand;
      delete k._workMem;
    }
  }

  // Stamp version for patch-note gating.
  s.meta = s.meta ?? {};
  s.meta.version = GAME_VERSION;
  s.meta.lastTs = Date.now();

  localStorage.setItem(SAVE_KEY, JSON.stringify(s));
}

// Headless-friendly migration helper (used by loadGame + replay harnesses).
// Accepts a parsed save object and returns a migrated/normalized state.
export function migrateState(s, {
  LOG_MAX,
  clamp01,
  ensureKittenName,
  genPersonality,
  genTraits,
} = {}) {
  if (!s || !s.res || !s.kittens || !s.rules) return null;

  s.mode = s.mode ?? 'Survive';

  // Migration: cap persisted event log so old saves don't balloon localStorage.
  s.log = Array.isArray(s.log) ? s.log : [];
  if (Number.isFinite(LOG_MAX) && s.log.length > LOG_MAX) s.log = s.log.slice(-LOG_MAX);

  // Society feed (high-signal, player-facing). Persisted + capped.
  s.feed = Array.isArray(s.feed) ? s.feed : [];
  const FEED_MAX = 220;
  if (s.feed.length > FEED_MAX) s.feed = s.feed.slice(-FEED_MAX);
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
  s.director = s.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDangerPause:false, autoDangerPauseNextAt:0, autoDangerPauseWhy:'', projectFocus:'Auto', autonomy: 0.60 };
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
  if (!('autoPolicy' in s.director)) s.director.autoPolicy = false;
  if (!('autoPolicyNextAt' in s.director)) s.director.autoPolicyNextAt = 0;
  if (!('autoPolicyWhy' in s.director)) s.director.autoPolicyWhy = '';
  if (!('autoMode' in s.director)) s.director.autoMode = false;
  if (!('autoModeNextChangeAt' in s.director)) s.director.autoModeNextChangeAt = 0;
  if (!('autoModeWhy' in s.director)) s.director.autoModeWhy = '';
  if (!('autoDangerPause' in s.director)) s.director.autoDangerPause = false;
  if (!('autoDangerPauseNextAt' in s.director)) s.director.autoDangerPauseNextAt = 0;
  if (!('autoDangerPauseWhy' in s.director)) s.director.autoDangerPauseWhy = '';
  if (!('confirmFactions' in s.director)) s.director.confirmFactions = true;
  if (!('projectFocus' in s.director)) s.director.projectFocus = 'Auto';
  if (!('pinnedProject' in s.director)) s.director.pinnedProject = null;
  // Migration: sanitize pinned project payload (keep it small + safe)
  if (s.director.pinnedProject && typeof s.director.pinnedProject === 'object') {
    const t = String(s.director.pinnedProject.type ?? '');
    const so = Number(s.director.pinnedProject.startOwned ?? 0);
    if (!['Hut','Palisade','Granary','Workshop','Library'].includes(t) || !Number.isFinite(so) || so < 0) s.director.pinnedProject = null;
    else s.director.pinnedProject = { type: t, startOwned: so, at: Number(s.director.pinnedProject.at ?? 0) || 0 };
  } else {
    s.director.pinnedProject = null;
  }
  if (!('autonomy' in s.director)) s.director.autonomy = 0.60;
  if (!('workPace' in s.director)) s.director.workPace = 1.00;
  if (typeof clamp01 === 'function') s.director.autonomy = clamp01(Number(s.director.autonomy ?? 0.60));
  else s.director.autonomy = Math.max(0, Math.min(1, Number(s.director.autonomy ?? 0.60) || 0.60));
  s.director.workPace = Math.max(0.8, Math.min(1.2, Number(s.director.workPace ?? 1.00) || 1.00));

  // Director profile slots (save/load policy stacks)
  if (!('profiles' in s.director) || !s.director.profiles) s.director.profiles = { A:null, B:null, C:null };
  for (const k of ['A','B','C']) if (!(k in s.director.profiles)) s.director.profiles[k] = null;

  // Curator (aquarium mode): minimal levers; safe default for old saves.
  if (!('curator' in s.director) || !s.director.curator || typeof s.director.curator !== 'object') {
    s.director.curator = { goal:'Thrive', ethos:'Balanced', intervention: 30, enabled:true, appliedOnce:false };
  }
  const c = s.director.curator;
  const goal = String(c.goal ?? 'Thrive');
  c.goal = ['Thrive','Expand','Defend','Innovate','Harmonize'].includes(goal) ? goal : 'Thrive';
  const ethos = String(c.ethos ?? 'Balanced');
  c.ethos = ['Gentle','Balanced','Strict'].includes(ethos) ? ethos : 'Balanced';
  c.intervention = Math.max(0, Math.min(100, Number(c.intervention ?? 30) || 30));
  if (!('enabled' in c)) c.enabled = true;
  if (!('devMode' in c)) c.devMode = false;
  if (!('appliedOnce' in c)) c.appliedOnce = false;

  // Effects migration
  s.effects = s.effects ?? { festivalUntil: 0, councilUntil: 0 };

  // Social layer migration (includes persistent norms / society memory).
  s.social = (s.social && typeof s.social === 'object') ? s.social : { dissent: 0, band: 'calm', lastLogBand: '', lastLogAt: 0 };
  if (!('dissent' in s.social)) s.social.dissent = 0;
  if (!('band' in s.social)) s.social.band = 'calm';
  if (!('lastLogBand' in s.social)) s.social.lastLogBand = '';
  if (!('lastLogAt' in s.social)) s.social.lastLogAt = 0;
  s.social.norms = (s.social.norms && typeof s.social.norms === 'object') ? s.social.norms : { raidParanoia: 0, scarcityMindset: 0 };
  if (!('raidParanoia' in s.social.norms)) s.social.norms.raidParanoia = 0;
  if (!('scarcityMindset' in s.social.norms)) s.social.norms.scarcityMindset = 0;
  s.social.norms.raidParanoia = (typeof clamp01 === 'function') ? clamp01(Number(s.social.norms.raidParanoia ?? 0)) : Math.max(0, Math.min(1, Number(s.social.norms.raidParanoia ?? 0) || 0));
  s.social.norms.scarcityMindset = (typeof clamp01 === 'function') ? clamp01(Number(s.social.norms.scarcityMindset ?? 0)) : Math.max(0, Math.min(1, Number(s.social.norms.scarcityMindset ?? 0) || 0));
  if (!('normsBand' in s.social)) s.social.normsBand = 'calm';
  if (!('normsLastAt' in s.social)) s.social.normsLastAt = 0;
  s.social.normsBand = String(s.social.normsBand ?? 'calm');
  s.social.normsLastAt = Number(s.social.normsLastAt ?? 0) || 0;
  if (!('scarcityBand' in s.social)) s.social.scarcityBand = 'calm';
  if (!('scarcityLastAt' in s.social)) s.social.scarcityLastAt = 0;
  s.social.scarcityBand = String(s.social.scarcityBand ?? 'calm');
  s.social.scarcityLastAt = Number(s.social.scarcityLastAt ?? 0) || 0;
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
    if (typeof ensureKittenName === 'function') ensureKittenName(k);
    if (typeof genPersonality === 'function') k.personality = k.personality ?? genPersonality(k.id ?? 0);
    else k.personality = k.personality ?? {};
    if (typeof genTraits === 'function') k.traits = Array.isArray(k.traits) ? k.traits : genTraits(k.id ?? 0);
    else k.traits = Array.isArray(k.traits) ? k.traits : [];
    // Migration: per-kitten Directive (player-set bias)
    if (!('directive' in k)) k.directive = 'Auto';
    const _dir = String(k.directive ?? 'Auto');
    k.directive = ['Auto','Food','Safety','Progress','Social','Rest'].includes(_dir) ? _dir : 'Auto';
    k.skills = k.skills ?? { Foraging:1, Farming:1, Woodcutting:1, Building:1, Scholarship:1, Combat:1, Cooking:1 };
    k.xp = k.xp ?? { Foraging:0, Farming:0, Woodcutting:0, Building:0, Scholarship:0, Combat:0, Cooking:0 };
    for (const [sk,lv] of Object.entries({ Foraging:1, Farming:1, Woodcutting:1, Building:1, Scholarship:1, Combat:1, Cooking:1 })) if (!(sk in k.skills)) k.skills[sk] = lv;
    for (const [sk,xp] of Object.entries({ Foraging:0, Farming:0, Woodcutting:0, Building:0, Scholarship:0, Combat:0, Cooking:0 })) if (!(sk in k.xp)) k.xp[sk] = xp;
    if (typeof clamp01 === 'function') {
      k.health = clamp01(Number(k.health ?? 1));
      k.mood = clamp01(Number(k.mood ?? 0.55));
      k.grievance = clamp01(Number(k.grievance ?? 0));
    } else {
      const c01 = (n) => Math.max(0, Math.min(1, Number(n ?? 0) || 0));
      k.health = c01(k.health ?? 1);
      k.mood = c01(k.mood ?? 0.55);
      k.grievance = c01(k.grievance ?? 0);
    }
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
}

export function loadGame({
  SAVE_KEY,
  LOG_MAX,
  clamp01,
  ensureKittenName,
  genPersonality,
  genTraits,
} = {}) {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return migrateState(parsed, { LOG_MAX, clamp01, ensureKittenName, genPersonality, genTraits });
  } catch {
    return null;
  }
}
