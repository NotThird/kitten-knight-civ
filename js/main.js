import { saveGame, loadGame } from './state.js';
import { fmt, clamp01, now } from './util.js';
import { makeCoreTaskDefs } from './tasks_core.js';
import { SEASON_LEN, YEAR_LEN, seasonAt, yearAt, seasonTargets, secondsToNextSeason, secondsToNextWinter, efficiency, momentumMul, ensureRateState, updateRates, updateProjectRates, runKittensTick, runDecisionSecond } from './sim.js';
import { initUI, initCuratorControls, initPatchNotes, initInspectModal, initSocietyInspectors, initSaveIO, initDirectorProfiles, initDirectiveTools, initDoctrineControls, initAutoModeControls, initAutoDoctrineControls, initAutoRationsControls, initAutoRecruitControls, initAutoWinterPrepControls, initAutoFoodCrisisControls, initAutoReservesControls, initAutoPolicyControls, initAutoBuildPushControls, initConfirmPoliticsControls, renderDirectorProfiles, renderProjectFocusHint, renderPinnedProjectControls, renderDirectiveTools } from './ui.js';
import { PATCH_HISTORY } from './content.js';
import { createSkillRegistry, TASK_SKILL_MAP, SKILL_CATEGORIES, ERAS } from './skills.js';
import { GENERATED_SKILLS } from './skills_generated.js';
import { renderRadar, renderSkillTrend, renderVitalsTrend, renderActivityBar } from './charts.js';

(() => {
  const GAME_VERSION = '0.9.136';
  const LOG_MAX = 260; // cap persisted event log lines to keep saves/localStorage small + fast
  const SAVE_KEY = 'kittenKnightCiv';

  // --- Living Skill Registry (DCC-inspired) ─────────────────────────────────
  // Every micro-action is a skill. Skills are discovered organically and impact the simulation.
  const skillRegistry = createSkillRegistry();
  // Register any OpenClaw-generated skills
  for (const def of GENERATED_SKILLS) skillRegistry.register(def);

  // Primary skill for a task (first micro-skill in TASK_SKILL_MAP)
  function skillForAction(action){
    const a = String(action ?? '');
    return skillRegistry.primaryForTask(a);
  }

  // Highest-level skill on a kitten (checks all micro-skills + categories)
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

  // Top category skill (for scoring, mentor, display)
  function topCategorySkill(k){
    const cats = Object.keys(SKILL_CATEGORIES);
    let best = null;
    let bestLvl = -1;
    for (const cat of cats) {
      const lvl = Number(k?.skills?.[cat] ?? 1);
      if (lvl > bestLvl) { bestLvl = lvl; best = cat; }
    }
    return { skill: best, level: (bestLvl > 0 ? bestLvl : 1) };
  }


  // --- Auto Project Focus (Director)
  // "Project focus" is a player nudge to bias build choices.
  // When set to Auto, we pick a focus each second based on obvious colony pain points.
  // This keeps the loop incremental (one priority at a time) while staying explainable.

  // --- Pinned Project (build-order micro loop)
  // Goal: let the player say "finish ONE Hut/Granary/etc" without having to permanently crank policy sliders.
  // Implementation: a pinned project temporarily overrides effective Project focus until ONE unit completes.
  function pinnedProjectDef(type){
    const t = String(type || '');
    if (t === 'Hut')      return { type:'Hut',      task:'BuildHut',      focus:'Housing',   owned: (s) => Number(s?.res?.huts ?? 0),        req:12, progressKey:'_hutProgress' };
    if (t === 'Palisade') return { type:'Palisade', task:'BuildPalisade', focus:'Defense',   owned: (s) => Number(s?.res?.palisade ?? 0),    req:16, progressKey:'_palProgress' };
    if (t === 'Granary')  return { type:'Granary',  task:'BuildGranary',  focus:'Storage',   owned: (s) => Number(s?.res?.granaries ?? 0),   req:22, progressKey:'_granProgress' };
    if (t === 'Workshop') return { type:'Workshop', task:'BuildWorkshop', focus:'Industry',  owned: (s) => Number(s?.res?.workshops ?? 0),   req:26, progressKey:'_workProgress' };
    if (t === 'Library')  return { type:'Library',  task:'BuildLibrary',  focus:'Knowledge', owned: (s) => Number(s?.res?.libraries ?? 0),   req:30, progressKey:'_libProgress' };
    return null;
  }

  function pinnedProjectInfo(s){
    const p = s?.director?.pinnedProject;
    if (!p || typeof p !== 'object') return null;
    const type = String(p.type || '');
    const def = pinnedProjectDef(type);
    if (!def) return null;

    // Only meaningful once Construction exists.
    if (!s.unlocked?.construction) return null;

    const startOwned = Number(p.startOwned ?? 0);
    const curOwned = Number(def.owned?.(s) ?? 0);
    const completed = curOwned > startOwned;
    return { ...def, startOwned, curOwned, completed };
  }

  function clearPinnedProject(s, msg){
    s.director = s.director ?? {};
    s.director.pinnedProject = null;
    if (msg) log(msg);
  }

  // Pinned projects are meant to be a tiny build-order loop: "finish ONE thing".
  // Auto-clear the pin immediately once the requested project completes.
  // Save-safe: if a save has an old pin, it'll still clear once completion is detected.
  function maybeAutoClearPinnedProject(s, builtType){
    const p = pinnedProjectInfo(s);
    if (!p) return;
    if (p.completed && String(p.type || '') === String(builtType || '')) {
      clearPinnedProject(s, `Pinned project complete: ${p.type}.`);
    }
  }

  function getEffectiveProjectFocus(s){
    // Pinned project overrides focus until ONE unit completes.
    const pinned = pinnedProjectInfo(s);
    if (pinned && !pinned.completed) {
      return { focus: pinned.focus, why: `pinned project: ${pinned.type} (${pinned.curOwned}/${pinned.startOwned + 1})`, auto: false };
    }

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

  const REVEAL_STAGE_MAX = 4;
  const REVEAL_STAGE_NAMES = ['Core', 'First Action', 'Trends', 'Systems', 'Full Civ'];
  const REVEAL_GATES = [
    null,
    { timeSec: 15 },
    { timeSec: 30 },
    { timeSec: 45 },
    { timeSec: 60 },
  ];

  function revealStageOf(s){
    const raw = Number(s?.meta?.revealStage ?? 0);
    return Math.max(0, Math.min(REVEAL_STAGE_MAX, Math.floor(raw) || 0));
  }

  function feedOnce(s, msg){
    s.feed = Array.isArray(s.feed) ? s.feed : [];
    s.feed.push(`[${fmt(s.t)}] ${msg}`);
    const FEED_MAX = 220;
    if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);
  }

  function tryAdvanceRevealStage(s){
    s.meta = s.meta ?? {};
    let stage = revealStageOf(s);
    while (stage < REVEAL_STAGE_MAX) {
      const next = stage + 1;
      const gate = REVEAL_GATES[next];
      const byMilestone = !!(gate && typeof gate.milestone === 'function' && gate.milestone(s));
      const byTime = !!(gate && Number(s.t ?? 0) >= Number(gate.timeSec ?? Infinity));
      if (!byMilestone && !byTime) break;
      stage = next;
      s.meta.revealStage = stage;
      const why = byMilestone ? 'milestone reached' : `time ${fmt(Number(gate.timeSec ?? 0))}s`;
      feedOnce(s, `UI unlock: Stage ${stage} (${REVEAL_STAGE_NAMES[stage]}). ${why}.`);
    }
    return stage;
  }

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
    res: { food: 220, jerky: 0, wood: 35, warmth: 70, threat: 8, huts: 0, palisade: 0, granaries: 0, workshops: 0, libraries: 0, science: 0, tools: 0 },
    unlocked: { construction:false, workshop:false, farm:false, security:false, granary:false, library:false },
    seenUnlocks: {},
    kittens: [ makeKitten(1), makeKitten(2), makeKitten(3), makeKitten(4), makeKitten(5), makeKitten(6) ],
    // Player policy: biases the colony-level plan (not hard locks; rules still override).
    policyMult: { Socialize:1, Care:1, Forage:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, PreserveFood:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Mentor:1, Research:1 },
    // Optional role quotas: "try to keep N kittens in this role" (0 = no quota).
    roleQuota: { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 },
    rules: defaultRules(),
    // Director helpers (not required for core sim; safe to ignore in old saves)
    director: { winterPrep:false, saved:null, crisis:false, crisisSaved:null, curfew:false, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoPolicy:false, autoPolicyNextAt:0, autoPolicyWhy:'', autoBuildPush:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', autoRecruit:false, autoRecruitWhy:'', autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', autoCouncil:false, autoCouncilNextAt:0, autoCouncilWhy:'', autoDangerPause:false, autoDangerPauseNextAt:0, autoDangerPauseWhy:'', confirmFactions:true, recruitYear:-1, projectFocus:'Auto', pinnedProject:null, autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00, prioSocial: 1.00, graphTab:'society', curator: { goal:'Thrive', ethos:'Balanced', intervention: 30, enabled:true } },
    // Social layer (emergence): dissent reduces plan compliance; discipline restores it.
    // Also includes slow-moving, persistent norms (society "memory") so macro events leave cultural scars.
    social: {
      dissent: 0,
      band: 'calm',
      lastLogBand: '',
      lastLogAt: 0,
      norms: { raidParanoia: 0, scarcityMindset: 0, mutualAid: 0 }, // 0..1: raid vigilance + scarcity memory + mutual-aid culture; all slowly decay
      normsBand: 'calm',
      normsLastAt: 0,
      scarcityBand: 'calm',
      scarcityLastAt: 0,
      mutualAidBand: 'atomized',
      mutualAidLastAt: 0,
    },
    // Lightweight timed colony-wide effects (kept simple + transparent)
    effects: { festivalUntil: 0, councilUntil: 0 },
    legacy: { shards: 0, totalShards: 0, resets: 0, upgrades: {} },
    eternity: { sigils: 0, totalSigils: 0, resets: 0, upgrades: {}, mandate: 'harmony', preserve: 'balanced' },
    research: { unlocked: {}, activeBranch: 'economy', selectedTechId: null, doctrine: null },
    sound: { enabled: false },
    activePlay: { nextAt: 70, active: null, boostUntil: 0, boostMul: 1, seen: 0, incident: null, incidentSeen: 0, lastIncidentAt: 0, incidentCooldownUntil: 0, nextIncidentAt: 600 },
    meta: { version: GAME_VERSION, seenVersion: '', lastTs: Date.now(), offlineReturnDay: 0, offlineReturnStreak: 0, revealStage: 0 },
    log: [],
    feed: []
  });

  const LEGACY_LORE_UPGRADES = [
    { id:'lore_inkwell', name:'Lore I: Inkwell Archives', cost: 3, desc:'+10% research output.' },
    { id:'lore_scribes', name:'Lore II: Scribes Guild', cost: 7, desc:'+25 science on each legacy reset.' },
    { id:'lore_embers', name:'Lore III: Embers of Memory', cost: 12, desc:'Keep 8% of food/wood/science/tools on legacy reset.' },
  ];

  const LEGACY_MILITARY_UPGRADES = [
    { id:'mil_drill_doctrine', name:'Military I: Drill Doctrine', cost: 4, maxRank: 1, desc:'+18% Guard threat reduction output.' },
    { id:'mil_veteran_cadre', name:'Military II: Veteran Cadre', cost: 7, maxRank: 1, desc:'+30% Combat XP gain from Guard duty.' },
    { id:'mil_fortified_timberline', name:'Military III: Fortified Timberline', cost: 10, maxRank: 1, desc:'+20% palisade defense contribution during raids.' },
    { id:'mil_war_ledger', name:'Military IV: War Ledger', cost: 5, maxRank: 4, desc:'+1 Legacy Shard on reset per rank (max +4).' },
  ];

  const ETERNITY_UPGRADES = [
    { id:'et_sigil_lens', name:'Sigil Lens', cost: 3, maxRank: 1, desc:'+12% Legacy shard gain.' },
    { id:'et_ancestral_forge', name:'Ancestral Forge', cost: 5, maxRank: 1, desc:'+15% tool crafting output.' },
    { id:'et_tempered_granaries', name:'Tempered Granaries', cost: 6, maxRank: 1, desc:'+16% food storage cap.' },
    { id:'et_civil_codex', name:'Civil Codex', cost: 7, maxRank: 1, desc:'Eligibility gate easier (+1 legacy reset credit).' },
    { id:'et_epoch_engine', name:'Epoch Engine', cost: 4, maxRank: 3, desc:'+8% Sigil gain per rank from reset formula.' },
  ];

  const ETERNITY_MANDATES = [
    { id:'harmony', name:'Harmony Charter', desc:'+10% research and +6% food output, -4% guard output.' },
    { id:'vigil', name:'Vigil Mandate', desc:'+14% guard output, -5% research output.' },
    { id:'industry', name:'Industry Pact', desc:'+12% tools output, +5% research output.' },
  ];

  const PRESERVATION_PACKAGES = [
    { id:'balanced', name:'Balanced Cache', keep:{ food:0.10, wood:0.10, science:0.10, tools:0.10 }, desc:'Keep 10% of core resources on Eternity reset.' },
    { id:'granary', name:'Granary Covenant', keep:{ food:0.22, wood:0.06, science:0.04, tools:0.06 }, desc:'Food-heavy carryover for quick regrowth.' },
    { id:'archive', name:'Archive Covenant', keep:{ food:0.04, wood:0.06, science:0.22, tools:0.08 }, desc:'Science-heavy carryover for fast unlocks.' },
  ];

  const RESEARCH_TECHS = [
    { id:'eco_foraging_kit', branch:'economy', tier:1, name:'Economy I: Foraging Kit', cost:60, desc:'+8% food actions output.' },
    { id:'eco_timber_metrics', branch:'economy', tier:2, name:'Economy II: Timber Metrics', cost:140, prereqs:['eco_foraging_kit'], desc:'+10% wood actions output.' },
    { id:'eco_tooling_standards', branch:'economy', tier:3, name:'Economy III: Tooling Standards', cost:260, prereqs:['eco_timber_metrics'], desc:'+12% tool crafting output.' },
    { id:'eco_civic_ledger', branch:'economy', tier:4, name:'Economy IV: Civic Ledger', cost:420, prereqs:['eco_tooling_standards'], desc:'+10% Legacy shard gain from run score.' },

    { id:'mil_watchfires', branch:'military', tier:1, name:'Military I: Watchfires', cost:70, desc:'+10% Guard output.' },
    { id:'mil_shieldwall', branch:'military', tier:2, name:'Military II: Shieldwall Drills', cost:160, prereqs:['mil_watchfires'], desc:'+12% palisade defense effect.' },
    { id:'mil_scout_net', branch:'military', tier:3, name:'Military III: Scout Network', cost:300, prereqs:['mil_shieldwall'], desc:'Threat grows slightly slower.' },
    { id:'doc_legion', branch:'military', tier:4, name:'Doctrine Fork: Legion Charter', cost:500, prereqs:['mil_scout_net'], doctrine:'legion', desc:'Irreversible doctrine: +16% Guard, -6% Research.' },

    { id:'cul_story_circle', branch:'culture', tier:1, name:'Culture I: Story Circle', cost:65, desc:'+6% Socialize/Care effect.' },
    { id:'cul_scriptorium', branch:'culture', tier:2, name:'Culture II: Scriptorium', cost:150, prereqs:['cul_story_circle'], desc:'+10% Research output.' },
    { id:'cul_academia', branch:'culture', tier:3, name:'Culture III: Academia', cost:280, prereqs:['cul_scriptorium'], desc:'+12% Mentor effectiveness.' },
    { id:'doc_scholarium', branch:'culture', tier:4, name:'Doctrine Fork: Scholarium Compact', cost:500, prereqs:['cul_academia'], doctrine:'scholarium', desc:'Irreversible doctrine: +18% Research, -5% Guard output.' },
  ];

  const RESEARCH_BRANCH_ORDER = ['economy', 'military', 'culture'];

  function ensureResearchState(s){
    s.research = (s.research && typeof s.research === 'object') ? s.research : { unlocked: {}, activeBranch: 'economy', selectedTechId: null, doctrine: null };
    s.research.unlocked = (s.research.unlocked && typeof s.research.unlocked === 'object') ? s.research.unlocked : {};
    s.research.activeBranch = RESEARCH_BRANCH_ORDER.includes(s.research.activeBranch) ? s.research.activeBranch : 'economy';
    const d = String(s.research.doctrine ?? '');
    s.research.doctrine = (d === 'legion' || d === 'scholarium') ? d : null;
    for (const tech of RESEARCH_TECHS) {
      s.research.unlocked[tech.id] = !!s.research.unlocked[tech.id];
      if (tech.doctrine && s.research.unlocked[tech.id]) s.research.doctrine = tech.doctrine;
    }
    const selected = String(s.research.selectedTechId ?? '');
    const selectedExists = RESEARCH_TECHS.some((t) => t.id === selected);
    s.research.selectedTechId = selectedExists ? selected : null;
    if (!s.research.selectedTechId) {
      const branchTech = RESEARCH_TECHS.find((t) => t.branch === s.research.activeBranch);
      s.research.selectedTechId = branchTech ? branchTech.id : null;
    }
  }

  function hasResearchTech(s, id){
    ensureResearchState(s);
    return !!s.research.unlocked[id];
  }

  function researchScienceMul(s){
    let m = 1;
    if (hasResearchTech(s, 'cul_scriptorium')) m *= 1.10;
    if (hasResearchTech(s, 'doc_scholarium')) m *= 1.18;
    if (hasResearchTech(s, 'doc_legion')) m *= 0.94;
    return m;
  }

  function researchGuardMul(s){
    let m = 1;
    if (hasResearchTech(s, 'mil_watchfires')) m *= 1.10;
    if (hasResearchTech(s, 'doc_legion')) m *= 1.16;
    if (hasResearchTech(s, 'doc_scholarium')) m *= 0.95;
    return m;
  }

  function researchPalisadeMul(s){
    return hasResearchTech(s, 'mil_shieldwall') ? 1.12 : 1.00;
  }

  function researchLegacyShardMul(s){
    return hasResearchTech(s, 'eco_civic_ledger') ? 1.10 : 1.00;
  }

  function canBuyResearchTech(s, tech){
    ensureResearchState(s);
    if (!tech || s.research.unlocked[tech.id]) return false;
    if (Number(s.res?.science ?? 0) < Number(tech.cost ?? 0)) return false;
    const prereqs = Array.isArray(tech.prereqs) ? tech.prereqs : [];
    for (const p of prereqs) if (!s.research.unlocked[p]) return false;
    if (tech.doctrine && s.research.doctrine && s.research.doctrine !== tech.doctrine) return false;
    return true;
  }

  function buyResearchTech(id){
    ensureResearchState(state);
    const tech = RESEARCH_TECHS.find(t => t.id === id);
    if (!tech) return { ok:false, reason:'missing' };
    if (!canBuyResearchTech(state, tech)) return { ok:false, reason:'locked' };
    state.res.science = Math.max(0, Number(state.res.science ?? 0) - Number(tech.cost ?? 0));
    state.research.unlocked[tech.id] = true;
    if (tech.doctrine) state.research.doctrine = tech.doctrine;
    log(`Research unlocked: ${tech.name}.`);
    playSfx('purchase');
    save();
    render();
    return { ok:true };
  }

  function ensureLegacyState(s){
    s.legacy = (s.legacy && typeof s.legacy === 'object') ? s.legacy : { shards: 0, totalShards: 0, resets: 0, upgrades: {}, activeBranch: 'lore' };
    s.legacy.shards = Math.max(0, Math.floor(Number(s.legacy.shards ?? 0) || 0));
    s.legacy.totalShards = Math.max(0, Math.floor(Number(s.legacy.totalShards ?? s.legacy.shards) || 0));
    s.legacy.resets = Math.max(0, Math.floor(Number(s.legacy.resets ?? 0) || 0));
    s.legacy.upgrades = (s.legacy.upgrades && typeof s.legacy.upgrades === 'object') ? s.legacy.upgrades : {};
    s.legacy.activeBranch = (s.legacy.activeBranch === 'military') ? 'military' : 'lore';
    for (const up of LEGACY_LORE_UPGRADES) {
      s.legacy.upgrades[up.id] = !!s.legacy.upgrades[up.id];
    }
    for (const up of LEGACY_MILITARY_UPGRADES) {
      const prev = Math.floor(Number(s.legacy.upgrades[up.id] ?? 0) || 0);
      s.legacy.upgrades[up.id] = Math.max(0, Math.min(up.maxRank, prev));
    }
  }

  function legacyUpgradeRank(s, id){
    ensureLegacyState(s);
    const cfg = LEGACY_MILITARY_UPGRADES.find(u => u.id === id);
    if (!cfg) return s?.legacy?.upgrades?.[id] ? 1 : 0;
    return Math.max(0, Math.min(cfg.maxRank, Math.floor(Number(s.legacy.upgrades[id] ?? 0) || 0)));
  }

  function legacyHas(s, id){
    return legacyUpgradeRank(s, id) > 0;
  }

  function legacyResearchMul(s){
    const base = legacyHas(s, 'lore_inkwell') ? 1.10 : 1.00;
    return base * researchScienceMul(s) * eternityMandateMul(s, 'research');
  }

  function legacyGuardOutputMul(s){
    const base = legacyHas(s, 'mil_drill_doctrine') ? 1.18 : 1.00;
    return base * researchGuardMul(s) * eternityMandateMul(s, 'guard');
  }

  function legacyCombatXPMul(s){
    return legacyHas(s, 'mil_veteran_cadre') ? 1.30 : 1.00;
  }

  function legacyPalisadeDefenseMul(s){
    const base = legacyHas(s, 'mil_fortified_timberline') ? 1.20 : 1.00;
    return base * researchPalisadeMul(s);
  }

  function performLegacyReset(){
    ensureLegacyState(state);
    const gain = computeLegacyShardGain(state);
    if (gain <= 0) return { ok:false, reason:'no_shards' };

    const prior = structuredClone(state.legacy);
    const priorResearch = structuredClone(state.research ?? { unlocked:{}, activeBranch:'economy', doctrine:null });
    const priorEternity = structuredClone(state.eternity ?? { sigils:0, totalSigils:0, resets:0, upgrades:{}, mandate:'harmony', preserve:'balanced' });
    const keepFrac = legacyHas(state, 'lore_embers') ? 0.08 : 0;
    const keep = {
      food: Math.floor(Math.max(0, Number(state?.res?.food ?? 0)) * keepFrac),
      wood: Math.floor(Math.max(0, Number(state?.res?.wood ?? 0)) * keepFrac),
      science: Math.floor(Math.max(0, Number(state?.res?.science ?? 0)) * keepFrac),
      tools: Math.floor(Math.max(0, Number(state?.res?.tools ?? 0)) * keepFrac),
    };

    const fresh = defaultState();
    fresh.sound = structuredClone(state.sound ?? { enabled:false });
    fresh.legacy = prior;
    fresh.eternity = priorEternity;
    fresh.research = priorResearch;
    fresh.legacy.shards += gain;
    fresh.legacy.totalShards += gain;
    fresh.legacy.resets += 1;

    if (legacyHas(fresh, 'lore_scribes')) {
      keep.science += 25;
    }

    fresh.res.food += keep.food;
    fresh.res.wood += keep.wood;
    fresh.res.science += keep.science;
    fresh.res.tools += keep.tools;

    state = fresh;
    ensureMilestonesState(state);
    ensureLegacyState(state);
    ensureEternityState(state);
    ensureResearchState(state);
    ensureAudioState(state);
    playSfx('legacy_reset');
    save();
    render();
    log(`Legacy reset complete: +${gain} shards (${state.legacy.shards} banked).`);
    return { ok:true, gain };
  }

  function buyLegacyUpgrade(id){
    ensureLegacyState(state);
    const loreUp = LEGACY_LORE_UPGRADES.find(u => u.id === id);
    if (loreUp) {
      if (state.legacy.upgrades[id]) return { ok:false, reason:'owned' };
      if (state.legacy.shards < loreUp.cost) return { ok:false, reason:'cost' };
      state.legacy.shards -= loreUp.cost;
      state.legacy.upgrades[id] = true;
      log(`Legacy upgrade unlocked: ${loreUp.name}.`);
      playSfx('purchase');
      save();
      render();
      return { ok:true };
    }

    const milUp = LEGACY_MILITARY_UPGRADES.find(u => u.id === id);
    if (!milUp) return { ok:false, reason:'missing' };
    const rank = legacyUpgradeRank(state, id);
    if (rank >= milUp.maxRank) return { ok:false, reason:'owned' };
    if (state.legacy.shards < milUp.cost) return { ok:false, reason:'cost' };
    state.legacy.shards -= milUp.cost;
    state.legacy.upgrades[id] = rank + 1;
    const nextRank = rank + 1;
    const rankTag = milUp.maxRank > 1 ? ` (Rank ${nextRank}/${milUp.maxRank})` : '';
    log(`Legacy upgrade unlocked: ${milUp.name}${rankTag}.`);
    playSfx('purchase');
    save();
    render();
    return { ok:true };
  }

  function legacyWarLedgerBonus(s){
    return Math.min(4, legacyUpgradeRank(s, 'mil_war_ledger'));
  }

  function ensureEternityState(s){
    s.eternity = (s.eternity && typeof s.eternity === 'object') ? s.eternity : { sigils:0, totalSigils:0, resets:0, upgrades:{}, mandate:'harmony', preserve:'balanced' };
    s.eternity.sigils = Math.max(0, Math.floor(Number(s.eternity.sigils ?? 0) || 0));
    s.eternity.totalSigils = Math.max(0, Math.floor(Number(s.eternity.totalSigils ?? s.eternity.sigils) || 0));
    s.eternity.resets = Math.max(0, Math.floor(Number(s.eternity.resets ?? 0) || 0));
    s.eternity.upgrades = (s.eternity.upgrades && typeof s.eternity.upgrades === 'object') ? s.eternity.upgrades : {};
    s.eternity.mandate = ETERNITY_MANDATES.some(m => m.id === s.eternity.mandate) ? s.eternity.mandate : 'harmony';
    s.eternity.preserve = PRESERVATION_PACKAGES.some(p => p.id === s.eternity.preserve) ? s.eternity.preserve : 'balanced';
    for (const up of ETERNITY_UPGRADES) {
      const prev = Math.floor(Number(s.eternity.upgrades[up.id] ?? 0) || 0);
      s.eternity.upgrades[up.id] = Math.max(0, Math.min(up.maxRank, prev));
    }
  }

  function eternityUpgradeRank(s, id){
    ensureEternityState(s);
    const cfg = ETERNITY_UPGRADES.find(u => u.id === id);
    if (!cfg) return 0;
    return Math.max(0, Math.min(cfg.maxRank, Math.floor(Number(s.eternity.upgrades[id] ?? 0) || 0)));
  }

  function eternityHas(s, id){
    return eternityUpgradeRank(s, id) > 0;
  }

  function eternityMandateMul(s, key){
    ensureEternityState(s);
    const m = String(s.eternity.mandate ?? 'harmony');
    if (key === 'research') {
      if (m === 'harmony') return 1.10;
      if (m === 'vigil') return 0.95;
      if (m === 'industry') return 1.05;
    }
    if (key === 'guard') {
      if (m === 'harmony') return 0.96;
      if (m === 'vigil') return 1.14;
      if (m === 'industry') return 1.00;
    }
    if (key === 'tools') {
      return (m === 'industry') ? 1.12 : 1.00;
    }
    return 1;
  }

  function eternityGateStatus(s){
    ensureLegacyState(s);
    ensureResearchState(s);
    ensureEternityState(s);
    const legacyResetsNeed = 4;
    const gates = {
      legacyResets: Number(s.legacy?.resets ?? 0) >= (legacyResetsNeed - (eternityHas(s, 'et_civil_codex') ? 1 : 0)),
      shardMastery: Number(s.legacy?.totalShards ?? 0) >= 60,
      doctrine: !!(s.research?.doctrine),
      population: Number(s?.kittens?.length ?? 0) >= 24,
    };
    const count = Object.values(gates).filter(Boolean).length;
    return { gates, count, ok: count >= 4 };
  }

  function computeEternitySigilGain(s){
    const gate = eternityGateStatus(s);
    if (!gate.ok) return 0;
    const resets = Math.max(0, Number(s.legacy?.resets ?? 0));
    const shards = Math.max(0, Number(s.legacy?.totalShards ?? 0));
    const techs = Object.values(s.research?.unlocked ?? {}).filter(Boolean).length;
    const epochRank = eternityUpgradeRank(s, 'et_epoch_engine');
    const base = Math.floor(Math.sqrt(shards) / 3 + resets * 0.6 + techs * 0.35);
    const mul = 1 + (0.08 * epochRank);
    return Math.max(0, Math.floor(base * mul));
  }

  function computeLegacyShardGain(s){
    const pop = Math.max(0, Number(s?.kittens?.length ?? 0));
    const sci = Math.max(0, Number(s?.res?.science ?? 0));
    const builds = Math.max(0,
      Number(s?.res?.huts ?? 0) +
      Number(s?.res?.palisade ?? 0) * 1.5 +
      Number(s?.res?.granaries ?? 0) * 2 +
      Number(s?.res?.workshops ?? 0) * 3 +
      Number(s?.res?.libraries ?? 0) * 4
    );
    const runScore = (pop * 35) + (sci * 0.25) + (builds * 80);
    const etMul = eternityHas(s, 'et_sigil_lens') ? 1.12 : 1.00;
    const gained = Math.floor(Math.log10(1 + Math.max(0, runScore)) * 6 * researchLegacyShardMul(s) * etMul);
    return Math.max(0, gained + legacyWarLedgerBonus(s));
  }

  function performEternityReset(){
    ensureLegacyState(state);
    ensureResearchState(state);
    ensureEternityState(state);
    const gate = eternityGateStatus(state);
    const gain = computeEternitySigilGain(state);
    if (!gate.ok || gain <= 0) return { ok:false, reason:'locked' };

    const priorEt = structuredClone(state.eternity);
    const pkg = PRESERVATION_PACKAGES.find(p => p.id === priorEt.preserve) ?? PRESERVATION_PACKAGES[0];
    const keep = {
      food: Math.floor(Math.max(0, Number(state?.res?.food ?? 0)) * pkg.keep.food),
      wood: Math.floor(Math.max(0, Number(state?.res?.wood ?? 0)) * pkg.keep.wood),
      science: Math.floor(Math.max(0, Number(state?.res?.science ?? 0)) * pkg.keep.science),
      tools: Math.floor(Math.max(0, Number(state?.res?.tools ?? 0)) * pkg.keep.tools),
    };

    const fresh = defaultState();
    fresh.sound = structuredClone(state.sound ?? { enabled:false });
    fresh.eternity = priorEt;
    fresh.eternity.sigils += gain;
    fresh.eternity.totalSigils += gain;
    fresh.eternity.resets += 1;
    fresh.res.food += keep.food;
    fresh.res.wood += keep.wood;
    fresh.res.science += keep.science;
    fresh.res.tools += keep.tools;

    state = fresh;
    ensureMilestonesState(state);
    ensureLegacyState(state);
    ensureResearchState(state);
    ensureEternityState(state);
    ensureAudioState(state);
    playSfx('legacy_reset');
    save();
    render();
    log(`Eternity reset complete: +${gain} sigils (${state.eternity.sigils} banked).`);
    return { ok:true, gain };
  }

  function buyEternityUpgrade(id){
    ensureEternityState(state);
    const up = ETERNITY_UPGRADES.find(u => u.id === id);
    if (!up) return { ok:false, reason:'missing' };
    const rank = eternityUpgradeRank(state, id);
    if (rank >= up.maxRank) return { ok:false, reason:'owned' };
    if (state.eternity.sigils < up.cost) return { ok:false, reason:'cost' };
    state.eternity.sigils -= up.cost;
    state.eternity.upgrades[id] = rank + 1;
    log(`Eternity upgrade unlocked: ${up.name}${up.maxRank > 1 ? ` (Rank ${rank+1}/${up.maxRank})` : ''}.`);
    playSfx('purchase');
    save();
    render();
    return { ok:true };
  }

  const sfxRuntime = {
    ctx: null,
    voices: [],
    maxVoices: 6,
    clickCooldownMs: Math.round(1000 / 14),
    lastClickMs: 0,
  };

  function ensureAudioState(s){
    s.sound = (s.sound && typeof s.sound === 'object') ? s.sound : { enabled:false };
    s.sound.enabled = !!s.sound.enabled;
  }

  function ensureActivePlayState(s){
    s.activePlay = (s.activePlay && typeof s.activePlay === 'object') ? s.activePlay : {};
    const ap = s.activePlay;
    const tNow = Number(s.t ?? 0) || 0;
    if (!Number.isFinite(ap.nextAt)) ap.nextAt = tNow + 70;
    ap.nextAt = Math.max(tNow + 5, Number(ap.nextAt) || (tNow + 70));
    ap.active = (ap.active && typeof ap.active === 'object') ? ap.active : null;
    ap.boostUntil = Number(ap.boostUntil ?? 0) || 0;
    ap.boostMul = Math.max(1, Number(ap.boostMul ?? 1) || 1);
    ap.seen = Math.max(0, Math.floor(Number(ap.seen ?? 0) || 0));
    ap.incident = (ap.incident && typeof ap.incident === 'object') ? ap.incident : null;
    ap.incidentSeen = Math.max(0, Math.floor(Number(ap.incidentSeen ?? 0) || 0));
    ap.lastIncidentAt = Number(ap.lastIncidentAt ?? 0) || 0;
    ap.incidentCooldownUntil = Number(ap.incidentCooldownUntil ?? 0) || 0;
    if (!Number.isFinite(ap.nextIncidentAt)) {
      ap.nextIncidentAt = tNow + 600;
    }
    ap.nextIncidentAt = Math.max(tNow + 45, Number(ap.nextIncidentAt) || (tNow + 600));
  }

  function rollActivePlayDelay(){
    return 60 + Math.random() * 60;
  }

  const FIELD_INCIDENTS = [
    {
      id: 'collapsed_bridge',
      label: 'Collapsed Bridge',
      desc: 'Supply bridge failed. Choose where to allocate labor tonight.',
      choices: [
        { id:'rebuild_fast', label:'Rebuild fast', effects:{ wood:-36, tools:-4, food:+26, threat:-8, mood:-0.02 } },
        { id:'ration_detour', label:'Detour with ration cuts', effects:{ food:-48, wood:+18, science:+10, dissent:+0.04 } },
      ],
    },
    {
      id: 'embers_in_rain',
      label: 'Embers in the Rain',
      desc: 'Storm soaked fuel stores. Decide between comfort and stockpile safety.',
      choices: [
        { id:'burn_reserves', label:'Burn reserve timber', effects:{ wood:-52, warmth:+24, mood:+0.04, threat:-5 } },
        { id:'cold_watch', label:'Cold watch shifts', effects:{ food:+20, science:+14, warmth:-18, dissent:+0.05 } },
      ],
    },
    {
      id: 'strange_caravan',
      label: 'Strange Caravan',
      desc: 'A caravan offers risky trade terms at dusk.',
      choices: [
        { id:'buy_map', label:'Buy star-map bundle', effects:{ food:-34, wood:-22, science:+42, tools:+6 } },
        { id:'seize_crates', label:'Seize crates by force', effects:{ food:+54, wood:+34, threat:+16, mood:-0.05, dissent:+0.03 } },
      ],
    },
    {
      id: 'rookery_fire',
      label: 'Rookery Fire',
      desc: 'A workshop ember sparked a rookery fire near storage huts.',
      choices: [
        { id:'bucket_line', label:'Bucket line response', effects:{ food:-20, wood:-12, threat:-10, mood:+0.03 } },
        { id:'save_tools', label:'Prioritize tool caches', effects:{ tools:+8, science:+12, food:-36, warmth:-10, dissent:+0.02 } },
      ],
    },
  ];

  function fieldIncidentSeed(s, salt=0){
    const ap = s.activePlay ?? {};
    const t = Math.floor(Number(s.t ?? 0));
    const runMix = (Math.floor(Number(s?.legacy?.resets ?? 0)) * 2654435761) ^ (Math.floor(Number(s?.eternity?.resets ?? 0)) * 2246822519);
    const socialMix = (Math.floor((Number(s?.social?.dissent ?? 0) || 0) * 1000) * 3266489917) ^ (Math.floor((Number(s?.social?.norms?.scarcityMindset ?? 0) || 0) * 1000) * 668265263);
    const seenMix = Math.floor(Number(ap.incidentSeen ?? 0)) * 1597334677;
    return (t ^ runMix ^ socialMix ^ seenMix ^ (Math.floor(Number(salt ?? 0)) * 374761393)) | 0;
  }

  function rollFieldIncidentDelay(s){
    const rng = seededRng(fieldIncidentSeed(s, 11));
    return 600 + Math.floor(rng() * 1201);
  }

  function spawnFieldIncident(s){
    ensureActivePlayState(s);
    const ap = s.activePlay;
    if (ap.incident) return;
    const nowT = Number(s.t ?? 0);
    const rng = seededRng(fieldIncidentSeed(s, 23));
    const idx = Math.floor(rng() * FIELD_INCIDENTS.length);
    const base = FIELD_INCIDENTS[idx] ?? FIELD_INCIDENTS[0];
    ap.incident = {
      id: String(base.id),
      label: String(base.label),
      desc: String(base.desc),
      choices: base.choices.map((c) => ({ id:String(c.id), label:String(c.label), effects:{ ...(c.effects ?? {}) } })),
      spawnedAt: nowT,
      expiresAt: nowT + 120,
    };
    ap.lastIncidentAt = nowT;
    log(`Field Incident: ${base.label}. Choose a response.`);
    playSfx('unlock');
  }

  function applyFieldIncidentChoice(s, choiceId){
    ensureActivePlayState(s);
    const ap = s.activePlay;
    const inc = ap.incident;
    if (!inc) return false;
    const choice = (Array.isArray(inc.choices) ? inc.choices : []).find((c) => String(c.id) === String(choiceId));
    if (!choice) return false;
    const fx = (choice.effects && typeof choice.effects === 'object') ? choice.effects : {};

    s.res.food = Math.max(0, Number(s.res.food ?? 0) + Number(fx.food ?? 0));
    s.res.wood = Math.max(0, Number(s.res.wood ?? 0) + Number(fx.wood ?? 0));
    s.res.science = Math.max(0, Number(s.res.science ?? 0) + Number(fx.science ?? 0));
    s.res.tools = Math.max(0, Number(s.res.tools ?? 0) + Number(fx.tools ?? 0));
    s.res.warmth = Math.max(0, Number(s.res.warmth ?? 0) + Number(fx.warmth ?? 0));
    s.res.threat = Math.max(0, Number(s.res.threat ?? 0) + Number(fx.threat ?? 0));

    s.social = s.social ?? { dissent:0, norms:{} };
    s.social.dissent = clamp01(Number(s.social.dissent ?? 0) + Number(fx.dissent ?? 0));
    const moodDelta = Number(fx.mood ?? 0);
    if (Math.abs(moodDelta) > 0.0001) {
      const ks = Array.isArray(s.kittens) ? s.kittens : [];
      for (const k of ks) {
        k.mood = clamp01(Number(k.mood ?? 0.6) + moodDelta);
      }
    }

    log(`Field Incident resolved: ${inc.label} -> ${choice.label}.`);
    ap.incident = null;
    ap.incidentSeen = Math.max(0, Number(ap.incidentSeen ?? 0) + 1);
    ap.incidentCooldownUntil = Number(s.t ?? 0) + 120;
    ap.nextIncidentAt = Number(s.t ?? 0) + rollFieldIncidentDelay(s);
    playSfx('milestone');
    save();
    return true;
  }

  function activePlayProdMul(s){
    const ap = s?.activePlay;
    if (!ap) return 1;
    return (Number(s?.t ?? 0) < Number(ap.boostUntil ?? 0)) ? Math.max(1, Number(ap.boostMul ?? 1) || 1) : 1;
  }

  function spawnActivePlayEvent(s){
    ensureActivePlayState(s);
    const ap = s.activePlay;
    if (ap.active) return;
    const nowT = Number(s.t ?? 0);
    const types = [
      { id:'sunbeam_cache', label:'Sunbeam Cache', reward:'burst', burst:{ food: 26, wood: 14 } },
      { id:'scholar_scroll', label:'Scholar Scroll', reward:'burst', burst:{ science: 20, tools: 5 } },
      { id:'forge_surge', label:'Forge Surge', reward:'boost', mul: 2.0, duration: 30 },
      { id:'harvest_blessing', label:'Harvest Blessing', reward:'boost', mul: 1.8, duration: 30 },
      { id:'knight_tithe', label:'Knight Tithe', reward:'burst', burst:{ food: 14, wood: 20, science: 8 } },
    ];
    const pick = types[Math.floor(Math.random() * types.length)] ?? types[0];
    ap.active = {
      id: String(pick.id),
      label: String(pick.label),
      reward: String(pick.reward),
      burst: pick.burst ? { ...pick.burst } : null,
      mul: Number(pick.mul ?? 1),
      duration: Number(pick.duration ?? 0),
      spawnedAt: nowT,
      expiresAt: nowT + 10,
    };
    ap.nextAt = nowT + rollActivePlayDelay();
    playSfx('unlock');
    log(`Active event: ${pick.label} appeared (10s).`);
  }

  function claimActivePlayEvent(s){
    ensureActivePlayState(s);
    const ap = s.activePlay;
    const ev = ap.active;
    if (!ev) return false;

    const pop = Math.max(1, Number(s.kittens?.length ?? 1));
    if (ev.reward === 'boost') {
      ap.boostMul = Math.max(1.6, Number(ev.mul ?? 2));
      ap.boostUntil = Math.max(Number(ap.boostUntil ?? 0), Number(s.t ?? 0) + Math.max(15, Number(ev.duration ?? 30)));
      log(`${ev.label}: production surge active (${ap.boostMul.toFixed(2)}x for ${Math.max(1, Math.ceil(ap.boostUntil - Number(s.t ?? 0)))}s).`);
    } else {
      const burst = ev.burst ?? { food: 18, wood: 10 };
      const food = Math.max(0, Number(burst.food ?? 0) * (1 + pop * 0.04));
      const wood = Math.max(0, Number(burst.wood ?? 0) * (1 + pop * 0.03));
      const science = Math.max(0, Number(burst.science ?? 0) * (1 + pop * 0.03));
      const tools = Math.max(0, Number(burst.tools ?? 0) * (1 + pop * 0.02));
      s.res.food = Number(s.res.food ?? 0) + food;
      s.res.wood = Number(s.res.wood ?? 0) + wood;
      s.res.science = Number(s.res.science ?? 0) + science;
      s.res.tools = Number(s.res.tools ?? 0) + tools;
      log(`${ev.label}: cache recovered (+${fmt(food)} food, +${fmt(wood)} wood${science > 0 ? `, +${fmt(science)} science` : ''}${tools > 0 ? `, +${fmt(tools)} tools` : ''}).`);
    }

    ap.active = null;
    ap.seen = Math.max(0, Number(ap.seen ?? 0) + 1);
    playSfx('milestone');
    save();
    return true;
  }

  function tickActivePlayEvents(){
    ensureActivePlayState(state);
    const ap = state.activePlay;
    const nowT = Number(state.t ?? 0);

    if (ap.active && nowT >= Number(ap.active.expiresAt ?? 0)) {
      log(`${ap.active.label} faded.`);
      ap.active = null;
    }

    if (ap.incident && nowT >= Number(ap.incident.expiresAt ?? 0)) {
      log(`Field Incident missed: ${ap.incident.label}. Opportunity lost.`);
      ap.incident = null;
      ap.incidentCooldownUntil = nowT + 120;
      ap.nextIncidentAt = nowT + rollFieldIncidentDelay(state);
    }

    if (nowT >= Number(ap.nextAt ?? Infinity) && !ap.active && !state.paused) {
      spawnActivePlayEvent(state);
    }

    if (!ap.incident && nowT >= Number(ap.nextIncidentAt ?? Infinity) && nowT >= Number(ap.incidentCooldownUntil ?? 0) && !state.paused) {
      spawnFieldIncident(state);
    }

    if (nowT >= Number(ap.boostUntil ?? 0)) {
      ap.boostMul = 1;
    }
  }

  function renderActivePlayEvent(){
    ensureActivePlayState(state);
    const ap = state.activePlay;
    let host = document.getElementById('activePlayEventHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'activePlayEventHost';
      host.className = 'active-play-event-host';
      document.body.appendChild(host);
    }

    if (ap.incident) {
      const inc = ap.incident;
      const left = Math.max(0, Number(inc.expiresAt ?? 0) - Number(state.t ?? 0));
      const choices = (Array.isArray(inc.choices) ? inc.choices : []).map((c) => {
        const label = escapeHtml(String(c.label ?? 'Respond'));
        const id = escapeHtml(String(c.id ?? 'choice'));
        return `<button class="incident-choice-btn" type="button" data-incident-choice="${id}">${label}</button>`;
      }).join('');
      host.innerHTML = `<div class="active-play-event incident"><div class="title">Field Incident: ${escapeHtml(String(inc.label ?? 'Incident'))}</div><div class="desc">${escapeHtml(String(inc.desc ?? 'Choose a response.'))} • ${Math.ceil(left)}s</div><div class="incident-choice-row">${choices}</div></div>`;
      return;
    }

    const ev = ap.active;
    const boostLeft = Math.max(0, Number(ap.boostUntil ?? 0) - Number(state.t ?? 0));
    if (!ev) {
      host.innerHTML = boostLeft > 0
        ? `<div class="active-play-event active"><div class="title">Momentum Surge</div><div class="desc">${Number(ap.boostMul ?? 1).toFixed(2)}x production • ${Math.ceil(boostLeft)}s</div></div>`
        : '';
      return;
    }

    const left = Math.max(0, Number(ev.expiresAt ?? 0) - Number(state.t ?? 0));
    const cta = (ev.reward === 'boost') ? `${Number(ev.mul ?? 2).toFixed(1)}x production` : 'Claim cache';
    host.innerHTML = `<button id="activePlayEventBtn" class="active-play-event" type="button"><div class="title">${ev.label}</div><div class="desc">Tap for ${cta} • ${Math.ceil(left)}s</div></button>`;
  }

  function audioCtx(){
    if (sfxRuntime.ctx) return sfxRuntime.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sfxRuntime.ctx = new Ctx();
    return sfxRuntime.ctx;
  }

  function playTone(ctx, spec){
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const nowAt = ctx.currentTime;
    const dur = Math.max(0.01, Number(spec.duration ?? 0.08));
    const atk = Math.max(0.001, Number(spec.attack ?? 0.004));
    const rel = Math.max(0.005, Number(spec.release ?? 0.07));
    const vol = Math.max(0, Math.min(1, Number(spec.volume ?? 0.05)));
    const startHz = Math.max(30, Number(spec.startHz ?? spec.hz ?? 440));
    const endHz = Math.max(30, Number(spec.endHz ?? startHz));

    osc.type = String(spec.wave ?? 'sine');
    osc.frequency.setValueAtTime(startHz, nowAt);
    if (Math.abs(endHz - startHz) > 0.001) {
      osc.frequency.exponentialRampToValueAtTime(endHz, nowAt + dur);
    }

    gain.gain.setValueAtTime(0.0001, nowAt);
    gain.gain.linearRampToValueAtTime(vol, nowAt + atk);
    gain.gain.exponentialRampToValueAtTime(0.0001, nowAt + dur + rel);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(nowAt);
    osc.stop(nowAt + dur + rel + 0.01);

    sfxRuntime.voices.push(osc);
    osc.onended = () => {
      sfxRuntime.voices = sfxRuntime.voices.filter(v => v !== osc);
      try { osc.disconnect(); gain.disconnect(); } catch (_) { /* noop */ }
    };
  }

  function playSfx(type){
    ensureAudioState(state);
    if (!state.sound.enabled) return;

    const ctx = audioCtx();
    if (!ctx) return;

    if (ctx.state === 'suspended') {
      try { ctx.resume(); } catch (_) { return; }
    }

    const nowMs = Date.now();
    if (type === 'click' && (nowMs - sfxRuntime.lastClickMs) < sfxRuntime.clickCooldownMs) return;
    if (type === 'click') sfxRuntime.lastClickMs = nowMs;

    if (sfxRuntime.voices.length >= sfxRuntime.maxVoices) return;

    const bank = {
      click:         [{ wave:'triangle', startHz:880, endHz:620, duration:0.04, attack:0.001, release:0.04, volume:0.020 }],
      toggle:        [{ wave:'square',   startHz:620, endHz:780, duration:0.05, attack:0.001, release:0.05, volume:0.018 }],
      purchase:      [{ wave:'sine',     startHz:520, endHz:820, duration:0.09, attack:0.002, release:0.08, volume:0.045 }],
      error:         [{ wave:'sawtooth', startHz:260, endHz:180, duration:0.11, attack:0.002, release:0.09, volume:0.035 }],
      unlock:        [{ wave:'triangle', startHz:520, endHz:980, duration:0.16, attack:0.002, release:0.12, volume:0.055 }],
      kitten:        [{ wave:'sine',     startHz:660, endHz:880, duration:0.12, attack:0.002, release:0.10, volume:0.040 }],
      milestone:     [{ wave:'sine',     startHz:740, endHz:1240, duration:0.20, attack:0.003, release:0.15, volume:0.080 }],
      raid:          [{ wave:'sawtooth', startHz:240, endHz:120, duration:0.22, attack:0.001, release:0.18, volume:0.080 }],
      legacy_reset:  [{ wave:'triangle', startHz:300, endHz:900, duration:0.28, attack:0.004, release:0.20, volume:0.090 }],
    };

    const spec = bank[String(type)] ?? bank.click;
    for (const tone of spec) playTone(ctx, tone);
  }

  // UI-only resource FX (non-persistent): gain fly-ups + scarcity colors.
  // Kept outside save data to preserve replay/save determinism.
  const resourceUiFx = {
    last: null,
    popups: { Food: [], Wood: [], Science: [], Tools: [], Jerky: [] }
  };

  const statDeltaUiFx = {
    last: Object.create(null),
  };

  const microUiFx = {
    newKittenUntilById: Object.create(null),
  };

  function playMicroClass(el, className, holdMs = 520){
    if (!(el instanceof Element)) return;
    const cls = String(className || '').trim();
    if (!cls) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    if (holdMs > 0) {
      setTimeout(() => {
        if (el && el.classList) el.classList.remove(cls);
      }, holdMs);
    }
  }

  function statPulseClass(key, value){
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    const prev = Number(statDeltaUiFx.last[key]);
    statDeltaUiFx.last[key] = numeric;
    if (!Number.isFinite(prev)) return '';
    const delta = numeric - prev;
    const abs = Math.abs(delta);
    const thresholdByKey = {
      Food: 0.4,
      Edible: 0.4,
      Threat: 0.25,
      Dissent: 0.15,
      Compliance: 0.01,
      'Legacy Preview': 0.5,
    };
    const threshold = Number(thresholdByKey[key] ?? 0.2);
    if (abs < threshold) return '';

    if (key === 'Threat' || key === 'Dissent') return delta > 0 ? 'pulse-warn' : 'pulse-good';
    if (key === 'Compliance') return delta > 0 ? 'pulse-good' : 'pulse-warn';
    return delta > 0 ? 'pulse-good' : 'pulse-warn';
  }

  function currentResourceSnapshot(s){
    return {
      Food: Number(s?.res?.food ?? 0),
      Wood: Number(s?.res?.wood ?? 0),
      Science: Number(s?.res?.science ?? 0),
      Tools: Number(s?.res?.tools ?? 0),
      Jerky: Number(s?.res?.jerky ?? 0)
    };
  }

  function resourceCapForKey(s, key){
    const n = Math.max(1, Number(s?.kittens?.length ?? 0));
    const reserve = s?.reserve ?? {};
    if (key === 'Food') return Math.max(1, Number(foodStorageCap(s) ?? 0));
    if (key === 'Wood') return Math.max(40, Number(reserve.wood ?? 0) * 4, n * 16);
    if (key === 'Science') return Math.max(80, Number(reserve.science ?? 0) * 4, n * 24);
    if (key === 'Tools') return Math.max(10, Number(reserve.tools ?? 0) * 4, n * 2);
    if (key === 'Jerky') return Math.max(30, n * 12);
    return 1;
  }

  function resourceLevelClass(s, key, amount){
    const cap = Math.max(1, resourceCapForKey(s, key));
    const ratio = Math.max(0, Number(amount ?? 0)) / cap;
    if (ratio < 0.10) return 'resource-critical';
    if (ratio < 0.50) return 'resource-low';
    return 'resource-ok';
  }

  function updateResourceFlyups(s){
    const nowMs = Date.now();
    const snap = currentResourceSnapshot(s);
    if (!resourceUiFx.last) {
      resourceUiFx.last = snap;
      return;
    }
    for (const key of Object.keys(resourceUiFx.popups)) {
      const prev = Number(resourceUiFx.last?.[key] ?? 0);
      const cur = Number(snap?.[key] ?? 0);
      const delta = cur - prev;
      if (delta > 0.095) {
        const arr = resourceUiFx.popups[key] ?? [];
        arr.push({ amount: delta, until: nowMs + 1200 });
        if (arr.length > 4) arr.splice(0, arr.length - 4);
        resourceUiFx.popups[key] = arr;
      }
      const arr = resourceUiFx.popups[key] ?? [];
      resourceUiFx.popups[key] = arr.filter(p => Number(p.until ?? 0) > nowMs);
    }
    resourceUiFx.last = snap;
  }

  // --- Milestones + inline celebrations (persisted unlocks, transient visuals)
  const milestoneUiFx = {
    active: [],
    layer: null,
  };

  const milestoneDefs = [
    { id:'ms-pop-8', title:'Village Stirs', desc:'Population reached 8 kittens.', tier:'spark', when: (s) => Number(s?.kittens?.length ?? 0) >= 8 },
    { id:'ms-pop-16', title:'Crowded Burrows', desc:'Population reached 16 kittens.', tier:'surge', when: (s) => Number(s?.kittens?.length ?? 0) >= 16 },
    { id:'ms-pop-24', title:'City of Whiskers', desc:'Population reached 24 kittens.', tier:'saga', when: (s) => Number(s?.kittens?.length ?? 0) >= 24 },
    { id:'ms-hut-1', title:'First Hearth', desc:'Built your first hut.', tier:'spark', when: (s) => Number(s?.res?.huts ?? 0) >= 1 },
    { id:'ms-wall-1', title:'Palisade Raised', desc:'Built your first palisade.', tier:'spark', when: (s) => Number(s?.res?.palisade ?? 0) >= 1 },
    { id:'ms-workshop-1', title:'Toolsmith Era', desc:'Built your first workshop.', tier:'surge', when: (s) => Number(s?.res?.workshops ?? 0) >= 1 },
    { id:'ms-library-1', title:'Scroll Hall', desc:'Built your first library.', tier:'surge', when: (s) => Number(s?.res?.libraries ?? 0) >= 1 },
    { id:'ms-unlock-security', title:'Night Watch', desc:'Unlocked Security doctrine.', tier:'surge', when: (s) => !!s?.unlocked?.security },
    { id:'ms-faction-rise', title:'Bloc Politics', desc:'A major faction took shape.', tier:'saga', when: (s) => dominantFactionShare01(s) >= 0.40 && Number(s?.kittens?.length ?? 0) >= 8 },
    { id:'ms-faction-demand', title:'Public Pressure', desc:'First faction demand appeared.', tier:'saga', when: (s) => !!s?.director?.factionDemand },
    { id:'ms-coterie', title:'Circle Within Circle', desc:'A coterie emerged in society.', tier:'spark', when: (s) => Number(s?.social?.coteries?.length ?? 0) >= 1 },
    { id:'ms-festival', title:'Lantern Festival', desc:'Held your first festival.', tier:'mythic', when: (s) => Number(s?.effects?.festivalUntil ?? 0) > Number(s?.t ?? 0) }
  ];

  function dominantFactionShare01(s){
    const kittens = Array.isArray(s?.kittens) ? s.kittens : [];
    if (!kittens.length) return 0;
    const groups = { Food:0, Safety:0, Progress:0, Social:0 };
    for (const k of kittens) {
      const ax = dominantValueAxis(k);
      if (ax in groups) groups[ax] += 1;
    }
    let top = 0;
    for (const v of Object.values(groups)) top = Math.max(top, Number(v) || 0);
    return top / Math.max(1, kittens.length);
  }

  function ensureMilestonesState(s){
    s.milestones = (s.milestones && typeof s.milestones === 'object') ? s.milestones : {};
    s.milestones.unlocked = (s.milestones.unlocked && typeof s.milestones.unlocked === 'object') ? s.milestones.unlocked : {};
    s.milestones.history = Array.isArray(s.milestones.history) ? s.milestones.history : [];
    if (!('lastCheckAt' in s.milestones)) s.milestones.lastCheckAt = 0;
  }

  function milestoneDurationMsForTier(tier){
    if (tier === 'spark') return 1300;
    if (tier === 'surge') return 1700;
    if (tier === 'saga') return 2100;
    if (tier === 'mythic') return 2600;
    return 1600;
  }

  function unlockMilestone(s, def){
    ensureMilestonesState(s);
    const key = String(def?.id || '');
    if (!key || s.milestones.unlocked[key]) return false;

    const at = Number(s?.t ?? 0);
    s.milestones.unlocked[key] = at;
    s.milestones.history.push({
      id: key,
      at,
      title: String(def?.title ?? key),
      desc: String(def?.desc ?? ''),
      tier: String(def?.tier ?? 'spark')
    });
    if (s.milestones.history.length > 80) {
      s.milestones.history.splice(0, s.milestones.history.length - 80);
    }

    feed(`Milestone unlocked: ${String(def?.title ?? key)}.`);
    playSfx('milestone');

    const nowMs = Date.now();
    milestoneUiFx.active.push({
      id: key,
      title: String(def?.title ?? key),
      desc: String(def?.desc ?? ''),
      tier: String(def?.tier ?? 'spark'),
      until: nowMs + milestoneDurationMsForTier(String(def?.tier ?? 'spark')),
    });
    if (milestoneUiFx.active.length > 4) milestoneUiFx.active.splice(0, milestoneUiFx.active.length - 4);

    return true;
  }

  function tickMilestones(s){
    ensureMilestonesState(s);

    const nowT = Number(s?.t ?? 0);
    const lastAt = Number(s?.milestones?.lastCheckAt ?? 0) || 0;
    if ((nowT - lastAt) < 1) return;
    s.milestones.lastCheckAt = nowT;

    for (const def of milestoneDefs) {
      if (s.milestones.unlocked?.[def.id]) continue;
      let ok = false;
      try { ok = !!def.when(s); } catch (_) { ok = false; }
      if (ok) unlockMilestone(s, def);
    }
  }

  function ensureMilestoneLayer(){
    if (milestoneUiFx.layer && document.body.contains(milestoneUiFx.layer)) return milestoneUiFx.layer;
    const d = document.createElement('div');
    d.className = 'milestone-burst-layer';
    document.body.appendChild(d);
    milestoneUiFx.layer = d;
    return d;
  }

  function renderMilestonesFx(){
    const nowMs = Date.now();
    milestoneUiFx.active = milestoneUiFx.active.filter(x => Number(x?.until ?? 0) > nowMs);

    const layer = ensureMilestoneLayer();
    if (!milestoneUiFx.active.length) {
      layer.innerHTML = '';
      return;
    }

    layer.innerHTML = milestoneUiFx.active.map((x) => {
      const tier = escapeHtml(String(x?.tier ?? 'spark'));
      const title = escapeHtml(String(x?.title ?? 'Milestone'));
      const desc = escapeHtml(String(x?.desc ?? ''));
      return `<div class="milestone-burst ${tier}"><div class="tier">${tier}</div><div class="title">${title}</div><div class="desc">${desc}</div></div>`;
    }).join('');
  }

  // --- Personality / micro-emergence
  // Kittens have soft preferences (likes/dislikes). This does NOT hard-lock actions; it just nudges.
  function rand01At(t, salt=0){
    // Deterministic pseudo-random in [0,1). No Math.random.
    const x = Math.sin((Number(t||0) + 0.1234 + Number(salt||0)) * 9999.123) * 10000;
    return x - Math.floor(x);
  }

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
  // 6-trait cap by design (clarity + balance). Each kitten gets 1-2 traits at birth.
  // Traits do two things:
  // 1) decision bias (which jobs they prefer)
  // 2) direct per-action output modifier (+/-15%) on productive actions.
  const TRAIT_DEFS = [
    { id:'Brave', desc:'Bold in danger. Better at guarding and crisis runs.', bias:{ Guard:12, BuildPalisade:7 }, prod:{ Guard:0.15, BuildPalisade:0.15 } },
    { id:'Curious', desc:'Always investigating. Better at research/mentoring.', bias:{ Research:11, Mentor:8 }, prod:{ Research:0.15, Mentor:0.15 } },
    { id:'Lazy', desc:'Conserves effort. Slower output, but less fatigue.', bias:{ Rest:6, Loaf:8 }, prod:{ '*':-0.15 } },
    { id:'Ambitious', desc:'Pushes hard for growth. Better at build/craft work.', bias:{ BuildHut:8, BuildGranary:8, BuildWorkshop:8, BuildLibrary:8, CraftTools:10 }, prod:{ BuildHut:0.15, BuildGranary:0.15, BuildWorkshop:0.15, BuildLibrary:0.15, CraftTools:0.15 } },
    { id:'Forager', desc:'Wilderness specialist. Better at food/wood gathering.', bias:{ Forage:9, Farm:8, ChopWood:8, PreserveFood:7 }, prod:{ Forage:0.15, Farm:0.15, ChopWood:0.15, PreserveFood:0.15 } },
    { id:'Caretaker', desc:'Community-first. Better at social and care duties.', bias:{ Socialize:10, Care:10 }, prod:{ Socialize:0.15, Care:0.15 } },
  ];
  const TRAIT_DEF_BY_ID = Object.fromEntries(TRAIT_DEFS.map((t) => [t.id, t]));

  function normalizeTraitId(id){
    const v = String(id ?? '').trim();
    if (TRAIT_DEF_BY_ID[v]) return v;
    const map = { Studious: 'Curious', Builder: 'Ambitious' };
    return map[v] ?? null;
  }

  function normalizeTraits(arr, fallbackId=1){
    const raw = Array.isArray(arr) ? arr : [];
    const out = [];
    for (const id of raw) {
      const n = normalizeTraitId(id);
      if (n && !out.includes(n)) out.push(n);
      if (out.length >= 2) break;
    }
    if (out.length) return out;
    return genTraits(fallbackId);
  }

  function genTraits(id){
    const rng = seededRng((id * 1103515245 + 12345) | 0);
    const pick1 = TRAIT_DEFS[Math.floor(rng() * TRAIT_DEFS.length)]?.id ?? 'Forager';
    const wantTwo = rng() < 0.38;
    if (!wantTwo) return [pick1];
    const rest = TRAIT_DEFS.map(t => t.id).filter(t => t !== pick1);
    const pick2 = rest[Math.floor(rng() * Math.max(1, rest.length))] ?? pick1;
    return [pick1, pick2];
  }

  function traitOutputMul(k, action){
    const traits = normalizeTraits(k?.traits, Number(k?.id ?? 1));
    let mod = 0;
    for (const id of traits) {
      const def = TRAIT_DEF_BY_ID[id];
      if (!def?.prod) continue;
      mod += Number(def.prod[action] ?? def.prod['*'] ?? 0) || 0;
    }
    return Math.max(0.55, Math.min(1.45, 1 + mod));
  }

  function traitSummary(k){
    const traits = normalizeTraits(k?.traits, Number(k?.id ?? 1));
    if (!traits.length) return '-';
    return traits.map((id) => {
      const d = TRAIT_DEF_BY_ID[id];
      if (!d?.prod) return id;
      const vals = Object.values(d.prod).map(v => Number(v) || 0);
      const best = vals.length ? Math.max(...vals) : 0;
      const worst = vals.length ? Math.min(...vals) : 0;
      if (best > 0 && worst >= 0) return `${id} (+${Math.round(best * 100)}%)`;
      if (worst < 0 && best <= 0) return `${id} (${Math.round(worst * 100)}%)`;
      return id;
    }).join(', ');
  }

  // --- Names (civ-sim readability)
  // Deterministic per kitten id; makes it easier to notice emergent personalities + social dynamics.
  const NAME_ADJ = ['Brisk','Clever','Drowsy','Sunny','Mossy','Wily','Gentle','Bold','Curious','Proud','Quiet','Stormy','Toasty','Nimble','Patient','Rusty','Velvet','Glitter','Sable','Honey'];
  const NAME_NOUN = ['Mochi','Paws','Whisker','Pebble','Biscuit','Saffron','Cinder','Thimble','Sprout','Maple','Kite','Clover','Pippin','Nova','Button','Marble','Fable','Echo','Oat','Puff'];

  function genName(id){
    const rng = seededRng((Number(id ?? 0) * 214013 + 2531011) | 0);
    const a = NAME_ADJ[Math.floor(rng() * NAME_ADJ.length)] ?? 'Curious';
    const n = NAME_NOUN[Math.floor(rng() * NAME_NOUN.length)] ?? 'Paws';
    return `${a} ${n}`;
  }

  function ensureKittenName(k){
    if (!k || typeof k !== 'object') return;
    if (typeof k.name === 'string' && k.name.trim()) return;
    k.name = genName(k.id);
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
    if (t.includes('Curious'))   { v.Progress += 0.26; v.Social -= 0.05; }
    if (t.includes('Ambitious')) { v.Progress += 0.20; v.Food += 0.06; v.Social -= 0.04; }
    if (t.includes('Caretaker')) { v.Social += 0.28; v.Safety += 0.04; v.Progress -= 0.06; }
    if (t.includes('Lazy'))      { v.Social += 0.10; v.Progress -= 0.08; }

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
      Social: prioMul(s,'prioSocial'),
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

  function normalizeValuesVec(v){
    if (!v || typeof v !== 'object') return { Food:0.25, Safety:0.25, Progress:0.25, Social:0.25 };
    const out = { Food:Number(v.Food ?? 0), Safety:Number(v.Safety ?? 0), Progress:Number(v.Progress ?? 0), Social:Number(v.Social ?? 0) };
    for (const ax of VALUE_AXES) out[ax] = Math.max(0.03, Number(out[ax] ?? 0));
    const sum = VALUE_AXES.reduce((a,k)=>a+out[k],0) || 1;
    for (const ax of VALUE_AXES) out[ax] /= sum;
    return out;
  }

  // Values drift: kittens slowly learn a "comfort zone" from what they actually do.
  // - Higher effective autonomy => faster drift (self-directed)
  // - Central planning doesn't freeze them; it just makes drift slower.
  // This creates a subtle emergent loop: specializing a colony changes *who your kittens become*.
  function taskValueVec(task){
    const a = String(task || '');
    // Note: these are intentionally coarse; they should be legible, not perfect.
    if (a === 'Forage' || a === 'Farm' || a === 'PreserveFood' || a === 'Eat') return { Food:0.70, Safety:0.10, Progress:0.12, Social:0.08 };
    if (a === 'ChopWood' || a === 'BuildGranary') return { Food:0.35, Safety:0.18, Progress:0.37, Social:0.10 };
    if (a === 'StokeFire') return { Food:0.10, Safety:0.70, Progress:0.08, Social:0.12 };
    if (a === 'Guard' || a === 'BuildPalisade') return { Food:0.05, Safety:0.80, Progress:0.10, Social:0.05 };
    if (a === 'Research' || a === 'Mentor' || a === 'CraftTools' || a === 'BuildWorkshop' || a === 'BuildLibrary') return { Food:0.10, Safety:0.10, Progress:0.72, Social:0.08 };
    if (a === 'Socialize' || a === 'Care') return { Food:0.12, Safety:0.15, Progress:0.10, Social:0.63 };
    if (a === 'Loaf') return { Food:0.10, Safety:0.10, Progress:0.05, Social:0.75 };
    // Rest / BuildHut / unknown: keep it near-neutral.
    return { Food:0.25, Safety:0.25, Progress:0.25, Social:0.25 };
  }

  function updateValuesPerSecond(s, k, task){
    ensureValues(k);
    if (!k?.values) return;

    const v = normalizeValuesVec(k.values);
    const tgt = normalizeValuesVec(taskValueVec(task));

    // Rate tuned to be noticeable over minutes, not seconds.
    const effA = effectiveAutonomy01(s);
    const rate = 0.004 + 0.016 * effA; // ~0.4%..2.0% toward target per second

    const before = { ...v };
    for (const ax of VALUE_AXES) v[ax] = v[ax] + (tgt[ax] - v[ax]) * rate;

    const after = normalizeValuesVec(v);
    k.values = after;

    // Explainability breadcrumb: what axis did this second "teach" the kitten?
    let best = 'Food';
    let bestD = -999;
    for (const ax of VALUE_AXES) {
      const d = Number(after[ax] ?? 0) - Number(before[ax] ?? 0);
      if (d > bestD) { bestD = d; best = ax; }
    }
    k._valuesDriftAt = Number(s?.t ?? 0) || 0;
    k._valuesDriftNote = `drift → ${best} (rate ${(rate*100).toFixed(1)}%/s)`;
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

  function makeKitten(id, birthTime){
    const t0 = Number(birthTime ?? 0);
    const traits = genTraits(id);
    return {
      id,
      name: genName(id),
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
      skills: { Foraging:1, Farming:1, Woodcutting:1, Building:1, Scholarship:1, Combat:1, Cooking:1, Social:1, Survival:1, Athletics:1 },
      xp: { Foraging:0, Farming:0, Woodcutting:0, Building:0, Scholarship:0, Combat:0, Cooking:0, Social:0, Survival:0, Athletics:0 },
      // Personality: soft preferences that bias scoring (adds emergent specialization)
      personality: genPersonality(id),
      // Traits: steady "identity" bias (civ-sim flavor)
      traits: normalizeTraits(traits, id),
      // Values: what this kitten *wants* the colony to be doing (policy fit affects mood under central planning)
      values: genValues(id, traits),

      // Directive: a persistent per-kitten bias layer (player set). NOT a hard lock.
      directive: 'Auto',

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

      // Per-kitten life story
      lifeLog: [{ t: t0, type: 'milestone', data: { what: 'Born', detail: 'Joined the colony' } }],
      activityTime: {},
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
      const newBuddy = (buddy && buddy !== id) ? buddy : null;
      if (newBuddy !== cur) {
        k.buddyId = newBuddy;
        if (newBuddy) {
          kittenLog(k, 'social', { event: 'buddy-assigned', targetName: kittenName(s, newBuddy) });
        }
      } else {
        k.buddyId = newBuddy;
      }
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
  // Aquarium hook: emits occasional relationship "beats" to the Society feed + Trends markers.
  function updateBuddyNeedPerSecond(s, k, task){
    const b = buddyOf(s, k);
    k.buddyNeed = clamp01(Number(k.buddyNeed ?? 0));
    if (!b) return;

    const t = String(task ?? k.task ?? '');
    const bt = String(b.task ?? '');

    // "Together" heuristics (no map/positions yet):
    // - Explicitly together if both Socialize.
    // - Also count as together if doing the same non-rest task (working side-by-side).
    const together = (t === 'Socialize' && bt === 'Socialize') || (t && t === bt && t !== 'Rest');

    const a = effectiveAutonomy01(s);
    const prevNeed = clamp01(Number(k.buddyNeed ?? 0));
    let need = prevNeed;

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

    // --- Aquarium: relationship beats (threshold crossings)
    // We only emit at most one beat per pair per cooldown to avoid spam.
    // (Deterministic, minimal interaction; purely observability + emergent texture.)
    const id = Number(k?.id ?? 0);
    const bid = Number(b?.id ?? 0);
    if (!Number.isFinite(id) || !Number.isFinite(bid) || id <= 0 || bid <= 0) return;
    if (id > bid) return; // only one side of the pair emits

    // Transient caches (strip on save)
    s._buddyBeatCooldown = (s._buddyBeatCooldown && typeof s._buddyBeatCooldown === 'object') ? s._buddyBeatCooldown : {};
    const key = `${id}-${bid}`;
    const nowT = Number(s.t ?? 0);
    const nextAt = Number(s._buddyBeatCooldown[key] ?? 0);
    if (nowT < nextAt) return;

    const bandFor = (n) => (n >= 0.85) ? 'strained' : (n <= 0.25) ? 'close' : 'ok';
    const prevBand = String(k._buddyBeatBand ?? bandFor(prevNeed));
    const newBand = bandFor(need);

    // Initialize silently.
    if (!k._buddyBeatBand) {
      k._buddyBeatBand = newBand;
      return;
    }

    if (newBand !== prevBand) {
      const nmA = String(k?.name ?? `Kitten ${id}`);
      const nmB = String(b?.name ?? `Kitten ${bid}`);

      // Local feed writer (avoid touching global state if called on preview clones).
      const feedTo = (ss, msg) => {
        ss.feed = Array.isArray(ss.feed) ? ss.feed : [];
        ss.feed.push(`[${fmt(ss.t)}] ${msg}`);
        const FEED_MAX = 220;
        if (ss.feed.length > FEED_MAX) ss.feed.splice(0, ss.feed.length - FEED_MAX);
      };

      if (newBand === 'strained') {
        feedTo(s, `Relationship: ${nmA} and ${nmB} seem to be drifting apart.`);
        s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
        s._trendEvents.push({ t: nowT, kind:'rel', label:'drift', color:'rgba(251,113,133,.16)' });
      }
      if (newBand === 'close') {
        feedTo(s, `Relationship: ${nmA} and ${nmB} reconnected.`);
        s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
        s._trendEvents.push({ t: nowT, kind:'rel', label:'reconnect', color:'rgba(52,211,153,.14)' });
      }
      if (Array.isArray(s._trendEvents) && s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

      k._buddyBeatBand = newBand;
      b._buddyBeatBand = newBand; // keep symmetric
      s._buddyBeatCooldown[key] = nowT + 60;
    }
  }

  // --- Micro-factions: Coteries (buddy-linked circles + shared-work ties)
  // Deterministic, low-interaction society depth: small circles emerge from buddy links *and* repeated co-work.
  // Shared-work edges are transient + decaying: they let circles form/shift beyond the static buddy ring.

  const COTERIE_COWORK_TASKS = new Set([
    'Forage','Farm','ChopWood','Research','Guard',
    'BuildHut','BuildPalisade','BuildGranary','BuildWorkshop','BuildLibrary',
    'CraftTools','PreserveFood','StokeFire',
  ]);

  const sharedEdgeKey = (a,b) => {
    const x = Number(a ?? 0), y = Number(b ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0 || x === y) return null;
    const lo = Math.min(x,y), hi = Math.max(x,y);
    return `${lo}-${hi}`;
  };

  function updateSharedWorkEdgesPerSecond(s){
    const kittens = Array.isArray(s?.kittens) ? s.kittens : [];
    if (kittens.length < 2) { s._sharedWorkEdges = {}; return; }

    // Decay old edges.
    const edges = (s._sharedWorkEdges && typeof s._sharedWorkEdges === 'object') ? s._sharedWorkEdges : {};
    for (const [k, wRaw] of Object.entries(edges)) {
      const w = Number(wRaw ?? 0);
      if (!Number.isFinite(w) || w <= 0.05) { delete edges[k]; continue; }
      const nw = w * 0.985;
      if (nw <= 0.08) delete edges[k]; else edges[k] = nw;
    }

    // Add co-work for this second: if multiple kittens execute the same productive task, strengthen their ties.
    const groups = new Map();
    for (const k of kittens) {
      const id = Number(k?.id ?? 0);
      if (!Number.isFinite(id) || id <= 0) continue;
      const task = String(k?.task ?? '');
      if (!COTERIE_COWORK_TASKS.has(task)) continue;
      if (!groups.has(task)) groups.set(task, []);
      groups.get(task).push(id);
    }

    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      ids.sort((a,b)=>a-b);
      for (let i=0;i<ids.length;i++) {
        for (let j=i+1;j<ids.length;j++) {
          const key = sharedEdgeKey(ids[i], ids[j]);
          if (!key) continue;
          const cur = Number(edges[key] ?? 0) || 0;
          edges[key] = Math.min(40, cur + 1);
        }
      }
    }

    s._sharedWorkEdges = edges;
  }

  // Track each kitten's recent productive work (exponential decay ~2 minutes).
  // Used to derive a small coterie "tradition" label (dominant co-work craft) without extra player input.
  function updateRecentWorkMemoryPerSecond(s){
    const kittens = Array.isArray(s?.kittens) ? s.kittens : [];
    if (!kittens.length) return;

    const DECAY = 0.992; // ~1/(1-DECAY) � 125s effective window
    const MIN_W = 0.15;

    for (const k of kittens) {
      const mem = (k._workMem && typeof k._workMem === 'object') ? k._workMem : {};
      // decay
      for (const [task, wRaw] of Object.entries(mem)) {
        const w = Number(wRaw ?? 0);
        if (!Number.isFinite(w)) { delete mem[task]; continue; }
        const nw = w * DECAY;
        if (nw < MIN_W) delete mem[task]; else mem[task] = nw;
      }
      const task = String(k?.task ?? '');
      if (COTERIE_COWORK_TASKS.has(task)) mem[task] = (Number(mem[task] ?? 0) || 0) + 1;
      k._workMem = mem;
    }
  }

  function computeCoteries(s){
    ensureBuddies(s);
    const kittens = Array.isArray(s?.kittens) ? s.kittens : [];
    const byId = new Map();
    for (const k of kittens) {
      const id = Number(k?.id ?? 0);
      if (Number.isFinite(id) && id > 0) byId.set(id, k);
    }

    const adj = new Map();
    const addEdge = (a,b) => {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b);
      adj.get(b).add(a);
    };

    // Buddy edges (stable, deterministic)
    for (const k of kittens) {
      const id = Number(k?.id ?? 0);
      const bid = Number(k?.buddyId ?? 0);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (!Number.isFinite(bid) || bid <= 0) continue;
      if (id === bid) continue;
      if (!byId.has(bid)) continue;
      addEdge(id, bid);
    }

    // Shared-work edges (transient, decaying)
    // Only add edges that have built up meaningful co-work time, so circles don't thrash.
    const JOIN_TH = 8; // seconds of repeated co-work required to count as a tie
    const edges = (s._sharedWorkEdges && typeof s._sharedWorkEdges === 'object') ? s._sharedWorkEdges : {};
    for (const [key, wRaw] of Object.entries(edges)) {
      const w = Number(wRaw ?? 0);
      if (!Number.isFinite(w) || w < JOIN_TH) continue;
      const parts = String(key).split('-');
      const a = Number(parts[0] ?? 0);
      const b = Number(parts[1] ?? 0);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
      if (!byId.has(a) || !byId.has(b)) continue;
      addEdge(a, b);
    }

    const seen = new Set();
    const comps = [];

    for (const id of byId.keys()) {
      if (seen.has(id)) continue;
      // Singleton nodes are not interesting as a "coterie".
      const nbrs = adj.get(id);
      if (!nbrs || nbrs.size === 0) { seen.add(id); continue; }

      const stack = [id];
      const members = [];
      seen.add(id);
      while (stack.length) {
        const cur = stack.pop();
        members.push(cur);
        const ns = adj.get(cur);
        if (!ns) continue;
        for (const nx of ns) {
          if (seen.has(nx)) continue;
          seen.add(nx);
          stack.push(nx);
        }
      }

      members.sort((a,b)=>a-b);
      comps.push(members);
    }

    const coteries = [];
    for (const memIds of comps) {
      const mem = memIds.map(id => byId.get(id)).filter(Boolean);
      if (mem.length < 2) continue;

      const counts = { Food:0, Safety:0, Progress:0, Social:0 };
      for (const k of mem) {
        const ax = dominantValueAxis(k);
        if (counts[ax] != null) counts[ax] += 1;
      }
      let domAx = 'Food';
      for (const ax of Object.keys(counts)) if (counts[ax] > counts[domAx]) domAx = ax;

      const id = memIds.join('-');
      const names = mem.map(k => String(k?.name ?? `Kitten ${k?.id ?? '?'}`));

      // "Why" signal: how much repeated co-work is tying this circle together (beyond buddies).
      let coWork = 0;
      const edges = (s._sharedWorkEdges && typeof s._sharedWorkEdges === 'object') ? s._sharedWorkEdges : {};
      for (let i=0;i<memIds.length;i++) {
        for (let j=i+1;j<memIds.length;j++) {
          const key = sharedEdgeKey(memIds[i], memIds[j]);
          if (!key) continue;
          const w = Number(edges[key] ?? 0);
          if (Number.isFinite(w) && w > 0) coWork += w;
        }
      }

      // Tiny culture/tradition label: what does this circle mostly *do* lately?
      // Derived from the last ~2 minutes of executed work (decayed), so it shifts as labor shifts.
      const tradCounts = Object.create(null);
      for (const k of mem) {
        const wm = (k._workMem && typeof k._workMem === 'object') ? k._workMem : null;
        if (!wm) continue;
        for (const [task, wRaw] of Object.entries(wm)) {
          const w = Number(wRaw ?? 0);
          if (!Number.isFinite(w) || w <= 0) continue;
          tradCounts[task] = (Number(tradCounts[task] ?? 0) || 0) + w;
        }
      }
      let tradTask = '';
      let tradScore = 0;
      let tradSecond = 0;
      for (const [task, w] of Object.entries(tradCounts)) {
        if (w > tradScore) { tradSecond = tradScore; tradScore = w; tradTask = task; }
        else if (w > tradSecond) tradSecond = w;
      }
      const traditionLabelFor = (t) => {
        if (!t) return '';
        if (t.startsWith('Build')) return "builders' circle";
        if (t === 'Forage' || t === 'Farm') return "gatherers' circle";
        if (t === 'ChopWood') return "woodcutters' circle";
        if (t === 'Research') return "scribes' circle";
        if (t === 'Guard') return "watch circle";
        if (t === 'CraftTools') return "tinker circle";
        if (t === 'PreserveFood') return "smokehouse circle";
        if (t === 'StokeFire') return "hearth circle";
        return `${t.toLowerCase()} circle`;
      };
      const tradLabel = traditionLabelFor(tradTask);

      coteries.push({ id, members: memIds, size: memIds.length, domAx, domN: counts[domAx] ?? 0, coWork, names, tradTask, tradLabel, tradScore, tradSecond });
    }

    // Stable ordering for UI: largest first, then id.
    coteries.sort((a,b)=> (b.size - a.size) || String(a.id).localeCompare(String(b.id)) );
    return coteries;
  }

  function coterieEthosLabel(v01){
    const v = clamp01(Number(v01 ?? 0));
    if (v >= 0.62) return { label:'mutual aid', tag:'aid' };
    if (v <= 0.38) return { label:'strictness', tag:'strict' };
    return { label:'balanced', tag:'bal' };
  }

  // Tiny reputation ledger: transient, decays back to neutral.
  // Goal: let recent macro outcomes (raids/winters) leave a readable "who is respected/resented" aura on coteries.
  function coterieRepLabel(v){
    const x = Math.max(-1, Math.min(1, Number(v ?? 0) || 0));
    if (x >= 0.35) return { label:'respected', tag:'pos' };
    if (x <= -0.35) return { label:'resented', tag:'neg' };
    return { label:'neutral', tag:'neu' };
  }

  function estimateCoterieEthosTarget(c){
    // Single tiny 0..1 axis: "mutual aid" (high) ? "strictness" (low).
    // Drifts from member values + what the coterie has mostly been doing lately.
    const domAx = String(c?.domAx ?? 'Food');
    let base = 0.52;
    if (domAx === 'Social') base = 0.72;
    else if (domAx === 'Food') base = 0.58;
    else if (domAx === 'Progress') base = 0.50;
    else if (domAx === 'Safety') base = 0.40;

    const t = String(c?.tradTask ?? '');
    if (t === 'Guard' || t === 'BuildPalisade') base -= 0.10;
    else if (t === 'StokeFire' || t === 'PreserveFood') base += 0.08;
    else if (t.startsWith('Build')) base -= 0.04;

    return clamp01(base);
  }

  function updateCoteriesAquarium(s){
    s.social = (s.social && typeof s.social === 'object') ? s.social : {};

    const pop = Number(s?.kittens?.length ?? 0);
    if (pop < 4) {
      // Keep state stable for old saves; don't spam.
      s.social.coteries = [];
      return;
    }

    const cots = computeCoteries(s);

    // Coterie ethos (tiny norms axis): mutual aid (high) ? strictness (low).
    // Stored transiently and surfaced in UI; when a coterie is influential it also slightly biases grievance dynamics.
    const byId = new Map();
    for (const k of (Array.isArray(s?.kittens) ? s.kittens : [])) {
      const id = Number(k?.id ?? 0);
      if (Number.isFinite(id) && id > 0) byId.set(id, k);
    }

    s._coterieEthos = (s._coterieEthos && typeof s._coterieEthos === 'object') ? s._coterieEthos : {};
    s._coterieEthosBand = (s._coterieEthosBand && typeof s._coterieEthosBand === 'object') ? s._coterieEthosBand : {};
    s._coterieEthosByKid = {};
    s._coterieIdByKid = {};

    // Reputation ledger (transient): decays toward neutral, updated by a few macro outcomes.
    s._coterieRep = (s._coterieRep && typeof s._coterieRep === 'object') ? s._coterieRep : {};
    for (const [cid, vRaw] of Object.entries(s._coterieRep)) {
      const v = Number(vRaw ?? 0);
      if (!Number.isFinite(v)) { delete s._coterieRep[cid]; continue; }
      const nv = v * 0.985;
      if (Math.abs(nv) < 0.03) delete s._coterieRep[cid]; else s._coterieRep[cid] = nv;
    }

    // Apply recent macro outcomes once (raid outcome, end-of-winter stability) into the reputation ledger.
    // These are intentionally tiny deltas; the point is ongoing texture, not permanent scores.
    s._coterieRepApplied = (s._coterieRepApplied && typeof s._coterieRepApplied === 'object') ? s._coterieRepApplied : { raidT:0, winterT:0 };
    const applyRepDelta = (c, d) => {
      if (!c) return;
      const id = String(c.id ?? '');
      if (!id) return;
      const cur = Number(s._coterieRep[id] ?? 0) || 0;
      s._coterieRep[id] = Math.max(-1, Math.min(1, cur + d));
    };

    const raidOut = (s._lastRaidOutcome && typeof s._lastRaidOutcome === 'object') ? s._lastRaidOutcome : null;
    if (raidOut && Number(raidOut.t ?? 0) > Number(s._coterieRepApplied.raidT ?? 0)) {
      const t = Number(raidOut.t ?? 0);
      const res = String(raidOut.result ?? '');
      for (const c of cots) {
        const isSafety = (String(c.domAx ?? '') === 'Safety');
        if (res === 'repel') applyRepDelta(c, isSafety ? 0.18 : 0.08);
        if (res === 'hit') applyRepDelta(c, isSafety ? -0.12 : -0.06);
      }
      s._coterieRepApplied.raidT = t;
    }

    const winOut = (s._lastWinterOutcome && typeof s._lastWinterOutcome === 'object') ? s._lastWinterOutcome : null;
    if (winOut && Number(winOut.t ?? 0) > Number(s._coterieRepApplied.winterT ?? 0)) {
      const t = Number(winOut.t ?? 0);
      const res = String(winOut.result ?? '');
      for (const c of cots) {
        const isFood = (String(c.domAx ?? '') === 'Food');
        if (res === 'good') applyRepDelta(c, isFood ? 0.15 : 0.08);
        if (res === 'hard') applyRepDelta(c, -0.10);
      }
      s._coterieRepApplied.winterT = t;
    }

    for (const c of cots) {
      const mem = (c.members ?? []).map(id => byId.get(id)).filter(Boolean);
      let sumSocial = 0;
      for (const k of mem) {
        ensureValues(k);
        sumSocial += clamp01(Number(k?.values?.Social ?? 0));
      }
      const avgSocial = mem.length ? (sumSocial / mem.length) : 0.5;
      const target = clamp01(0.65 * avgSocial + 0.35 * estimateCoterieEthosTarget(c));

      const prev = s._coterieEthos[c.id] ?? { v: target };
      let v = clamp01(Number(prev.v ?? target));
      // Slow drift so ethos feels "sticky".
      v = clamp01(v * 0.98 + target * 0.02);
      s._coterieEthos[c.id] = { v };

      for (const id of (c.members ?? [])) { s._coterieEthosByKid[id] = v; s._coterieIdByKid[id] = c.id; }

      const lab = coterieEthosLabel(v);
      c.ethosV = v;
      c.ethosLabel = lab.label;
      c.ethosTag = lab.tag;
    }

    // Attach reputation (transient) to each coterie for UI surfacing.
    for (const c of cots) {
      const rv = Number(s._coterieRep?.[String(c.id ?? '')] ?? 0) || 0;
      const lab = coterieRepLabel(rv);
      c.repV = rv;
      c.repLabel = lab.label;
      c.repTag = lab.tag;
    }

    // Aquarium depth: "legitimacy" � during crises, respected circles slightly increase plan compliance,
    // while resented circles slightly erode it. Kept tiny + bounded; fully observable.
    const crisisOn = !!(s?.director?.crisis || s?.signals?.FOOD || s?.signals?.ALARM);
    let repSum = 0;
    let repW = 0;
    const influential = (c) => (c.size >= 3) && (c.domN >= Math.ceil(c.size * 0.67));
    if (crisisOn) {
      for (const c of cots) {
        if (!influential(c)) continue;
        const rv = Math.max(-1, Math.min(1, Number(c.repV ?? 0) || 0));
        if (!rv) continue;
        const w = (Number(c.size ?? 0) || 0);
        repSum += rv * w;
        repW += w;
      }
    }
    const repAvg = repW > 0 ? (repSum / repW) : 0;
    const compBonus = crisisOn ? Math.max(-0.04, Math.min(0.04, repAvg * 0.05)) : 0;
    s._repLegit = { repAvg, compBonus, crisisOn: !!crisisOn };

    // Observability: when it matters (non-trivial effect), emit a feed beat + Trends marker with cooldown.
    if (crisisOn && Math.abs(compBonus) >= 0.009) {
      const nowT = Number(s.t ?? 0);
      s._repLegitBeat = (s._repLegitBeat && typeof s._repLegitBeat === 'object') ? s._repLegitBeat : { nextAt:0, last:'' };
      if (nowT >= Number(s._repLegitBeat.nextAt ?? 0)) {
        const txt = compBonus > 0 ? 'respected circles rally behind the curator � coordination steadies.' : 'resented circles undermine authority � coordination frays.';
        s.feed = Array.isArray(s.feed) ? s.feed : [];
        s.feed.push(`[${fmt(s.t)}] Legitimacy: ${txt}`);
        const FEED_MAX = 220;
        if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

        s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
        s._trendEvents.push({ t: nowT, kind:'repfx', label: compBonus > 0 ? 'legit+' : 'legit-', color: compBonus > 0 ? 'rgba(34,197,94,.09)' : 'rgba(239,68,68,.09)' });
        if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

        s._repLegitBeat = { nextAt: nowT + 140, last: compBonus > 0 ? 'pos' : 'neg' };
      }
    }

    s.social.coteries = cots.map(c => ({ id:c.id, size:c.size, domAx:c.domAx, domN:c.domN, coWork: Number(c.coWork ?? 0), members:c.members, trad: c.tradLabel || '', tradTask: c.tradTask || '', ethos: Number(c.ethosV ?? 0), ethosLabel: String(c.ethosLabel ?? ''), rep: Number(c.repV ?? 0), repLabel: String(c.repLabel ?? '') }));

    // Influence threshold (first pass): a circle that's both big and values-aligned is "politically relevant".
    const isInfluential = (c) => (c.size >= 3) && (c.domN >= Math.ceil(c.size * 0.67));

    s._coterieInfluence = (s._coterieInfluence && typeof s._coterieInfluence === 'object') ? s._coterieInfluence : {};
    s._coterieTraditions = (s._coterieTraditions && typeof s._coterieTraditions === 'object') ? s._coterieTraditions : {};

    const nowT = Number(s.t ?? 0);
    for (const c of cots) {
      // Tradition shifts: when a circle's dominant co-work task changes (and it's not a near-tie), log a beat.
      const tp = s._coterieTraditions[c.id] ?? { task:'', nextAt:0 };
      const tradTask = String(c.tradTask ?? '');
      const tradLabel = String(c.tradLabel ?? '');
      const score = Number(c.tradScore ?? 0) || 0;
      const second = Number(c.tradSecond ?? 0) || 0;
      const meaningful = tradTask && score >= 12 && (score - second) >= 3;
      if (meaningful && tradTask !== String(tp.task ?? '') && nowT >= Number(tp.nextAt ?? 0)) {
        s.feed = Array.isArray(s.feed) ? s.feed : [];
        const who = (c.names ?? []).slice(0, 3).join(', ') + ((c.names?.length ?? 0) > 3 ? '�' : '');
        s.feed.push(`[${fmt(s.t)}] Tradition shift: a coterie becomes the ${tradLabel}. (${who})`);
        const FEED_MAX = 220;
        if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

        s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
        s._trendEvents.push({ t: nowT, kind:'trad', label:`${tradTask}`, color:'rgba(196,181,253,.16)' });
        if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

        s._coterieTraditions[c.id] = { task: tradTask, nextAt: nowT + 75 };
      } else if (meaningful && !tp.task) {
        // Initialize silently once it becomes meaningful.
        s._coterieTraditions[c.id] = { task: tradTask, nextAt: Number(tp.nextAt ?? 0) || (nowT + 45) };
      }

      const prev = s._coterieInfluence[c.id] ?? { inf:false, nextAt:0 };
      const inf = isInfluential(c);

      // Ethos beats: when an influential circle's ethos crosses a band, log a norms beat.
      const ep = s._coterieEthosBand[c.id] ?? { tag:'', nextAt:0 };
      const curTag = String(c.ethosTag ?? '');
      if (curTag && inf && curTag !== String(ep.tag ?? '') && nowT >= Number(ep.nextAt ?? 0)) {
        s.feed = Array.isArray(s.feed) ? s.feed : [];
        const who = (c.names ?? []).slice(0, 3).join(', ') + ((c.names?.length ?? 0) > 3 ? '�' : '');
        const txt = (curTag === 'aid') ? 'leans into mutual aid' : (curTag === 'strict' ? 'leans into strict norms' : 'settles into balance');
        s.feed.push(`[${fmt(s.t)}] Norms: a coterie ${txt}. (${who})`);
        const FEED_MAX = 220;
        if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

        s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
        s._trendEvents.push({ t: nowT, kind:'eth', label:`${curTag}`, color:'rgba(34,197,94,.12)' });
        if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

        s._coterieEthosBand[c.id] = { tag: curTag, nextAt: nowT + 90 };
      } else if (curTag && !ep.tag) {
        // Initialize silently.
        s._coterieEthosBand[c.id] = { tag: curTag, nextAt: Number(ep.nextAt ?? 0) || (nowT + 45) };
      }

      // Reputation beats: respected/resented is a simple, decaying aura derived from macro outcomes.
      s._coterieRepBand = (s._coterieRepBand && typeof s._coterieRepBand === 'object') ? s._coterieRepBand : {};
      const rp = s._coterieRepBand[c.id] ?? { tag:'', nextAt:0 };
      const repTag = String(c.repTag ?? '');
      if (repTag && inf && repTag !== String(rp.tag ?? '') && nowT >= Number(rp.nextAt ?? 0)) {
        const who = (c.names ?? []).slice(0, 3).join(', ') + ((c.names?.length ?? 0) > 3 ? '�' : '');
        const txt = (repTag === 'pos') ? 'is widely respected' : (repTag === 'neg') ? 'is widely resented' : 'returns to the background';
        s.feed = Array.isArray(s.feed) ? s.feed : [];
        s.feed.push(`[${fmt(s.t)}] Reputation: a coterie ${txt}. (${who})`);
        const FEED_MAX = 220;
        if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

        s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
        const col = (repTag === 'pos') ? 'rgba(34,197,94,.11)' : (repTag === 'neg') ? 'rgba(239,68,68,.12)' : 'rgba(148,163,184,.10)';
        s._trendEvents.push({ t: nowT, kind:'rep', label:`${repTag}`, color: col });
        if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

        s._coterieRepBand[c.id] = { tag: repTag, nextAt: nowT + 110 };
      } else if (repTag && !rp.tag) {
        s._coterieRepBand[c.id] = { tag: repTag, nextAt: Number(rp.nextAt ?? 0) || (nowT + 55) };
      }

      // Rising edge only, cooldown-protected.
      if (inf && !prev.inf && nowT >= Number(prev.nextAt ?? 0)) {
        // Feed
        s.feed = Array.isArray(s.feed) ? s.feed : [];
        const label = `${c.domAx} coterie`;
        const who = c.names.slice(0, 3).join(', ') + (c.names.length > 3 ? '�' : '');
        s.feed.push(`[${fmt(s.t)}] Coterie rising: a ${label} is gaining influence (${c.size}). (${who})`);
        const FEED_MAX = 220;
        if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

        // Trends marker
        s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
        s._trendEvents.push({ t: nowT, kind:'cot', label:`${c.domAx}:${c.size}`, color:'rgba(253,186,116,.18)' });
        if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

        s._coterieInfluence[c.id] = { inf:true, nextAt: nowT + 90 };
      } else {
        s._coterieInfluence[c.id] = { inf, nextAt: Number(prev.nextAt ?? 0) };
      }
    }

    // Coterie pressure beats (tiny, short-lived society modifiers)
    // Goal: a circle's norms sometimes "spill" into colony-wide atmosphere without player clicks.
    // - mutual aid: grievances cool faster for members (and the air feels calmer)
    // - strict norms: dissent desire rises slightly for a short window
    s._coteriePressure = (s._coteriePressure && typeof s._coteriePressure === 'object') ? s._coteriePressure : {
      aid: { cid:null, until:0, nextAt:0 },
      strict: { cid:null, until:0, nextAt:0 },
    };

    const best = (tag) => cots
      .filter(c => isInfluential(c) && String(c.ethosTag ?? '') === tag)
      .sort((a,b)=> ((b.size*1.25 + (b.coWork ?? 0)) - (a.size*1.25 + (a.coWork ?? 0))))
      [0] ?? null;

    const aidC = best('aid');
    const strictC = best('strict');

    const trigger = (kind, c) => {
      if (!c) return;
      const slot = s._coteriePressure[kind] ?? { cid:null, until:0, nextAt:0 };
      if (nowT < Number(slot.nextAt ?? 0)) return;
      if (nowT < Number(slot.until ?? 0)) return; // already active

      const who = (c.names ?? []).slice(0, 3).join(', ') + ((c.names?.length ?? 0) > 3 ? '�' : '');
      s.feed = Array.isArray(s.feed) ? s.feed : [];
      if (kind === 'aid') s.feed.push(`[${fmt(s.t)}] Culture: mutual aid spreads through a coterie � resentments cool faster for a time. (${who})`);
      if (kind === 'strict') s.feed.push(`[${fmt(s.t)}] Culture: strict norms tighten in a coterie � grumbling rises for a time. (${who})`);
      const FEED_MAX = 220;
      if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

      s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
      const label = (kind === 'aid') ? `aid:${c.size}` : `strict:${c.size}`;
      const color = (kind === 'aid') ? 'rgba(52,211,153,.12)' : 'rgba(251,113,133,.14)';
      s._trendEvents.push({ t: nowT, kind:'press', label, color });
      if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

      s._coteriePressure[kind] = { cid: c.id, until: nowT + 60, nextAt: nowT + 140 };
    };

    // Don't spam: at most one trigger per ~15s.
    s._coteriePressureGate = Number(s._coteriePressureGate ?? 0) || 0;
    if (nowT >= s._coteriePressureGate) {
      // If both exist, prefer the larger circle as the stronger "culture signal".
      if (aidC && strictC) {
        trigger((aidC.size >= strictC.size) ? 'aid' : 'strict', (aidC.size >= strictC.size) ? aidC : strictC);
      } else {
        trigger('aid', aidC);
        trigger('strict', strictC);
      }
      s._coteriePressureGate = nowT + 15;
    }

    // Culture rituals (short-lived society mood) — a higher-level beat than pressure windows.
    // Triggered off influential coterie reputation (respected/resented), with tiny scoring biases.
    // Goal: make the tank feel like it has "minutes-long" atmosphere shifts without player clicks.
    s._cultureRitual = (s._cultureRitual && typeof s._cultureRitual === 'object') ? s._cultureRitual : { kind:'', cid:null, until:0, nextAt:0 };
    if (nowT >= Number(s._cultureRitual.until ?? 0)) {
      // Ritual aftermath: a tiny, persistent culture-memory nudge (no player clicks).
      // Bounded + deterministic: lets 60s rituals leave a faint "scar" in norms.
      const endedKind = String(s._cultureRitual.kind || '');
      const endedCid = s._cultureRitual.cid;
      if (endedKind) {
        const endedC = (Array.isArray(cots) ? cots : []).find(c => String(c?.id ?? '') === String(endedCid ?? ''));
        const who = endedC ? ((endedC.names ?? []).slice(0, 3).join(', ') + ((endedC.names?.length ?? 0) > 3 ? '…' : '')) : '';

        s.social = s.social ?? { dissent: 0 };
        s.social.norms = (s.social.norms && typeof s.social.norms === 'object') ? s.social.norms : { raidParanoia: 0, scarcityMindset: 0, mutualAid: 0, punitiveTolerance: 0 };

        // Very small one-shot nudge (on the order of a few minutes of natural drift).
        const d = 0.006;
        if (endedKind === 'story') {
          s.social.norms.mutualAid = clamp01(Number(s.social.norms.mutualAid ?? 0) + d);
          s.feed = Array.isArray(s.feed) ? s.feed : [];
          s.feed.push(`[${fmt(s.t)}] Culture: story-circle aftermath — mutual aid feels a little more natural. ${who ? `(${who})` : ''}`);
          const FEED_MAX = 220;
          if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

          s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
          s._trendEvents.push({ t: nowT, kind:'rit', label:'after:aid+', color:'rgba(250,204,21,.12)' });
          if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);
        } else if (endedKind === 'oath') {
          s.social.norms.punitiveTolerance = clamp01(Number(s.social.norms.punitiveTolerance ?? 0) + d);
          s.feed = Array.isArray(s.feed) ? s.feed : [];
          s.feed.push(`[${fmt(s.t)}] Culture: work-oath aftermath — harsher discipline feels a little more normal. ${who ? `(${who})` : ''}`);
          const FEED_MAX = 220;
          if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

          s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
          s._trendEvents.push({ t: nowT, kind:'rit', label:'after:pun+', color:'rgba(248,113,113,.14)' });
          if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);
        }
      }

      // Clear expired ritual.
      if (s._cultureRitual.kind) s._cultureRitual.kind = '';
      if (s._cultureRitual.cid) s._cultureRitual.cid = null;
    }

    const ritualActive = (nowT < Number(s._cultureRitual.until ?? 0)) && !!String(s._cultureRitual.kind || '');
    if (!ritualActive && nowT >= Number(s._cultureRitual.nextAt ?? 0)) {
      // Find the strongest influential respected/resented circle.
      const repV = (c) => Number(s._coterieRep?.[String(c?.id ?? '')] ?? 0) || 0;
      const scoreInf = (c) => (Number(c?.size ?? 0) * 1.35 + (Number(c?.coWork ?? 0) * 0.05)) * (0.6 + Math.abs(repV(c)));
      const bestRep = (tag) => cots
        .filter(c => isInfluential(c) && String(c.repTag ?? '') === tag)
        .sort((a,b)=> (scoreInf(b) - scoreInf(a)))
        [0] ?? null;

      const respected = bestRep('pos');
      const resented = bestRep('neg');

      // If both exist, pick the stronger "signal" deterministically.
      let pick = null;
      let kind = '';
      if (respected && resented) {
        const a = scoreInf(respected);
        const b = scoreInf(resented);
        pick = (a >= b) ? respected : resented;
        kind = (a >= b) ? 'story' : 'oath';
      } else if (respected) {
        pick = respected;
        kind = 'story';
      } else if (resented) {
        pick = resented;
        kind = 'oath';
      }

      if (pick && kind) {
        const who = (pick.names ?? []).slice(0, 3).join(', ') + ((pick.names?.length ?? 0) > 3 ? '…' : '');
        s.feed = Array.isArray(s.feed) ? s.feed : [];
        if (kind === 'story') s.feed.push(`[${fmt(s.t)}] Ritual: a story-circle spreads — warmth and care feel briefly easier. (${who})`);
        if (kind === 'oath') s.feed.push(`[${fmt(s.t)}] Ritual: a work-oath takes hold — productivity tightens, leisure chills. (${who})`);
        const FEED_MAX = 220;
        if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

        s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
        const color = (kind === 'story') ? 'rgba(34,197,94,.10)' : 'rgba(239,68,68,.11)';
        s._trendEvents.push({ t: nowT, kind:'rit', label:kind, color });
        if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

        // ~1 minute window, with a cooldown so it reads as an occasional "beat".
        s._cultureRitual = { kind, cid: pick.id, until: nowT + 60, nextAt: nowT + 170 };
      } else {
        // No candidates — check again later.
        s._cultureRitual.nextAt = nowT + 35;
      }
    }


    // Coterie relationship arcs (tiny status memory)
    // Rivalry now leaves a short-lived status tag so the aquarium feels like it has "ongoing politics"
    // rather than one-off pings.
    // Stored transiently and stripped on save.
    s._coterieRelations = (s._coterieRelations && typeof s._coterieRelations === 'object') ? s._coterieRelations : {};
    for (const [key, vRaw] of Object.entries(s._coterieRelations)) {
      const v = (vRaw && typeof vRaw === 'object') ? vRaw : null;
      if (!v) { delete s._coterieRelations[key]; continue; }
      const until = Number(v.until ?? 0) || 0;
      if (nowT < until) continue;

      const status = String(v.status ?? '');
      if (status === 'feud') {
        // Feud cools into a short truce (a readable arc, no player input).
        s._coterieRelations[key] = { status:'truce', until: nowT + 90 };
        s.feed = Array.isArray(s.feed) ? s.feed : [];
        s.feed.push(`[${fmt(s.t)}] Truce: rival circles cool their tempers for a while.`);
        const FEED_MAX = 220;
        if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

        s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
        s._trendEvents.push({ t: nowT, kind:'truce', label:'cooling', color:'rgba(147,197,253,.14)' });
        if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);
      } else {
        // Truce fades back to neutral.
        delete s._coterieRelations[key];
      }
    }

    // Coterie rivalry beat (tiny politics texture)
    // Highest-leverage "aquarium" depth: circles with opposing ethos sometimes snub each other,
    // nudging mood/grievance and leaving a visible marker in the feed + trends.
    // Deterministic cadence (no RNG): cooldown-gated and keyed off sim time.
    s._coterieRivalry = (s._coterieRivalry && typeof s._coterieRivalry === 'object') ? s._coterieRivalry : { nextAt:0, lastPair:'' };
    if (nowT >= Number(s._coterieRivalry.nextAt ?? 0)) {
      const pickBest = (tag) => cots
        .filter(c => isInfluential(c) && String(c.ethosTag ?? '') === tag)
        .sort((a,b)=> ((b.size*1.25 + (b.coWork ?? 0)) - (a.size*1.25 + (a.coWork ?? 0))))
        [0] ?? null;

      const aid = pickBest('aid');
      const strict = pickBest('strict');
      if (aid && strict && String(aid.id) !== String(strict.id)) {
        const pairKey = `${aid.id}|${strict.id}`;

        // If they're currently in a truce, don't immediately re-trigger a clash.
        const rel = s._coterieRelations && typeof s._coterieRelations === 'object' ? s._coterieRelations : {};
        const rs = rel[pairKey];
        if (rs && String(rs.status ?? '') === 'truce' && nowT < Number(rs.until ?? 0)) {
          s._coterieRivalry.nextAt = nowT + 45;
          return;
        }

        // Prevent the exact same rivalry from repeating back-to-back.
        if (String(s._coterieRivalry.lastPair ?? '') !== pairKey) {
          const clampPct = (x) => Math.max(0, Math.min(100, Number(x ?? 0) || 0));

          // Small, bounded consequence: a little mood drag + grievance heat for members of both circles.
          const applyTo = (c) => {
            for (const id of (c.members ?? [])) {
              const k = byId.get(id);
              if (!k) continue;
              k.mood = clampPct((Number(k.mood ?? 55) || 55) - 0.6);
              k.griev = clampPct((Number(k.griev ?? 0) || 0) + 0.9);
            }
          };
          applyTo(aid);
          applyTo(strict);

          // Observability
          const whoA = (aid.names ?? []).slice(0, 2).join(', ') + ((aid.names?.length ?? 0) > 2 ? '�' : '');
          const whoB = (strict.names ?? []).slice(0, 2).join(', ') + ((strict.names?.length ?? 0) > 2 ? '�' : '');
          s.feed = Array.isArray(s.feed) ? s.feed : [];
          s.feed.push(`[${fmt(s.t)}] Rivalry: circles clash � the mutual-aid coterie snubs the strict circle. (${whoA} ? ${whoB})`);
          const FEED_MAX = 220;
          if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

          s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
          s._trendEvents.push({ t: nowT, kind:'rival', label:'aid vs strict', color:'rgba(148,163,184,.14)' });
          if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

          // Relationship memory: they carry a short feud status that later cools into a truce.
          s._coterieRelations = (s._coterieRelations && typeof s._coterieRelations === 'object') ? s._coterieRelations : {};
          s._coterieRelations[pairKey] = { status:'feud', until: nowT + 75 };
          s._trendEvents.push({ t: nowT, kind:'feud', label:'hot', color:'rgba(251,113,133,.10)' });
          if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

          // Next time: 2�3 minutes, deterministic jitter based on time.
          // Reputation texture: if either circle is widely resented, clashes flare up sooner.
          const jitter = (Math.floor(nowT) % 61);
          const repA = Number(aid.repV ?? 0) || 0;
          const repB = Number(strict.repV ?? 0) || 0;
          const resent = (repA <= -0.35) || (repB <= -0.35);
          const base = 120 + jitter + (resent ? -28 : 0);
          s._coterieRivalry = { nextAt: nowT + Math.max(75, base), lastPair: pairKey };
        } else {
          // Same pair; wait a bit.
          s._coterieRivalry.nextAt = nowT + 60;
        }
      } else {
        // No opposing influential circles yet; check again later.
        s._coterieRivalry.nextAt = nowT + 45;
      }
    }
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
  ensureMilestonesState(state);
  ensureLegacyState(state);
  ensureEternityState(state);
  ensureResearchState(state);
  ensureAudioState(state);
  ensureActivePlayState(state);
  state.meta = state.meta ?? { version: GAME_VERSION, seenVersion: '', lastTs: Date.now(), revealStage: 0 };
  state.meta.revealStage = Math.max(0, Math.min(REVEAL_STAGE_MAX, Math.floor(Number(state.meta.revealStage ?? 0) || 0)));

  // --- Offline progress (tiny idle-game slice)
  // On boot, we simulate a capped amount of time since the last save.
  // This keeps the prototype incremental even when you're not staring at the tab.
  // Explainability: we log a compact summary of what happened.
  const OFFLINE_RATE = 0.50;
  const OFFLINE_CAP_SEC = 24 * 60 * 60;
  const OFFLINE_KNEE_SEC = 4 * 60 * 60;
  const OFFLINE_STREAK_MIN_AWAY_SEC = 2 * 60;
  const _lastTs = Number(state?.meta?.lastTs ?? 0) || 0;
  const _offlineSecRaw = _lastTs ? Math.max(0, (Date.now() - _lastTs) / 1000) : 0;
  state._offlinePending = Math.min(OFFLINE_CAP_SEC, _offlineSecRaw);
  state._offlineWasCapped = (_offlineSecRaw > state._offlinePending + 0.5);


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

  // --- Explainability: smoothed deltas (resource rates + project ETAs)
  // Moved to sim.js to keep deterministic sim helpers centralized.

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

        const fx = skillRegistry.applySkillEffects(s, k, 'Eat');
        const need = 0.95 * dt * rat.foodUse;
        const useFood = Math.min(haveFood, need);
        s.res.food = Math.max(0, haveFood - useFood);
        const rem = Math.max(0, need - useFood);
        const useJerky = Math.min(haveJerky, rem);
        s.res.jerky = Math.max(0, haveJerky - useJerky);
        k.hunger = clamp01(k.hunger - dt * 0.55 * rat.hungerRelief * fx.outputMult);
        k.energy = clamp01(k.energy + dt * 0.03 * rat.energyGain);
        // Food helps recovery.
        k.health = clamp01((k.health ?? 1) + dt * 0.015);
        gainSkillXP(s, k, 'Eat', dt * 0.35);
      }
    },
    Rest: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const fx = skillRegistry.applySkillEffects(s, k, 'Rest');
        k.energy = clamp01(k.energy + dt * 0.16 * fx.outputMult);
        k.hunger = clamp01(k.hunger + dt * 0.03);
        // Rest recovers health; warmth speeds recovery.
        const w = clamp01(Number(s.res?.warmth ?? 0) / 100);
        k.health = clamp01((k.health ?? 1) + dt * (0.018 + 0.020 * w));
        gainSkillXP(s, k, 'Rest', dt * 0.30);
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
        gainSkillXP(s, k, 'Loaf', dt * 0.25);
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

        const fx = skillRegistry.applySkillEffects(s, k, 'Socialize');
        s.social.dissent = clamp01(Number(s.social.dissent ?? 0) - reduce * fx.outputMult);

        // Small spillover: boost one other kitten's mood a tiny amount.
        const others = (s.kittens ?? []).filter(x => x && x.id !== k.id);
        if (others.length) {
          const target = others[(Math.random() * others.length) | 0];
          target.mood = clamp01(Number(target.mood ?? 0.55) + dt * 0.004);
        }
        gainSkillXP(s, k, 'Socialize', dt * 0.40 * eff);
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
        gainSkillXP(s, k, 'Care', dt * 0.40 * eff);
      }
    },
    Forage: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const season = seasonAt(s.t);
        const winterPenalty = season.name === 'Winter' ? 0.55 : 1;
        const fx = skillRegistry.applySkillEffects(s, k, 'Forage');
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Forage');
        const wp = workPaceMul(s);
        const out = 1.85 * fx.outputMult * winterPenalty * toolsBonus(s) * activePlayProdMul(s) * dt * eff * mom * wp * traitOutputMul(k, 'Forage');
        s.res.food += out;
        k.energy = clamp01(k.energy - dt * 0.04 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'Forage', dt * 1.0 * efficiency(s,k));
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
        const fx = skillRegistry.applySkillEffects(s, k, 'PreserveFood');
        const mom = momentumMul(k, 'PreserveFood');
        const wp = workPaceMul(s);

        // Costs per second at eff=1 (tuned to be a midgame sink, not a free win).
        const wantFood = 0.95 * fx.outputMult * dt * eff * mom * wp;
        const wantWood = 0.22 * fx.outputMult * dt * eff * mom * wp;
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
        const made = Math.min(spentFood / 0.95, spentWood / 0.22) * 0.72 * traitOutputMul(k, 'PreserveFood'); // yield < 1 to keep it from dominating

        s.res.jerky = (s.res.jerky ?? 0) + made;
        k.energy = clamp01(k.energy - dt * 0.03 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.02 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'PreserveFood', dt * 0.95 * efficiency(s,k));
      }
    },
    Farm: {
      enabled: (s) => s.unlocked.farm,
      tick: (s,k,dt) => {
        const season = seasonAt(s.t);
        const winterPenalty = season.name === 'Winter' ? 0.85 : 1;
        const fx = skillRegistry.applySkillEffects(s, k, 'Farm');
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Farm');
        const wp = workPaceMul(s);
        const out = 2.35 * fx.outputMult * winterPenalty * toolsBonus(s) * activePlayProdMul(s) * dt * eff * mom * wp * traitOutputMul(k, 'Farm');
        s.res.food += out;
        k.energy = clamp01(k.energy - dt * 0.035 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.025 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'Farm', dt * 1.0 * efficiency(s,k));
      }
    },
    ChopWood: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const fx = skillRegistry.applySkillEffects(s, k, 'ChopWood');
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'ChopWood');
        const wp = workPaceMul(s);
        const out = 1.05 * fx.outputMult * toolsBonus(s) * activePlayProdMul(s) * dt * eff * mom * wp * traitOutputMul(k, 'ChopWood');
        s.res.wood += out;
        k.energy = clamp01(k.energy - dt * 0.05 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.035 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'ChopWood', dt * 1.0 * efficiency(s,k));
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
        const fx = skillRegistry.applySkillEffects(s, k, 'StokeFire');
        const wp = workPaceMul(s);
        const use = Math.min(s.res.wood, 0.9 * dt * wp * fx.speedMult);
        const mom = momentumMul(k, 'StokeFire');
        s.res.wood -= use;
        s.res.warmth = Math.min(100, s.res.warmth + use * 6.5 * mom * fx.outputMult * traitOutputMul(k, 'StokeFire'));
        k.energy = clamp01(k.energy - dt * 0.02 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.02 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'StokeFire', dt * 0.70 * efficiency(s,k));
      }
    },
    Guard: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const fx = skillRegistry.applySkillEffects(s, k, 'Guard');
        let base = s.unlocked.security ? 2.6 : 2.1;
        const drill = drillActive(s) ? 1 : 0;
        if (drill) base += 0.55; // training + patrols

        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Guard');
        const wp = workPaceMul(s);
        s.res.threat = Math.max(0, s.res.threat - base * fx.outputMult * legacyGuardOutputMul(s) * dt * eff * mom * wp * traitOutputMul(k, 'Guard'));
        k.energy = clamp01(k.energy - dt * 0.03 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'Guard', dt * (1.0 + 0.35*drill) * efficiency(s,k) * legacyCombatXPMul(s));
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
        const fx = skillRegistry.applySkillEffects(s, k, 'BuildHut');
        const speed = fx.outputMult * toolsBonus(s) * eff * mom * wp * traitOutputMul(k, 'BuildHut');
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
          maybeAutoClearPinnedProject(s,'Hut');
        }
        k.energy = clamp01(k.energy - dt * 0.06 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'BuildHut', dt * 1.0 * efficiency(s,k));
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
        const fx = skillRegistry.applySkillEffects(s, k, 'BuildPalisade');
        const speed = fx.outputMult * toolsBonus(s) * eff * mom * wp * traitOutputMul(k, 'BuildPalisade');
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
          maybeAutoClearPinnedProject(s,'Palisade');
        }
        k.energy = clamp01(k.energy - dt * 0.06 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'BuildPalisade', dt * 1.0 * efficiency(s,k));
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
        const fx = skillRegistry.applySkillEffects(s, k, 'BuildGranary');
        const speed = fx.outputMult * toolsBonus(s) * eff * mom * wp * traitOutputMul(k, 'BuildGranary');
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
          maybeAutoClearPinnedProject(s,'Granary');
        }
        k.energy = clamp01(k.energy - dt * 0.055 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.035 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'BuildGranary', dt * 1.0 * efficiency(s,k));
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
        const fx = skillRegistry.applySkillEffects(s, k, 'BuildWorkshop');
        const speed = fx.outputMult * toolsBonus(s) * eff * mom * wp * traitOutputMul(k, 'BuildWorkshop');
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
          maybeAutoClearPinnedProject(s,'Workshop');
        }
        k.energy = clamp01(k.energy - dt * 0.06 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'BuildWorkshop', dt * 1.2 * efficiency(s,k));
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
        const fx = skillRegistry.applySkillEffects(s, k, 'BuildLibrary');
        const speed = fx.outputMult * toolsBonus(s) * eff * mom * wp * traitOutputMul(k, 'BuildLibrary');

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
          maybeAutoClearPinnedProject(s,'Library');
        }

        k.energy = clamp01(k.energy - dt * 0.06 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.04 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'BuildLibrary', dt * 1.3 * efficiency(s,k));
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
        const fx = skillRegistry.applySkillEffects(s, k, 'CraftTools');
        const mom = momentumMul(k, 'CraftTools');
        const wp = workPaceMul(s);
        // Respect reserves (hard stop at execution time).
        const useWood = Math.min(woodAvail, 0.55 * fx.outputMult * dt * eff * wp * traitOutputMul(k, 'CraftTools'));
        const useSci  = Math.min(sciAvail, 0.40 * fx.outputMult * dt * eff * wp * traitOutputMul(k, 'CraftTools'));
        const craft = Math.min(useWood / 0.55, useSci / 0.40); // normalize to "tool-seconds"
        if (craft <= 0.0001) {
          doFallback(s, k, dt, 'Research', 'CraftTools blocked by reserve → Research');
          return;
        }
        const made = craft * 0.55 * workshopBonus(s) * activePlayProdMul(s) * mom * eternityMandateMul(s, 'tools') * (eternityHas(s, 'et_ancestral_forge') ? 1.15 : 1.00) * traitOutputMul(k, 'CraftTools'); // workshops improve throughput
        spendUpToReserve(s,'wood', craft * 0.55);
        spendUpToReserve(s,'science', craft * 0.40);
        s.res.tools = (s.res.tools ?? 0) + made;
        k.energy = clamp01(k.energy - dt * 0.05 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'CraftTools', dt * 1.0 * efficiency(s,k));
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
        // Default: mentor's top category skill (excluding Cooking) if it exists; otherwise Scholarship.
        // Upgrade: if the colony is short on a quota/plan role, teach the corresponding role skill instead.
        const top = topCategorySkill(k);
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
        const fx = skillRegistry.applySkillEffects(s, k, 'Mentor');
        const wp = workPaceMul(s);

        // Science cost scales with teaching throughput.
        const wantSci = 0.42 * fx.outputMult * dt * eff * mom * wp * traitOutputMul(k, 'Mentor');
        const spent = spendUpToReserve(s,'science', wantSci);
        if (spent <= 0.0001) {
          doFallback(s, k, dt, 'Research', 'Mentor blocked by science reserve → Research');
          return;
        }

        // Teaching value: convert spent science into XP for the target.
        const teach = (spent / 0.42) * 1.20 * libraryBonus(s);
        gainSkillXP(s, target, teachSkill, teach);
        gainSkillXP(s, k, 'Mentor', teach * 0.45);

        // Small morale bump for both; mentoring feels good.
        k.mood = clamp01(Number(k.mood ?? 0.55) + dt * 0.004);
        target.mood = clamp01(Number(target.mood ?? 0.55) + dt * 0.003);

        // Track for UI explainability.
        k._mentor = { id: target.id, skill: teachSkill, why: teachWhy };

        k.energy = clamp01(k.energy - dt * 0.032 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.028 * wp * fx.hungerMult);
      }
    },
    Research: {
      enabled: (s) => true,
      tick: (s,k,dt) => {
        const fx = skillRegistry.applySkillEffects(s, k, 'Research');
        const eff = efficiency(s, k);
        const mom = momentumMul(k, 'Research');
        const wp = workPaceMul(s);
        const out = 0.95 * fx.outputMult * libraryBonus(s) * legacyResearchMul(s) * activePlayProdMul(s) * dt * eff * mom * wp * traitOutputMul(k, 'Research');
        s.res.science += out;
        k.energy = clamp01(k.energy - dt * 0.035 * wp * fx.fatigueMult);
        k.hunger = clamp01(k.hunger + dt * 0.03 * wp * fx.hungerMult);
        gainSkillXP(s, k, 'Research', dt * 1.0 * efficiency(s,k));
      }
    },
  };

  // P0.2 follow-up: shared subset of task defs consumed by both main.js and replay_test.
  // We keep the existing inline defs for now, but override these four keys with a shared module.
  Object.assign(taskDefs, makeCoreTaskDefs({
    clamp01,
    seasonAt,
    efficiency,
    momentumMul,
    workPaceMul,
    toolsBonus,
    libraryBonus,
    drillActive,
    gainXP: gainSkillXP,
    skillEffects: (s, k, task) => skillRegistry.applySkillEffects(s, k, task),
  }));

  function xpToNext(level){ return 10 + Math.pow(level, 1.35) * 6; }

  // Award XP to a single skill on a kitten (internal helper).
  function awardMicroSkillXP(s, k, skillId, xp){
    const def = skillRegistry.get(skillId);
    // Era check: don't award XP for skills from locked eras
    if (def && !skillRegistry.isEraUnlocked(def.era, s)) return;
    // Auto-init on first earn (organic discovery)
    if (k.skills[skillId] === undefined) k.skills[skillId] = 1;
    if (k.xp[skillId] === undefined) k.xp[skillId] = 0;
    const xpRate = def?.xpRate ?? 1.0;
    const earned = xp * xpRate;
    k.xp[skillId] += earned;
    // Level up
    let level = k.skills[skillId];
    const nm = String(k?.name ?? `Kitten ${k.id}`);
    const sName = def?.name ?? skillId;
    while (k.xp[skillId] >= xpToNext(level)) {
      k.xp[skillId] -= xpToNext(level);
      level += 1;
      k.skills[skillId] = level;
      log(`${nm}: ${sName} → level ${level}`);
      feed(`${nm}: ${sName} level ${level}!`);
      kittenLog(k, 'skill', { skill: skillId, name: sName, level, category: def?.category });
      // Milestone log for notable levels
      if (level === 5 || level === 10 || level === 15 || level === 20) {
        kittenLog(k, 'milestone', { what: `${sName} level ${level}`, detail: `Reached level ${level} in ${sName}` });
      }
    }
    // Trickle 25% to parent category skill
    const parent = def?.parentSkill ?? def?.category;
    if (parent && parent !== skillId) {
      if (k.skills[parent] === undefined) k.skills[parent] = 1;
      if (k.xp[parent] === undefined) k.xp[parent] = 0;
      k.xp[parent] += earned * 0.25;
      let pLevel = k.skills[parent];
      while (k.xp[parent] >= xpToNext(pLevel)) {
        k.xp[parent] -= xpToNext(pLevel);
        pLevel += 1;
        k.skills[parent] = pLevel;
        log(`${nm}: ${parent} → level ${pLevel}`);
        feed(`${nm}: ${parent} level ${pLevel}!`);
        kittenLog(k, 'skill', { skill: parent, name: parent, level: pLevel, category: parent });
      }
    }
  }

  // Main XP function: distributes XP across micro-skills for a task, or awards directly.
  // Signature: gainSkillXP(state, kitten, taskOrSkill, amount)
  function gainSkillXP(s, k, taskOrSkill, amt){
    const entries = TASK_SKILL_MAP[taskOrSkill];
    if (entries) {
      // Distribute across micro-skills based on TASK_SKILL_MAP rates
      for (const [skillId, rate] of entries) {
        awardMicroSkillXP(s, k, skillId, amt * rate);
      }
    } else {
      // Direct skill/category XP (backward compat for Mentor target teaching, etc.)
      awardMicroSkillXP(s, k, taskOrSkill, amt);
    }
  }

  // --- Per-kitten life logging ─────────────────────────────────────────────────
  function kittenName(s, id){
    const k = (s?.kittens ?? []).find(x => Number(x?.id ?? 0) === Number(id));
    return k ? (String(k.name ?? '').trim() || `#${id}`) : `#${id}`;
  }

  const LIFE_LOG_MAX = 150;

  function kittenLog(k, type, data){
    if (!k) return;
    if (!Array.isArray(k.lifeLog)) k.lifeLog = [];
    k.lifeLog.push({ t: state?.t ?? 0, type, data });
    if (k.lifeLog.length > LIFE_LOG_MAX) k.lifeLog.splice(0, k.lifeLog.length - LIFE_LOG_MAX);
  }

  // Track cumulative time spent on each task
  function trackActivityTime(k, task, dt){
    if (!k || !task) return;
    if (!k.activityTime || typeof k.activityTime !== 'object') k.activityTime = {};
    k.activityTime[task] = (k.activityTime[task] ?? 0) + dt;
  }

  // Mood band labels (for life log entries)
  function moodBand(m){
    if (m <= 0.20) return 'Miserable';
    if (m <= 0.35) return 'Glum';
    if (m <= 0.50) return 'Uneasy';
    if (m <= 0.65) return 'Content';
    if (m <= 0.80) return 'Happy';
    return 'Joyful';
  }

  // Log task switch (called from decision second hook)
  function logTaskSwitch(s, k, prevTask, newTask, why){
    if (!k || prevTask === newTask) return;
    // Only log if the kitten has been doing the previous task for at least 3s (avoid log spam)
    if ((k.taskStreak ?? 0) < 3) return;
    kittenLog(k, 'task', { from: prevTask, to: newTask, why: String(why ?? '').slice(0, 60) });
  }

  // Log mood band crossings (called at end of mood update)
  function logMoodTransition(k, prevMood, newMood){
    if (!k) return;
    const prevBand = moodBand(prevMood);
    const newBand = moodBand(newMood);
    if (prevBand !== newBand) {
      kittenLog(k, 'mood', { mood: +newMood.toFixed(3), band: newBand, from: prevBand });
    }
  }

  // Log health threshold crossings
  function logHealthEvent(k, prevHealth, newHealth){
    if (!k) return;
    if (prevHealth >= 0.50 && newHealth < 0.50) {
      kittenLog(k, 'health', { health: +newHealth.toFixed(3), event: 'declining' });
    } else if (prevHealth <= 0.80 && newHealth > 0.80) {
      kittenLog(k, 'health', { health: +newHealth.toFixed(3), event: 'recovered' });
    }
  }

  // --- Conditions
  function evalCond(cond, s, k){
    const foodPerKitten = ediblePerKitten(s);
    switch(cond.type){
      case 'always': return true;
      case 'hungry_gt': return k.hunger > cond.v;
      case 'tired_gt': return (1 - k.energy) > cond.v;
      case 'health_lt': return (Number(k.health ?? 1) || 0) < cond.v;
      case 'food_lt': return s.res.food < cond.v;
      case 'edible_lt': return edibleFood(s) < cond.v;
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

    // Aquarium depth: reputations can slightly affect "legitimacy" during crises.
    // This is computed (and logged) in updateCoteriesAquarium(...) and stored as a small transient bonus.
    const legit = (s && s._repLegit && typeof s._repLegit === 'object') ? Number(s._repLegit.compBonus ?? 0) : 0;
    if (Number.isFinite(legit) && legit) c += legit;

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

  function applyRolePressure(scored, k, s){
    const role = k.role ?? 'Generalist';
    if (role === 'Generalist') return;
    const def = roleDefs.find(r=>r.id===role);
    if (!def) return;

    // Autonomy: higher autonomy means individuals resist rigid specialization a bit.
    // (They still specialize via skills + the plan; this just dampens the role push.)
    const a = effectiveAutonomy01(s);
    const comp = compliance01(s);
    const doc = doctrineKey(s);
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

  function applyPersonalityPressure(scored, k, s){
    // Preferences add a nudge so individuals feel different.
    // Effective autonomy controls how strongly likes/dislikes pull vs colony policy.
    const p = k.personality ?? genPersonality(k.id ?? 0);
    const a = effectiveAutonomy01(s);

    const likeBonus = 6 + 10 * a;      // 6..16
    const dislikePenalty = 4 + 8 * a;  // 4..12
    const doc = doctrineKey(s);
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
    const traits = normalizeTraits(k?.traits, Number(k?.id ?? 1));
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

  function tickTraitEvents(s){
    s._traitEventTimer = Number(s._traitEventTimer ?? 0) + 1;
    if (s._traitEventTimer < 20) return;
    s._traitEventTimer = 0;

    const ks = Array.isArray(s?.kittens) ? s.kittens : [];
    if (!ks.length) return;

    for (const k of ks) {
      k._traitEventAt = Number(k._traitEventAt ?? 0) || 0;
      if ((Number(s.t ?? 0) - k._traitEventAt) < 120) continue;
      const traits = normalizeTraits(k?.traits, Number(k?.id ?? 1));

      if (traits.includes('Brave')) {
        const r = rand01At((s.t ?? 0) + (k.id ?? 0) * 0.37, 41);
        if (r < 0.015) {
          const gain = 8 + Math.floor((Number(k.skills?.Combat ?? 1) || 1) * 0.5);
          s.res.threat = Math.max(0, Number(s.res?.threat ?? 0) - gain);
          s.res.wood = Number(s.res?.wood ?? 0) + 6;
          k._traitEventAt = Number(s.t ?? 0);
          log(`${k.name || ('Kitten '+k.id)} (Brave) led a scouting patrol: -${gain} threat, +6 wood.`);
        }
      }

      if (traits.includes('Curious')) {
        const r = rand01At((s.t ?? 0) + (k.id ?? 0) * 0.53, 77);
        if (r < 0.015) {
          const sci = 12 + Math.floor((Number(k.skills?.Scholarship ?? 1) || 1) * 0.8);
          s.res.science = Number(s.res?.science ?? 0) + sci;
          k._traitEventAt = Number(s.t ?? 0);
          log(`${k.name || ('Kitten '+k.id)} (Curious) uncovered an insight cache: +${sci} science.`);
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

    // Culture rituals: short-lived "mood of the town" drift (tiny, bounded, deterministic).
    // This is separate from action scoring so rituals feel like atmosphere, not just AI bias.
    const ritual = (s && s._cultureRitual && typeof s._cultureRitual === 'object') ? s._cultureRitual : null;
    const ritualKind = (ritual && (Number(s.t ?? 0) < Number(ritual.until ?? 0))) ? String(ritual.kind || '') : '';
    if (ritualKind === 'story') {
      // Story-circle: spirits lift a bit faster (noticeable over ~1 minute).
      m += 0.0012;
    } else if (ritualKind === 'oath') {
      // Work-oath: a subtle chill in leisure/comfort.
      m -= 0.0008;
    }

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

    // Coterie reputation (aquarium consequence):
    // If a kitten belongs to an influential coterie with a strong "respected" aura,
    // their mood recovers a tiny bit faster (social prestige/validation).
    // (Negative reputation consequences are modeled via grievance instead, to keep mood changes subtle.)
    const kid = Number(k?.id ?? 0);
    const cid = (s && s._coterieIdByKid && kid) ? s._coterieIdByKid[kid] : null;
    const inf = cid && s && s._coterieInfluence && s._coterieInfluence[cid] ? !!s._coterieInfluence[cid].inf : false;
    if (inf && s && s._coterieRep) {
      const rv = Number(s._coterieRep[String(cid)] ?? 0) || 0;
      if (rv >= 0.35) {
        // +~0.0009..0.0021 / sec when respected (small but noticeable over ~1 minute).
        const t = (rv - 0.35) / 0.65;
        m += (0.0009 + 0.0012 * clamp01(t));

        // Observability: when it actually matters (mood is low), emit a beat with cooldown.
        const nowT = Number(s.t ?? 0);
        if (m < 0.58) {
          s._coterieRepFx = (s._coterieRepFx && typeof s._coterieRepFx === 'object') ? s._coterieRepFx : {};
          const fx = s._coterieRepFx[cid] ?? { nextAt:0 };
          if (nowT >= Number(fx.nextAt ?? 0)) {
            const cots = Array.isArray(s?.social?.coteries) ? s.social.coteries : [];
            const c = cots.find(x => Number(x?.id ?? 0) === Number(cid));
            const who = c ? (Array.isArray(c.members) ? c.members.slice(0, 3).map(id => kittenName(s, id)).join(', ') : '') : '';
            s.feed = Array.isArray(s.feed) ? s.feed : [];
            s.feed.push(`[${fmt(s.t)}] Reputation: respected circles lift spirits in hard times.` + (who ? ` (${who}${(c?.members?.length ?? 0) > 3 ? '�' : ''})` : ''));
            const FEED_MAX = 220;
            if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

            s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
            s._trendEvents.push({ t: nowT, kind:'repfx', label:'uplift', color:'rgba(34,197,94,.10)' });
            if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

            s._coterieRepFx[cid] = { nextAt: nowT + 140 };
          }
        }
      }
    }

    const prevMood = clamp01(Number(k.mood ?? 0.55));
    k.mood = clamp01(m);
    logMoodTransition(k, prevMood, k.mood);
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
    // Aquarium: during a "mutual aid" culture pressure, members cool down a bit faster.
    const kid = Number(k?.id ?? 0);
    const cid = (s && s._coterieIdByKid && kid) ? s._coterieIdByKid[kid] : null;
    const press = (s && s._coteriePressure && typeof s._coteriePressure === 'object') ? s._coteriePressure : null;
    const nowT = Number(s.t ?? 0);
    const aidActive = !!(press && press.aid && Number(press.aid.until ?? 0) > nowT && cid && Number(press.aid.cid ?? 0) === Number(cid));
    const strictActive = !!(press && press.strict && Number(press.strict.until ?? 0) > nowT && cid && Number(press.strict.cid ?? 0) === Number(cid));
    g = Math.max(0, g - (aidActive ? 0.007 : 0.004));

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

    // Culture ritual atmosphere: tiny, explicit "town mood" drift.
    // Story-circles make resentments soften; work-oaths make resentment stick a bit more under planning pressure.
    const ritual = (s && s._cultureRitual && typeof s._cultureRitual === 'object') ? s._cultureRitual : null;
    const ritualKind = (ritual && (Number(s.t ?? 0) < Number(ritual.until ?? 0))) ? String(ritual.kind || '') : '';
    if (ritualKind === 'story') {
      delta -= 0.0022;
    } else if (ritualKind === 'oath') {
      delta += 0.0015 * planPressure;
      if (delta > 0) delta *= 1.03;
    }

    // Timed colony-wide relief.
    if (festivalActive(s)) delta *= 0.70;
    if (councilActive(s)) delta *= 0.80;

    // Buddy separation can also translate into low-grade resentment under strong planning.
    const need = clamp01(Number(k.buddyNeed ?? 0));
    if (need > 0.70) {
      delta += (need - 0.70) * (0.006 + 0.006 * planPressure) * (1 + 0.35 * disPol);
    }

    // Coterie norms: if a kitten belongs to an influential coterie, that circle's ethos gently biases resentment.
    // Mutual aid reduces grievance buildup; strictness amplifies it a bit.
    const inf = cid && s && s._coterieInfluence && s._coterieInfluence[cid] ? !!s._coterieInfluence[cid].inf : false;
    if (inf) {
      const e = clamp01(Number(s?._coterieEthos?.[cid]?.v ?? s?._coterieEthosByKid?.[kid] ?? 0.5));
      const mul = 1 - 0.22 * ((e - 0.5) * 2); // e=1 => ~0.78, e=0 => ~1.22
      if (delta > 0) delta *= mul;

      // Coterie reputation consequence: "resented" circles accumulate resentment a bit faster.
      const rv = Number(s?._coterieRep?.[String(cid)] ?? 0) || 0;
      if (rv <= -0.35) {
        const t = (-rv - 0.35) / 0.65;
        const mulR = 1 + 0.16 * clamp01(t); // up to +16% on grievance gains
        if (delta > 0) delta *= mulR;

        // Observability: if grievance is already high, emit a beat with cooldown.
        if (g > 0.62) {
          s._coterieRepFx = (s._coterieRepFx && typeof s._coterieRepFx === 'object') ? s._coterieRepFx : {};
          const fx = s._coterieRepFx[`${cid}:neg`] ?? { nextAt:0 };
          if (nowT >= Number(fx.nextAt ?? 0)) {
            s.feed = Array.isArray(s.feed) ? s.feed : [];
            s.feed.push(`[${fmt(s.t)}] Reputation: resentment clings to a disliked circle � grievances rise more easily.`);
            const FEED_MAX = 220;
            if (s.feed.length > FEED_MAX) s.feed.splice(0, s.feed.length - FEED_MAX);

            s._trendEvents = Array.isArray(s._trendEvents) ? s._trendEvents : [];
            s._trendEvents.push({ t: nowT, kind:'repfx', label:'sting', color:'rgba(239,68,68,.10)' });
            if (s._trendEvents.length > 80) s._trendEvents.splice(0, s._trendEvents.length - 80);

            s._coterieRepFx[`${cid}:neg`] = { nextAt: nowT + 160 };
          }
        }
      }
    }

    // Culture pressure: "strict norms" makes resentment stickier for members during the window.
    if (strictActive) {
      if (delta > 0) delta *= 1.10;
      delta += 0.0025 * planPressure;
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
    applyPlanPressure(scored, plan, s);
    applyRolePressure(scored, k, s);
    applyPersonalityPressure(scored, k, s);
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
    if (c === 'edible_lt') return `edible<${v}`;
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
    const topSkill = topCategorySkill(k);

    // Director priorities (policy weights)
    const pFood = prioMul(s,'prioFood');
    const pSafety = prioMul(s,'prioSafety');
    const pProg = prioMul(s,'prioProgress');
    const pSoc = prioMul(s,'prioSocial');
    const FOOD_ACT = new Set(['Forage','Farm','PreserveFood']);
    const SAFETY_ACT = new Set(['Guard','StokeFire']);
    const PROG_ACT = new Set(['Research','Mentor','CraftTools','BuildWorkshop','BuildLibrary']);
    const SOCIAL_ACT = new Set(['Socialize','Care']);
    // Builders are special: they are both "safety" (palisade/huts/granary) and "progress" (infrastructure).

    // Culture rituals: transient 1-minute "atmosphere" that gently biases action choice.
    // Implemented as a small, bounded additive bump so it stays explainable.
    const ritual = (s && s._cultureRitual && typeof s._cultureRitual === 'object') ? s._cultureRitual : null;
    const ritualKind = (ritual && (Number(s.t ?? 0) < Number(ritual.until ?? 0))) ? String(ritual.kind || '') : '';

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
      if (SOCIAL_ACT.has(a)) {
        const add = base(a) * (pSoc - 1);
        if (Math.abs(add) >= 0.05) { score += add; reasons.push(`prio Social x${pSoc.toFixed(2)} → ${add>=0?'+':''}${add.toFixed(1)}`); }
      }
      if (a === 'BuildHut' || a === 'BuildGranary' || a === 'BuildPalisade') {
        // Infrastructure: treat as a blend of Safety + Progress, so you can push building without always pushing research.
        const mul = (0.55 * pSafety + 0.45 * pProg);
        const add = base(a) * (mul - 1);
        if (Math.abs(add) >= 0.05) { score += add; reasons.push(`prio Infra x${mul.toFixed(2)} (S/P) → ${add>=0?'+':''}${add.toFixed(1)}`); }
      }

      // Per-kitten Directive: a persistent scoring nudge (player-set). Not a lock.
      const dir = String(k.directive ?? 'Auto');
      if (dir !== 'Auto') {
        const dirMatch = (dir === 'Food' && FOOD_ACT.has(a))
          || (dir === 'Safety' && (SAFETY_ACT.has(a) || a === 'BuildPalisade' || a === 'BuildGranary' || a === 'BuildHut' || a === 'StokeFire'))
          || (dir === 'Progress' && (PROG_ACT.has(a) || a === 'BuildWorkshop' || a === 'BuildLibrary' || a === 'CraftTools'))
          || (dir === 'Social' && (a === 'Socialize' || a === 'Care'))
          || (dir === 'Rest' && (a === 'Rest' || a === 'Loaf'));
        if (dirMatch) {
          // Additive bump so it stays legible and doesn't overpower emergencies.
          const add = 6 + 0.10 * base(a);
          score += add;
          reasons.push(`directive ${dir} → +${add.toFixed(1)}`);
        }
      }

      // Culture ritual atmosphere: tiny, bounded biases.
      if (ritualKind === 'story') {
        if (SOCIAL_ACT.has(a)) { score += 8; reasons.push('ritual story-circle → +8 (social easier)'); }
        else if (a === 'Loaf') { score -= 4; reasons.push('ritual story-circle → -4 (less passive idling)'); }
      }
      if (ritualKind === 'oath') {
        if (SOCIAL_ACT.has(a)) { score -= 6; reasons.push('ritual work-oath → -6 (leisure chills)'); }
        // "Work" includes food/safety/progress + builders.
        if (FOOD_ACT.has(a) || SAFETY_ACT.has(a) || PROG_ACT.has(a) || a.startsWith('Build') || a === 'CraftTools' || a === 'StokeFire') {
          score += 5;
          reasons.push('ritual work-oath → +5 (productivity tightens)');
        }
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
        // If dissent is VERY high but basics are stable, we want some kittens to actively organize
        // (Socialize/Care) rather than everyone passively loafing.
        const basicsOk = (foodPerKitten >= targets.foodPerKitten * 0.95) && (Number(s.res.warmth ?? 0) >= targets.warmth - 6) && (Number(s.res.threat ?? 0) <= targets.maxThreat * 1.10) && !s.signals?.ALARM;
        if (dis > 0.65 && basicsOk) {
          score -= 14;
          reasons.push('strike + stable basics → -14 (prefer organizing)');
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

        // Strike recovery: if dissent is extreme but the colony isn't actively starving/freezing,
        // strongly encourage an organizer to emerge.
        const basicsOk = (foodPerKitten >= targets.foodPerKitten * 0.95) && (Number(s.res.warmth ?? 0) >= targets.warmth - 6) && (Number(s.res.threat ?? 0) <= targets.maxThreat * 1.10) && !s.signals?.ALARM;
        if (dis > 0.65 && basicsOk) {
          const add = 18 + 12 * discipline01(s);
          score += add;
          reasons.push(`strike recovery → +${add.toFixed(1)}`);
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

        // Norm: mutual-aid culture makes organizing feel more "natural" when cohesion is shaky.
        const ma = clamp01(Number(s.social?.norms?.mutualAid ?? 0));
        if (ma > 0.02 && dis > 0.40) {
          const add = 4 + ma * 14;
          score += add;
          reasons.push(`norm mutual aid ${(ma*100).toFixed(0)}% → +${add.toFixed(1)}`);
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

        // Norm: mutual aid makes "paid care" more politically acceptable when things are tense.
        const ma = clamp01(Number(s.social?.norms?.mutualAid ?? 0));
        if (ma > 0.02 && dis > 0.40) {
          const add = 3 + ma * 16;
          score += add;
          reasons.push(`norm mutual aid ${(ma*100).toFixed(0)}% → +${add.toFixed(1)}`);
        }

        // Strike recovery: if dissent is extreme but basics are stable, "Care" becomes a legitimate
        // paid stabilization tool (spend a little surplus to restore cohesion faster).
        const basicsOk = (foodPerKitten >= targets.foodPerKitten * 0.98) && (Number(s.res.warmth ?? 0) >= targets.warmth - 4) && (Number(s.res.threat ?? 0) <= targets.maxThreat * 1.05) && !s.signals?.ALARM;
        if (dis > 0.65 && basicsOk) {
          const add = 14 + 10 * discipline01(s);
          score += add;
          reasons.push(`strike recovery (paid care) → +${add.toFixed(1)}`);
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
      // Uses the primary micro-skill for each task + category skill bonus.
      const aSkill = skillForAction(a);
      if (aSkill) {
        const lvl = Number(k.skills?.[aSkill] ?? 1);
        const add = Math.min(12, Math.max(0, (lvl - 1) * 1.4));
        if (add >= 0.5) {
          const def = skillRegistry.get(aSkill);
          score += add;
          reasons.push(`${def?.name ?? aSkill}=${lvl} → +${add.toFixed(1)}`);
        }
        // Category skill bonus: if this kitten's top category matches the task's primary skill category
        const def = skillRegistry.get(aSkill);
        const cat = def?.category ?? null;
        if (cat && topSkill.skill === cat && topSkill.level >= 3) {
          const add2 = Math.min(6, 1.2 * (topSkill.level - 2));
          score += add2;
          reasons.push(`top cat ${cat}=${topSkill.level} → +${add2.toFixed(1)}`);
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

        // Norm: sustained scarcity creates a cultural bias toward preservation (even when there is only a modest surplus).
        const sm = clamp01(Number(s.social?.norms?.scarcityMindset ?? 0));
        if (sm > 0.02) {
          const add = 4 + sm * 18;
          score += add;
          reasons.push(`norm scarcity ${(sm*100).toFixed(0)}% → +${add.toFixed(1)}`);
        }
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

        // Norm: raid paranoia creates a small, persistent "vigilance" bias even when threat is below target.
        // This helps the aquarium feel like it remembers past danger without needing player clicks.
        const rp = clamp01(Number(s.social?.norms?.raidParanoia ?? 0));
        if (rp > 0.02) {
          const add = 6 + rp * 20;
          score += add;
          reasons.push(`norm vigilance ${(rp*100).toFixed(0)}% → +${add.toFixed(1)}`);
        }
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

    // Pinned project: guarantee at least 1 builder is *desired* for the specific pinned build track.
    // (Reserves can still block execution; the Projects panel will show the blocker.)
    const pinned = pinnedProjectInfo(s);
    const pinnedTask = (pinned && !pinned.completed) ? String(pinned.task || '') : '';
    const pinnedActive = !!pinnedTask;

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

    if (pinnedActive && (pinnedTask in desired)) {
      desired[pinnedTask] = Math.max(desired[pinnedTask] ?? 0, 1);
    }

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

  function applyPlanPressure(scored, plan, s){
    if (!plan) return;

    // Social layer: dissent reduces obedience to the central plan; discipline restores it.
    const comp = compliance01(s);

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
    // Aquarium pacing: start with breathing room so growth systems can actually kick in.
    // Huts still matter, but the base cap shouldn't trap the sim at pop=3.
    const huts = Math.max(0, Number(s.res?.huts ?? 0));
    const base = 8;
    return base + huts * 3;
  }

  function foodStorageCap(s){
    // Soft cap: above this, spoilage accelerates (see tickPressures).
    // Purpose: make Granaries + PreserveFood (jerky) an actual midgame loop.
    const huts = Math.max(0, Number(s.res?.huts ?? 0));
    const gran = Math.max(0, Number(s.res?.granaries ?? 0));
    const base = 260;
    const raw = base + huts * 90 + gran * 260;
    return raw * (eternityHas(s, 'et_tempered_granaries') ? 1.16 : 1.00);
  }

  // --- Civ pressures
  function applyUnlocks(){
    for (const u of unlockDefs) {
      if (state.seenUnlocks[u.id]) continue;
      if (state.res.science >= u.at) {
        state.seenUnlocks[u.id] = true;
        u.apply(state);
        log(`UNLOCK: ${u.name} (science ≥ ${u.at})`);
        playSfx('unlock');
        feed(`New knowledge: unlocked ${u.name}.`);
        state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
        state._trendEvents.push({ t: Number(state.t ?? 0), kind:'unlock', label:u.name, color:'rgba(125,211,252,.22)' });
        if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
      }
    }
  }

  function tickPressures(dt){
    const season = seasonAt(state.t);

    // Aquarium: periodic high-level feed (keeps the world feeling alive without player clicks)
    state._feedTimer = Number(state._feedTimer ?? 0) + dt;
    if (state._feedTimer >= 12) {
      state._feedTimer = 0;
      const yr = yearAt(state.t) + 1;
      const pop = Number(state.kittens?.length ?? 0);
      const cap = housingCap(state);
      const ediblePk = ediblePerKitten(state);
      const warm = Number(state.res?.warmth ?? 0);
      const thr = Number(state.res?.threat ?? 0);
      const diss = dissent01(state);
      feed(`Year ${yr}: pop ${pop}/${cap} | edible/kit ${fmt(ediblePk)} | warmth ${fmt(warm)} | threat ${fmt(thr)} | dissent ${(diss*100).toFixed(0)}%`);

      // Aquarium: politics drift marker � when the dominant values bloc changes, mark it in the feed + trends.
      // Keeps "emergent society" visible without needing to open Factions.
      if (pop >= 4) {
        const dom = dominantFactionAxis(state);
        const lastAx = String(state._lastDomBlocAxis ?? '');
        const lastN = Number(state._lastDomBlocN ?? -1);
        const canFlipAt = Number(state._lastDomBlocNextAt ?? 0);
        if (dom && dom.axis && dom.axis !== lastAx && Number(state.t ?? 0) >= canFlipAt) {
          // Basic anti-flap: only accept a flip if the new bloc is not *smaller* than the old cached count.
          // (This makes 1-kitten ties less spammy while staying deterministic.)
          if (lastN < 0 || dom.n >= lastN) {
            state._lastDomBlocAxis = dom.axis;
            state._lastDomBlocN = dom.n;
            state._lastDomBlocNextAt = Number(state.t ?? 0) + 36;
            feed(`Politics shift: the ${dom.axis} bloc is now dominant (${dom.n}/${pop}).`);
            state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
            state._trendEvents.push({ t: Number(state.t ?? 0), kind:'bloc', label:`dominant:${dom.axis}`, color:'rgba(167,139,250,.18)' });
            if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
          }
        }
        // Initialize cache for old saves (or first run) without logging.
        if (!lastAx) {
          state._lastDomBlocAxis = dom.axis;
          state._lastDomBlocN = dom.n;
          state._lastDomBlocNextAt = Number(state.t ?? 0) + 36;
        }
      }

      // Aquarium: micro-factions (coteries) � friendship circles that can become "influential".
      // Runs on the same slow cadence as the feed tick to keep overhead/spam low.
      updateCoteriesAquarium(state);
    }

    // Politics pressure: demands expire into consequences (instead of silently vanishing).
    const exp = expireFactionDemandIfNeeded(state);
    if (exp?.ok) log(exp.msg);

    // Season transition log (explainability): one clean ping when the season flips.
    // This helps players connect "why did outputs change" to the seasonal model.
    // NEW: include a small "season report" (stats + targets) so it's actionable without opening panels.
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

      // chart marker
      state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
      state._trendEvents.push({ t: Number(state.t ?? 0), kind:'season', label:`${from}?${season.name}`, color:'rgba(255,255,255,.10)' });
      if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);

      const yr = yearAt(state.t) + 1;
      const pop = Number(state.kittens?.length ?? 0);
      const cap = housingCap(state);
      const ediblePk = ediblePerKitten(state);
      const warm = Number(state.res?.warmth ?? 0);
      const thr = Number(state.res?.threat ?? 0);
      const diss = dissent01(state);
      let avgMood = 0;
      if (pop > 0) {
        for (const k of state.kittens) avgMood += Number(k.mood ?? 0.60);
        avgMood /= pop;
      } else {
        avgMood = 0.60;
      }
      const targets = seasonTargets(state);
      const demand = activeFactionDemand(state);

      // Aquarium depth: end-of-Winter leaves a soft "reputation" imprint on coteries.
      // We tag it once at the Winter?Spring boundary; the coterie ledger consumes it later.
      if (String(from) === 'Winter' && String(season.name) === 'Spring') {
        let avgHealth = 0;
        if (pop > 0) {
          for (const k of state.kittens) avgHealth += clamp01(Number(k.health ?? 1));
          avgHealth /= pop;
        } else {
          avgHealth = 1;
        }
        const okFood = ediblePk >= targets.foodPerKitten * 0.90;
        const okWarm = warm >= targets.warmth * 0.85;
        const okHealth = avgHealth >= 0.70;
        const res = (okFood && okWarm && okHealth) ? 'good' : 'hard';
        state._lastWinterOutcome = { t: Number(state.t ?? 0), result: res };
      }

      const report = `Year ${yr} | pop ${pop}/${cap} | edible/kit ${fmt(ediblePk)} | warmth ${fmt(warm)} | threat ${fmt(thr)} | dissent ${(diss*100).toFixed(0)}% | mood ${(avgMood*100).toFixed(0)}%`;
      const targetLine = `Targets now: edible/kit ≥ ${targets.foodPerKitten}, warmth ≥ ${targets.warmth}, threat ≤ ${targets.maxThreat}` + (targets.why !== 'baseline' ? ` (${targets.why})` : '');
      const demandLine = demand ? `Faction demand active: ${demand.axis} bloc (${String(demand.what ?? 'concessions')})` : '';

      log(msg + (from ? ` (from ${from})` : '') + `\n${report}\n${targetLine}` + (demandLine ? `\n${demandLine}` : ''));

      // Civ-sim: faction demands often emerge at season boundaries when priorities naturally shift.
      const fd = maybeStartFactionDemand(state, `season ${from}→${season.name}`);
      if (fd) log(`Faction demand: the ${fd.axis} bloc wants concessions (accept or ignore in Factions).`);
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
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, curfew:false, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoPolicy:false, autoPolicyNextAt:0, autoPolicyWhy:'', autoBuildPush:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', autoRecruit:false, autoRecruitWhy:'', autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', autoCouncil:false, autoCouncilNextAt:0, autoCouncilWhy:'', autoDangerPause:false, autoDangerPauseNextAt:0, autoDangerPauseWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    if (!('crisis' in state.director)) state.director.crisis = false;
    if (!('crisisSaved' in state.director)) state.director.crisisSaved = null;
    if (!('curfew' in state.director)) state.director.curfew = false;
    if (!('autoWinterPrep' in state.director)) state.director.autoWinterPrep = false;
    if (!('autoFoodCrisis' in state.director)) state.director.autoFoodCrisis = false;
    if (!('autoReserves' in state.director)) state.director.autoReserves = false;
    if (!('autoPolicy' in state.director)) state.director.autoPolicy = false;
    if (!('autoPolicyNextAt' in state.director)) state.director.autoPolicyNextAt = 0;
    if (!('autoPolicyWhy' in state.director)) state.director.autoPolicyWhy = '';
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
    if (!('prioSocial' in state.director)) state.director.prioSocial = 1.00;
    state.director.autonomy = clamp01(Number(state.director.autonomy ?? 0.60));
    state.director.discipline = clamp01(Number(state.director.discipline ?? 0.40));
    state.director.workPace = Math.max(0.8, Math.min(1.2, Number(state.director.workPace ?? 1.00) || 1.00));
    state.director.prioFood = Math.max(0.50, Math.min(1.50, Number(state.director.prioFood ?? 1.00) || 1.00));
    state.director.prioSafety = Math.max(0.50, Math.min(1.50, Number(state.director.prioSafety ?? 1.00) || 1.00));
    state.director.prioProgress = Math.max(0.50, Math.min(1.50, Number(state.director.prioProgress ?? 1.00) || 1.00));
    state.director.prioSocial = Math.max(0.50, Math.min(1.50, Number(state.director.prioSocial ?? 1.00) || 1.00));

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

      // Aquarium: coterie culture "pressure" sometimes spills into macro politics.
      // Strict norms -> a bit more grumbling; Mutual aid -> a bit calmer.
      const cp = (state && state._coteriePressure && typeof state._coteriePressure === 'object') ? state._coteriePressure : null;
      const aidPressure = (cp && cp.aid && Number(cp.aid.until ?? 0) > Number(state.t ?? 0)) ? -0.025 : 0;
      const strictPressure = (cp && cp.strict && Number(cp.strict.until ?? 0) > Number(state.t ?? 0)) ? 0.035 : 0;
      const coteriePressure = aidPressure + strictPressure;

      let desire = 0;
      desire += moodPressure;
      desire += workPressure;
      desire += rationPressure;
      desire += hungerPressure;
      desire += grievancePressure;
      desire += alarmPressure;
      desire += curfewPressure;
      desire += coteriePressure;

      const rawDesire = desire;

      // Discipline reduces how quickly dissent forms (but never to zero).
      // Aquarium: a persistent culture norm can change how *effective* discipline feels.
      // Low punitiveTolerance => discipline causes backlash (less effective). High => discipline is culturally accepted (more effective).
      const disPol = discipline01(state);
      state.social.norms = (state.social.norms && typeof state.social.norms === 'object') ? state.social.norms : { raidParanoia: 0, scarcityMindset: 0, mutualAid: 0, punitiveTolerance: 0 };
      const pt = clamp01(Number(state.social.norms.punitiveTolerance ?? 0));
      const disEff = clamp01(disPol * (0.75 + 0.50 * pt));
      desire *= (1 - 0.45 * disEff);

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
        discipline: disPol,
        punitiveTolerance: pt,
        disciplineEffective: disEff,
        workPace: wp,
        rationsLabel: String(rat.label ?? state.rations ?? 'Normal'),
        alarmStress,
        curfew: !!state.director?.curfew,
        moodPressure, workPressure, rationPressure, hungerPressure, grievancePressure, alarmPressure, curfewPressure,
        coteriePressure,
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
        const season = seasonAt(state.t);

        // Conditions are intentionally strict to avoid "win-more" runaway:
        // - Only once per year, during Spring
        // - Must be stable on basics (surplus food, low threat, decent mood)
        const inSpring = (season.name === 'Spring' && season.phase >= 0.06 && season.phase <= 0.80);
        const stableFood = (foodPerKitten >= targets.foodPerKitten * 1.08);
        const stableThreat = (state.res.threat <= targets.maxThreat * 0.92);
        const stableMood = (avgMood >= 0.56);

        // Cost scales lightly with population so growth stays easy.
        // (We want the aquarium to fill up; pressure systems scale with pop anyway.)
        const pop = Math.max(1, state.kittens.length);
        const cost = Math.round((18 + Math.floor(pop / 6) * 3) / 2) * 2; // 18,20,22,...

        // Explainability: surface why Auto Recruit is (or isn't) firing.
        // Keep it short; the full condition set is already in the tooltip.
        const whyParts = [];
        if (!hasHousing) whyParts.push(`no housing (${state.kittens.length}/${cap})`);
        if (yr === Number(state.director.recruitYear ?? -1)) whyParts.push('already recruited this year');
        if (season.name !== 'Spring') whyParts.push(`wait for Spring (now ${season.name})`);
        else if (!inSpring) whyParts.push('wait mid-Spring');
        if (!stableFood) whyParts.push(`food/kitten ${(foodPerKitten).toFixed(1)} < ${(targets.foodPerKitten*1.08).toFixed(0)}`);
        if (!stableThreat) whyParts.push(`threat ${fmt(state.res.threat)} > ${(targets.maxThreat*0.92).toFixed(0)}`);
        if (!stableMood) whyParts.push(`avg mood ${(avgMood*100).toFixed(0)}% < 56%`);

        // Respect food reserve (director won't "immigrate" below your buffer).
        const minFoodAfter = getReserve(state,'food');
        const needFood = cost + minFoodAfter;
        if ((state.res.food ?? 0) < needFood) whyParts.push(`need food ≥ ${fmt(needFood)} (cost ${cost} + reserve)`);

        state.director.autoRecruitWhy = whyParts.length ? whyParts.slice(0,2).join('; ') : `ready (cost ${cost} food)`;

        if (inSpring && hasHousing && yr !== Number(state.director.recruitYear ?? -1) && stableFood && stableThreat && stableMood) {
          if ((state.res.food - cost) >= minFoodAfter) {
            state.res.food -= cost;
            const id = state.kittens.length ? Math.max(...state.kittens.map(k=>k.id))+1 : 1;
            state.kittens.push(makeKitten(id, state.t));
            state.director.recruitYear = yr;
            state.director.autoRecruitWhy = '';
            log(`A stray kitten joined this Spring! (-${cost} food) Population: ${state.kittens.length}/${cap}`);
            feed(`Immigration: a stray kitten joined (pop ${state.kittens.length}/${cap}).`);
            state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
            state._trendEvents.push({ t: Number(state.t ?? 0), kind:'pop', label:'kitten+', color:'rgba(52,211,153,.18)' });
            if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
          }
        }
      }
    }

    // Aquarium: births + wandering arrivals (continuous growth, not 1/year).
    // Goal: reach dozens+ kittens quickly when stable.
    state._popFlowTimer = (state._popFlowTimer ?? 0) + dt;
    if (state._popFlowTimer >= 1) {
      state._popFlowTimer = 0;
      const cap = housingCap(state);
      const pop = Math.max(0, state.kittens.length);
      const space = Math.max(0, cap - pop);
      if (space > 0 && pop > 0) {
        const season = seasonAt(state.t);
        const targets = seasonTargets(state);
        const ediblePk = ediblePerKitten(state);
        const avgMood = pop ? (state.kittens.reduce((a,k)=>a + clamp01(Number(k.mood ?? 0.55)),0) / pop) : 0.55;
        const avgGriev = pop ? (state.kittens.reduce((a,k)=>a + clamp01(Number(k.grievance ?? 0)),0) / pop) : 0;
        const threat = Number(state.res?.threat ?? 0);

        const surplus = clamp01((ediblePk / Math.max(1, targets.foodPerKitten) - 1.05) / 0.8);
        const cozy = clamp01((Number(state.res?.warmth ?? 0) - targets.warmth) / Math.max(1, targets.warmth));
        const safe = clamp01((targets.maxThreat - threat) / Math.max(1, targets.maxThreat));
        const happy = clamp01((avgMood - 0.52) / 0.30);
        const calm = clamp01(1 - avgGriev);

        // Desired pace: if stable, add kittens frequently. Rates are capped and deterministic.
        let birthRate = 0.02 + 0.22 * surplus * happy * safe;  // up to ~0.24 / sec
        let wanderRate = 0.03 + 0.26 * surplus * safe * clamp01(0.4 + 0.6 * calm); // up to ~0.29 / sec

        // Seasonal spice
        if (season.name === 'Spring') { birthRate *= 1.15; wanderRate *= 1.10; }
        if (season.name === 'Winter') { birthRate *= 0.75; wanderRate *= 0.80; }
        if (cozy < 0) { birthRate *= 0.85; }

        const minFoodAfter = getReserve(state,'food');
        const canAfford = (state.res.food ?? 0) >= (minFoodAfter + 24);

        const tInt = Math.floor(Number(state.t ?? 0));
        const rollA = rand01At(tInt, 101);
        const rollB = rand01At(tInt, 202);

        // Births consume a small amount of food (pregnancy/baby care), but are otherwise free.
        if (canAfford && rollA < birthRate) {
          const cost = Math.max(8, Math.round(10 + pop * 0.03));
          if ((state.res.food - cost) >= minFoodAfter) {
            state.res.food -= cost;
            const id = state.kittens.length ? Math.max(...state.kittens.map(k=>k.id))+1 : 1;
            state.kittens.push(makeKitten(id, state.t));
            feed(`Birth: a kitten was born (pop ${state.kittens.length}/${cap}).`);
            state._birthCt = (state._birthCt ?? 0) + 1;
            state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
            state._trendEvents.push({ t: Number(state.t ?? 0), kind:'pop', label:'birth', color:'rgba(52,211,153,.22)' });
            if (state._trendEvents.length > 120) state._trendEvents.splice(0, state._trendEvents.length - 120);
          }
        }

        // Wanderers (immigration) — cheaper than spring event, can happen any season if stable.
        if (canAfford && rollB < wanderRate) {
          const cost = Math.max(6, Math.round(8 + pop * 0.02));
          if ((state.res.food - cost) >= minFoodAfter) {
            state.res.food -= cost;
            const id = state.kittens.length ? Math.max(...state.kittens.map(k=>k.id))+1 : 1;
            state.kittens.push(makeKitten(id, state.t));
            feed(`Wanderer: a kitten joined from the wilds (pop ${state.kittens.length}/${cap}).`);
            state._wanderCt = (state._wanderCt ?? 0) + 1;
            state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
            state._trendEvents.push({ t: Number(state.t ?? 0), kind:'pop', label:'wander', color:'rgba(52,211,153,.16)' });
            if (state._trendEvents.length > 120) state._trendEvents.splice(0, state._trendEvents.length - 120);
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

    // Director automation: optional auto Policy tuning (targets → policy multipliers).
    // Goal: create a more "civ governor" feel: you set Targets; the Director nudges policy quotas a little to hit them.
    // It makes small reversible changes, with a cooldown, and it pauses during Crisis Protocol.
    if (state.director.autoPolicy && !state.director.crisis) {
      state._autoPolicyTimer = (state._autoPolicyTimer ?? 0) + dt;
      if (state._autoPolicyTimer >= 1) {
        state._autoPolicyTimer = 0;

        state.director.autoPolicyNextAt = Number(state.director.autoPolicyNextAt ?? 0) || 0;
        if (state.t >= state.director.autoPolicyNextAt) {
          const res = autoTunePolicyTowardTargets(state);
          if (res.changed) {
            state.director.autoPolicyWhy = res.why;
            // Keep logs sparse; this is meant to be background governance.
            if ((state._autoPolicyLogAt ?? -9999) + 14 <= state.t) {
              state._autoPolicyLogAt = state.t;
              log(`Auto Policy: ${res.why}`);
            }
            state.director.autoPolicyNextAt = state.t + 6;
          } else {
            // If no change, back off a bit.
            state.director.autoPolicyNextAt = state.t + 10;
            state.director.autoPolicyWhy = res.why || state.director.autoPolicyWhy || '';
          }
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

    // Goal: reduce micro by picking Survive/Expand/Defend/Advance based on obvious stability signals.
    // It respects Crisis Protocol (manual) and only changes occasionally to avoid flapping.
    // Director automation: optional auto COUNCIL.
    // Goal: reduce micro by holding Council when cohesion is the bottleneck.
    // It only fires when dissent is high, basics are stable, and you can afford the cost above reserves.
    if (state.director.autoCouncil) {
      state._autoCouncilTimer = (state._autoCouncilTimer ?? 0) + dt;
      if (state._autoCouncilTimer >= 1) {
        state._autoCouncilTimer = 0;

        state.director.autoCouncilNextAt = Number(state.director.autoCouncilNextAt ?? 0) || 0;
        if (!councilActive(state) && state.t >= state.director.autoCouncilNextAt) {
          const targets = seasonTargets(state);
          const season = seasonAt(state.t);
          const foodPerKitten = ediblePerKitten(state);
          const warmth = Number(state.res.warmth ?? 0);
          const threat = Number(state.res.threat ?? 0);
          const dis = dissent01(state);

          const basicsOk = (foodPerKitten >= targets.foodPerKitten * 0.95) && (warmth >= targets.warmth - (season.name === 'Winter' ? 6 : 10)) && (threat <= targets.maxThreat * 1.10);
          const needCohesion = dis >= 0.58;

          if (needCohesion && basicsOk && canHoldCouncil(state)) {
            const res = holdCouncil(state);
            if (res?.ok) {
              state.director.autoCouncilWhy = `trigger: dissent ${(dis*100).toFixed(0)}%`;
              log(`Auto Council: HELD (${state.director.autoCouncilWhy})`);
            }
            state.director.autoCouncilNextAt = state.t + 70;
          } else {
            if (!needCohesion) state.director.autoCouncilWhy = `waiting: dissent ${(dis*100).toFixed(0)}% < 58%`;
            else if (!basicsOk) state.director.autoCouncilWhy = 'waiting: basics not stable (food/warmth/threat)';
            else if (!canHoldCouncil(state)) state.director.autoCouncilWhy = 'waiting: not enough food+science above reserves';
          }
        }
      }
    }

    // Director automation: optional auto PAUSE on danger.
    // Goal: make slow spirals (starvation/freezing/raid buildup) more visible by stopping the sim when things are clearly about to go bad.
    // It will NOT auto-resume.
    // Upgrade: uses simple trend forecasts (resource rates) so it can pause *before* you hit zero.
    if (state.director.autoDangerPause) {
      state._autoDPauseTimer = (state._autoDPauseTimer ?? 0) + dt;
      if (state._autoDPauseTimer >= 1) {
        state._autoDPauseTimer = 0;

        state.director.autoDangerPauseNextAt = Number(state.director.autoDangerPauseNextAt ?? 0) || 0;
        if (!state.paused && state.t >= state.director.autoDangerPauseNextAt) {
          const targets = seasonTargets(state);
          const season = seasonAt(state.t);
          const foodPerKitten = ediblePerKitten(state);
          const warmth = Number(state.res.warmth ?? 0);
          const threat = Number(state.res.threat ?? 0);

          // Trend-based forecasts (smoothed) — keeps the pauses from being too hair-trigger.
          ensureRateState(state);
          const r = state._rate ?? {};
          const foodRate = Number(r.food ?? 0);
          const jerkyRate = Number(r.jerky ?? 0);
          const warmthRate = Number(r.warmth ?? 0);
          const threatRate = Number(r.threat ?? 0);

          const edibleNow = edibleFood(state);
          const edibleRate = foodRate + jerkyRate;

          const etaZero = (cur, rate) => {
            const c = Number(cur ?? 0);
            const rr = Number(rate ?? 0);
            if (!Number.isFinite(c) || !Number.isFinite(rr)) return Infinity;
            if (c <= 0.0001) return 0;
            if (rr >= -0.02) return Infinity; // not dropping meaningfully
            return c / (-rr);
          };

          const etaRaid = () => {
            if (!Number.isFinite(threatRate) || threatRate <= 0.02) return Infinity;
            if (threat >= 100) return 0;
            return (100 - threat) / threatRate;
          };

          const starveEta = etaZero(edibleNow, edibleRate);
          const freezeEta = etaZero(warmth, warmthRate);
          const raidEta = etaRaid();

          // Hard thresholds (immediate danger)
          const starving = (edibleNow <= 0) || (foodPerKitten < targets.foodPerKitten * 0.55);
          const freezing = (season.name === 'Winter') && (warmth < (targets.warmth - 18));
          const raidSoon = (threat >= 95) || (state.signals?.ALARM && threat >= 80) || (threat > targets.maxThreat * 1.35);

          // Forecast thresholds ("we are trending into the wall")
          const starveSoon = (starveEta <= 22);
          const freezeSoon = (season.name === 'Winter') && (freezeEta <= 22);
          const raidEtaSoon = (raidEta <= 20);

          if (starving || freezing || raidSoon || starveSoon || freezeSoon || raidEtaSoon) {
            let why = '';
            if (starving) {
              why = `starving risk (edible/kitten ${fmt(foodPerKitten)} < ${(targets.foodPerKitten * 0.55).toFixed(0)})`;
            } else if (starveSoon) {
              why = `starving soon (edible ${fmt(edibleNow)} at ${fmtRate(edibleRate)} → 0 in ${fmtEtaSeconds(starveEta)})`;
            } else if (freezing) {
              why = `freezing risk (winter warmth ${fmt(warmth)} < ${(targets.warmth - 18).toFixed(0)})`;
            } else if (freezeSoon) {
              why = `freezing soon (warmth ${fmt(warmth)} at ${fmtRate(warmthRate)} → 0 in ${fmtEtaSeconds(freezeEta)})`;
            } else if (raidSoon) {
              why = `raid risk (threat ${fmt(threat)})`;
            } else {
              why = `raid soon (threat ${fmt(threat)} at ${fmtRate(threatRate)} → raid in ${fmtEtaSeconds(raidEta)})`;
            }

            state.paused = true;
            state.director.autoDangerPauseWhy = why;
            state.director.autoDangerPauseNextAt = state.t + 20; // cooldown: don't instantly re-pause if the player resumes
            log(`Auto-paused (danger): ${why}`);
            save();
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

    // Spoilage warning (explainability): if you're way over storage cap, ping the log once.
    // This is easy to miss otherwise (it shows as a small multiplier in stats).
    // Reset once you drop back near/below cap.
    state._spoilWarned = state._spoilWarned ?? false;
    if (!state._spoilWarned && foodCap > 0 && food > foodCap * 1.15) {
      const mult = Number(state._lastFoodOvercap?.mult ?? 1);
      log(`Food stores exceed storage cap (${fmt(food)}/${fmt(foodCap)}). Spoilage is now x${(Number.isFinite(mult)?mult:1).toFixed(2)}. Consider building Granaries or running PreserveFood (jerky).`);
      state._spoilWarned = true;
    }
    if (state._spoilWarned && foodCap > 0 && food < foodCap * 1.05) {
      state._spoilWarned = false;
    }

    state.res.food = Math.max(0, food - food * spoil * dt);

    // Warmth decay; faster in winter
    const decay = season.name === 'Winter' ? 0.42 : 0.22;
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
        k.health = clamp01((k.health ?? 1) - dt * (0.002 + 0.006 * cold));
      }
    }

    // Housing overcrowding pressure
    // Overcrowding is a classic civ-sim pain point that should push you toward building housing.
    // It now has TWO layers:
    // - Physical strain (energy/hunger) (existing)
    // - Social strain (dissent + grievance) (new)
    const cap = housingCap(state);
    const over = Math.max(0, (state.kittens.length ?? 0) - cap);

    // One-time log when overcrowding begins/ends (explainability)
    state._overcrowdWarned = state._overcrowdWarned ?? false;
    if (over > 0 && !state._overcrowdWarned) {
      state._overcrowdWarned = true;
      log(`Overcrowding: population exceeds housing cap (${state.kittens.length}/${cap}). Mood and cohesion will suffer until you build more huts.`);
    }
    if (over <= 0 && state._overcrowdWarned) {
      state._overcrowdWarned = false;
      log('Overcrowding resolved: housing cap is no longer exceeded.');
    }

    if (over > 0) {
      // Physical strain
      for (const k of state.kittens) {
        k.energy = clamp01(k.energy - dt * (0.010 + 0.002 * over));
        k.hunger = clamp01(k.hunger + dt * (0.006 + 0.001 * over));
      }

      // Social strain (slow burn). More discipline can keep order, but doesn't eliminate stress.
      state.social = state.social ?? { dissent: 0 };
      if (!('dissent' in state.social)) state.social.dissent = 0;

      const disPol = discipline01(state);
      const dissentAdd = dt * (0.0016 + 0.0006 * over) * (1 - 0.45 * disPol);
      state.social.dissent = clamp01(Number(state.social.dissent ?? 0) + dissentAdd);

      for (const k of state.kittens) {
        k.grievance = clamp01(Number(k.grievance ?? 0) + dt * (0.0012 + 0.0004 * over));
        k.mood = clamp01(Number(k.mood ?? 0.55) - dt * (0.0009 + 0.0003 * over));
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
        // Raid outcome now depends on your defenses.
        // - Palisade (built) reduces damage
        // - Guards on duty help repel raids
        // - Security unlock enables ALARM + better response
        // - Drills/Curfew provide small temporary mitigation
        const pal = Math.max(0, Number(state.res.palisade ?? 0));
        const guards = (state.kittens ?? []).filter(k => String(k?.task ?? '') === 'Guard').length;
        const sec = state.unlocked.security ? 1 : 0;
        const drill = drillActive(state) ? 1 : 0;
        const curfew = state.director?.curfew ? 1 : 0;

        const palWeight = 0.7 * legacyPalisadeDefenseMul(state);
        const defScore = pal * palWeight + guards * 1.4 + sec * 2.0 + drill * 3.0 + curfew * 1.5;
        const mitigate = Math.max(0.25, 1 - 0.035 * defScore); // 1.00 (none) → 0.25 (strong defense)
        const repelChance = Math.min(0.65, 0.04 * guards + 0.012 * pal * legacyPalisadeDefenseMul(state) + 0.10 * drill + 0.06 * sec);

        const repelled = Math.random() < repelChance;

        if (repelled) {
          state.res.threat = Math.max(12, state.res.threat - (55 + 10 * Math.random()));
          // A successful defense is a morale win.
          for (const k of state.kittens) {
            k.mood = clamp01(Number(k.mood ?? 0.55) + 0.02);
            k.grievance = clamp01(Number(k.grievance ?? 0) * 0.96);
          }
          log(`RAID REPELLED! (guards ${guards}, palisade ${pal}) Threat pushed back.`);
          playSfx('raid');
          feed('Raid repelled. The colony feels safer.');
          state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
          state._trendEvents.push({ t: Number(state.t ?? 0), kind:'raid', label:'repel', color:'rgba(251,113,133,.18)' });
          if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
          state._recentRaidTimer = 45;
          state._lastRaidOutcome = { t: Number(state.t ?? 0), result:'repel' };

          // Norms: raids leave cultural memory. A repelled raid still increases vigilance, but less than a hit.
          state.social = state.social ?? { dissent: 0 };
          state.social.norms = (state.social.norms && typeof state.social.norms === 'object') ? state.social.norms : { raidParanoia: 0 };
          state.social.norms.raidParanoia = clamp01(Number(state.social.norms.raidParanoia ?? 0) + 0.10);
        } else {
          state.res.threat = Math.max(20, state.res.threat - 35);

          const stealFood = Math.min(state.res.food, (35 + Math.random()*30) * mitigate);
          const stealWood = Math.min(state.res.wood, (15 + Math.random()*20) * mitigate);
          state.res.food -= stealFood;
          state.res.wood -= stealWood;

          // Hurt: raise hunger a bit + add injury (health), reduced by defense.
          const injBase = (0.07 + Math.random()*0.06) * mitigate;
          for (const k of state.kittens) {
            k.hunger = clamp01(Number(k.hunger ?? 0) + 0.08 * mitigate);
            k.health = clamp01((Number(k.health ?? 1) || 1) - injBase);
          }

          log(`RAID! Lost ${fmt(stealFood)} food + ${fmt(stealWood)} wood. Injuries reported. (mitigation x${mitigate.toFixed(2)}; guards ${guards}, palisade ${pal})`);
          playSfx('raid');
          feed(`Raid hit the colony. Lost ${fmt(stealFood)} food and ${fmt(stealWood)} wood.`);
          state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
          state._trendEvents.push({ t: Number(state.t ?? 0), kind:'raid', label:'hit', color:'rgba(251,113,133,.26)' });
          if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
          state._recentRaidTimer = 75;
          state._lastRaidOutcome = { t: Number(state.t ?? 0), result:'hit' };

          // Norms: a raid that hits the colony leaves a stronger vigilance scar.
          state.social = state.social ?? { dissent: 0 };
          state.social.norms = (state.social.norms && typeof state.social.norms === 'object') ? state.social.norms : { raidParanoia: 0 };
          state.social.norms.raidParanoia = clamp01(Number(state.social.norms.raidParanoia ?? 0) + 0.18);

          // Auto alarm (only once you know what "ALARM" means)
          state.signals.ALARM = state.unlocked.security ? true : false;
        }
      }
    }

    // Norms: raid paranoia decays slowly, but changes how the colony behaves even when threat is "objectively" safe.
    // This creates a self-sustaining aquarium loop: raids -> vigilance -> more guards -> fewer raids -> calm.
    state.social = state.social ?? { dissent: 0 };
    state.social.norms = (state.social.norms && typeof state.social.norms === 'object') ? state.social.norms : { raidParanoia: 0 };
    state.social.normsBand = String(state.social.normsBand ?? 'calm');
    state.social.normsLastAt = Number(state.social.normsLastAt ?? 0) || 0;

    // Decay (slow): ~5-7 minutes to fully cool down from max.
    const rp0 = clamp01(Number(state.social.norms.raidParanoia ?? 0));
    const rp = clamp01(rp0 - dt * 0.0025);
    state.social.norms.raidParanoia = rp;

    const band = (rp < 0.25) ? 'calm' : (rp < 0.55) ? 'wary' : 'paranoid';
    if (band !== state.social.normsBand && (Number(state.t ?? 0) - state.social.normsLastAt) > 25) {
      state.social.normsBand = band;
      state.social.normsLastAt = Number(state.t ?? 0);
      if (band === 'wary') feed('Norms: the colony grows more vigilant after recent danger.');
      else if (band === 'paranoid') feed('Norms: paranoia takes hold. Watch circles and guard rotations intensify.');
      else feed('Norms: vigilance fades. The colony feels safe enough to relax.');
      state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
      state._trendEvents.push({ t: Number(state.t ?? 0), kind:'norm', label:`vig:${band}`, color:'rgba(96,165,250,.22)' });
      if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
    }

    // Norms: sustained scarcity creates "thrift" culture that pushes preservation even after the pantry recovers.
    // This is NOT event-based; it emerges from living under the food target for extended periods.
    state.social.norms.scarcityMindset = clamp01(Number(state.social.norms.scarcityMindset ?? 0));
    state.social.scarcityBand = String(state.social.scarcityBand ?? 'calm');
    state.social.scarcityLastAt = Number(state.social.scarcityLastAt ?? 0) || 0;

    const edible = edibleFood(state);
    const nPop = Math.max(1, state.kittens?.length ?? 1);
    const wantEdible = Math.max(1, Number(seasonTargets(state)?.foodPerKitten ?? state.targets.foodPerKitten) * nPop);
    const ratio = edible / wantEdible; // <1 = under target

    const sm0 = clamp01(Number(state.social.norms.scarcityMindset ?? 0));
    let sm = sm0;
    // Mild natural decay so it eventually fades even if you hover around target.
    sm = clamp01(sm - dt * 0.0012);
    if (ratio < 0.90) {
      const deficit = clamp01((0.90 - ratio) / 0.90);
      sm = clamp01(sm + dt * (0.0038 + 0.0042 * deficit));
    } else if (ratio > 1.20) {
      const surplus = clamp01((ratio - 1.20) / 1.20);
      sm = clamp01(sm - dt * (0.0035 + 0.0040 * surplus));
    }
    state.social.norms.scarcityMindset = sm;

    const sBand = (sm < 0.25) ? 'calm' : (sm < 0.55) ? 'thrifty' : 'hoarding';
    if (sBand !== state.social.scarcityBand && (Number(state.t ?? 0) - state.social.scarcityLastAt) > 25) {
      state.social.scarcityBand = sBand;
      state.social.scarcityLastAt = Number(state.t ?? 0);
      if (sBand === 'thrifty') feed('Norms: lean times teach thrift. More food gets preserved for later.');
      else if (sBand === 'hoarding') feed('Norms: scarcity mindset hardens. Preserving rations becomes a reflex.');
      else feed('Norms: abundance returns. The colony relaxes its hoarding instinct.');
      state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
      state._trendEvents.push({ t: Number(state.t ?? 0), kind:'norm', label:`scar:${sBand}`, color:'rgba(34,197,94,.18)' });
      if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
    }

    // Norms: mutual aid (social culture) emerges from sustained social stress (dissent/grievance) and
    // gently increases willingness to organize (Socialize/Care).
    state.social.norms.mutualAid = clamp01(Number(state.social.norms.mutualAid ?? 0));
    state.social.mutualAidBand = String(state.social.mutualAidBand ?? 'atomized');
    state.social.mutualAidLastAt = Number(state.social.mutualAidLastAt ?? 0) || 0;

    const dis01 = clamp01(Number(state.social?.dissent ?? 0) / 100);
    let gAvg01 = 0;
    const kk = Array.isArray(state.kittens) ? state.kittens : [];
    if (kk.length) {
      let sum = 0;
      for (const k of kk) sum += clamp01(Number(k?.grievance ?? 0) / 100);
      gAvg01 = sum / kk.length;
    }
    const stress = Math.max(0, Math.max(dis01 - 0.35, gAvg01 - 0.35)); // 0..~0.65

    let ma = clamp01(Number(state.social.norms.mutualAid ?? 0));
    // Natural decay: fades over ~6-8 minutes if society is calm.
    ma = clamp01(ma - dt * 0.0018);
    if (stress > 0) {
      // Rises faster when society is clearly strained.
      ma = clamp01(ma + dt * (0.0026 + 0.0060 * clamp01(stress / 0.65)));
    } else if (dis01 < 0.22 && gAvg01 < 0.22) {
      // Calm periods actively unwind mutual-aid mobilization.
      ma = clamp01(ma - dt * 0.0022);
    }
    state.social.norms.mutualAid = ma;

    const mBand = (ma < 0.25) ? 'atomized' : (ma < 0.55) ? 'neighborly' : 'communal';
    if (mBand !== state.social.mutualAidBand && (Number(state.t ?? 0) - state.social.mutualAidLastAt) > 25) {
      state.social.mutualAidBand = mBand;
      state.social.mutualAidLastAt = Number(state.t ?? 0);
      if (mBand === 'neighborly') feed('Norms: in hard times, neighbors start to look out for each other.');
      else if (mBand === 'communal') feed('Norms: mutual aid becomes a default expectation. Organizers gain legitimacy.');
      else feed('Norms: the mutual-aid surge fades. People drift back into their own routines.');
      state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
      state._trendEvents.push({ t: Number(state.t ?? 0), kind:'norm', label:`aid:${mBand}`, color:'rgba(250,204,21,.18)' });
      if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
    }

    // Norms: punitive tolerance (culture memory about harsh governance).
    // Emerges from sustained dissent/grievance under harsh levers (low autonomy/high discipline/curfew).
    // Small, bounded effect: changes how *effective* Discipline is at suppressing dissent (see dissent model above).
    state.social.norms.punitiveTolerance = clamp01(Number(state.social.norms.punitiveTolerance ?? 0));
    state.social.punitiveBand = String(state.social.punitiveBand ?? 'lenient');
    state.social.punitiveLastAt = Number(state.social.punitiveLastAt ?? 0) || 0;

    const aut01 = clamp01(Number(state.director?.autonomy ?? 0.60));
    const disPol2 = discipline01(state);
    const dis01b = clamp01(Number(state.social?.dissent ?? 0) / 100);
    let gAvg01b = 0;
    const kk2 = Array.isArray(state.kittens) ? state.kittens : [];
    if (kk2.length) {
      let sum = 0;
      for (const k of kk2) sum += clamp01(Number(k?.grievance ?? 0) / 100);
      gAvg01b = sum / kk2.length;
    }

    const conflict = clamp01(Math.max(dis01b - 0.35, gAvg01b - 0.35) / 0.65);
    const harsh = clamp01((1 - aut01) * 0.65 + disPol2 * 0.55 + (state.director?.curfew ? 0.18 : 0));

    let ptv = clamp01(Number(state.social.norms.punitiveTolerance ?? 0));
    // Natural decay: fades over ~6-8 minutes if conditions soften.
    ptv = clamp01(ptv - dt * 0.0018);
    if (conflict > 0 && harsh > 0.2) {
      ptv = clamp01(ptv + dt * (0.0022 + 0.0060 * conflict) * harsh);
    } else if (conflict < 0.10 && aut01 > 0.65 && disPol2 < 0.45 && !state.director?.curfew) {
      // Calm + liberal governance actively unwind punitive reflexes.
      ptv = clamp01(ptv - dt * 0.0024);
    }
    state.social.norms.punitiveTolerance = ptv;

    const pBand = (ptv < 0.25) ? 'lenient' : (ptv < 0.55) ? 'firm' : 'punitive';
    if (pBand !== state.social.punitiveBand && (Number(state.t ?? 0) - state.social.punitiveLastAt) > 25) {
      state.social.punitiveBand = pBand;
      state.social.punitiveLastAt = Number(state.t ?? 0);
      if (pBand === 'firm') feed('Norms: people accept stricter measures. Order feels like a fair trade.');
      else if (pBand === 'punitive') feed('Norms: punitive justice takes root. Harsh governance feels normal.');
      else feed('Norms: tolerance for harshness fades. Mediation is preferred again.');
      state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
      state._trendEvents.push({ t: Number(state.t ?? 0), kind:'norm', label:`pun:${pBand}`, color:'rgba(248,113,113,.20)' });
      if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
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
    tryAdvanceRevealStage(state);
    tickPressures(dt);
    tickActivePlayEvents();

    // Trends sampling (charts): 1Hz, last ~2 minutes
    state._trend = state._trend ?? { t:[], food:[], warmth:[], threat:[], science:[], dissent:[] };
    state._trendAcc = Number(state._trendAcc ?? 0) + dt;
    if (state._trendAcc >= 1) {
      state._trendAcc -= 1;
      const tr = state._trend;
      tr.t.push(Number(state.t ?? 0));
      tr.food.push(Number(state.res?.food ?? 0));
      tr.warmth.push(Number(state.res?.warmth ?? 0));
      tr.threat.push(Number(state.res?.threat ?? 0));
      tr.science.push(Number(state.res?.science ?? 0));
      tr.dissent.push(Number(state.social?.dissent ?? 0));
      const MAX = 120;
      for (const k of ['t','food','warmth','threat','science','dissent']) {
        if (tr[k].length > MAX) tr[k].splice(0, tr[k].length - MAX);
      }
    }

    // Extra graphs: Population / Society / Culture+ML (sampled 1Hz, last ~2 minutes)
    state._popTrend = state._popTrend ?? { t:[], pop:[], cap:[], births:[], wander:[], ediblePk:[] };
    state._socTrend = state._socTrend ?? { t:[], mood:[], griev:[], dissent:[], compliance:[], threat:[], warmth:[], food:[], jerky:[], science:[] };
    state._culTrend = state._culTrend ?? { t:[], vig:[], scar:[], aid:[], coteries:[], influential:[], repAvg:[], mlLoss:[], mlFood:[], mlSafety:[], mlProg:[], mlSoc:[] };

      const pop = Number(state.kittens?.length ?? 0);
      const cap = housingCap(state);
      const births = Number(state._birthCt ?? 0);
      const wander = Number(state._wanderCt ?? 0);
      state._birthCt = 0; state._wanderCt = 0;

      const avgMood = pop ? (state.kittens.reduce((a,k)=>a + clamp01(Number(k.mood ?? 0.55)),0)/pop) : 0.55;
      const avgGriev = pop ? (state.kittens.reduce((a,k)=>a + clamp01(Number(k.grievance ?? 0)),0)/pop) : 0;
      const repAvg = (state.social?.coteries && Array.isArray(state.social.coteries) && state.social.coteries.length)
        ? (state.social.coteries.reduce((a,c)=>a + (Number(c.rep ?? 0) || 0),0) / state.social.coteries.length)
        : 0;
      const influ = (state.social?.coteries && Array.isArray(state.social.coteries))
        ? state.social.coteries.filter(c=>c && c.influential).length
        : 0;

      const tNow = Number(state.t ?? 0);
      state._popTrend.t.push(tNow);
      state._popTrend.pop.push(pop);
      state._popTrend.cap.push(cap);
      state._popTrend.births.push(births);
      state._popTrend.wander.push(wander);
      state._popTrend.ediblePk.push(ediblePerKitten(state));

      state._socTrend.t.push(tNow);
      state._socTrend.mood.push(avgMood);
      state._socTrend.griev.push(avgGriev);
      state._socTrend.dissent.push(Number(state.social?.dissent ?? 0));
      state._socTrend.compliance.push(compliance01(state));
      state._socTrend.threat.push(Number(state.res?.threat ?? 0));
      state._socTrend.warmth.push(Number(state.res?.warmth ?? 0));
      state._socTrend.food.push(Number(state.res?.food ?? 0));
      state._socTrend.jerky.push(Number(state.res?.jerky ?? 0));
      state._socTrend.science.push(Number(state.res?.science ?? 0));

      state._culTrend.t.push(tNow);
      state._culTrend.vig.push(Number(state.social?.norms?.raidParanoia ?? 0));
      state._culTrend.scar.push(Number(state.social?.norms?.scarcityMindset ?? 0));
      state._culTrend.aid.push(Number(state.social?.norms?.mutualAid ?? 0));
      state._culTrend.coteries.push((state.social?.coteries && Array.isArray(state.social.coteries)) ? state.social.coteries.length : 0);
      state._culTrend.influential.push(influ);
      state._culTrend.repAvg.push(repAvg);
      state._culTrend.mlLoss.push(Number(state.director?.ml?.lastLoss ?? 0));
      state._culTrend.mlFood.push(Number(state.director?.ml?.lastPred?.food ?? 0));
      state._culTrend.mlSafety.push(Number(state.director?.ml?.lastPred?.safety ?? 0));
      state._culTrend.mlProg.push(Number(state.director?.ml?.lastPred?.progress ?? 0));
      state._culTrend.mlSoc.push(Number(state.director?.ml?.lastPred?.social ?? 0));

      const MAX = 120;
      for (const store of [state._popTrend, state._socTrend, state._culTrend]) {
        for (const k of Object.keys(store)) {
          if (store[k].length > MAX) store[k].splice(0, store[k].length - MAX);
        }
      }

    // --- ML v1: online learned priority deltas (contextual linear model, deterministic)
    ensureCurator(state);
    state.director.ml = state.director.ml ?? {
      enabled: true,
      lr: 0.06,
      // weights per axis: [bias, winter, edibleDef, warmthDef, threatOver, dissent, housingCap]
      w: {
        food:    [0, 0, 0, 0, 0, 0, 0],
        safety:  [0, 0, 0, 0, 0, 0, 0],
        progress:[0, 0, 0, 0, 0, 0, 0],
        social:  [0, 0, 0, 0, 0, 0, 0],
      },
      lastPred: { food:0, safety:0, progress:0, social:0 },
      lastLoss: 0,
    };
    // Adaptive Safety (ML): tune ONLY numeric thresholds of a few safety rules (bounded).
    state.director.mlSafety = state.director.mlSafety ?? {
      enabled: true,
      lr: 0.18,
      last: { hungry:0.75, tired:0.88, warmth:35, threat:85 },
      lastWhy: '',
    };

    const ml = state.director.ml;
    if (ml.enabled && state.director?.curator?.enabled) {
      const season = seasonAt(state.t);
      const targets = seasonTargets(state);
      const pop = Math.max(1, Number(state.kittens?.length ?? 1));
      const ediblePk = ediblePerKitten(state);
      const edibleDef = clamp01((targets.foodPerKitten - ediblePk) / Math.max(1, targets.foodPerKitten));
      const warmthDef = clamp01((targets.warmth - Number(state.res?.warmth ?? 0)) / Math.max(1, targets.warmth));
      const threatOver = clamp01((Number(state.res?.threat ?? 0) - targets.maxThreat) / Math.max(1, targets.maxThreat));
      const diss = clamp01(Number(state.social?.dissent ?? 0));
      const houseCapped = (pop >= housingCap(state)) ? 1 : 0;
      const winter = (season.name === 'Winter') ? 1 : 0;
      const x = [1, winter, edibleDef, warmthDef, threatOver, diss, houseCapped];

      const dot = (w) => w.reduce((a,wi,i)=>a + wi * x[i], 0);
      const pred = {
        food: dot(ml.w.food),
        safety: dot(ml.w.safety),
        progress: dot(ml.w.progress),
        social: dot(ml.w.social),
      };

      // Targets (supervised): teach the model to map context -> sensible deltas.
      // This is ML, but still explainable and bounded.
      const g = String(state.director.curator.goal ?? 'Thrive');
      const goalBias = (axis) => {
        if (g === 'Defend') return axis === 'safety' ? 0.10 : axis === 'progress' ? -0.06 : 0;
        if (g === 'Innovate') return axis === 'progress' ? 0.12 : axis === 'food' ? -0.04 : 0;
        if (g === 'Expand') return axis === 'progress' ? 0.06 : axis === 'social' ? -0.05 : 0;
        if (g === 'Harmonize') return axis === 'social' ? 0.14 : axis === 'progress' ? -0.06 : 0;
        return 0;
      };

      const y = {
        food:      goalBias('food')      + 0.22 * edibleDef + 0.08 * warmthDef + 0.05 * threatOver,
        safety:    goalBias('safety')    + 0.20 * threatOver + 0.10 * warmthDef + 0.04 * diss,
        progress:  goalBias('progress')  + 0.16 * clamp01(1 - edibleDef*1.2) * clamp01(1 - threatOver*1.2) - 0.10 * warmthDef,
        social:    goalBias('social')    + 0.18 * diss - 0.08 * edibleDef,
      };

      const clampDelta = (v) => Math.max(-0.18, Math.min(0.18, Number(v) || 0));
      for (const k of Object.keys(pred)) pred[k] = clampDelta(pred[k]);

      // SGD update
      const lr = Math.max(0.0, Math.min(0.25, Number(ml.lr ?? 0.06)));
      let loss = 0;
      for (const axis of ['food','safety','progress','social']) {
        const err = (pred[axis] - clampDelta(y[axis]));
        loss += err*err;
        const w = ml.w[axis];
        for (let i=0;i<w.length;i++) w[i] -= lr * 2 * err * x[i];
      }
      ml.lastLoss = loss / 4;
      ml.lastPred = { ...pred };

      // Apply: base priorities + learned deltas
      const base = state.director._basePrio ?? { food: state.director.prioFood ?? 1, safety: state.director.prioSafety ?? 1, progress: state.director.prioProgress ?? 1, social: state.director.prioSocial ?? 1, doctrine: state.director.doctrine ?? 'Balanced' };
      const clampPr = (v) => Math.max(0.70, Math.min(1.45, Number(v) || 1));
      state.director.prioFood = clampPr(Number(base.food) + pred.food);
      state.director.prioSafety = clampPr(Number(base.safety) + pred.safety);
      state.director.prioProgress = clampPr(Number(base.progress) + pred.progress);
      state.director.prioSocial = clampPr(Number(base.social) + pred.social);

      // Adaptive Safety: tune the numeric thresholds of a few rules.
      const ms = state.director.mlSafety;
      if (ms?.enabled) {
        state._recentRaidTimer = Math.max(0, Number(state._recentRaidTimer ?? 0) - dt);

        // locate the canonical rules (by cond.type)
        const findRule = (type) => (state.rules || []).find(r => r?.cond?.type === type);
        const rHungry = findRule('hungry_gt');
        const rTired  = findRule('tired_gt');
        const rWarmth = findRule('warmth_lt');
        const rThreat = findRule('threat_gt_or_alarm');

        // current values
        const cur = {
          hungry: Number(rHungry?.cond?.v ?? 0.75),
          tired:  Number(rTired?.cond?.v ?? 0.88),
          warmth: Number(rWarmth?.cond?.v ?? 35),
          threat: Number(rThreat?.cond?.v ?? 85),
        };

        // context-derived desired values (bounded)
        const avgEnergy = state.kittens.length ? (state.kittens.reduce((a,k)=>a + clamp01(Number(k.energy ?? 1)),0) / state.kittens.length) : 1;
        const fatigue = clamp01(1 - avgEnergy);

        const hungryDes = 0.75 - 0.18*edibleDef + 0.06*clamp01((ediblePk - targets.foodPerKitten) / Math.max(1, targets.foodPerKitten));
        const tiredDes  = 0.88 - 0.14*fatigue;
        const warmthDes = 35 + 7*warmthDef + 4*winter;
        const raidBump  = (state._recentRaidTimer > 0) ? 0.6 : 0;
        const threatDes = 85 - 18*clamp01(threatOver + raidBump);

        const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)||0));
        const des = {
          hungry: clampTo(hungryDes, 0.55, 0.86),
          tired:  clampTo(tiredDes,  0.72, 0.95),
          warmth: clampTo(warmthDes, 28,   46),
          threat: clampTo(threatDes, 60,   90),
        };

        // low-frequency update (every ~8s) to keep it legible
        ms._t = Number(ms._t ?? 0) + dt;
        if (ms._t >= 8) {
          ms._t = 0;
          const lrS = clampTo(ms.lr ?? 0.18, 0.02, 0.35);
          const next = {
            hungry: cur.hungry + (des.hungry - cur.hungry) * lrS,
            tired:  cur.tired  + (des.tired  - cur.tired)  * lrS,
            warmth: cur.warmth + (des.warmth - cur.warmth) * lrS,
            threat: cur.threat + (des.threat - cur.threat) * lrS,
          };

          // apply if rules exist
          const setIf = (ruleObj, val) => { if (ruleObj?.cond) ruleObj.cond.v = val; };
          setIf(rHungry, clampTo(next.hungry, 0.55, 0.86));
          setIf(rTired,  clampTo(next.tired,  0.72, 0.95));
          setIf(rWarmth, clampTo(next.warmth, 28,   46));
          setIf(rThreat, clampTo(next.threat, 60,   90));

          // log only meaningful changes
          const fmt2 = (v)=>Number(v).toFixed(2);
          const changes = [];
          const pushCh = (name, a, b) => { if (Math.abs(a-b) >= 0.02) changes.push(`${name} ${fmt2(a)}?${fmt2(b)}`); };
          pushCh('hungry>', cur.hungry, rHungry?.cond?.v ?? cur.hungry);
          pushCh('tired>',  cur.tired,  rTired?.cond?.v ?? cur.tired);
          pushCh('warmth<', cur.warmth, rWarmth?.cond?.v ?? cur.warmth);
          pushCh('threat>', cur.threat, rThreat?.cond?.v ?? cur.threat);
          if (changes.length) {
            const why = edibleDef > 0.35 ? 'food deficit' : threatOver > 0.25 ? 'threat pressure' : warmthDef > 0.25 ? 'cold risk' : fatigue > 0.55 ? 'fatigue' : 'stability tuning';
            ms.lastWhy = why;
            feed(`Learned safety: ${changes.slice(0,3).join(' | ')} (${why}).`);
          }

          ms.last = {
            hungry: Number(rHungry?.cond?.v ?? cur.hungry),
            tired:  Number(rTired?.cond?.v ?? cur.tired),
            warmth: Number(rWarmth?.cond?.v ?? cur.warmth),
            threat: Number(rThreat?.cond?.v ?? cur.threat),
          };
        }
      }
    }

    state._decTimer = (state._decTimer ?? 0) + dt;
    if (state._decTimer >= 1) {
      state._decTimer -= 1;
      runDecisionSecond(state, {
        ensureBuddies,
        desiredWorkerPlan,
        updateRoles,
        makeShadowAvail,
        decideTask,
        updateMoodPerSecond,
        updateGrievancePerSecond,
        updateBuddyNeedPerSecond,
        updateValuesPerSecond,
        commitSecondsForTask,
        reserveForTask,
        onTaskSwitch: logTaskSwitch,
      });

      // Aquarium depth: let "coteries" form/shift based on repeated co-work, not just static buddy links.
      updateSharedWorkEdgesPerSecond(state);
      updateRecentWorkMemoryPerSecond(state);
      tickTraitEvents(state);
    }

    runKittensTick(state, dt, {
      taskDefs,
      edibleFood,
      log,
      pinnedProjectInfo,
      clearPinnedProject,
      onKittenTick: (s, k, tickDt, prevHealth) => {
        trackActivityTime(k, k.task, tickDt);
        logHealthEvent(k, prevHealth, Number(k.health ?? 1));
      },
    });

    // Explainability: maintain smoothed deltas (not saved)
    updateRates(state, dt);
    updateProjectRates(state, dt);

    // Milestones: persisted unlock history + short inline celebration bursts.
    tickMilestones(state);

    // Transient trend sampling (for per-kitten graphs — stripped on save)
    state._trendTimer = (state._trendTimer ?? 0) + dt;
    if (state._trendTimer >= 10) {
      state._trendTimer = 0;
      const TREND_MAX = 60;
      for (const k of state.kittens) {
        // Skill trend: category skill levels snapshot
        if (!Array.isArray(k._skillTrend)) k._skillTrend = [];
        const snap = {};
        for (const cat of Object.keys(SKILL_CATEGORIES)) snap[cat] = Number(k.skills?.[cat] ?? 1);
        k._skillTrend.push({ t: state.t, ...snap });
        if (k._skillTrend.length > TREND_MAX) k._skillTrend.splice(0, k._skillTrend.length - TREND_MAX);
      }
    }
    state._vitalTimer = (state._vitalTimer ?? 0) + dt;
    if (state._vitalTimer >= 2) {
      state._vitalTimer = 0;
      const VITAL_MAX = 60;
      for (const k of state.kittens) {
        if (!Array.isArray(k._vitalsTrend)) k._vitalsTrend = [];
        k._vitalsTrend.push({ t: state.t, mood: +k.mood.toFixed(3), energy: +k.energy.toFixed(3), health: +(k.health ?? 1).toFixed(3), hunger: +k.hunger.toFixed(3) });
        if (k._vitalsTrend.length > VITAL_MAX) k._vitalsTrend.splice(0, k._vitalsTrend.length - VITAL_MAX);
      }
    }

    // Autosave
    state._saveTimer = (state._saveTimer ?? 0) + dt;
    if (state._saveTimer >= 2) { state._saveTimer = 0; save(); }
  }

  // --- Offline gains (incremental QoL)
  // On load, simulate some time passage based on last real-world save timestamp.
  // Cap is intentionally small to prevent huge log spam or runaway spirals.
  function applyOfflineProgressOnce(){
    state.meta = state.meta ?? { version: GAME_VERSION, seenVersion: '', lastTs: 0, revealStage: 0 };
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

  // --- UI
  const el = (id) => document.getElementById(id);
  const statsEl = el('stats');
  const kittenGridEl = el('kittenGrid');
  const colonySortKeyEl = el('colonySortKey');
  const colonySortDirEl = el('colonySortDir');
  const colonyFilterEl = el('colonyFilter');
  const colonyCountEl = el('colonyCount');

  const rulesEl = el('rules');
  const logEl = el('log');
  const goalsEl = el('goals');
  const advisorEl = el('advisor');
  const govLogEl = el('govlog');
  const councilPanelEl = el('council');
  const factionsEl = el('factions');
  const blocHealthEl = el('blocHealth');
  const unlocksEl = el('unlocks');
  const seasonEl = el('season');
  const policyEl = el('policy');
  const roleQuotasEl = el('roleQuotas');
  const planDebugEl = el('planDebug');
  const projectsEl = el('projects');
  const profilesEl = el('profiles');
  const profilesHintEl = el('profilesHint');

  // Curator controls (aquarium mode)
  const curatorGoalEl = el('curatorGoal');
  const curatorEthosEl = el('curatorEthos');
  const curatorInterventionEl = el('curatorIntervention');
  const curatorInterventionHintEl = el('curatorInterventionHint');
  const steeringSummaryEl = el('steeringSummary');
  const devModeEl = el('devMode');
  const advancedControlsEl = el('advancedControls');
  const feedEl = el('feed');
  const tankEl = el('tank');
  const trendsEl = el('trends');  const popTrendsEl = el('popTrends');  const socTrendsEl = el('socTrends');  const socLegendEl = el('socLegend');  const socHintEl = el('socHint');  const culTrendsEl = el('culTrends');
  const trendTabRailEl = el('trendTabRail');
  const trendTabButtons = Array.from(document.querySelectorAll('[data-trend-tab]'));
  const trendPanels = Array.from(document.querySelectorAll('[data-trend-panel]'));
  const trendsLegendEl = el('trendsLegend');
  const mlHintEl = el('mlHint');

  function ensureCurator(s){
    s.director = s.director ?? {};
    if (!s.director.curator || typeof s.director.curator !== 'object') s.director.curator = { goal:'Thrive', ethos:'Balanced', intervention: 30, enabled:true, devMode:false, appliedOnce:false, revealAdvanced:false, advancedRevealNoted:false };
    const c = s.director.curator;
    if (!('devMode' in c)) c.devMode = false;
    const goal = String(c.goal ?? 'Thrive');
    c.goal = ['Thrive','Expand','Defend','Innovate','Harmonize'].includes(goal) ? goal : 'Thrive';
    const ethos = String(c.ethos ?? 'Balanced');
    c.ethos = ['Gentle','Balanced','Strict'].includes(ethos) ? ethos : 'Balanced';
    c.intervention = Math.max(0, Math.min(100, Number(c.intervention ?? 30) || 30));
    if (!('enabled' in c)) c.enabled = true;
    if (!('devMode' in c)) c.devMode = false;
    if (!('appliedOnce' in c)) c.appliedOnce = false;
    if (!('revealAdvanced' in c)) c.revealAdvanced = false;
    if (!('advancedRevealNoted' in c)) c.advancedRevealNoted = false;
  }

  function ensureGraphDashboard(s){
    s.director = s.director ?? {};
    const tab = String(s.director.graphTab ?? 'society').toLowerCase();
    s.director.graphTab = (tab === 'population' || tab === 'society' || tab === 'culture') ? tab : 'society';
  }

  function setGraphDashboardTab(tab){
    ensureGraphDashboard(state);
    const v = String(tab ?? '').toLowerCase();
    if (v !== 'population' && v !== 'society' && v !== 'culture') return;
    if (state.director.graphTab === v) return;
    state.director.graphTab = v;
    save();
    render();
  }

  function syncGraphDashboardUI(){
    ensureGraphDashboard(state);
    const active = String(state.director.graphTab ?? 'society');

    for (const btn of trendTabButtons){
      const tab = String(btn?.dataset?.trendTab ?? '').toLowerCase();
      const on = tab === active;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.setAttribute('tabindex', on ? '0' : '-1');
    }

    for (const panel of trendPanels){
      const tab = String(panel?.dataset?.trendPanel ?? '').toLowerCase();
      panel.classList.toggle('active', tab === active);
    }
  }

  function applyCuratorEthos(s){
    ensureCurator(s);
    const ethos = String(s.director.curator.ethos);
    if (ethos === 'Gentle') { s.director.discipline = 0.30; s.director.autonomy = 0.75; }
    else if (ethos === 'Strict') { s.director.discipline = 0.65; s.director.autonomy = 0.45; }
    else { s.director.discipline = 0.40; s.director.autonomy = 0.60; }
  }

  function applyCuratorGoal(s){
    ensureCurator(s);
    const g = String(s.director.curator.goal);

    // Default: aquarium behavior = mostly self-sustaining
    s.director.autoWinterPrep = true;
    s.director.autoFoodCrisis = true;
    s.director.autoReserves = true;
    s.director.autoPolicy = true;
    s.director.autoMode = true;
    s.director.autoDoctrine = true;
    s.director.autoRations = true;
    s.director.autoRecruit = true;
    s.director.autoCrisis = true;

    // Curator base priorities (ML deltas add on top)
    const setBase = (pFood,pSafety,pProg,pSoc, doctrine, mode) => {
      s.mode = mode;
      s.director._basePrio = { food:pFood, safety:pSafety, progress:pProg, social:pSoc, doctrine };
      s.director.prioFood = pFood; s.director.prioSafety = pSafety; s.director.prioProgress = pProg; s.director.prioSocial = pSoc;
      s.director.doctrine = doctrine;
    };

    if (g === 'Expand') {
      setBase(1.05, 0.95, 1.10, 0.90, 'Specialize', 'Expand');
    } else if (g === 'Defend') {
      setBase(1.00, 1.25, 0.90, 0.85, 'Balanced', 'Defend');
    } else if (g === 'Innovate') {
      setBase(0.95, 1.00, 1.30, 0.90, 'Specialize', 'Advance');
    } else if (g === 'Harmonize') {
      setBase(1.05, 1.00, 0.85, 1.35, 'Rotate', 'Survive');
    } else {
      // Thrive
      setBase(1.15, 1.05, 0.95, 1.15, 'Balanced', 'Survive');
    }

    applyCuratorEthos(s);
  }

  function setCuratorGoal(goal){
    ensureCurator(state);
    state.director.curator.goal = String(goal || 'Thrive');
    state.director.curator.appliedOnce = true;
    applyCuratorGoal(state);

    state._trendEvents = Array.isArray(state._trendEvents) ? state._trendEvents : [];
    state._trendEvents.push({ t: Number(state.t ?? 0), kind:'curator', label:`goal:${state.director.curator.goal}`, color:'rgba(251,191,36,.18)' });
    if (state._trendEvents.length > 80) state._trendEvents.splice(0, state._trendEvents.length - 80);
  }
  function setCuratorEthos(ethos){
    ensureCurator(state);
    state.director.curator.ethos = String(ethos || 'Balanced');
    state.director.curator.appliedOnce = true;
    applyCuratorEthos(state);
  }
  function setCuratorIntervention(v){
    ensureCurator(state);
    state.director.curator.intervention = Math.max(0, Math.min(100, Number(v) || 0));
  }

  function getSteeringSummary(s){
    if (!s) return '';
    const c = s.director?.curator;
    const curatorOn = !!(c && c.enabled);
    const head = curatorOn ? `Steering: Curator (${String(c.goal ?? 'Thrive')} / ${String(c.ethos ?? 'Balanced')})` : 'Steering: manual';
    const bits = [];
    const push = (label, why) => { const w = String(why ?? '').trim(); if (w) bits.push(`${label}: ${w}`); };
    push('Auto mode', s.director?.autoModeWhy);
    push('Auto policy', s.director?.autoPolicyWhy);
    push('Auto doctrine', s.director?.autoDoctrineWhy);
    push('Auto rations', s.director?.autoRationsWhy);
    push('Auto crisis', s.director?.autoCrisisWhy);

    const ml = s.director?.ml;
    const mlOn = !!ml?.enabled;
    const mlNote = mlOn ? ` | ML: ON (r=${Number(ml.lastLoss ?? 0).toFixed(3)})` : '';

    return head + (bits.length ? ` � ${bits.slice(0,2).join(' | ')}` : '') + mlNote;
  }

  // Ensure curator defaults exist; if this save hasn't seen curator mode yet, apply once.
  ensureCurator(state);
  ensureGraphDashboard(state);
  if (state.director?.curator?.enabled && !state.director.curator.appliedOnce) {
    applyCuratorGoal(state);
    state.director.curator.appliedOnce = true;
    save();
  }

  const curatorUI = initCuratorControls({
    goalEl: curatorGoalEl,
    ethosEl: curatorEthosEl,
    interventionEl: curatorInterventionEl,
    interventionHintEl: curatorInterventionHintEl,
    steeringSummaryEl,
    getState: () => state,
    setGoal: setCuratorGoal,
    setEthos: setCuratorEthos,
    setIntervention: setCuratorIntervention,
    log,
    save,
    render,
    getSteeringSummary,
  });

  // Progressive disclosure: keep advanced controls hidden on fresh saves,
  // then reveal after first unlock or ~2 minutes. Developer Mode still forces visibility.
  function hasAnyKnowledgeUnlock(s){
    const seen = s?.seenUnlocks ?? {};
    if (Object.keys(seen).some((k) => !!seen[k])) return true;
    const u = s?.unlocked ?? {};
    return !!(u.construction || u.workshop || u.farm || u.security || u.granary || u.library);
  }
  function syncDevMode(){
    ensureCurator(state);
    const c = state.director.curator;
    const on = !!c.devMode;
    if (devModeEl) devModeEl.checked = on;

    const shouldReveal = !!c.revealAdvanced || hasAnyKnowledgeUnlock(state) || Number(state.t ?? 0) >= 120;
    if (shouldReveal && !c.revealAdvanced) {
      c.revealAdvanced = true;
      save();
    }
    if (c.revealAdvanced && !c.advancedRevealNoted) {
      c.advancedRevealNoted = true;
      feed('Advanced controls unlocked. Open "Advanced controls (optional)" if you want deeper policy tools.');
    }

    if (advancedControlsEl) advancedControlsEl.style.display = (on || c.revealAdvanced) ? '' : 'none';
  }
  if (devModeEl) devModeEl.addEventListener('change', () => {
    ensureCurator(state);
    state.director.curator.devMode = !!devModeEl.checked;
    log(`Developer Mode ? ${state.director.curator.devMode ? 'ON' : 'OFF'}`);
    save();
    render();
  });
  syncDevMode();

  if (trendTabRailEl) {
    trendTabRailEl.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-trend-tab]');
      if (!btn) return;
      setGraphDashboardTab(btn.dataset?.trendTab);
    });
  }

  function initMobileLayoutControls(){
    const mobileMq = (typeof window.matchMedia === 'function')
      ? window.matchMedia('(max-width: 479px)')
      : null;
    const isMobile = () => {
      if (mobileMq && mobileMq.matches) return true;
      const vv = Number(window.visualViewport?.width || 0);
      const iw = Number(window.innerWidth || 0);
      const cw = Number(document.documentElement?.clientWidth || 0);
      const width = Math.min(...[vv, iw, cw].filter((v) => Number.isFinite(v) && v > 0));
      return (Number.isFinite(width) ? width : iw) <= 479;
    };
    const accordionIds = ['directorSection', 'colonySection', 'safetySection'];
    const storageKey = 'kkc_mobile_accordion_v1';
    const cards = accordionIds
      .map((id) => document.getElementById(id))
      .filter((node) => !!node);

    let persisted = {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) persisted = JSON.parse(raw) || {};
    } catch (_err) { persisted = {}; }

    const getCardHeading = (card) => {
      if (!card) return null;
      const first = card.firstElementChild;
      if (first && first.tagName === 'H2') return first;
      return card.querySelector('h2');
    };

    const setExpanded = (card, heading) => {
      if (!heading) return;
      heading.setAttribute('aria-expanded', card.classList.contains('is-collapsed') ? 'false' : 'true');
    };

    const persist = () => {
      const next = {};
      for (const card of cards) next[card.id] = !card.classList.contains('is-collapsed');
      try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch (_err) {}
      persisted = next;
    };

    for (const card of cards){
      const heading = getCardHeading(card);
      if (!heading) continue;
      heading.setAttribute('role', 'button');
      heading.setAttribute('tabindex', '0');
      heading.addEventListener('click', () => {
        if (!isMobile()) return;
        card.classList.toggle('is-collapsed');
        setExpanded(card, heading);
        persist();
      });
      heading.addEventListener('keydown', (ev) => {
        if (!isMobile()) return;
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        card.classList.toggle('is-collapsed');
        setExpanded(card, heading);
        persist();
      });
    }

    const apply = () => {
      const mobile = isMobile();
      document.body.classList.toggle('mobile-accordion', mobile);
      for (const card of cards){
        const heading = getCardHeading(card);
        if (!mobile) {
          card.classList.remove('is-collapsed');
          setExpanded(card, heading);
          continue;
        }
        const open = Object.prototype.hasOwnProperty.call(persisted, card.id)
          ? !!persisted[card.id]
          : card.id === 'directorSection';
        card.classList.toggle('is-collapsed', !open);
        setExpanded(card, heading);
      }
      if (mobile) persist();
    };

    apply();
    const listener = () => apply();
    if (mobileMq) {
      if (typeof mobileMq.addEventListener === 'function') mobileMq.addEventListener('change', listener);
      else mobileMq.addListener(listener);
    } else {
      window.addEventListener('resize', listener);
    }

    const overflow = document.getElementById('headerOverflow');
    if (overflow) {
      document.addEventListener('click', (ev) => {
        if (!overflow.open) return;
        if (overflow.contains(ev.target)) return;
        overflow.open = false;
      });
      overflow.addEventListener('click', (ev) => {
        const btn = ev.target?.closest?.('button');
        if (btn) overflow.open = false;
      });
    }
  }
  initMobileLayoutControls();

  // Inspector modals are initialized later once their DOM nodes exist.
  // These wrappers let other UI (stat cards, Escape key) call them safely.
  // These wrappers let other UI (stat cards, Escape key) call them safely.
  let societyUI = null;
  function openSocial(){ societyUI?.openSocial?.(); }
  function closeSocial(){ societyUI?.closeSocial?.(); }
  function openStorage(){ societyUI?.openStorage?.(); }
  function closeStorage(){ societyUI?.closeStorage?.(); }
  function openThreat(){ societyUI?.openThreat?.(); }
  function closeThreat(){ societyUI?.closeThreat?.(); }

  function openCulture(){ societyUI?.openCulture?.(); }
  function closeCulture(){ societyUI?.closeCulture?.(); }

  // Transient UI state + small listeners (sorting, debounced UI logs, stat-card clicks)
  const { uiSort, uiFilter, uiDebouncedLog, colonyCountEl: _ccEl } = initUI({
    statsEl,
    kittensTableEl: null,
    colonySortKeyEl,
    colonySortDirEl,
    colonyFilterEl,
    colonyCountEl,
    log,
    save,
    render,
    openSocial,
    openStorage,
    openThreat,
    openCulture,
  });

  // Trends: marker legend + filter (culture beats timeline)
  function ensureTrendMarkerFilter(s){
    s.ui = (s.ui && typeof s.ui === 'object') ? s.ui : {};
    s.ui.trendMarkerFilter = (s.ui.trendMarkerFilter && typeof s.ui.trendMarkerFilter === 'object') ? s.ui.trendMarkerFilter : {};
    const f = s.ui.trendMarkerFilter;
    for (const k of ['norm','cot','trad','eth','rep','press','rel','rit']) {
      if (!(k in f)) f[k] = true;
      f[k] = !!f[k];
    }
    return f;
  }

  function renderTrendsLegend(){
    if (!trendsLegendEl) return;
    const f = ensureTrendMarkerFilter(state);
    const chip = (c) => `<span style="display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; border:1px solid rgba(255,255,255,.12); background:${c}"></span>`;
    const item = (k, label, color, title) => {
      const on = !!f[k];
      return `<label class="small" style="display:inline-flex; align-items:center; gap:6px; margin-right:10px; cursor:pointer; opacity:${on?1:0.55}" title="${title||''}">` +
        `<input type="checkbox" data-tmf="${k}" ${on?'checked':''} style="transform:translateY(1px)">` +
        `${chip(color)}${label}</label>`;
    };

    const html = [
      `<span class="small" style="opacity:.85; margin-right:10px">markers:</span>`,
      item('norm','norm','rgba(34,197,94,.11)','Culture memory / norms band flips (vig/scar/aid/pun).'),
      item('cot','cot','rgba(253,186,116,.18)','Coterie becomes influential.'),
      item('trad','trad','rgba(56,189,248,.14)','Coterie tradition shift (shared work).'),
      item('eth','eth','rgba(167,139,250,.14)','Coterie ethos drift (mutual aid ↔ strictness).'),
      item('rep','rep','rgba(148,163,184,.10)','Coterie reputation (respected/resented).'),
      item('press','press','rgba(251,113,133,.14)','Short-lived culture pressure window (aid/strict).'),
      item('rit','rit','rgba(99,102,241,.12)','Short-lived culture ritual window (story-circle / work-oath).'),
      item('rel','rel','rgba(244,114,182,.14)','Buddy relationship beats (drift/reconnect).'),
      `<button class="btn" data-tmf-all="1" style="padding:2px 8px; margin-left:6px">All</button>`,
      `<button class="btn" data-tmf-none="1" style="padding:2px 8px">None</button>`,
    ].join('');

    trendsLegendEl.innerHTML = html;
  }

  if (trendsLegendEl) {
    trendsLegendEl.addEventListener('change', (e) => {
      const cb = e.target?.closest?.('input[data-tmf]');
      if (!cb) return;
      const k = String(cb.dataset.tmf || '');
      const f = ensureTrendMarkerFilter(state);
      if (!(k in f)) return;
      f[k] = !!cb.checked;
      save();
      render();
    });
    trendsLegendEl.addEventListener('click', (e) => {
      const allBtn = e.target?.closest?.('button[data-tmf-all]');
      const noneBtn = e.target?.closest?.('button[data-tmf-none]');
      if (!allBtn && !noneBtn) return;
      const f = ensureTrendMarkerFilter(state);
      for (const k of Object.keys(f)) f[k] = !!allBtn;
      save();
      render();
    });
  }

  // Trends marker tooltips (hover: label + time)
  // Goal: make culture-beat markers self-explanatory without clicks or feed scrolling.
  const trendsTipEl = (() => {
    if (!trendsEl) return null;
    const d = document.createElement('div');
    d.style.position = 'fixed';
    d.style.zIndex = '9999';
    d.style.pointerEvents = 'none';
    d.style.padding = '5px 7px';
    d.style.borderRadius = '10px';
    d.style.border = '1px solid rgba(255,255,255,.14)';
    d.style.background = 'rgba(2,6,23,.92)';
    d.style.color = 'rgba(226,232,240,.98)';
    d.style.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    // Allow wrapping for long marker labels.
    d.style.whiteSpace = 'normal';
    d.style.maxWidth = '280px';
    d.style.lineHeight = '1.25';
    d.style.display = 'none';
    document.body.appendChild(d);
    return d;
  })();

  function hideTrendsTip(){
    if (!trendsTipEl) return;
    trendsTipEl.style.display = 'none';
  }

  function formatMarkerKind(kind){
    const k = String(kind || '');
    if (k === 'norm') return 'Norms';
    if (k === 'cot') return 'Coterie';
    if (k === 'trad') return 'Tradition';
    if (k === 'eth') return 'Ethos';
    if (k === 'rep') return 'Reputation';
    if (k === 'press') return 'Pressure';
    if (k === 'rit') return 'Ritual';
    if (k === 'rel') return 'Relationship';
    if (k === 'bloc') return 'Politics';
    if (k === 'raid') return 'Raid';
    if (k === 'unlock') return 'Unlock';
    if (k === 'season') return 'Season';
    if (k === 'curator') return 'Curator';
    return k || 'Event';
  }

  function pickTrendsMarkerAtCanvasX(xCanvas){
    const tr = state._trend;
    if (!tr || !tr.t || tr.t.length < 2) return null;
    const n = tr.t.length;
    const pad = 10;
    const W = trendsEl?.width ?? 0;
    const plotW = W - pad*2;
    if (plotW <= 0) return null;

    const ev = Array.isArray(state._trendEvents) ? state._trendEvents : [];
    const tMin = tr.t[0];
    const tMax = tr.t[n-1];
    const xForT = (t) => pad + ((t - tMin) / Math.max(1e-6, (tMax - tMin))) * plotW;

    const mf = ensureTrendMarkerFilter(state);

    const cultureKinds = new Set(['norm','cot','trad','eth','rep','press','rel']);
    // Priority: culture beats > everything else, so aquarium markers win ties.
    const kindPriority = (kind) => cultureKinds.has(kind) ? 5 : 1;

    let best = null;
    let bestDx = Infinity;
    let bestPri = -Infinity;
    let near = [];

    for (const e of ev) {
      const kind = String(e.kind ?? '');
      if (cultureKinds.has(kind) && !mf[kind]) continue;
      const tt = Number(e.t ?? NaN);
      if (!Number.isFinite(tt) || tt < tMin || tt > tMax) continue;
      const dx = Math.abs(xForT(tt) - xCanvas);
      if (dx <= 7) near.push({ e, dx, pri: kindPriority(kind) });

      // Primary selection favors priority first, then closeness.
      const pri = kindPriority(kind);
      if (pri > bestPri || (pri === bestPri && dx < bestDx)) {
        bestPri = pri;
        bestDx = dx;
        best = e;
      }
    }

    if (!best || bestDx > 7) return null;

    // Multi-marker disambiguation: count how many are "effectively the same line".
    // Use a tighter radius so we don't over-count.
    const close = near.filter(x => x.dx <= 5);
    const moreCount = Math.max(0, close.length - 1);
    return { marker: best, moreCount };
  }

  if (trendsEl && trendsTipEl) {
    trendsEl.addEventListener('mouseleave', hideTrendsTip);
    trendsEl.addEventListener('mousemove', (ev) => {
      const rect = trendsEl.getBoundingClientRect();
      const W = trendsEl.width;
      const xCanvas = (ev.clientX - rect.left) * (W / Math.max(1, rect.width));

      const pick = pickTrendsMarkerAtCanvasX(xCanvas);
      if (!pick) return hideTrendsTip();
      const m = pick.marker;

      const kind = formatMarkerKind(m.kind);
      const label = String(m.label ?? '').trim();
      const age = Math.max(0, Number(state.t ?? 0) - Number(m.t ?? 0));
      const ageStr = (age < 120) ? `${Math.round(age)}s ago` : `${fmt(age)}s ago`;
      const more = pick.moreCount > 0 ? ` · +${pick.moreCount} more` : '';

      const chipColor = String(m.color || 'rgba(255,255,255,.25)');
      const labelHtml = label ? `<span style="opacity:.92">${escapeHtml(label)}</span>` : '';
      const txtHtml = label
        ? `<span style="opacity:.95">${escapeHtml(kind)}:</span> ${labelHtml} <span style="opacity:.72">· ${escapeHtml(ageStr)}${escapeHtml(more)}</span>`
        : `<span style="opacity:.95">${escapeHtml(kind)}</span> <span style="opacity:.72">· ${escapeHtml(ageStr)}${escapeHtml(more)}</span>`;

      trendsTipEl.innerHTML = `<span style="display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; border:1px solid rgba(255,255,255,.14); background:${chipColor}; vertical-align:-1px"></span>` + txtHtml;
      trendsTipEl.style.display = '';
      // Position near cursor but keep on-screen.
      const margin = 12;
      const w = trendsTipEl.offsetWidth;
      const h = trendsTipEl.offsetHeight;
      const x = Math.min(window.innerWidth - w - 6, Math.max(6, ev.clientX + margin));
      const y = Math.min(window.innerHeight - h - 6, Math.max(6, ev.clientY + margin));
      trendsTipEl.style.left = x + 'px';
      trendsTipEl.style.top = y + 'px';
    });
  }

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

  // Governance log (explainability): record policy changes driven by automation/politics.
  // Save-safe: stored under director.govLog.
  function ensureGovLog(s){
    s.director = s.director ?? {};
    if (!Array.isArray(s.director.govLog)) s.director.govLog = [];
  }

  function recordGovLog(s, entry){
    ensureGovLog(s);
    const e = entry && typeof entry === 'object' ? entry : { kind:'Note', why:String(entry || '') };
    const nowT = Number(s?.t ?? 0) || 0;
    const kind = String(e.kind ?? 'Note');

    const row = {
      at: nowT,
      kind,
      why: String(e.why ?? ''),
      changes: Array.isArray(e.changes) ? e.changes.slice(0, 10).map(String) : [],
    };

    // Coalesce spam: if the last entry is the same kind and very recent, overwrite it.
    const arr = s.director.govLog;
    const last = arr.length ? arr[arr.length - 1] : null;
    if (last && String(last.kind ?? '') === kind && Math.abs((Number(last.at ?? 0) || 0) - nowT) <= 12) {
      arr[arr.length - 1] = row;
    } else {
      arr.push(row);
      // Keep only the most recent N.
      while (arr.length > 12) arr.shift();
    }
  }

  function renderGovLog(s){
    if (!govLogEl) return;
    ensureGovLog(s);

    const arr = (s.director.govLog ?? []).slice().reverse();
    if (!arr.length) {
      govLogEl.textContent = '— No governance events yet. Turn on Auto Policy or negotiate with a faction to see entries.';
      return;
    }

    const lines = [];
    for (const e of arr) {
      const at = Number(e.at ?? 0) || 0;
      const head = `[t+${fmt(at)}s] ${String(e.kind ?? 'Note')}`;
      const why = String(e.why ?? '').trim();
      const changes = Array.isArray(e.changes) ? e.changes : [];

      lines.push(head + (why ? ` — ${why}` : ''));
      for (const ch of changes.slice(0, 6)) lines.push(`  - ${ch}`);
    }

    govLogEl.textContent = lines.join('\n');
  }

  // Policy undo (player QoL): restore last manual policy/role-quota change.
  // Stored in save (director.policyUndo) but expires quickly so it doesn't become a time-travel mechanic.
  function recordPolicyUndo(s, reason){
    s.director = s.director ?? {};
    // Keep this migration-safe: missing keys are fine.
    const snap = {
      at: Number(s.t ?? 0) || 0,
      reason: String(reason || 'manual change'),
      policyMult: { ...(s.policyMult ?? {}) },
      roleQuota: { ...(s.roleQuota ?? {}) },
    };
    s.director.policyUndo = snap;
  }

  function policyUndoInfo(s){
    const u = s?.director?.policyUndo;
    if (!u) return { ok:false, left:0, reason:'' };
    const at = Number(u.at ?? 0);
    if (!Number.isFinite(at)) return { ok:false, left:0, reason:'' };
    const ttl = 120;
    const left = Math.max(0, ttl - (Number(s?.t ?? 0) - at));
    return { ok: left > 0 && !!u.policyMult, left, reason: String(u.reason || '') };
  }

  function applyPolicyUndo(s){
    const info = policyUndoInfo(s);
    if (!info.ok) return { ok:false, msg:'Policy undo expired (or nothing to undo).' };
    const u = s.director.policyUndo;
    if (u?.policyMult) s.policyMult = { ...(u.policyMult ?? {}) };
    if (u?.roleQuota) s.roleQuota = { ...(u.roleQuota ?? {}) };
    s.director.policyUndo = null;
    return { ok:true, msg:`Policy undo: restored previous policy snapshot${info.reason ? ` (${info.reason})` : ''}.` };
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
    // Demand resolution (accept/ignore)
    const dBtn = e.target?.closest?.('button[data-demand]');
    if (dBtn) {
      const act = String(dBtn.dataset.demand || '');
      const accept = (act === 'accept');
      const res = resolveFactionDemand(state, accept);
      if (res?.msg) log(res.msg);
      save();
      render();
      return;
    }

    // Undo last negotiation (short window)
    const undoBtn = e.target?.closest?.('button[data-faction-undo]');
    if (undoBtn) {
      const res = undoFactionNegotiation(state);
      if (res?.msg) log(res.msg);
      save();
      render();
      return;
    }

    // Normal negotiation
    const btn = e.target?.closest?.('button[data-faction]');
    if (!btn) return;
    const axis = String(btn.dataset.faction || '');

    // Optional confirmation: politics is a drift lever, and undo has a timer.
    // This reduces "oops" clicks without slowing down players who want fast iteration.
    state.director = state.director ?? {};
    if (!('confirmFactions' in state.director)) state.director.confirmFactions = true;

    if (state.director.confirmFactions) {
      try {
        const preview = {
          t: Number(state.t ?? 0) || 0,
          director: structuredClone(state.director ?? {}),
          policyMult: structuredClone(state.policyMult ?? {}),
          social: structuredClone(state.social ?? {}),
        };
        const p = negotiateWithFaction(preview, axis, { ignoreCooldown:true, govKind:'Preview', govWhy:'', reason:`preview ${axis}` });
        const msg = (p && p.msg) ? String(p.msg) : `Negotiate with ${axis} bloc?`;
        const ok = confirm(`Confirm faction negotiation?\n\n${msg}\n\nThis will drift priorities/policy. You can Undo once for ~120s.`);
        if (!ok) return;
      } catch (e) {
        // If preview fails for any reason, fall back to a simple confirm.
        const ok = confirm(`Confirm faction negotiation with the ${axis} bloc? (This drifts priorities/policy; Undo is available briefly.)`);
        if (!ok) return;
      }
    }

    const res = negotiateWithFaction(state, axis);
    if (res?.msg) log(res.msg);
    save();
    render();
  });

  // Projects panel: quick actions
  // - Focus: sets Project focus (build order nudge)
  // - Unblock: lowers reserve(s) that are currently stalling an in-progress project (safe small steps)
  if (projectsEl) projectsEl.addEventListener('click', (e) => {
    const pinBtn = e.target?.closest?.('button[data-pin]');
    if (pinBtn) {
      const act = String(pinBtn.dataset.pin || '');
      const type = String(pinBtn.dataset.pintype || '');
      state.director = state.director ?? {};

      if (act === 'on') {
        const def = pinnedProjectDef(type);
        if (!def) { log('Pin failed: unknown project.'); return; }
        const startOwned = Number(def.owned?.(state) ?? 0);
        state.director.pinnedProject = { type: def.type, startOwned, at: state.t };

        // Convenience: pin also sets focus to the matching track (still visible + reversible).
        const focus = String(pinBtn.dataset.focus || def.focus || 'Auto');
        if (focus) state.director.projectFocus = focus;

        log(`Pinned project: ${def.type} (finish 1).`);
      } else {
        clearPinnedProject(state, 'Pinned project cleared.');
      }

      save();
      render();
      return;
    }

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

  initDirectorProfiles({
    profilesEl,
    getState: () => state,
    ensureProfiles,
    snapshotDirectorSettings,
    applyDirectorSettings,
    log,
    save,
    render,
  });
  // --- Patch notes modal (explainability)
  const patchModalEl = el('patchModal');
  const patchTitleEl = el('patchTitle');
  const patchSubEl = el('patchSub');
  const patchBodyEl = el('patchBody');
  const btnPatchNotesEl = el('btnPatchNotes');
  const btnPatchCloseEl = el('btnPatchClose');

  const offlineModalEl = el('offlineModal');
  const offlineSubEl = el('offlineSub');
  const offlineBodyEl = el('offlineBody');
  const btnOfflineCloseEl = el('btnOfflineClose');

  const patchNotesUI = initPatchNotes({
    gameVersion: GAME_VERSION,
    patchHistory: PATCH_HISTORY,
    patchModalEl,
    patchTitleEl,
    patchSubEl,
    patchBodyEl,
    btnPatchNotesEl,
    btnPatchCloseEl,
  });

  function closeOfflineModal(){
    if (offlineModalEl) offlineModalEl.classList.add('hidden');
  }

  function openOfflineModal(summary){
    if (!offlineModalEl || !offlineSubEl || !offlineBodyEl) return;
    const away = Number(summary?.away ?? 0) || 0;
    const sim = Number(summary?.simulated ?? 0) || 0;
    const capped = !!summary?.capped;
    const gains = summary?.gains ?? {};
    const streak = Math.max(0, Number(summary?.streak ?? 0) || 0);
    const streakBonusPct = Math.max(0, Number(summary?.streakBonusPct ?? 0) || 0);
    const tier = String(summary?.tier ?? 'Welcome back');
    const items = [];
    for (const k of ['food','jerky','wood','science','tools']) {
      const v = Number(gains[k] ?? 0);
      if (v > 0.001) items.push(`${k}: +${fmt(v)}`);
    }

    offlineSubEl.textContent = `${tier} - Away ${fmt(away)}s. Effective sim ${fmt(sim)}s at 50% base rate${capped ? ' (capped at 24h)' : ''}.`;
    offlineBodyEl.innerHTML = [
      `<div>Daily return streak: ${streak} day${streak === 1 ? '' : 's'}${streakBonusPct > 0 ? ` (+${streakBonusPct}% bonus)` : ''}</div>`,
      items.length ? items.map((line) => `<div>${line}</div>`).join('') : '<div>No meaningful gains this time.</div>'
    ].join('<div style="height:8px"></div>');

    offlineModalEl.classList.remove('hidden');
  }

  if (btnOfflineCloseEl) btnOfflineCloseEl.addEventListener('click', closeOfflineModal);
  if (offlineModalEl) offlineModalEl.addEventListener('click', (e) => {
    if (e.target === offlineModalEl) closeOfflineModal();
  });

  // --- Inspect modal (explainability)
  const inspectModalEl = el('inspectModal');
  const inspectTitleEl = el('inspectTitle');
  const inspectSubEl = el('inspectSub');
  const inspectBodyEl = el('inspectBody');
  const inspectControlsEl = el('inspectControls');
  const btnInspectClose = el('btnInspectClose');

  const inspectUI = initInspectModal({
    getState: () => state,
    fmt,
    clamp01,
    genPersonality,
    buddyOf,
    valuesAlignment01,
    dominantValueAxis,
    valuesShort,
    log,
    save,
    render,
    inspectModalEl,
    inspectTitleEl,
    inspectSubEl,
    inspectBodyEl,
    inspectControlsEl,
    btnInspectClose,
    // Skill/chart deps for tabbed UI
    skillRegistry,
    SKILL_CATEGORIES,
    renderRadar,
    renderSkillTrend,
    renderVitalsTrend,
    renderActivityBar,
  });

  // --- Social inspector modal (explainability)
  const socialModalEl = el('socialModal');
  const socialTitleEl = el('socialTitle');
  const socialSubEl = el('socialSub');
  const socialBodyEl = el('socialBody');
  const btnSocialClose = el('btnSocialClose');

  // --- Culture inspector modal (norms)
  const cultureModalEl = el('cultureModal');
  const cultureTitleEl = el('cultureTitle');
  const cultureSubEl = el('cultureSub');
  const cultureBodyEl = el('cultureBody');
  const btnCultureClose = el('btnCultureClose');

  const storageModalEl = el('storageModal');
  const storageTitleEl = el('storageTitle');
  const storageSubEl = el('storageSub');
  const storageBodyEl = el('storageBody');
  const btnStorageClose = el('btnStorageClose');

  const threatModalEl = el('threatModal');
  const threatTitleEl = el('threatTitle');
  const threatSubEl = el('threatSub');
  const threatBodyEl = el('threatBody');
  const btnThreatClose = el('btnThreatClose');

  // (moved) social/storage/threat modal open flags live in ui.js via initSocietyInspectors

  function closeInspect(){ inspectUI.close(); }

  function openInspect(kidx){ inspectUI.open(kidx); }

  function renderInspect(){
    return inspectUI.render();

    if (!inspectModalEl || !inspectTitleEl || !inspectSubEl || !inspectBodyEl) return;
    if (!ui.inspectOpen || ui.inspectKidx < 0 || ui.inspectKidx >= state.kittens.length) {
      inspectModalEl.classList.add('hidden');
      return;
    }

    const k = state.kittens[ui.inspectKidx];
    const p = k.personality ?? genPersonality(k.id ?? 0);
    const nm = String(k.name ?? '').trim();
    inspectTitleEl.textContent = `${nm || 'Kitten'} (#${k.id}) - ${k.role ?? 'Generalist'} (${k.task ?? '-'})`;

    const likes = (p.likes ?? []).join(', ') || '-';
    const hates = (p.dislikes ?? []).join(', ') || '-';
    const at = (typeof k._lastScoredAt === 'number') ? `t=${fmt(k._lastScoredAt)}s` : '';
    const autoFresh = (k._autonomyPickNote && (state.t - Number(k._autonomyPickAt ?? 0)) < 2) ? k._autonomyPickNote : '';
    const traits = traitSummary(k);
    const buddy = buddyOf(state, k);
    const buddyNote = buddy ? ` | buddy: #${buddy.id}` : '';
    const needNote = buddy ? ` | buddy-need: ${Math.round(clamp01(Number(k.buddyNeed ?? 0))*100)}%` : '';
    const align = valuesAlignment01(state, k);
    const bloc = dominantValueAxis(k);
    const driftFresh = (k._valuesDriftNote && (state.t - Number(k._valuesDriftAt ?? 0)) < 30);
    const driftNote = driftFresh ? ` | ${String(k._valuesDriftNote ?? '')}` : '';
    inspectSubEl.textContent = `traits: ${traits} | bloc: ${bloc} | values: ${valuesShort(k)} | focus-fit: ${Math.round(align*100)}% | likes: ${likes} | hates: ${hates}${buddyNote}${needNote}${driftNote}${autoFresh ? ' | ' + autoFresh : ''}${at ? ' | ' + at : ''}`;

    // Controls: per-kitten Directive (a small, persistent bias layer)
    if (inspectControlsEl) {
      const dir = String(k.directive ?? 'Auto');
      const opts = ['Auto','Food','Safety','Progress','Social','Rest'];
      inspectControlsEl.innerHTML = `
        <label class="small" title="Directive: a persistent nudge for this kitten's scoring. This is NOT a hard lock (safety rules/emergencies still override).">Directive
          <select id="inspectDirective">
            ${opts.map(o => `<option value="${o}" ${o===dir?'selected':''}>${o}</option>`).join('')}
          </select>
        </label>
        <span class="small" style="opacity:.85" title="What this does">Bias: ${dir==='Auto'?'none':dir}</span>
        <button class="btn" id="btnDirectiveClear" ${dir==='Auto'?'disabled':''} title="Reset directive to Auto.">Clear</button>
      `;

      const sel = inspectControlsEl.querySelector('#inspectDirective');
      if (sel) {
        sel.addEventListener('change', () => {
          const v = String(sel.value || 'Auto');
          const next = opts.includes(v) ? v : 'Auto';
          const prev = String(k.directive ?? 'Auto');
          k.directive = next;

          // Make it immediately visible in-table.
          k.why = String(k.why ?? '');

          // Persist change + keep it legible (updates the "Bias" label + Clear button state).
          if (next !== prev) log(`Directive: ${String(k.name ?? 'Kitten')} (#${k.id}) → ${next}`);
          save();
          renderInspect();
          render();
        });
      }
      const btn = inspectControlsEl.querySelector('#btnDirectiveClear');
      if (btn) {
        btn.addEventListener('click', () => {
          const prev = String(k.directive ?? 'Auto');
          k.directive = 'Auto';
          if (prev !== 'Auto') log(`Directive cleared: ${String(k.name ?? 'Kitten')} (#${k.id})`);
          save();
          renderInspect();
          render();
        });
      }
    }

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

  // Social/Storage/Threat inspectors (explainability)
  societyUI = initSocietyInspectors({
    getState: () => state,
    fmt,
    clamp01,
    seasonAt,
    seasonTargets,
    dissent01,
    compliance01,
    getRations,
    doctrineKey,
    workPaceMul,
    discipline01,
    VALUE_AXES,
    ensureValues,
    valuesAlignment01,
    dominantValueAxis,
    colonyFocusVec,
    foodStorageCap,
    fmtEtaSeconds,
    etaToTarget,
    fmtRate,
    drillActive,

    socialModalEl,
    socialTitleEl,
    socialSubEl,
    socialBodyEl,
    btnSocialClose,

    cultureModalEl,
    cultureTitleEl,
    cultureSubEl,
    cultureBodyEl,
    btnCultureClose,

    storageModalEl,
    storageTitleEl,
    storageSubEl,
    storageBodyEl,
    btnStorageClose,

    threatModalEl,
    threatTitleEl,
    threatSubEl,
    threatBodyEl,
    btnThreatClose,
  });

  function uiIsTypingTarget(t){
    const tag = String(t?.tagName ?? '').toUpperCase();
    return !!(t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
  }

  function togglePause(){
    state.paused = !state.paused;

    // If we manually toggle pause/resume, clear any auto-pause reason so the UI doesn't stay "alarm red" forever.
    // (Auto-pauses are meant to be an attention signal, not a permanent flag.)
    if (state.director && 'autoDangerPauseWhy' in state.director) {
      // Clear when resuming or when the player manually pauses.
      state.director.autoDangerPauseWhy = '';
    }

    const btn = el('btnPause');
    if (btn) btn.textContent = state.paused ? 'Resume' : 'Pause';
    save();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      inspectUI.close();
      patchNotesUI.close();
      societyUI?.closeAll?.();
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

    if (key === 'd' || key === 'D') {
      // Defense drills (only when not already active)
      state.effects = state.effects ?? { festivalUntil: 0, councilUntil: 0, drillUntil: 0 };
      if (!drillActive(state)) {
        const res = runDrills(state);
        log(res.msg);
        save();
        render();
      }
      return;
    }
  });

  if (kittenGridEl) kittenGridEl.addEventListener('click', (e) => {
    const card = e.target?.closest?.('.kitten-card');
    if (!card) return;
    const kidx = Number(card.dataset.kidx ?? -1);
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

  // Auto Policy: a tiny "governor" that nudges policy multipliers toward the player's Targets.
  // Design: small reversible adjustments (±0.05), bounded, and explainable.
  function autoTunePolicyTowardTargets(s){
    s.director = s.director ?? {};
    s.director.policyLocks = s.director.policyLocks ?? {};

    s.policyMult = s.policyMult ?? { Socialize:1, Care:1, Forage:1, PreserveFood:1, Farm:1, ChopWood:1, StokeFire:1, Guard:1, BuildHut:1, BuildPalisade:1, BuildGranary:1, BuildWorkshop:1, BuildLibrary:1, CraftTools:1, Mentor:1, Research:1 };

    const beforeMult = { ...(s.policyMult ?? {}) };

    const targets = seasonTargets(s);
    const season = seasonAt(s.t);
    const n = Math.max(1, s.kittens?.length ?? 1);
    const foodPerKitten = ediblePerKitten(s);
    const warmth = Number(s.res?.warmth ?? 0);
    const threat = Number(s.res?.threat ?? 0);

    const step = 0.05;
    const changed = { any:false };

    const unlocked = (a) => {
      if (a === 'Farm') return !!s.unlocked?.farm;
      if (a === 'BuildGranary') return !!(s.unlocked?.construction && s.unlocked?.granary);
      if (a === 'BuildWorkshop') return !!(s.unlocked?.construction && s.unlocked?.workshop);
      if (a === 'BuildLibrary') return !!(s.unlocked?.construction && s.unlocked?.library);
      if (a === 'BuildHut' || a === 'BuildPalisade' || a === 'PreserveFood') return !!s.unlocked?.construction;
      if (a === 'CraftTools') return !!s.unlocked?.workshop;
      if (a === 'Mentor') return !!s.unlocked?.library;
      return true;
    };

    const nudgeTo = (a, want, maxDelta = step) => {
      if (!unlocked(a)) return;
      if (s.director?.policyLocks?.[a]) return;
      const cur = clampPolicyMult(Number(s.policyMult?.[a] ?? 1));
      const w = clampPolicyMult(want);
      const d = Math.max(-maxDelta, Math.min(maxDelta, w - cur));
      if (Math.abs(d) >= 0.0001) {
        s.policyMult[a] = clampPolicyMult(cur + d);
        changed.any = true;
      }
    };

    // 1) Basics pressure → push the relevant levers.
    const foodBad = foodPerKitten < targets.foodPerKitten * 0.95;
    const foodGreat = foodPerKitten >= targets.foodPerKitten * 1.10;

    const winter = season.name === 'Winter';
    const warmTarget = targets.warmth + (winter ? 10 : 0);
    const warmBad = warmth < (warmTarget - (winter ? 6 : 10));
    const warmGreat = warmth >= (warmTarget + 10);

    const threatBad = threat > targets.maxThreat * 1.07 || (s.signals?.ALARM);
    const threatGreat = threat <= targets.maxThreat * 0.92 && !s.signals?.ALARM;

    // 2) Convert pressure into small target multipliers.
    // We bias toward 1.30 when struggling, toward 0.90 when very safe, otherwise drift to 1.00.
    const want = {
      Forage: 1.00,
      Farm: 1.00,
      PreserveFood: 1.00,
      ChopWood: 1.00,
      StokeFire: 1.00,
      Guard: 1.00,
      BuildPalisade: 1.00,
      Research: 1.00,
      CraftTools: 1.00,
      BuildWorkshop: 1.00,
      BuildLibrary: 1.00,
      BuildHut: 1.00,
      Socialize: 1.00,
      Care: 1.00,
    };

    if (foodBad) {
      want.Forage = 1.30; want.Farm = 1.25; want.PreserveFood = 1.15;
      // When hungry, de-emphasize progress sinks a bit.
      want.Research = 0.92; want.CraftTools = 0.92; want.BuildWorkshop = 0.92; want.BuildLibrary = 0.92;
    } else if (foodGreat) {
      want.Forage = 0.95; want.Farm = 0.95; want.PreserveFood = 0.95;
    }

    if (warmBad) {
      want.StokeFire = 1.30; want.ChopWood = 1.15;
      want.Research = Math.min(want.Research, 0.94);
    } else if (warmGreat) {
      want.StokeFire = 0.92;
    }

    if (threatBad) {
      want.Guard = 1.35;
      want.BuildPalisade = 1.20;
      want.Research = Math.min(want.Research, 0.92);
    } else if (threatGreat) {
      want.Guard = 0.92;
    }

    // Housing: if capped, give builders a gentle nudge.
    if (s.unlocked?.construction) {
      const cap = housingCap(s);
      if (n >= cap) want.BuildHut = 1.20;
    }

    // 3) Apply small step toward our wants.
    for (const [a, w] of Object.entries(want)) {
      nudgeTo(a, w, step);
    }

    // 4) Explainability string.
    const parts = [];
    if (foodBad) parts.push(`food/kitten ${foodPerKitten.toFixed(1)}<${(targets.foodPerKitten*0.95).toFixed(0)} → +food`);
    else if (foodGreat) parts.push(`food surplus → ease food labor`);

    if (warmBad) parts.push(`warmth ${fmt(warmth)}<${fmt(warmTarget)} → +fire/wood`);
    else if (warmGreat) parts.push(`warmth surplus → ease stoke`);

    if (threatBad) parts.push(`threat ${fmt(threat)}>${fmt(targets.maxThreat)} → +guard/defense`);
    else if (threatGreat) parts.push(`threat low → ease guard`);

    const why = parts.length ? parts.join(' | ') : 'stable: drifting policy toward neutral';

    if (changed.any) {
      const diff = policyDiff(beforeMult, s.policyMult ?? {});
      const changes = diff.slice(0, 6).map(fmtPolicyChange);
      recordGovLog(s, { kind:'Auto Policy', why, changes });
    }

    return { changed: !!changed.any, why };
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

    // 0) Politics: active faction demand
    const demand = activeFactionDemand(s);
    if (demand) {
      const left = Math.max(0, Math.ceil((Number(demand.expiresAt ?? 0) - Number(s.t ?? 0))));
      lines.push(`• FACTION DEMAND: ${demand.axis} bloc (expires ~${left}s)`);

      // Recommendation: accept only if the colony is not actively collapsing.
      const basicsOk = (foodPerKitten >= targets.foodPerKitten * 0.92) && (Number(s.res.warmth ?? 0) >= targets.warmth - 6) && (Number(s.res.threat ?? 0) <= targets.maxThreat * 1.10);
      if (basicsOk) {
        lines.push(`  - Nudge: Accept to buy cohesion (reduces dissent); ignoring will spike dissent + grievance`);
        recs.push({
          id: 'demand-accept',
          label: 'Accept demand',
          tip: `Accept the ${demand.axis} demand (best when basics are stable).`,
          apply: (st) => { resolveFactionDemand(st, true); }
        });
      } else {
        lines.push(`  - Nudge: Ignore for now (you\'re not stable; concessions can be dangerous)`);
        recs.push({
          id: 'demand-ignore',
          label: 'Ignore demand',
          tip: `Ignore the ${demand.axis} demand (safer when you\'re collapsing).`,
          apply: (st) => { resolveFactionDemand(st, false); }
        });
      }
    }

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

    // 0.25) Overcrowding / housing cap (classic civ-sim pain point)
    // When pop exceeds housing cap, mood + cohesion steadily suffer.
    // Make this *extremely* legible with a direct advisor callout + one-click fix.
    const houseCap = housingCap(s);
    const over = Math.max(0, pop - houseCap);
    if (over > 0) {
      lines.push(`• overcrowding: pop ${pop}/${houseCap} (+${over} over cap)`);
      lines.push(`  - Nudge: focus Housing (BuildHut) + keep wood flowing; overcrowding slowly raises dissent + grievance`);

      recs.push({
        id: 'housing',
        label: 'Fix housing',
        tip: 'Set Project focus → Housing, enable BUILD PUSH, and bias policy toward Hut building + wood income.',
        apply: (st) => {
          st.director = st.director ?? { projectFocus:'Auto' };
          st.director.projectFocus = 'Housing';
          st.signals = st.signals ?? { BUILD:false, FOOD:false, ALARM:false };
          st.signals.BUILD = true;
          nudgePolicyMult(st,'BuildHut', 0.5);
          nudgePolicyMult(st,'ChopWood', 0.25);
          // Don't let a too-high wood reserve silently stall huts.
          // (Execution cannot spend below reserves, so we clamp reserve to a sane baseline.)
          st.reserve = st.reserve ?? { food:0, wood:18, science:25, tools:0 };
          st.reserve.wood = Math.min(getReserve(st,'wood'), 24);
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
    s.director.council = s.director.council ?? { nextAt: 0, lastKey: '', lastAnnouncedKey:'', flashUntil:0 };
    if (!('nextAt' in s.director.council)) s.director.council.nextAt = 0;
    if (!('lastKey' in s.director.council)) s.director.council.lastKey = '';
    if (!('lastAnnouncedKey' in s.director.council)) s.director.council.lastAnnouncedKey = '';
    if (!('flashUntil' in s.director.council)) s.director.council.flashUntil = 0;

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
    s.director.council.flashUntil = s.t + 12;

    // One-time announce (QoL): make council nudges harder to miss without spamming every frame.
    if (String(s.director.council.lastAnnouncedKey || '') !== String(key || '')) {
      s.director.council.lastAnnouncedKey = key;
      const labels = out.map(r => r.label || r.id).filter(Boolean).join(' / ');
      log(`Council: spokeskitten #${k.id} suggests ${labels}.`);
    }

    const traits = traitSummary(k);
    const mood = Math.round(clamp01(Number(k.mood ?? 0.55)) * 100);
    const dis = Math.round(dissent01(s) * 100);

    const header = `Spokeskitten: #${k.id} (mood ${mood}%, dissent ${dis}%) | traits: ${traits}`;
    return { text: header, recs: out };
  }

  function renderCouncil(s, targets){
    if (!councilPanelEl) return;
    const c = buildCouncil(s, targets);
    councilRecs = Array.isArray(c.recs) ? c.recs : [];

    // NEW badge: briefly show when a fresh council suggestion appears.
    const badgeEl = el('councilNew');
    if (badgeEl) {
      const until = Number(s.director?.council?.flashUntil ?? 0) || 0;
      badgeEl.style.display = (councilRecs.length && s.t < until) ? 'inline-block' : 'none';
    }

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

  function negotiateWithFaction(s, axis, opts){
    const o = (opts && typeof opts === 'object') ? opts : {};
    const ignoreCooldown = !!o.ignoreCooldown;
    const govKind = String(o.govKind ?? 'Faction Negotiation');
    const govWhy = String(o.govWhy ?? '');

    const ax = String(axis || '').trim();
    if (!['Food','Safety','Progress','Social'].includes(ax)) return { ok:false, msg:'Unknown faction.' };

    s.director = s.director ?? {};
    s.policyMult = s.policyMult ?? {};
    s.social = s.social ?? { dissent: 0 };

    // Cooldown: negotiations are a *politics* lever, not a spam button.
    // BUT: faction demands should still be "actionable" even if you just negotiated.
    // Save-safe: fields are optional and default to 0.
    if (!ignoreCooldown) {
      const nextAt = Number(s.director.factionsNextAt ?? 0) || 0;
      if (Number(s.t ?? 0) < nextAt) {
        const left = Math.max(0, nextAt - Number(s.t ?? 0));
        return { ok:false, msg:`Faction talks need time. Try again in ~${Math.ceil(left)}s.` };
      }
    }

    const before = {
      prioFood: Number(s.director.prioFood ?? 1) || 1,
      prioSafety: Number(s.director.prioSafety ?? 1) || 1,
      prioProgress: Number(s.director.prioProgress ?? 1) || 1,
      prioSocial: Number(s.director.prioSocial ?? 1) || 1,
      workPace: Number(s.director.workPace ?? 1) || 1,
      discipline: Number(s.director.discipline ?? 0.4) || 0.4,
      policyMult: { ...(s.policyMult ?? {}) },
      dissent: clamp01(Number(s.social.dissent ?? 0)),
    };

    // Save an undo snapshot (short window) so politics feels reversible and teachable.
    // Save-safe: stored under director.factionsUndo; if missing, nothing breaks.
    s.director.factionsUndo = {
      at: Number(s.t ?? 0) || 0,
      director: {
        prioFood: before.prioFood,
        prioSafety: before.prioSafety,
        prioProgress: before.prioProgress,
        prioSocial: before.prioSocial,
        workPace: before.workPace,
        discipline: before.discipline,
      },
      policyMult: { ...(before.policyMult ?? {}) },
      reason: String(o.reason ?? `Negotiation with ${ax}`),
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
      // Social concession: invest more into cohesion actions (and slightly slow pure growth pressure).
      s.director.prioSocial = Math.min(1.5, before.prioSocial + 0.10);
      s.director.prioProgress = Math.max(0.5, before.prioProgress - 0.05);
      s.director.workPace = Math.max(0.8, before.workPace - 0.03);
      s.director.discipline = clamp01(before.discipline - 0.02);
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
      prioSocial: Number(s.director.prioSocial ?? 1) || 1,
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
      fmtDelta('prioSocial', before.prioSocial, after.prioSocial),
      fmtDelta('workPace', before.workPace, after.workPace),
      fmtDelta('discipline', before.discipline, after.discipline),
      ...polDiff,
    ].filter(Boolean);

    const dissMsg = `${Math.round(before.dissent*100)}%→${Math.round(after.dissent*100)}%`;
    const changeMsg = changes.length ? changes.slice(0, 6).join('; ') : 'no policy deltas';

    // Explainability: mirror to Governance log.
    const why = govWhy || `${ax} bloc`;
    recordGovLog(s, { kind: govKind || 'Faction Negotiation', why, changes: changes.slice(0, 6) });

    return { ok:true, msg:`Negotiated with the ${ax} bloc: ${changeMsg}. Dissent ${dissMsg}. (cooldown ~45s)` };
  }

  function factionsUndoInfo(s){
    const u = s?.director?.factionsUndo;
    if (!u || typeof u !== 'object') return { ok:false, left:0, undo:null };
    const at = Number(u.at ?? 0) || 0;
    const left = Math.max(0, 120 - (Number(s?.t ?? 0) - at));
    if (left <= 0) return { ok:false, left:0, undo:null };
    return { ok:true, left, undo: u };
  }

  function undoFactionNegotiation(s){
    s.director = s.director ?? {};
    const info = factionsUndoInfo(s);
    if (!info.ok || !info.undo) return { ok:false, msg:'Faction undo expired (or nothing to undo).' };

    const u = info.undo;
    const d = u.director ?? {};
    s.director.prioFood = Math.max(0.50, Math.min(1.50, Number(d.prioFood ?? 1) || 1));
    s.director.prioSafety = Math.max(0.50, Math.min(1.50, Number(d.prioSafety ?? 1) || 1));
    s.director.prioProgress = Math.max(0.50, Math.min(1.50, Number(d.prioProgress ?? 1) || 1));
    s.director.prioSocial = Math.max(0.50, Math.min(1.50, Number(d.prioSocial ?? 1) || 1));
    s.director.workPace = Math.max(0.8, Math.min(1.2, Number(d.workPace ?? 1) || 1));
    s.director.discipline = clamp01(Number(d.discipline ?? 0.4) || 0.4);
    if (u.policyMult && typeof u.policyMult === 'object') s.policyMult = { ...(u.policyMult ?? {}) };

    s.director.factionsUndo = null;
    return { ok:true, msg:'Faction undo: restored the previous policy snapshot.' };
  }

  // --- Faction Demands (civ-sim pressure)
  // Once in a while (usually on season change), the dominant values bloc will make a demand.
  // Accepting makes a small policy concession (same knobs as "Negotiate"), but gives a stronger cohesion boost.
  // Ignoring increases dissent and grievance for that bloc (politics has consequences).
  // Save-safe: stored in director.factionDemand; missing fields default harmlessly.
  function activeFactionDemand(s){
    const d = s?.director?.factionDemand;
    if (!d || typeof d !== 'object') return null;
    const nowT = Number(s?.t ?? 0) || 0;
    const exp = Number(d.expiresAt ?? 0) || 0;
    const resolved = !!d.resolved;
    if (resolved) return null;
    if (exp > 0 && nowT > exp) return null;
    const ax = String(d.axis ?? '');
    if (!['Food','Safety','Progress','Social'].includes(ax)) return null;
    return { axis: ax, at: Number(d.at ?? 0) || 0, expiresAt: exp, why: String(d.why ?? '') };
  }

  function dominantFactionAxis(s){
    const groups = { Food:0, Safety:0, Progress:0, Social:0 };
    for (const k of (s.kittens ?? [])) {
      const ax = dominantValueAxis(k);
      if (ax in groups) groups[ax] += 1;
    }
    let best = 'Food';
    let bestN = -1;
    for (const ax of Object.keys(groups)) {
      if (groups[ax] > bestN) { bestN = groups[ax]; best = ax; }
    }
    return { axis: best, n: bestN };
  }

  function factionDemandShouldTrigger(s){
    const n = Number(s?.kittens?.length ?? 0) || 0;
    if (n < 4) return { ok:false, why:'pop too low' };

    // Don’t spam: at most once per ~2 seasons.
    const last = Number(s?.director?.factionDemandLastAt ?? 0) || 0;
    if ((Number(s?.t ?? 0) || 0) - last < 120) return { ok:false, why:'cooldown' };

    // Only when there’s meaningful political tension.
    const dis = clamp01(Number(s?.social?.dissent ?? 0));
    if (dis < 0.38) return { ok:false, why:'dissent low' };

    // Only when the dominant bloc feels misaligned.
    const dom = dominantFactionAxis(s);
    let fitSum = 0;
    let count = 0;
    for (const k of (s.kittens ?? [])) {
      if (dominantValueAxis(k) !== dom.axis) continue;
      fitSum += valuesAlignment01(s, k);
      count += 1;
    }
    const fit = count ? (fitSum / count) : 1;
    if (fit > 0.74) return { ok:false, why:`dominant bloc fit ok (${fit.toFixed(2)})` };

    return { ok:true, why:`${dom.axis} bloc uneasy (fit ${fit.toFixed(2)}, dissent ${(dis*100).toFixed(0)}%)` };
  }

  function maybeStartFactionDemand(s, triggerLabel){
    s.director = s.director ?? {};

    // If one is already active, do nothing.
    if (activeFactionDemand(s)) return null;

    const chk = factionDemandShouldTrigger(s);
    if (!chk.ok) return null;

    const dom = dominantFactionAxis(s);
    const nowT = Number(s.t ?? 0) || 0;

    s.director.factionDemand = {
      axis: dom.axis,
      at: nowT,
      expiresAt: nowT + 45,
      resolved: false,
      why: `${triggerLabel}: ${chk.why}`,
    };
    s.director.factionDemandLastAt = nowT;

    return s.director.factionDemand;
  }

  // Expired demands used to silently vanish (no consequence), which undermined the politics loop.
  // Now: if a demand times out unresolved, it auto-resolves as a *soft* ignore.
  function expireFactionDemandIfNeeded(s){
    s.director = s.director ?? {};
    const d = s.director.factionDemand;
    if (!d || typeof d !== 'object') return null;
    if (d.resolved) return null;

    const exp = Number(d.expiresAt ?? 0) || 0;
    const nowT = Number(s.t ?? 0) || 0;
    if (!(exp > 0) || nowT <= exp) return null;

    const ax = String(d.axis ?? '');

    // Mark resolved first to avoid any double-processing.
    d.resolved = true;
    d.resolvedAt = nowT;
    d.accepted = false;
    d.expired = true;

    // If axis is invalid, just resolve without effects (save safety).
    if (!['Food','Safety','Progress','Social'].includes(ax)) return { ok:false, msg:'Faction demand expired (invalid axis).' };

    // Softer than an explicit "Ignore" click: you didn't slam the door, you just missed the window.
    s.social = s.social ?? { dissent: 0 };
    s.social.dissent = clamp01(Number(s.social.dissent ?? 0) + 0.02);
    for (const k of (s.kittens ?? [])) {
      if (dominantValueAxis(k) !== ax) continue;
      k.grievance = clamp01(Number(k.grievance ?? 0) + 0.03);
      k.mood = clamp01(Number(k.mood ?? 0.55) - 0.015);
    }

    // Explainability: mirror to Governance log.
    recordGovLog(s, { kind:'Faction Demand (Expired)', why:`${ax} bloc demand`, changes:[`dissent +0.02`, `bloc grievance +0.03`, `bloc mood -0.02`] });

    return { ok:true, msg:`Faction demand expired (${ax}). Dissent rises slightly; the bloc feels unheard.` };
  }

  function resolveFactionDemand(s, accept){
    s.director = s.director ?? {};
    s.social = s.social ?? { dissent: 0 };

    const d = activeFactionDemand(s);
    if (!d) return { ok:false, msg:'No active demand.' };

    // Mark resolved first to avoid double-press.
    s.director.factionDemand = s.director.factionDemand ?? {};
    s.director.factionDemand.resolved = true;
    s.director.factionDemand.resolvedAt = Number(s.t ?? 0) || 0;
    s.director.factionDemand.accepted = !!accept;

    if (accept) {
      // Stronger than a normal negotiation: being "heard" matters.
      const res = negotiateWithFaction(s, d.axis, {
        ignoreCooldown: true,
        govKind: 'Faction Demand (Accepted)',
        govWhy: `${d.axis} bloc demand`,
        reason: `Demand accepted (${d.axis})`,
      });
      // Extra cohesion bump + small grievance relief for that bloc.
      s.social.dissent = clamp01(Number(s.social.dissent ?? 0) * 0.92);
      for (const k of (s.kittens ?? [])) {
        if (dominantValueAxis(k) === d.axis) k.grievance = clamp01(Number(k.grievance ?? 0) * 0.88);
      }
      return { ok:true, msg:`Demand accepted (${d.axis}). ${res?.msg || ''}`.trim() };
    } else {
      // Consequence: dissent spike + bloc resentment.
      s.social.dissent = clamp01(Number(s.social.dissent ?? 0) + 0.04);
      for (const k of (s.kittens ?? [])) {
        if (dominantValueAxis(k) !== d.axis) continue;
        k.grievance = clamp01(Number(k.grievance ?? 0) + 0.05);
        k.mood = clamp01(Number(k.mood ?? 0.55) - 0.03);
      }
      // Explainability: mirror to Governance log.
      recordGovLog(s, { kind:'Faction Demand (Ignored)', why:`${d.axis} bloc demand`, changes:[`dissent +0.04`, `bloc grievance +0.05`, `bloc mood -0.03`] });

      return { ok:true, msg:`Demand ignored (${d.axis}). Dissent rises; the bloc grows resentful.` };
    }
  }

  function renderFactions(s){
    if (!factionsEl) return;

    s.director = s.director ?? {};
    const nextAt = Number(s.director.factionsNextAt ?? 0) || 0;
    const can = Number(s.t ?? 0) >= nextAt;
    const left = Math.max(0, nextAt - Number(s.t ?? 0));

    const demand = activeFactionDemand(s);

    const preview = (ax) => {
      if (ax === 'Food') return 'Concession: +prioFood, -prioProgress';
      if (ax === 'Safety') return 'Concession: +prioSafety, -prioProgress';
      if (ax === 'Progress') return 'Concession: +prioProgress, -prioSafety';
      if (ax === 'Social') return 'Concession: +prioSocial, -prioProgress, -workPace, -discipline, +Socialize/Care policy, -Research policy';
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

    const demandHtml = demand
      ? (() => {
          const left = Math.max(0, Math.ceil((Number(demand.expiresAt ?? 0) - Number(s.t ?? 0))));
          const title = `A political demand from the ${demand.axis} bloc. Accepting makes a small concession but reduces dissent; ignoring raises dissent and grievance. Expires in ~${left}s.`;
          return `<div class="rule" style="border-color: rgba(251,191,36,.35); background: rgba(251,191,36,.05)">` +
            `<div class="top">` +
              `<div>` +
                `<div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">` +
                  `<span class="tag">Demand</span>` +
                  `<span class="small" style="opacity:.9">${escapeHtml(demand.axis)} bloc</span>` +
                  `<span class="small" style="opacity:.75">(expires ~${left}s)</span>` +
                `</div>` +
                `<div class="small" style="margin-top:4px; opacity:.85">${escapeHtml(String(demand.why || 'Seasonal tensions'))}</div>` +
              `</div>` +
              `<div class="row" style="gap:8px">` +
                `<button class="btn good" data-demand="accept" title="Accept: concede slightly + reduce dissent more.">Accept</button>` +
                `<button class="btn bad" data-demand="ignore" title="Ignore: dissent spikes; the bloc gains grievance.">Ignore</button>` +
              `</div>` +
            `</div>` +
          `</div>`;
        })()
      : '';

    const undo = factionsUndoInfo(s);
    const undoHtml = undo.ok
      ? (() => {
          const title = `Undo the last faction negotiation (restores Director priorities + policy multipliers). Expires in ~${Math.ceil(undo.left)}s.`;
          return `<div class="rule" style="border-color: rgba(125,211,252,.35); background: rgba(125,211,252,.05)">` +
            `<div class="top">` +
              `<div>` +
                `<div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">` +
                  `<span class="tag">Undo</span>` +
                  `<span class="small" style="opacity:.9">Last negotiation snapshot</span>` +
                  `<span class="small" style="opacity:.75">(expires ~${Math.ceil(undo.left)}s)</span>` +
                `</div>` +
                `<div class="small" style="margin-top:4px; opacity:.85">Politics drift is real — but this is a prototype, so you get one quick undo.</div>` +
              `</div>` +
              `<div class="row" style="gap:8px">` +
                `<button class="btn" data-faction-undo="1" title="${title}">Undo</button>` +
              `</div>` +
            `</div>` +
          `</div>`;
        })()
      : '';

    // Micro-factions: coteries (buddy-linked circles)
    const coteries = Array.isArray(s?.social?.coteries) ? s.social.coteries : [];
    const nameById = new Map();
    for (const k of kittens) {
      const id = Number(k?.id ?? 0);
      if (Number.isFinite(id) && id > 0) nameById.set(id, String(k?.name ?? `Kitten ${id}`));
    }
    const coteriesHtml = coteries.length
      ? (() => {
          const nowT = Number(s?.t ?? 0) || 0;
          const cp = (s && s._coteriePressure && typeof s._coteriePressure === 'object') ? s._coteriePressure : null;

          const rows = coteries.slice(0, 8).map(c => {
            const mem = (c.members ?? []).map(id => nameById.get(Number(id)) ?? `#${id}`).slice(0, 5);
            const who = mem.join(', ') + ((c.members?.length ?? 0) > 5 ? '�' : '');
            const ax = escapeHtml(String(c.domAx ?? ''));
            const sz = Number(c.size ?? 0);
            const cw = Number(c.coWork ?? 0);
            const trad = escapeHtml(String(c.trad ?? ''));
            const ethosLabel = escapeHtml(String(c.ethosLabel ?? ''));
            const ethos = clamp01(Number(c.ethos ?? 0));

            // Aquarium observability: surface active coterie pressure windows (aid/strict)
            // so players can connect macro mood/dissent drift to micro-factions.
            let pressTag = '';
            if (cp) {
              const aid = cp.aid;
              const strict = cp.strict;
              const aidLeft = aid && Number(aid.until ?? 0) - nowT;
              const strictLeft = strict && Number(strict.until ?? 0) - nowT;
              if (aid && Number(aid.cid ?? null) === Number(c.id ?? null) && Number.isFinite(aidLeft) && aidLeft > 0.5) {
                pressTag = `<span class="tag" style="border-color: rgba(52,211,153,.45); background: rgba(52,211,153,.08)">AID ${Math.ceil(aidLeft)}s</span> `;
              } else if (strict && Number(strict.cid ?? null) === Number(c.id ?? null) && Number.isFinite(strictLeft) && strictLeft > 0.5) {
                pressTag = `<span class="tag" style="border-color: rgba(251,113,133,.55); background: rgba(251,113,133,.08)">STRICT ${Math.ceil(strictLeft)}s</span> `;
              }
            }

            // Aquarium depth: surface ongoing feud/truce arcs per circle.
            let relTag = '';
            const rels = (s && s._coterieRelations && typeof s._coterieRelations === 'object') ? s._coterieRelations : null;
            if (rels) {
              let best = null;
              for (const [key, vRaw] of Object.entries(rels)) {
                const v = (vRaw && typeof vRaw === 'object') ? vRaw : null;
                if (!v) continue;
                if (nowT >= Number(v.until ?? 0)) continue;
                if (!key.includes('|')) continue;
                const parts = key.split('|');
                if (parts.length !== 2) continue;
                const a = parts[0], b = parts[1];
                if (String(a) !== String(c.id) && String(b) !== String(c.id)) continue;
                const st = String(v.status ?? '');
                // Prefer showing FEUD over TRUCE if both exist.
                if (st === 'feud') { best = { st:'feud', left: Number(v.until ?? 0) - nowT }; break; }
                if (!best && st === 'truce') best = { st:'truce', left: Number(v.until ?? 0) - nowT };
              }
              if (best && best.left > 0.5) {
                if (best.st === 'feud') relTag = `<span class="tag" style="border-color: rgba(251,113,133,.45); background: rgba(251,113,133,.06)">FEUD ${Math.ceil(best.left)}s</span> `;
                if (best.st === 'truce') relTag = `<span class="tag" style="border-color: rgba(147,197,253,.45); background: rgba(147,197,253,.06)">TRUCE ${Math.ceil(best.left)}s</span> `;
              }
            }

            // Reputation surfacing: respected/resented aura (decays back to neutral).
            let repTag = '';
            const repLabel = String(c.repLabel ?? '');
            if (repLabel === 'respected') repTag = `<span class="tag" style="border-color: rgba(34,197,94,.45); background: rgba(34,197,94,.06)">RESPECT</span> `;
            if (repLabel === 'resented') repTag = `<span class="tag" style="border-color: rgba(239,68,68,.45); background: rgba(239,68,68,.06)">RESENT</span> `;

            const title = `Circle ties: buddies + shared work. Dominant axis ${ax} (${c.domN ?? 0}/${sz}). Shared-work cohesion ~${cw.toFixed(1)}.${trad ? ` Tradition: ${trad}.` : ''}${ethosLabel ? ` Ethos: ${ethosLabel} (${Math.round(ethos*100)}%).` : ''}${repLabel ? ` Reputation: ${repLabel}.` : ''}`;
            return `<div class="small" style="opacity:.88; margin-top:4px" title="${title}">` +
              `<span class="tag">Coterie</span> <span class="tag">${ax}</span> ` +
              pressTag +
              relTag +
              repTag +
              `<span class="small">x${sz}</span> ` +
              (trad ? `<span class="small" style="opacity:.72">${trad}</span> ` : '') +
              (ethosLabel ? `<span class="small" style="opacity:.72">${ethosLabel}</span> ` : '') +
              `<span class="small" style="opacity:.7">cowork ${cw.toFixed(0)}</span> ` +
              `<span style="opacity:.9">${escapeHtml(who)}</span>` +
            `</div>`;
          }).join('');
          return `<div style="margin-top:10px">` +
            `<div class="small" style="opacity:.75">Coteries (micro-factions): buddy-linked circles that sometimes become influential.</div>` +
            rows +
          `</div>`;
        })()
      : '';

    factionsEl.innerHTML = demandHtml + undoHtml + lines + coteriesHtml + `<div class="small" style="margin-top:6px; opacity:.75">Tip: if dissent is creeping up and focus-fit is low, negotiating with the largest bloc is a quick stabilization lever (at the cost of drifting priorities). Cooldown prevents rapid drift; Undo lets you back out once if you over-correct.</div>`;
  }

  function renderBlocHealth(s){
    if (!blocHealthEl) return;

    const axes = ['Food','Safety','Progress','Social'];
    const groups = Object.create(null);
    for (const ax of axes) groups[ax] = { axis: ax, n:0, mood:0, griev:0, fit:0 };

    const kittens = Array.isArray(s?.kittens) ? s.kittens : [];
    for (const k of kittens) {
      const ax = dominantValueAxis(k);
      const g = groups[ax] ?? (groups[ax] = { axis: ax, n:0, mood:0, griev:0, fit:0 });
      g.n += 1;
      g.mood += clamp01(Number(k.mood ?? 0.55));
      g.griev += clamp01(Number(k.grievance ?? 0));
      g.fit += valuesAlignment01(s, k);
    }

    const arr = Object.values(groups).filter(g => g.n > 0).sort((a,b)=>b.n-a.n);
    if (!arr.length) { blocHealthEl.textContent = '-'; return; }

    const pct = (x)=>Math.round(100 * clamp01(Number(x ?? 0)));

    // Most-unhappy heuristic: large bloc + low fit + high grievance.
    const pressureScore = (g) => {
      const fit = g.fit / g.n;
      const griev = g.griev / g.n;
      // We weight size so big blocs show up as "politically relevant".
      return (g.n * 1.0) * (1 - fit) * (0.55 + griev);
    };

    let worst = arr[0];
    for (const g of arr) if (pressureScore(g) > pressureScore(worst)) worst = g;

    const lines = [];
    lines.push('Axis | size | fit | mood | grievance | read');
    lines.push('-----|------|-----|------|-----------|-----');

    for (const g of arr) {
      const fit = g.fit / g.n;
      const mood = g.mood / g.n;
      const griev = g.griev / g.n;

      let tag = 'ok';
      if (fit < 0.55 || griev >= 0.35) tag = 'bad';
      else if (fit < 0.68 || griev >= 0.25) tag = 'warn';

      const read = (tag === 'bad') ? 'UNHAPPY' : (tag === 'warn') ? 'uneasy' : 'fine';

      lines.push(`${g.axis.padEnd(8)} | ${String(g.n).padStart(4)} | ${String(pct(fit)).padStart(3)}% | ${String(pct(mood)).padStart(3)}% | ${String(pct(griev)).padStart(3)}%      | ${read}`);
    }

    if (worst && worst.n > 0) {
      const wFit = worst.fit / worst.n;
      const wGr = worst.griev / worst.n;
      const hint = `Nudge: biggest pressure looks like ${worst.axis} (fit ${pct(wFit)}%, griev ${pct(wGr)}%). If dissent is rising, try: Negotiate ${worst.axis} OR increase prio${worst.axis} briefly.`;
      lines.push('');
      lines.push(hint);
    }

    blocHealthEl.textContent = lines.join('\n');
  }

  function applyRevealVisibility(){
    const stage = revealStageOf(state);
    const nodes = document.querySelectorAll('[data-reveal-min]');
    for (const node of nodes) {
      const min = Math.max(0, Math.min(REVEAL_STAGE_MAX, Number(node.getAttribute('data-reveal-min') ?? 0) || 0));
      const show = stage >= min;
      const wasVisible = node.getAttribute('data-reveal-visible') === '1';
      node.classList.toggle('reveal-hidden', !show);
      if (show && !wasVisible) {
        node.classList.add('reveal-enter');
        setTimeout(() => node.classList.remove('reveal-enter'), 440);
      }
      node.setAttribute('data-reveal-visible', show ? '1' : '0');
      if (!show) node.setAttribute('aria-hidden', 'true');
      else node.removeAttribute('aria-hidden');
    }
  }

  function render(){
    const season = seasonAt(state.t);
    const targets = seasonTargets(state);
    const verEl = el('ver');
    if (verEl) verEl.textContent = `v${GAME_VERSION}`;
    el('clock').textContent = `t=${fmt(state.t)}s | pop=${state.kittens.length}/${housingCap(state)} | mode=${state.mode}`;

    // Curator summary: show what is currently steering the colony.
    if (steeringSummaryEl) steeringSummaryEl.textContent = getSteeringSummary(state);
    syncDevMode();
    applyRevealVisibility();
    renderTrendsLegend();

    // Society feed
    if (feedEl) feedEl.textContent = (Array.isArray(state.feed) ? state.feed : []).join('\n');
    renderMilestonesFx();
    renderActivePlayEvent();

    // Pause button: show auto-danger pause reason (if any) as a first-class, visible signal.
    const pauseBtn = el('btnPause');
    if (pauseBtn) {
      pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
      const why = String(state.director?.autoDangerPauseWhy ?? '').trim();
      const danger = state.paused && !!why;
      pauseBtn.classList.toggle('danger', danger);
      pauseBtn.title = danger ? `Auto-paused (danger): ${why}` : 'Shortcut: Space';
    }

    const prestigeBtn = el('btnPrestige');
    if (prestigeBtn) {
      const prev = computeLegacyShardGain(state);
      prestigeBtn.textContent = `Legacy Reset (+${fmt(prev)})`;
      prestigeBtn.title = `Reset colony and gain ${fmt(prev)} Legacy Shards`;
      prestigeBtn.disabled = prev <= 0;
    }

    const eternityBtn = el('btnEternity');
    if (eternityBtn) {
      ensureEternityState(state);
      const gate = eternityGateStatus(state);
      const prev = computeEternitySigilGain(state);
      eternityBtn.textContent = `Eternity Reset (+${fmt(prev)})`;
      eternityBtn.title = gate.ok
        ? `Reset legacy progression and gain ${fmt(prev)} Ancestral Sigils`
        : `Eternity locked (${gate.count}/4 gates met)`;
      eternityBtn.disabled = !gate.ok || prev <= 0;
    }

    const soundBtn = el('btnSound');
    if (soundBtn) {
      ensureAudioState(state);
      const on = !!state.sound.enabled;
      soundBtn.textContent = on ? 'Sound: On' : 'Sound: Off';
      soundBtn.classList.toggle('active', on);
      soundBtn.title = on ? 'Sound effects enabled' : 'Toggle sound effects (default off)';
    }

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
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, curfew:false, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoPolicy:false, autoPolicyNextAt:0, autoPolicyWhy:'', autoBuildPush:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', autoRecruit:false, autoRecruitWhy:'', autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', autoCouncil:false, autoCouncilNextAt:0, autoCouncilWhy:'', autoDangerPause:false, autoDangerPauseNextAt:0, autoDangerPauseWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00 };
    if (!('crisis' in state.director)) state.director.crisis = false;
    if (!('crisisSaved' in state.director)) state.director.crisisSaved = null;
    if (!('curfew' in state.director)) state.director.curfew = false;
    if (!('autoWinterPrep' in state.director)) state.director.autoWinterPrep = false;
    if (!('autoFoodCrisis' in state.director)) state.director.autoFoodCrisis = false;
    if (!('autoReserves' in state.director)) state.director.autoReserves = false;
    if (!('autoPolicy' in state.director)) state.director.autoPolicy = false;
    if (!('autoPolicyNextAt' in state.director)) state.director.autoPolicyNextAt = 0;
    if (!('autoPolicyWhy' in state.director)) state.director.autoPolicyWhy = '';
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
    if (!('prioSocial' in state.director)) state.director.prioSocial = 1.00;
    state.director.autonomy = clamp01(Number(state.director.autonomy ?? 0.60));
    state.director.discipline = clamp01(Number(state.director.discipline ?? 0.40));
    state.director.workPace = Math.max(0.8, Math.min(1.2, Number(state.director.workPace ?? 1.00) || 1.00));
    state.director.prioFood = Math.max(0.50, Math.min(1.50, Number(state.director.prioFood ?? 1.00) || 1.00));
    state.director.prioSafety = Math.max(0.50, Math.min(1.50, Number(state.director.prioSafety ?? 1.00) || 1.00));
    state.director.prioProgress = Math.max(0.50, Math.min(1.50, Number(state.director.prioProgress ?? 1.00) || 1.00));
    state.director.prioSocial = Math.max(0.50, Math.min(1.50, Number(state.director.prioSocial ?? 1.00) || 1.00));

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
    const autoPol = el('autoPolicy');
    if (autoPol) autoPol.checked = !!state.director.autoPolicy;
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
    const autoCouncil = el('autoCouncil');
    if (autoCouncil) autoCouncil.checked = !!state.director.autoCouncil;
    const autoDP = el('autoDangerPause');
    if (autoDP) autoDP.checked = !!state.director.autoDangerPause;
    const cf = el('confirmFactions');
    if (cf) {
      if (!('confirmFactions' in state.director)) state.director.confirmFactions = true;
      cf.checked = !!state.director.confirmFactions;
    }

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
    renderProjectFocusHint({
      state,
      projectFocusSelectEl: el('projectFocus'),
      projectFocusHintEl: el('projectFocusHint'),
      getEffectiveProjectFocus,
    });

    // Pinned project selector + hint (Director)
    renderPinnedProjectControls({
      state,
      pinHintEl: el('pinHint'),
      btnClearPinEl: el('btnClearPin'),
      pinSelectEl: el('pinProjectSelect'),
      btnPinEl: el('btnPinProject'),
      pinProjectHintEl: el('pinProjectHint'),
      pinnedProjectInfo,
      pinnedProjectDef,
    });

    // Director profiles UI
    if (profilesEl) {
      ensureProfiles(state);
      renderDirectorProfiles({
        profilesEl,
        profilesHintEl,
        profiles: state.director?.profiles ?? null,
      });
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
    updateResourceFlyups(state);

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

    // Reserve forecasts: when a rate is negative, show time until you hit your configured buffer.
    // This makes reserves feel like a real planning lever (not just a hidden execution constraint).
    const resFood = getReserve(state,'food');
    const resWood = getReserve(state,'wood');
    const resSci = getReserve(state,'science');
    const resTools = getReserve(state,'tools');

    const etaToReserve = (cur, resv, rate) => {
      const c = Number(cur ?? 0);
      const r0 = Number(resv ?? 0);
      const rr = Number(rate ?? 0);
      if (!Number.isFinite(c) || !Number.isFinite(r0) || !Number.isFinite(rr)) return '-';
      if (c <= r0 + 0.0001) return '0s';
      if (rr >= -0.02) return '-';
      return fmtEtaSeconds((c - r0) / (-rr));
    };

    const statSub = (key) => {
      if (key === 'Food') {
        const spoilNote = (spoilMult > 1.05) ? ` | spoil x${spoilMult.toFixed(2)}` : '';
        const capNote = ` | cap ${fmt(foodCapNow)}`;
        const resEta = etaToReserve(state.res.food, resFood, foodRate);
        const below = (Number(state.res.food ?? 0) < resFood - 0.01) ? ' | BELOW RES' : '';
        return `fresh ${fmtRate(foodRate)} | 0 in ${starveEtaFresh} | res ${fmt(resFood)} in ${resEta}${below}${spoilNote}${capNote}`;
      }
      if (key === 'Edible') {
        return `food+jerky ${fmtRate(edibleRate)} | 0 in ${starveEtaEdible}`;
      }
      if (key === 'Jerky') return `${fmtRate(jerkyRate)}`;
      if (key === 'Wood') {
        const resEta = etaToReserve(state.res.wood, resWood, woodRate);
        const below = (Number(state.res.wood ?? 0) < resWood - 0.01) ? ' | BELOW RES' : '';
        return `${fmtRate(woodRate)} | res ${fmt(resWood)} in ${resEta}${below}`;
      }
      if (key === 'Warmth') return `${fmtRate(warmthRate)} | tgt in ${warmthToTargetEta} | 0 in ${freezeEta}`;
      if (key === 'Threat') return `${fmtRate(threatRate)} | tgt in ${threatTargetEta} | raid in ${raidEta}`;
      if (key === 'Science') {
        const resEta = etaToReserve(state.res.science, resSci, scienceRate);
        const below = (Number(state.res.science ?? 0) < resSci - 0.01) ? ' | BELOW RES' : '';
        return `${fmtRate(scienceRate)} | next unlock in ${nextUnlockEta} | res ${fmt(resSci)} in ${resEta}${below}`;
      }
      if (key === 'Tools') {
        const resEta = etaToReserve(state.res.tools ?? 0, resTools, toolsRate);
        const below = (Number(state.res.tools ?? 0) < resTools - 0.01) ? ' | BELOW RES' : '';
        return `${fmtRate(toolsRate)} | res ${fmt(resTools)} in ${resEta}${below}`;
      }
      if (key === 'Commitment') {
        const cm = coordinationMul(state);
        const build = commitSecondsForTask(state,'BuildHut');
        const work = commitSecondsForTask(state,'Forage');
        return `x${cm.toFixed(2)} | typical locks: build ${build}s, work ${work}s (range 1–6s)`;
      }
      if (key === 'Focus-fit') return `min ${Math.round(minAlign*100)}% | low ${lowAlignCt}/${Math.max(1,state.kittens.length)}`;
      if (key === 'Legacy Shards') {
        return `spent ${fmt(Math.max(0, (state.legacy?.totalShards ?? 0) - (state.legacy?.shards ?? 0)))} | resets ${fmt(state.legacy?.resets ?? 0)}`;
      }
      if (key === 'Legacy Preview') {
        return 'log-scale gain from population, science, and built structures';
      }
      if (key === 'Culture') {
        const ns = state?.social?.norms ?? {};
        const vig = Math.max(0, Math.min(1, Number(ns.raidParanoia ?? 0) || 0));
        const scar = Math.max(0, Math.min(1, Number(ns.scarcityMindset ?? 0) || 0));
        const aid = Math.max(0, Math.min(1, Number(ns.mutualAid ?? 0) || 0));
        const pun = Math.max(0, Math.min(1, Number(ns.punitiveTolerance ?? 0) || 0));
        const vigBand = String(state?.social?.normsBand ?? (vig >= 0.70 ? 'paranoid' : vig >= 0.40 ? 'wary' : 'calm'));
        const scarBand = String(state?.social?.scarcityBand ?? (scar >= 0.70 ? 'hoarding' : scar >= 0.40 ? 'thrifty' : 'calm'));
        const aidBand = String(state?.social?.mutualAidBand ?? (aid >= 0.70 ? 'communal' : aid >= 0.40 ? 'neighborly' : 'atomized'));
        const punBand = String(state?.social?.punitiveBand ?? (pun >= 0.70 ? 'punitive' : pun >= 0.40 ? 'firm' : 'lenient'));
        return `vig ${vigBand} | scar ${scarBand} | aid ${aidBand} | pun ${punBand}`;
      }
      return '';
    };

    const legacyPreview = computeLegacyShardGain(state);
    const devMode = !!state?.director?.curator?.devMode;
    const revealStage = revealStageOf(state);
    const statRevealMin = {
      'Legacy Shards': 3, 'Legacy Preview': 3,
      'Food': 0, 'Edible': 1, 'Wood': 0, 'Warmth': 0, 'Threat': 0,
      'Science': 2, 'Tools': 2, 'Prod x': 3,
      'Huts': 1, 'Palisade': 1, 'Granaries': 2, 'Workshops': 2, 'Libraries': 3,
      'Industry x': 3, 'Research x': 3,
      'Food Cap': 2, 'Spoilage': 2, 'Edible/Kitten': 1,
      'Dissent': 2, 'Compliance': 2, 'Grievance': 3, 'Autonomy': 2, 'Focus-fit': 3, 'Culture': 4,
      'Jerky': 3, 'Fresh/Kitten': 2, 'Eff Auto': 3, 'Discipline': 3, 'Work pace': 3, 'Commitment': 4,
    };
    const stats = [
      ['Legacy Shards', fmt(state.legacy?.shards ?? 0)],
      ['Legacy Preview', `+${fmt(legacyPreview)} shards`],
      ['Food', fmt(state.res.food)],
      ['Edible', fmt(edibleFood(state))],
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
      ['Dissent', `${Math.round(diss*100)}% (${dissBand})`],
      ['Compliance', `x${compMul.toFixed(2)}`],
      ['Grievance', `${Math.round(avgGriev*100)}%`],
      ['Autonomy', `${Math.round(autonomy01(state)*100)}%`],
      ['Focus-fit', `${Math.round(avgAlign*100)}%`],
      ['Culture', 'Norms'],
    ];
    if (devMode) {
      stats.push(
        ['Jerky', fmt(state.res.jerky ?? 0)],
        ['Fresh/Kitten', fmt(freshPerKitten)],
        ['Eff Auto', `${Math.round(effectiveAutonomy01(state)*100)}%`],
        ['Discipline', `${Math.round(discipline01(state)*100)}%`],
        ['Work pace', `${Math.round(workPaceMul(state)*100)}%`],
        ['Commitment', `x${coordinationMul(state).toFixed(2)}`],
      );
    }

    const visibleStats = stats.filter(([key]) => revealStage >= Number(statRevealMin[key] ?? 0));

    const statLabelMeta = {
      'Food': { icon: '🍖', tone: 'food' },
      'Edible': { icon: '🥫', tone: 'food' },
      'Wood': { icon: '🪵', tone: 'wood' },
      'Warmth': { icon: '🔥', tone: 'warmth' },
      'Threat': { icon: '⚠️', tone: 'threat' },
      'Science': { icon: '🔬', tone: 'science' },
      'Tools': { icon: '⚒️', tone: 'tools' },
      'Jerky': { icon: '🥓', tone: 'food' },
      'Food Cap': { icon: '📦', tone: 'food' },
      'Spoilage': { icon: '🧪', tone: 'threat' },
      'Edible/Kitten': { icon: '🐾', tone: 'food' },
      'Legacy Shards': { icon: '💠', tone: 'legacy' },
      'Legacy Preview': { icon: '✨', tone: 'legacy' },
    };

    const statDisplayParts = (key) => {
      const meta = statLabelMeta[key];
      if (!meta) return { icon: '', label: key };
      return { icon: String(meta.icon || ''), label: key };
    };

    for (const [k,v] of visibleStats) {
      const d = document.createElement('div');
      d.className = 'stat';
      const labelMeta = statLabelMeta[k] ?? null;
      if (labelMeta?.tone) d.classList.add(`tone-${labelMeta.tone}`);
      if (k === 'Legacy Shards') {
        d.title = 'Persistent prestige currency. Shards survive Legacy Reset and buy permanent upgrades.';
      }
      if (k === 'Legacy Preview') {
        d.title = 'Expected shard gain if you reset now. Formula is log-scaled to avoid runaway inflation.';
      }
      if (k === 'Dissent') {
        d.dataset.stat = 'dissent';
        d.classList.add('inspectable');
        d.title = 'Click to inspect what is driving dissent/compliance';
      }
      if (k === 'Compliance') {
        d.dataset.stat = 'compliance';
        d.classList.add('inspectable');
        d.title = 'Click to inspect what is driving dissent/compliance (compliance scales how strongly the colony follows the plan)';
      }
      if (k === 'Food Cap' || k === 'Spoilage') {
        d.dataset.stat = 'storage';
        d.classList.add('inspectable');
        d.title = 'Click to inspect food storage cap + spoilage mechanics';
      }
      if (k === 'Grievance') {
        d.dataset.stat = 'grievance';
        d.classList.add('inspectable');
        d.title = 'Average grievance (slow-burn resentment). It rises when kittens are pushed into disliked/misaligned work under strong central planning, and it contributes to dissent pressure. Click to inspect the social model.';
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
      if (k === 'Commitment') {
        d.title = 'Coordination/commitment multiplier (derived from Discipline + Effective Autonomy). Higher = kittens stick to tasks longer (less thrash); lower = they switch more often (more emergent wandering).';
      }
      if (k === 'Focus-fit') {
        d.dataset.stat = 'focusfit';
        d.classList.add('inspectable');
        d.title = 'Values alignment: avg match between kittens\' values and colony focus (Mode + priority sliders). Low fit can drag mood and raise dissent, especially with low autonomy/high discipline. Click to inspect the social model.';
      }
      if (k === 'Culture') {
        d.dataset.stat = 'culture';
        d.classList.add('inspectable');
        d.title = 'Culture memory (Norms). Persistent norms drift slowly from raids, scarcity, and social strain. Click to open the Culture inspector.';
      }
      if (k === 'Food') {
        const oc = state._lastFoodOvercap ?? { cap: foodCapNow, food: Number(state.res.food ?? 0), mult: 1 };
        const cap = Number(oc.cap ?? foodCapNow);
        const mult = Number(oc.mult ?? spoilMult);
        d.title = `Fresh food (not counting jerky). Food storage soft cap: ${fmt(cap)}. If food is above cap, spoilage accelerates (shown as Spoilage x1..x4). Current spoilage: x${(Number.isFinite(mult)?mult:1).toFixed(2)}.`;
      }
      if (k === 'Edible') {
        d.title = 'Total edible stores = Food + Jerky. Starvation checks use edible, not just fresh food.';
      }
      if (k === 'Threat') {
        d.dataset.stat = 'threat';
        d.classList.add('inspectable');
        d.title = 'Threat rises over time and triggers raids at 100. Click to inspect the raid/defense model (mitigation + repel chance).';
      }
      const sub = statSub(k);
      const subHtml = sub ? `<div class="small" style="margin-top:4px; opacity:.85">${escapeHtml(sub)}</div>` : '';

      const isResource = (k === 'Food' || k === 'Wood' || k === 'Science' || k === 'Tools' || k === 'Jerky');
      const valueClass = isResource ? resourceLevelClass(state, k, state?.res?.[k.toLowerCase()] ?? 0) : '';
      const pulseMetric = (
        k === 'Food' ? Number(state.res.food ?? 0) :
        k === 'Edible' ? Number(edibleFood(state) ?? 0) :
        k === 'Threat' ? Number(state.res.threat ?? 0) :
        k === 'Dissent' ? Number(diss ?? 0) :
        k === 'Compliance' ? Number(compMul ?? 0) :
        k === 'Legacy Preview' ? Number(legacyPreview ?? 0) :
        NaN
      );
      const pulseClass = statPulseClass(k, pulseMetric);
      const flyups = (resourceUiFx.popups?.[k] ?? []);
      const flyupHtml = flyups.map((p, i) => `<span class="resource-flyup" style="--flyup-index:${i}">+${escapeHtml(fmt(Number(p.amount ?? 0)))}</span>`).join('');
      const labelParts = statDisplayParts(k);
      const iconPulseClass = (isResource && flyups.length > 0 && labelParts.icon) ? ' icon-pulse' : '';
      const labelHtml = labelParts.icon
        ? `<span class="stat-icon${iconPulseClass}" aria-hidden="true">${escapeHtml(labelParts.icon)}</span> ${escapeHtml(labelParts.label)}`
        : escapeHtml(labelParts.label);

      const microClass = pulseClass === 'pulse-good' ? 'micro-gain' : (pulseClass === 'pulse-warn' ? 'micro-spend' : '');
      d.classList.toggle('micro-gain', microClass === 'micro-gain');
      d.classList.toggle('micro-spend', microClass === 'micro-spend');
      d.innerHTML = `<div class="k">${labelHtml}</div><div class="v ${valueClass} ${pulseClass}">${v}${flyupHtml}</div>${subHtml}`;
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

    const pinnedNow = pinnedProjectInfo(state);
    const pinnedType = String(pinnedNow?.type ?? '');

    for (const pd of projDefs) {
      if (!pd.show()) continue;
      const prog = Number(state[pd.key] ?? 0);
      const req = Number(pd.req);
      const pct = clamp01(req > 0 ? prog / req : 0);
      const owned = Number(pd.owned?.() ?? 0);

      if (prog > 0.0001) proj.push(`${pd.name} ${prog.toFixed(1)}/${req}`);

      const blockedBy = blockKeys(projInputs(pd.name));
      const blocked = blockedBy.length ? ` (blocked by ${blockedBy.join('+')} reserve)` : '';

      // ETA (explainability): based on smoothed progress/sec. Only meaningful once progress has started.
      const rate = Number(state._projRate?.[pd.key] ?? 0);
      const rem = Math.max(0, req - prog);
      const eta = (prog > 0.0001 && rate > 0.001) ? fmtEtaSeconds(rem / rate) : (prog > 0.0001 ? (blockedBy.length ? 'blocked' : '-') : '-');
      const etaText = (prog > 0.0001) ? ` | ETA ${eta}` : '';

      const isPinned = (pinnedType === pd.name);
      const pinTag = isPinned ? ' <span class="tag good">PINNED</span>' : '';
      const pinBtn = isPinned
        ? `<button class=\"btn bad\" data-pin=\"off\" data-pintype=\"${pd.name}\" title=\"Unpin this project (stop forcing focus)\">Unpin</button>`
        : `<button class=\"btn\" data-pin=\"on\" data-pintype=\"${pd.name}\" data-focus=\"${pd.focus}\" title=\"Pin: temporarily force focus to finish ONE ${pd.name}. Clears automatically on completion.\">Pin</button>`;

      projHtml.push(`
        <div style="margin-bottom:10px">
          <div class="row" style="justify-content:space-between; gap:10px">
            <div class="small" style="flex:1 1 auto">${pd.name}${pinTag}: owned ${owned} - ${prog.toFixed(1)}/${req} (${Math.round(pct*100)}%)${blocked}${etaText}</div>
            <div class="row" style="gap:6px">
              ${pinBtn}
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

    const legacyPanelEl = el('legacyPanel');
    if (legacyPanelEl) {
      ensureLegacyState(state);
      const preview = computeLegacyShardGain(state);
      const activeBranch = state.legacy.activeBranch === 'military' ? 'military' : 'lore';

      const branchTab = (id, label) => `<button class="btn ${activeBranch === id ? 'active' : ''}" data-legacy-tab="${id}">${label}</button>`;
      const tabsHtml = `<div class="row" style="gap:6px; margin-top:8px">${branchTab('lore','Lore')} ${branchTab('military','Military')}</div>`;

      const upgradeRows = (activeBranch === 'military' ? LEGACY_MILITARY_UPGRADES : LEGACY_LORE_UPGRADES).map((up) => {
        const isMil = activeBranch === 'military';
        const rank = isMil ? legacyUpgradeRank(state, up.id) : (state.legacy.upgrades[up.id] ? 1 : 0);
        const maxRank = isMil ? up.maxRank : 1;
        const owned = rank >= maxRank;
        const afford = (state.legacy.shards >= up.cost);
        const rankLine = isMil ? ` <span class="small" style="opacity:.8">(Rank ${rank}/${maxRank})</span>` : '';
        const btn = owned
          ? '<span class="tag">Owned</span>'
          : `<button class="btn" data-legacy-buy="${up.id}" ${afford ? '' : 'disabled'}>Buy (${up.cost})</button>`;
        return `<div style="margin-bottom:8px"><div><b>${escapeHtml(up.name)}</b>${rankLine} - ${escapeHtml(up.desc)}</div><div class="small" style="margin-top:4px">${btn}</div></div>`;
      }).join('');

      const warLedger = legacyWarLedgerBonus(state);
      const milSummary = `<div class="small" style="margin-top:4px">Military shard bonus: <b>+${warLedger}</b> (cap +4)</div>`;

      legacyPanelEl.innerHTML =
        `<div class="small">Shard bank: <b>${fmt(state.legacy.shards)}</b> | total earned: ${fmt(state.legacy.totalShards)} | resets: ${fmt(state.legacy.resets)}</div>` +
        `<div class="small" style="margin-top:4px">Reset preview: <b>+${fmt(preview)}</b> shards now.</div>` +
        milSummary +
        tabsHtml +
        `<div style="margin-top:8px">${upgradeRows}</div>`;
    }

    const eternityPanelEl = el('eternityPanel');
    if (eternityPanelEl) {
      ensureEternityState(state);
      const gate = eternityGateStatus(state);
      const gain = computeEternitySigilGain(state);
      const rows = ETERNITY_UPGRADES.map((up) => {
        const rank = eternityUpgradeRank(state, up.id);
        const owned = rank >= up.maxRank;
        const afford = state.eternity.sigils >= up.cost;
        const rankLine = `<span class="small" style="opacity:.8">(Rank ${rank}/${up.maxRank})</span>`;
        const btn = owned
          ? '<span class="tag good">Owned</span>'
          : `<button class="btn" data-eternity-buy="${up.id}" ${afford ? '' : 'disabled'}>Buy (${up.cost})</button>`;
        return `<div style="margin-bottom:8px"><div><b>${escapeHtml(up.name)}</b> ${rankLine} - ${escapeHtml(up.desc)}</div><div class="small" style="margin-top:4px">${btn}</div></div>`;
      }).join('');

      const mandateTabs = ETERNITY_MANDATES.map((m) => `<button class="btn ${state.eternity.mandate === m.id ? 'active' : ''}" data-eternity-mandate="${m.id}">${escapeHtml(m.name)}</button>`).join(' ');
      const preserveTabs = PRESERVATION_PACKAGES.map((p) => `<button class="btn ${state.eternity.preserve === p.id ? 'active' : ''}" data-eternity-preserve="${p.id}">${escapeHtml(p.name)}</button>`).join(' ');
      const gateLine = `Gates: legacy resets ${gate.gates.legacyResets ? 'yes' : 'no'} | shard mastery ${gate.gates.shardMastery ? 'yes' : 'no'} | doctrine ${gate.gates.doctrine ? 'yes' : 'no'} | population ${gate.gates.population ? 'yes' : 'no'}`;

      eternityPanelEl.innerHTML =
        `<div class="small">Sigils bank: <b>${fmt(state.eternity.sigils)}</b> | total earned: ${fmt(state.eternity.totalSigils)} | resets: ${fmt(state.eternity.resets)}</div>` +
        `<div class="small" style="margin-top:4px">Reset preview: <b>+${fmt(gain)}</b> sigils. ${escapeHtml(gateLine)}</div>` +
        `<div class="small" style="margin-top:6px">Mandates (tab rail):</div><div class="row" style="gap:6px; margin-top:4px">${mandateTabs}</div>` +
        `<div class="small" style="margin-top:6px">Preservation package:</div><div class="row" style="gap:6px; margin-top:4px">${preserveTabs}</div>` +
        `<div style="margin-top:8px">${rows}</div>`;
    }

    const researchPanelEl = el('researchPanel');
    if (researchPanelEl) {
      ensureResearchState(state);
      const active = state.research.activeBranch;
      const bLabel = (b) => b === 'economy' ? 'Economy' : (b === 'military' ? 'Military' : 'Culture');
      const tabs = RESEARCH_BRANCH_ORDER.map((b) => `<button class="btn ${active === b ? 'active' : ''}" data-research-tab="${b}">${bLabel(b)}</button>`).join(' ');
      const branchTechs = RESEARCH_TECHS.filter(t => t.branch === active).sort((a,b) => a.tier - b.tier);
      const selectedId = String(state.research.selectedTechId ?? '');
      const selected = branchTechs.find((t) => t.id === selectedId) ?? branchTechs[0] ?? null;
      if (selected && state.research.selectedTechId !== selected.id) state.research.selectedTechId = selected.id;
      const rows = branchTechs.map((tech) => {
        const owned = !!state.research.unlocked[tech.id];
        const selectedClass = selected && selected.id === tech.id ? 'active' : '';
        const status = owned ? '<span class="tag good">Unlocked</span>' : `<span class="small" style="opacity:.8">Cost ${tech.cost}</span>`;
        return `<button class="btn ${selectedClass}" style="width:100%; text-align:left; margin-bottom:6px" data-research-select="${tech.id}"><b>T${tech.tier}.</b> ${escapeHtml(tech.name)} <span class="small" style="opacity:.7">(${tech.branch})</span> ${status}</button>`;
      }).join('');

      let detailSheet = '<div class="small" style="margin-top:8px; opacity:.75">No research available for this branch.</div>';
      if (selected) {
        const owned = !!state.research.unlocked[selected.id];
        const canBuy = canBuyResearchTech(state, selected);
        const prereqs = (selected.prereqs ?? []).map((id) => RESEARCH_TECHS.find(t => t.id === id)?.name || id);
        const reqLine = prereqs.length ? `<div class="small" style="opacity:.75; margin-top:4px">Requires: ${escapeHtml(prereqs.join(', '))}</div>` : '<div class="small" style="opacity:.75; margin-top:4px">Requires: none</div>';
        const doctrineTag = selected.doctrine ? `<span class="tag warn" style="margin-left:6px">Doctrine fork</span>` : '';
        const btn = owned
          ? '<span class="tag good">Unlocked</span>'
          : `<button class="btn" data-research-buy="${selected.id}" ${canBuy ? '' : 'disabled'}>Research (${selected.cost} science)</button>`;
        detailSheet =
          `<div class="research-detail-sheet" style="margin-top:8px">` +
          `<div><b>${escapeHtml(selected.name)}</b>${doctrineTag}</div>` +
          `<div class="small" style="margin-top:4px">${escapeHtml(selected.desc)}</div>` +
          `${reqLine}` +
          `<div class="small" style="margin-top:8px">${btn}</div>` +
          `</div>`;
      }

      const doctrine = state.research.doctrine ? (state.research.doctrine === 'legion' ? 'Legion Charter' : 'Scholarium Compact') : 'none';
      researchPanelEl.innerHTML =
        `<div class="small">Science bank: <b>${fmt(state.res.science)}</b> | Doctrine: <b>${doctrine}</b></div>` +
        `<div class="row" style="gap:6px; margin-top:8px">${tabs}</div>` +
        `<div style="margin-top:8px">${rows}</div>` +
        `${detailSheet}`;
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

    const pinLine = (pinnedNow && !pinnedNow.completed)
      ? `Pinned project: ${String(pinnedNow.type ?? '')} (finish 1)\n`
      : '';

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

    const apOn = !!state.director?.autoPolicy;
    const apWhy = String(state.director?.autoPolicyWhy ?? '').trim();
    const apLine = apOn ? `Auto policy: ON${apWhy ? ` - ${apWhy}` : ''}\n` : '';

    const adOn = !!state.director?.autoDoctrine;
    const adWhy = String(state.director?.autoDoctrineWhy ?? '').trim();
    const adLine = adOn ? `Auto doctrine: ON (${doctrineKey(state)})${adWhy ? ` - ${adWhy}` : ''}\n` : '';

    const aRatOn = !!state.director?.autoRations;
    const aRatWhy = String(state.director?.autoRationsWhy ?? '').trim();
    const aRatLine = aRatOn ? `Auto rations: ON (${String(state.rations ?? 'Normal')})${aRatWhy ? ` - ${aRatWhy}` : ''}\n` : '';

    const arOn = !!state.director?.autoRecruit;
    const arYear = Number(state.director?.recruitYear ?? -1);
    const curYear = yearAt(state.t);
    const arWhy = String(state.director?.autoRecruitWhy ?? '').trim();
    const arLine = arOn
      ? `Auto recruit: ON (Spring; ${arYear === curYear ? 'already recruited this year' : 'eligible'})${arWhy ? ` - ${arWhy}` : ''}\n`
      : '';

    const acOn = !!state.director?.autoCrisis;
    const acWhy = String(state.director?.autoCrisisWhy ?? '').trim();
    const acLine = acOn ? `Auto crisis: ON${acWhy ? ` - last trigger: ${acWhy}` : ''}\n` : '';

    const aDrillOn = !!state.director?.autoDrills;
    const aDrillWhy = String(state.director?.autoDrillsWhy ?? '').trim();
    const aDrillLine = aDrillOn ? `Auto drills: ON${aDrillWhy ? ` - ${aDrillWhy}` : ''}\n` : '';

    const aCouncilOn = !!state.director?.autoCouncil;
    const aCouncilWhy = String(state.director?.autoCouncilWhy ?? '').trim();
    const aCouncilLine = aCouncilOn ? `Auto council: ON${aCouncilWhy ? ` - ${aCouncilWhy}` : ''}\n` : '';

    const aDPOn = !!state.director?.autoDangerPause;
    const aDPWhy = String(state.director?.autoDangerPauseWhy ?? '').trim();
    const aDPLine = aDPOn ? `Auto pause (danger): ON${aDPWhy ? ` - ${aDPWhy}` : ''}\n` : '';

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
      pinLine +
      autLine +
      amLine +
      abLine +
      apLine +
      adLine +
      aRatLine +
      arLine +
      acLine +
      aDrillLine +
      aCouncilLine +
      aDPLine +
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
    renderGovLog(state);
    renderCouncil(state, targets);
    renderFactions(state);
    renderBlocHealth(state);

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
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood:1.00, prioSafety:1.00, prioProgress:1.00, prioSocial:1.00 };
    if (!('prioFood' in state.director)) state.director.prioFood = 1.00;
    if (!('prioSafety' in state.director)) state.director.prioSafety = 1.00;
    if (!('prioProgress' in state.director)) state.director.prioProgress = 1.00;
    if (!('prioSocial' in state.director)) state.director.prioSocial = 1.00;

    const prFoodMul = prioMul(state,'prioFood');
    const prSafetyMul = prioMul(state,'prioSafety');
    const prProgMul = prioMul(state,'prioProgress');
    const prSocMul = prioMul(state,'prioSocial');

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

    const prSocEl = el('prioSocial');
    if (prSocEl) prSocEl.value = String(Math.round(prSocMul*100/5)*5);
    const prSocH = el('prioSocialHint');
    if (prSocH) prSocH.textContent = `${Math.round(prSocMul*100)}% | biases Socialize/Care (mood+dissent stability)`;

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

    renderDirectiveTools({
      state,
      dirHintEl: el('dirToolsHint'),
      btnMatchEl: el('btnDirBloc'),
      btnClearEl: el('btnDirClearAll'),
      countActiveDirectives,
    });

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

    // ── Colony Kitten Cards ───────────────────────────────────────────────────
    // Sorting + filtering is purely UI/QoL: it does not affect simulation and is not saved.

    // Visual throttle: hold displayed decision/task for ≥3s so cards don't flash.
    if (!window._kittenDisplayCache) window._kittenDisplayCache = {};
    const displayCache = window._kittenDisplayCache;
    const DISPLAY_HOLD_MS = 3000;

    const entries = state.kittens.map((k, idx) => ({ k, idx }));

    function sortValFor(k, key){
      const kk = k || {};
      switch(String(key || '')){
        case 'name': return String(kk.name ?? '');
        case 'role': return String(kk.role ?? '');
        case 'task': return String((kk._fallbackTo ? kk._fallbackTo : (kk.task ?? '')));
        case 'energy': return Number(kk.energy ?? 0);
        case 'hunger': return Number(kk.hunger ?? 0);
        case 'health': return Number(kk.health ?? 1);
        case 'mood': return Number(kk.mood ?? 0.55);
        case 'griev': return Number(kk.grievance ?? 0);
        case 'eff': return efficiency(state, kk);
        case 'apt': {
          const top = topSkillInfo(kk);
          return Number(top.level ?? 1);
        }
        case 'bloc': return String(dominantValueAxis(kk) ?? '');
        case 'fit': return valuesAlignment01(state, kk);
        case 'buddy': return Number(kk.buddyNeed ?? 0);
        default: return 0;
      }
    }

    if (uiSort.key && uiSort.dir) {
      const key = uiSort.key;
      const dir = uiSort.dir;
      entries.sort((a,b) => {
        const av = sortValFor(a.k, key);
        const bv = sortValFor(b.k, key);
        if (typeof av === 'number' && typeof bv === 'number') {
          const an = Number.isFinite(av) ? av : 0;
          const bn = Number.isFinite(bv) ? bv : 0;
          if (an !== bn) return (an - bn) * dir;
          return (a.idx - b.idx);
        }
        const as = String(av ?? '');
        const bs = String(bv ?? '');
        if (as !== bs) return as.localeCompare(bs) * dir;
        return (a.idx - b.idx);
      });
    }

    // Text filter
    const filterText = uiFilter?.text ?? '';
    const filtered = filterText
      ? entries.filter(({ k }) => {
          const hay = [
            k.name, k.role, k.task, k._fallbackTo,
            ...(Array.isArray(k.traits) ? k.traits : []),
            k.why,
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(filterText);
        })
      : entries;

    if (_ccEl) _ccEl.textContent = filterText
      ? `${filtered.length} / ${entries.length}`
      : `${entries.length} kittens`;

    if (kittenGridEl) {
      // Throttle radar re-renders (skills change slowly)
      const now = performance.now();
      const radarInterval = 2000; // ms
      if (!kittenGridEl._lastRadarT) kittenGridEl._lastRadarT = 0;
      const redrawRadar = (now - kittenGridEl._lastRadarT) > radarInterval;
      if (redrawRadar) kittenGridEl._lastRadarT = now;

      // Build/update cards
      // For performance: reuse existing card elements when possible
      const existingCards = kittenGridEl.querySelectorAll('.kitten-card');
      const existingMap = new Map();
      existingCards.forEach(c => existingMap.set(c.dataset.kidx, c));

      const usedKeys = new Set();
      const fragment = document.createDocumentFragment();

      for (const ent of filtered) {
        const kidx = ent.idx;
        const k = ent.k;
        const key = String(kidx);
        usedKeys.add(key);

        const top = topSkillInfo(k);
        const eff = efficiency(state, k);
        const mood = clamp01(Number(k.mood ?? 0.55));
        const energy = clamp01(Number(k.energy ?? 0));
        const hunger = clamp01(Number(k.hunger ?? 0));
        const health = clamp01(Number(k.health ?? 1));
        const traits = normalizeTraits(k.traits, Number(k.id ?? 1));
        const buddy = buddyOf(state, k);
        const buddyNeedPct = Math.round(clamp01(Number(k.buddyNeed ?? 0)) * 100);
        const align = valuesAlignment01(state, k);
        const fitPct = Math.round(align * 100);
        const bloc = dominantValueAxis(k);

        const d = (k && typeof k === 'object') ? (k._lastDecision ?? null) : null;

        // Visual throttle: hold decision display for DISPLAY_HOLD_MS so labels don't flash
        const cacheKey = k.id;
        const now = performance.now();
        const cached = displayCache[cacheKey];
        let displayTask = k.task ?? '';
        let displayKind = String(d?.kind ?? 'score');
        let displayFallback = k._fallbackTo || '';

        if (cached && (now - cached.setAt) < DISPLAY_HOLD_MS) {
          // Hold the cached display values
          displayTask = cached.task;
          displayKind = cached.kind;
          displayFallback = cached.fallback;
        } else if (!cached || displayTask !== cached.task || displayKind !== cached.kind) {
          // New decision or cache expired with a change — update cache
          displayCache[cacheKey] = { task: displayTask, kind: displayKind, fallback: displayFallback, setAt: now };
        }
        // else: cache expired but nothing changed — refresh timer
        else { displayCache[cacheKey].setAt = now; }

        const decLabel = (displayKind === 'rule') ? 'RULE' : (displayKind === 'emergency') ? 'EMERG' : (displayKind === 'commit') ? 'COMMIT' : '';
        const blockedFresh = !!displayFallback;

        // Task display
        let taskText = escapeHtml(displayTask);
        if (k._mentor && displayTask === 'Mentor') taskText += ` → #${k._mentor.id}`;
        if (displayFallback) taskText += ` → ${escapeHtml(displayFallback)}`;

        // Badges
        let badges = '';
        if (blockedFresh) badges += `<span class="tag" style="border-color:rgba(251,191,36,.35);color:var(--warn);font-size:10px">BLOCKED</span> `;
        if (decLabel) badges += `<span class="tag" style="font-size:10px">${decLabel}</span> `;

        // Vital bar helper
        const vBar = (label, val, color) => {
          const pct = Math.round(val * 100);
          return `<div class="kc-vital-row">
            <span class="kc-vital-label">${label}</span>
            <div class="kc-vital-bar"><div class="kc-vital-fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="kc-vital-val">${pct}%</span>
          </div>`;
        };

        // Fit color
        const fitColor = (fitPct >= 75) ? 'var(--good)' : (fitPct >= 55) ? 'var(--warn)' : 'var(--bad)';

        // Buddy string
        const buddyNameShort = buddy ? (String(buddy.name ?? '').trim().split(/\s+/).slice(-1)[0] || `#${buddy.id}`) : '';
        const buddyStr = buddy ? `Buddy: ${escapeHtml(buddyNameShort)} #${buddy.id} (${buddyNeedPct}%)` : '';

        // Warn classes
        const warnClass = (health < 0.4) ? ' warn-health' : (mood < 0.3) ? ' warn-mood' : '';
        const kittenPopUntil = Number(microUiFx.newKittenUntilById[k.id] ?? 0);
        const kittenPopClass = (kittenPopUntil > performance.now()) ? ' kitten-pop' : '';

        // Top skills compact
        const topSkills = Object.entries(k.skills || {}).sort((a,b) => b[1] - a[1]).slice(0, 1);
        const topSkillStr = topSkills.length ? `${topSkills[0][0]}:${topSkills[0][1]}` : '-';

        const cardHTML = `
          <div class="kc-header">
            <span class="kc-name">${escapeHtml(k.name ?? ('Kitten ' + k.id))} <span class="tag" style="font-size:10px">#${k.id}</span></span>
            <span class="kc-role">${escapeHtml(k.role ?? '-')}</span>
          </div>
          <div class="kc-task${blockedFresh ? ' blocked' : ''}">
            <span class="kc-task-label">${taskText}</span>
            ${badges}
          </div>
          <div class="kc-vitals">
            ${vBar('E', energy, '#34d399')}
            ${vBar('HP', health, '#fb7185')}
            ${vBar('H', hunger, '#fbbf24')}
            ${vBar('M', mood, '#c4b5fd')}
          </div>
          <div class="kc-middle">
            <canvas class="kc-radar" width="100" height="100"></canvas>
            <div class="kc-stats">
              <div class="kc-stat-line"><span class="kc-stat-k">Eff</span><span class="kc-stat-v">${fmt(eff * 100)}%</span></div>
              <div class="kc-stat-line"><span class="kc-stat-k">Top</span><span class="kc-stat-v">${escapeHtml(topSkillStr)}</span></div>
              <div class="kc-stat-line"><span class="kc-stat-k">Bloc</span><span class="kc-stat-v"><span class="tag">${escapeHtml(bloc)}</span></span></div>
              <div class="kc-stat-line"><span class="kc-stat-k">Fit</span><span class="kc-stat-v"><span class="tag" style="border-color:${fitColor};color:${fitColor}">${fitPct}%</span></span></div>
            </div>
          </div>
          <div class="kc-footer">
            ${traits.length ? `<div class="kc-traits">${escapeHtml(traits.join(', '))}</div>` : ''}
            ${buddyStr ? `<div class="kc-buddy">${buddyStr}</div>` : ''}
            <div class="kc-why">${escapeHtml(k.why ?? '')}</div>
          </div>
        `;

        let card = existingMap.get(key);
        if (card) {
          // Reuse existing card, update content
          card.className = `kitten-card${warnClass}${kittenPopClass}`;
          card.innerHTML = cardHTML;
          fragment.appendChild(card);
          existingMap.delete(key);
        } else {
          card = document.createElement('div');
          card.className = `kitten-card${warnClass}${kittenPopClass}`;
          card.dataset.kidx = key;
          card.innerHTML = cardHTML;
          fragment.appendChild(card);
        }

        // Render mini radar (throttled)
        if (redrawRadar) {
          const radarCanvas = card.querySelector('.kc-radar');
          if (radarCanvas) {
            try { renderRadar(radarCanvas, k); } catch (_) {}
          }
        }
      }

      const nowMs = performance.now();
      for (const id of Object.keys(microUiFx.newKittenUntilById)) {
        if (Number(microUiFx.newKittenUntilById[id] ?? 0) <= nowMs) delete microUiFx.newKittenUntilById[id];
      }

      // Clear stale cards and append new fragment
      kittenGridEl.innerHTML = '';
      kittenGridEl.appendChild(fragment);
    }

    // safety rules (read-only unless Developer Mode)
    ensureCurator(state);
    const rulesRO = !state.director?.curator?.devMode;
    if (rulesControlsEl) rulesControlsEl.style.display = rulesRO ? 'none' : '';

    rulesEl.innerHTML = '';
    state.rules.forEach((r, idx) => {
      const box = document.createElement('div');
      box.className = 'rule';
      const btns = rulesRO
        ? `<span class="small" style="opacity:.7">(read-only)</span>`
        : `<button class="btn" data-act="up" data-i="${idx}">↑</button>
           <button class="btn" data-act="down" data-i="${idx}">↓</button>
           <button class="btn bad" data-act="del" data-i="${idx}">Delete</button>`;
      box.innerHTML = `
        <div class="top">
          <div class="row">
            <label class="small"><input type="checkbox" data-act="toggle" data-i="${idx}" ${rulesRO?'disabled':''}> enabled</label>
            <span class="tag">#${idx+1}</span>
          </div>
          <div class="row">${btns}</div>
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
      const cb = box.querySelector('input[data-act="toggle"]');
      if (cb) cb.checked = !!r.enabled;
    });

    logEl.textContent = state.log.slice(-40).join('\n');
    logEl.scrollTop = logEl.scrollHeight;

    // Society feed scroll follows newest entries.
    if (feedEl) {
      feedEl.textContent = (Array.isArray(state.feed) ? state.feed : []).slice(-180).join('\n');
      feedEl.scrollTop = feedEl.scrollHeight;
    }

    // Canvas HUDs
    renderTank();
    renderTrends();
    syncGraphDashboardUI();
    if (state.director.graphTab === 'population') renderPopTrends();
    else if (state.director.graphTab === 'culture') renderCulTrends();
    else renderSocTrends();

    // Keep inspectors in sync with latest snapshots.
    renderInspect();
    patchNotesUI.render();
    societyUI?.renderAll?.();
  }

  function escapeHtml(s){
    return String(s)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#39;');
  }
  function phaseFromLevel(level, p1, p2){
    const lv = Math.max(0, Number(level ?? 0) || 0);
    if (lv < p1) return 'early';
    if (lv < p2) return 'mid';
    return 'late';
  }

  function applySoftCap(value, threshold, tailPow){
    const v = Math.max(0, Number(value ?? 0) || 0);
    const th = Math.max(1, Number(threshold ?? 1) || 1);
    const pow = Math.max(0.15, Number(tailPow ?? 0.6) || 0.6);
    if (v <= th) return v;
    return th + Math.pow(v - th, pow);
  }

  function getUpgradeCost(baseCost, level, opts){
    const cfg = opts && typeof opts === 'object' ? opts : {};
    const base = Math.max(1, Number(baseCost ?? 1) || 1);
    const lv = Math.max(0, Number(level ?? 0) || 0);
    const p1 = Math.max(1, Number(cfg.phase1At ?? 18) || 18);
    const p2 = Math.max(p1 + 1, Number(cfg.phase2At ?? 48) || 48);
    const earlyMul = Math.max(1.01, Number(cfg.earlyMul ?? 1.16) || 1.16);
    const midMul = Math.max(1.01, Number(cfg.midMul ?? 1.19) || 1.19);
    const lateMul = Math.max(1.01, Number(cfg.lateMul ?? 1.23) || 1.23);

    const phase = phaseFromLevel(lv, p1, p2);
    let expo = 0;
    if (phase === 'early') {
      expo = lv;
    } else if (phase === 'mid') {
      expo = p1 + (lv - p1);
    } else {
      expo = p1 + (p2 - p1) + (lv - p2);
    }

    const phaseGrowth =
      (phase === 'early') ? Math.pow(earlyMul, expo)
      : (phase === 'mid') ? Math.pow(earlyMul, p1) * Math.pow(midMul, lv - p1)
      : Math.pow(earlyMul, p1) * Math.pow(midMul, p2 - p1) * Math.pow(lateMul, lv - p2);

    const softCapAt = Math.max(10, Number(cfg.softCapAt ?? 2000) || 2000);
    const softTailPow = Math.max(0.15, Number(cfg.softTailPow ?? 0.62) || 0.62);
    const afterSoftCap = applySoftCap(base * phaseGrowth, softCapAt, softTailPow);

    const legacyMul = Math.max(0.1, Number(cfg.legacyMul ?? 1) || 1);
    const eternityMul = Math.max(0.1, Number(cfg.eternityMul ?? 1) || 1);
    const breakthroughMul = Math.max(0.1, Number(cfg.breakthroughMul ?? 1) || 1);

    return {
      phase,
      raw: base * phaseGrowth,
      cost: Math.max(1, Math.floor(afterSoftCap * legacyMul * eternityMul * breakthroughMul)),
    };
  }

  function getPacingBreakthroughs(s){
    const legacyResets = Math.max(0, Number(s?.legacy?.resets ?? 0) || 0);
    const eternityResets = Math.max(0, Number(s?.eternity?.resets ?? 0) || 0);
    const totalShards = Math.max(0, Number(s?.legacy?.totalShards ?? 0) || 0);
    const unlockedTechs = Object.values(s?.research?.unlocked ?? {}).filter(Boolean).length;
    return {
      legacyMomentum: legacyResets >= 2,
      shardMastery: totalShards >= 80,
      doctrineLift: unlockedTechs >= 10,
      eternityEcho: eternityResets >= 1,
    };
  }

  function kittenCost(){
    const n = Math.max(0, Number(state.kittens?.length ?? 0));
    const expo = Math.max(0, n - 3);
    const legacyResets = Math.max(0, Number(state?.legacy?.resets ?? 0) || 0);
    const eternityResets = Math.max(0, Number(state?.eternity?.resets ?? 0) || 0);
    const breakthroughs = getPacingBreakthroughs(state);

    let breakthroughMul = 1;
    if (breakthroughs.legacyMomentum) breakthroughMul *= 0.97;
    if (breakthroughs.shardMastery) breakthroughMul *= 0.96;
    if (breakthroughs.doctrineLift) breakthroughMul *= 0.96;
    if (breakthroughs.eternityEcho) breakthroughMul *= 0.92;

    const { cost } = getUpgradeCost(35, expo, {
      phase1At: 16,
      phase2At: 46,
      earlyMul: 1.16,
      midMul: 1.20,
      lateMul: 1.24,
      softCapAt: 1700,
      softTailPow: 0.60,
      legacyMul: Math.pow(0.988, legacyResets),
      eternityMul: Math.pow(0.95, eternityResets),
      breakthroughMul,
    });

    return Math.max(10, cost);
  }

  function renderTank(){
    if (!tankEl) return;
    const ctx = tankEl.getContext('2d');
    if (!ctx) return;

    const W = tankEl.width, H = tankEl.height;
    ctx.clearRect(0,0,W,H);

    // Zones (no pathing): kittens snap to task zones so it feels like an aquarium.
    const zones = [
      { id:'Hearth',   x:10, y:10,  w:W*0.42-15, h:H*0.45-15, color:'rgba(251,191,36,.08)' },
      { id:'Stock',    x:W*0.42, y:10, w:W*0.58-20, h:H*0.28-15, color:'rgba(125,211,252,.06)' },
      { id:'Forest',   x:10, y:H*0.45, w:W*0.36-15, h:H*0.55-20, color:'rgba(52,211,153,.06)' },
      { id:'Fields',   x:W*0.36, y:H*0.45, w:W*0.32-10, h:H*0.55-20, color:'rgba(34,211,238,.04)' },
      { id:'Study',    x:W*0.68, y:H*0.28, w:W*0.32-20, h:H*0.72-30, color:'rgba(167,139,250,.05)' },
    ];

    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';

    for (const z of zones) {
      ctx.fillStyle = z.color;
      ctx.strokeStyle = 'rgba(255,255,255,.10)';
      ctx.lineWidth = 1;
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      ctx.fillStyle = 'rgba(148,163,184,.95)';
      ctx.fillText(z.id, z.x + 6, z.y + 6);
    }

    const taskZone = (task) => {
      const t = String(task || '');
      if (t === 'StokeFire' || t === 'Eat' || t === 'Rest' || t === 'Care' || t === 'Socialize') return 'Hearth';
      if (t === 'Forage' || t === 'ChopWood' || t === 'Guard') return 'Forest';
      if (t === 'Farm') return 'Fields';
      if (t === 'Research' || t === 'Mentor') return 'Study';
      if (t.startsWith('Build') || t === 'CraftTools' || t === 'PreserveFood') return 'Stock';
      return 'Hearth';
    };

    // Place kittens as dots in their zone.
    const byZone = Object.create(null);
    for (const z of zones) byZone[z.id] = [];
    for (const k of (state.kittens ?? [])) {
      const z = taskZone(k._fallbackTo || k.task);
      (byZone[z] ?? (byZone[z]=[])).push(k);
    }

    for (const z of zones) {
      const arr = byZone[z.id] ?? [];
      const showN = Math.min(arr.length, 12);
      for (let i=0;i<showN;i++) {
        const k = arr[i];
        const nx = (i % 4);
        const ny = Math.floor(i / 4);
        const px = z.x + 20 + nx * 22;
        const py = z.y + 28 + ny * 18;
        ctx.fillStyle = 'rgba(217,226,239,.95)';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI*2);
        ctx.fill();
        ctx.fillStyle = 'rgba(217,226,239,.75)';
        const name = String(k?.name ?? `#${k.id}`);
        const short = name.split(/\s+/).slice(-1)[0] || name;
        ctx.fillText(short, px + 6, py - 6);
      }
      if (arr.length > showN) {
        ctx.fillStyle = 'rgba(148,163,184,.85)';
        ctx.fillText(`+${arr.length - showN}`, z.x + z.w - 34, z.y + 6);
      }
    }
  }

    function renderStacked(canvasEl, store, rows, opts={}){
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    const W = canvasEl.width, H = canvasEl.height;
    ctx.clearRect(0,0,W,H);
    if (!store || !store.t || store.t.length < 2) return;

    const pad = 10;
    const plotW = W - pad*2;
    const n = store.t.length;
    const rowH = Math.floor((H - pad*2) / rows.length);
    const xFor = (i) => pad + (i/(n-1))*plotW;

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';

    for (let r=0;r<rows.length;r++){
      const row = rows[r];
      const arr = store[row.key] || [];
      if (arr.length !== n) continue;
      const y0 = pad + r*rowH;
      const y1 = y0 + rowH - 6;

      let min=Infinity, max=-Infinity;
      for (const v0 of arr){ const v=Number(v0); if (!Number.isFinite(v)) continue; min=Math.min(min,v); max=Math.max(max,v); }
      if (row.scale01){ min=0; max=1; }
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      if (Math.abs(max-min) < 1e-6) max = min + 1;
      const padY = (max-min)*0.10;
      min -= padY; max += padY;

      const yFor = (v) => {
        const t = (Number(v)-min)/(max-min);
        return y0 + (1 - clamp01(t)) * (y1-y0);
      };

      // bg
      ctx.fillStyle = 'rgba(0,0,0,.06)';
      ctx.fillRect(pad, y0, plotW, (y1-y0));
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.strokeRect(pad, y0, plotW, (y1-y0));

      // line
      ctx.strokeStyle = row.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i=0;i<n;i++){
        const x=xFor(i);
        const y=yFor(arr[i]);
        if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();

      // label + now
      const last = Number(arr[n-1] ?? 0);
      ctx.fillStyle = 'rgba(148,163,184,.95)';
      const val = row.fmt01 ? row.fmt01(last) : (row.scale01 ? (last*100).toFixed(0)+'%' : fmt(last));
      ctx.fillText(`${row.label}: ${val}`, pad+4, y0+2);
    }
  }

  function renderPopTrends(){
    renderStacked(popTrendsEl, state._popTrend, [
      { key:'pop', label:'Pop', color:'rgba(52,211,153,.95)' },
      { key:'cap', label:'Cap', color:'rgba(148,163,184,.70)' },
      { key:'births', label:'Birth/s', color:'rgba(34,211,238,.90)' },
      { key:'wander', label:'Wander/s', color:'rgba(16,185,129,.80)' },
      { key:'ediblePk', label:'Edible/kit', color:'rgba(251,191,36,.90)' },
    ]);
  }

  function renderSocTrends(){
    renderStacked(socTrendsEl, state._socTrend, [
      { key:'mood', label:'Mood', color:'rgba(52,211,153,.95)', scale01:true },
      { key:'griev', label:'Griev', color:'rgba(251,113,133,.90)', scale01:true },
      { key:'dissent', label:'Dissent', color:'rgba(167,139,250,.95)', scale01:true },
      { key:'compliance', label:'Compliance', color:'rgba(125,211,252,.95)' },
      { key:'threat', label:'Threat', color:'rgba(251,113,133,.85)' },
      { key:'warmth', label:'Warmth', color:'rgba(251,191,36,.90)' },
      { key:'science', label:'Sci', color:'rgba(125,211,252,.85)' },
    ]);
  }

  function renderCulTrends(){
    renderStacked(culTrendsEl, state._culTrend, [
      { key:'vig', label:'Vigilance', color:'rgba(251,113,133,.70)', scale01:true },
      { key:'scar', label:'Scarcity', color:'rgba(251,191,36,.80)', scale01:true },
      { key:'aid', label:'Mutual aid', color:'rgba(52,211,153,.80)', scale01:true },
      { key:'coteries', label:'Coteries', color:'rgba(167,139,250,.85)' },
      { key:'influential', label:'Influential', color:'rgba(139,92,246,.80)' },
      { key:'repAvg', label:'Rep avg', color:'rgba(148,163,184,.85)' },
      { key:'mlLoss', label:'ML loss', color:'rgba(125,211,252,.80)', fmt01:(v)=>Number(v).toFixed(3) },
      { key:'mlFood', label:'ML ? food', color:'rgba(52,211,153,.75)', fmt01:(v)=>Number(v).toFixed(2) },
      { key:'mlSafety', label:'ML ? safety', color:'rgba(251,191,36,.75)', fmt01:(v)=>Number(v).toFixed(2) },
      { key:'mlProg', label:'ML ? prog', color:'rgba(125,211,252,.75)', fmt01:(v)=>Number(v).toFixed(2) },
      { key:'mlSoc', label:'ML ? soc', color:'rgba(167,139,250,.75)', fmt01:(v)=>Number(v).toFixed(2) },
    ]);
  }
function renderTrends(){
    if (!trendsEl) return;
    const ctx = trendsEl.getContext('2d');
    if (!ctx) return;
    const W = trendsEl.width, H = trendsEl.height;
    ctx.clearRect(0,0,W,H);

    const tr = state._trend;
    if (!tr || !tr.t || tr.t.length < 2) return;

    const pad = 10;
    const rows = [
      { key:'food',   label:'Food',   color:'rgba(52,211,153,.95)', threshold: () => (seasonTargets(state).foodPerKitten * Math.max(1, state.kittens.length)) },
      { key:'warmth', label:'Warmth', color:'rgba(251,191,36,.95)', threshold: () => seasonTargets(state).warmth },
      { key:'threat', label:'Threat', color:'rgba(251,113,133,.95)', threshold: () => 100 },
      { key:'science',label:'Science',color:'rgba(125,211,252,.95)', threshold: () => (unlockDefs.find(u => !state.seenUnlocks?.[u.id])?.at ?? null) },
      { key:'dissent',label:'Dissent',color:'rgba(167,139,250,.95)', threshold: () => 0.45, scale01:true },
    ];

    const n = tr.t.length;
    const plotW = W - pad*2;
    const rowH = Math.floor((H - pad*2) / rows.length);

    // Event markers (season flips, raids, unlocks)
    const ev = Array.isArray(state._trendEvents) ? state._trendEvents : [];
    const tMin = tr.t[0];
    const tMax = tr.t[n-1];
    const xForT = (t) => pad + ((t - tMin) / Math.max(1e-6, (tMax - tMin))) * plotW;

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';

    for (let r=0;r<rows.length;r++) {
      const row = rows[r];
      const y0 = pad + r * rowH;
      const y1 = y0 + rowH - 6;

      // find min/max for this row
      const arr = tr[row.key] || [];
      if (arr.length !== n) continue;
      let min = Infinity, max = -Infinity;
      for (const v0 of arr) { const v = Number(v0); if (!Number.isFinite(v)) continue; min = Math.min(min,v); max = Math.max(max,v); }
      if (row.scale01) { min = 0; max = 1; }
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      if (Math.abs(max-min) < 1e-6) max = min + 1;
      const padY = (max-min) * 0.10;
      min -= padY; max += padY;

      const xFor = (i) => pad + (i/(n-1))*plotW;
      const yFor = (v) => {
        const t = (Number(v)-min)/(max-min);
        return y0 + (1 - clamp01(t)) * (y1 - y0);
      };

      // background
      ctx.fillStyle = 'rgba(0,0,0,.06)';
      ctx.fillRect(pad, y0, plotW, (y1 - y0));
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.strokeRect(pad, y0, plotW, (y1 - y0));

      // threshold line
      const thr = (typeof row.threshold === 'function') ? row.threshold() : null;
      if (thr !== null && thr !== undefined && Number.isFinite(Number(thr))) {
        const ty = yFor(Number(thr));
        ctx.strokeStyle = 'rgba(255,255,255,.12)';
        ctx.setLineDash([4,3]);
        ctx.beginPath(); ctx.moveTo(pad, ty); ctx.lineTo(pad+plotW, ty); ctx.stroke();
        ctx.setLineDash([]);
      }

      // event markers
      const mf = ensureTrendMarkerFilter(state);
      for (const e of ev) {
        const kind = String(e.kind ?? '');
        // Culture beats filter: let players isolate society markers from the resource lines.
        if ((kind === 'norm' || kind === 'cot' || kind === 'trad' || kind === 'eth' || kind === 'rep' || kind === 'press' || kind === 'rel') && !mf[kind]) continue;
        const tt = Number(e.t ?? NaN);
        if (!Number.isFinite(tt) || tt < tMin || tt > tMax) continue;
        const x = xForT(tt);
        ctx.strokeStyle = String(e.color || 'rgba(255,255,255,.10)');
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      }

      // line
      ctx.strokeStyle = row.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i=0;i<n;i++) {
        const x = xFor(i);
        const y = yFor(arr[i]);
        if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();

      // label + right-side min/max
      const last = Number(arr[n-1] ?? 0);
      const slope = (Number(arr[n-1]) - Number(arr[Math.max(0,n-6)]) ) / Math.max(1, Math.min(5, n-1));
      const slopeStr = (slope >= 0 ? '+' : '') + slope.toFixed(row.scale01 ? 3 : 1) + '/s';
      ctx.fillStyle = 'rgba(148,163,184,.95)';
      ctx.fillText(`${row.label}: ${row.scale01 ? (last*100).toFixed(0)+'%' : fmt(last)} (${slopeStr})`, pad+4, y0+2);
      ctx.fillStyle = 'rgba(148,163,184,.65)';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmt(max), pad+plotW-38, y0+12);
      ctx.textBaseline = 'top';
    }

    // ML hint (tiny)
    if (mlHintEl) {
      const ml = state.director?.ml;
      if (ml?.enabled) {
        const p = ml.lastPred || { food:0, safety:0, progress:0, social:0 };
        const ms = state.director?.mlSafety;
        const sTxt = (ms?.enabled && ms.last)
          ? ` | safety(hungry>${Number(ms.last.hungry).toFixed(2)}, tired>${Number(ms.last.tired).toFixed(2)}, warmth<${Number(ms.last.warmth).toFixed(0)}, threat>${Number(ms.last.threat).toFixed(0)})` + (ms.lastWhy ? ` (${ms.lastWhy})` : '')
          : '';
        mlHintEl.textContent = `ML priorities ?: food ${(p.food>=0?'+':'')+p.food.toFixed(2)} | safety ${(p.safety>=0?'+':'')+p.safety.toFixed(2)} | progress ${(p.progress>=0?'+':'')+p.progress.toFixed(2)} | social ${(p.social>=0?'+':'')+p.social.toFixed(2)} | loss ${Number(ml.lastLoss??0).toFixed(3)}` + sTxt;
      } else {
        mlHintEl.textContent = '';
      }
    }
  }

  function log(msg){
    // Optional suppression (used for offline simulation to avoid dumping 300 lines of season warnings).
    if (state?._suppressLog) {
      state._suppressedLogCount = (state._suppressedLogCount ?? 0) + 1;
      return;
    }

    state.log = Array.isArray(state.log) ? state.log : [];
    state.log.push(`[${fmt(state.t)}] ${msg}`);

    // Keep saves small + rendering fast (localStorage has tight limits).
    if (state.log.length > LOG_MAX) {
      state.log.splice(0, state.log.length - LOG_MAX);
    }
  }

  function feed(msg){
    state.feed = Array.isArray(state.feed) ? state.feed : [];
    state.feed.push(`[${fmt(state.t)}] ${msg}`);
    const FEED_MAX = 220;
    if (state.feed.length > FEED_MAX) state.feed.splice(0, state.feed.length - FEED_MAX);
  }

  // Simple one-shot toast at boot so the aquarium feels alive immediately.
  if (!state._fedHello) {
    state._fedHello = true;
    feed(`Curator goal: ${String(state.director?.curator?.goal ?? 'Thrive')} (${String(state.director?.curator?.ethos ?? 'Balanced')}).`);
  }

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
    state.director = state.director ?? {};
    state.director.policyLocks = state.director.policyLocks ?? {};

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

    const plan = state._lastPlan ?? null;
    const desiredNow = plan?.desired ? summarizePlan(plan.desired) : '';
    const desiredBase = plan?.desiredBase ? summarizePlan(plan.desiredBase) : '';

    const line = (label, a) => {
      const v = Number(state.policyMult[a] ?? 1);
      const val = Math.max(0, Math.min(2, Number.isFinite(v)?v:1));
      state.policyMult[a] = val;
      const disabled = lock(a);
      const isLocked = !!state.director?.policyLocks?.[a];

      const b = (plan && plan.desiredBase && (a in plan.desiredBase)) ? Number(plan.desiredBase[a] ?? 0) : null;
      const w = (plan && plan.desired && (a in plan.desired)) ? Number(plan.desired[a] ?? 0) : null;
      const planNote = (b !== null || w !== null)
        ? `<span class=\"small\" style=\"opacity:.75; margin-left:6px\" title=\"Plan preview for this action (without policy → with policy).\">plan ${b===null?'-':b}→${w===null?'-':w}</span>`
        : '';

      return `
        <div class="row" style="justify-content:space-between; gap:10px; margin-bottom:6px">
          <span class="small" style="min-width:110px">${label}${planNote}</span>
          <div class="row" style="gap:6px">
            <button class="btn" data-pol="dec" data-a="${a}" ${disabled?'disabled':''} title="Adjust multiplier. Shift=±0.50, Alt=±1.00, Ctrl/⌘=min/max.">-</button>
            <span class="small" style="display:inline-block; width:44px; text-align:center" title="Multiplier for ${a}. Tip: Shift=0.50 steps, Alt=1.00 steps, Ctrl/⌘ sets to min/max.">${val.toFixed(2)}</span>
            <button class="btn" data-pol="inc" data-a="${a}" ${disabled?'disabled':''} title="Adjust multiplier. Shift=±0.50, Alt=±1.00, Ctrl/⌘=min/max.">+</button>
            <button class="btn mode ${isLocked?'active':''}" data-pol="lock" data-a="${a}" title="Auto Policy will not modify this multiplier while locked.">${isLocked?'Locked':'Lock'}</button>
            <span class="small" style="opacity:.85">(0..2)</span>
          </div>
        </div>`;
    };

    const undo = policyUndoInfo(state);
    const undoRow = `
      <div class="row" style="justify-content:space-between; gap:10px; margin-bottom:10px; align-items:center">
        <div class="small" style="opacity:.9">
          <b>Undo</b>
          <span style="opacity:.85">(policy + role quotas)</span>
        </div>
        <div class="row" style="gap:8px">
          <button class="btn" data-policy-undo="1" ${undo.ok?'':'disabled'} title="Restores the last manual policy/role-quota change for ~2 minutes.">Undo</button>
          <span class="small" style="opacity:.8">${undo.ok ? `~${Math.ceil(undo.left)}s left${undo.reason?` • ${escapeHtml(undo.reason)}`:''}` : '—'}</span>
        </div>
      </div>
    `;

    const bulkRow = `
      <div class="row" style="justify-content:space-between; gap:10px; margin-bottom:10px; align-items:center">
        <div class="small" style="opacity:.9">
          <b>Policy locks</b>
          <span style="opacity:.85">(bulk)</span>
        </div>
        <div class="row" style="gap:8px; flex-wrap:wrap; justify-content:flex-end">
          <button class="btn" data-polbulk="lockBasics" title="Lock the basic survival levers (Forage/Farm/PreserveFood/ChopWood/StokeFire/Guard) so Auto Policy won\'t change them.">Lock basics</button>
          <button class="btn" data-polbulk="lockAll" title="Lock ALL policy multipliers so Auto Policy can\'t change them.">Lock all</button>
          <button class="btn" data-polbulk="unlockAll" title="Unlock ALL policy multipliers so Auto Policy can resume nudging them.">Unlock all</button>
        </div>
      </div>
    `;

    const head = undoRow + bulkRow + ((desiredNow || desiredBase) ? `
      <div class="small" style="margin-bottom:8px; opacity:.9">
        <b>Plan preview</b>
        <div class="why" style="margin-top:6px">${escapeHtml(desiredNow ? ('with policy: ' + desiredNow) : 'with policy: -')}${desiredBase ? ('\nwithout policy: ' + desiredBase) : ''}</div>
        <div class="small" style="opacity:.8; margin-top:6px">Tip: policy multipliers bias the colony plan; individual kittens may still diverge due to Autonomy, traits, and needs.</div>
      </div>
    ` : '');

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

    const footer = `<div class="row" style="margin-top:8px; justify-content:space-between; align-items:center">
      <span class="small" style="opacity:.9">Tip: quotas work best with policy multipliers (e.g., set Builder quota=1 + BuildHut mult=1.5).</span>
      <div class="row" style="gap:6px; flex-wrap:wrap; justify-content:flex-end">
        <button class="btn" data-rqpreset="Stable" title="Quick role-quotas for a stable colony (food+wood+warmth+guard as needed).">Preset: Stable</button>
        <button class="btn" data-rqpreset="Advance" title="Quick role-quotas for research/industry (keeps a scholar/toolsmith/builder online when unlocked).">Preset: Advance</button>
        <button class="btn" id="btnRoleQuotaReset" title="Set all role quotas back to 0.">Reset</button>
      </div>
    </div>`;

    roleQuotasEl.innerHTML = rows.map(([label,id,ok]) => line(label,id,ok)).join('') + footer;

    // One-off bind for the reset button inside this panel.
    const rb = roleQuotasEl.querySelector('#btnRoleQuotaReset');
    if (rb) rb.onclick = () => {
      recordPolicyUndo(state, 'role quotas reset');
      state.roleQuota = { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
      log('Role quotas reset (all 0).');
      save();
      render();
    };
  }


  function applyRoleQuotaPreset(s, name){
    // Record undo snapshot BEFORE applying a preset.
    recordPolicyUndo(s, `role quota preset ${name}`);

    s.roleQuota = s.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };

    const n = Math.max(1, Number(s.kittens?.length ?? 1) || 1);
    const season = seasonAt(s.t);
    const targets = seasonTargets(s);
    const foodPk = ediblePerKitten(s);
    const warmth = Number(s.res?.warmth ?? 0);
    const threat = Number(s.res?.threat ?? 0);

    const next = { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };

    if (name === 'Stable') {
      // Stabilize basics first; quotas are gentle targets (not locks).
      // Always keep some food + wood online; add warmth + guard when pressured.
      next.Forager = 1;
      if (s.unlocked?.farm) next.Farmer = (foodPk < targets.foodPerKitten * 0.95) ? 1 : 0;
      next.Woodcutter = 1;
      next.Firekeeper = (season.name === 'Winter' || warmth < targets.warmth - 6) ? 1 : 0;
      next.Guard = (threat > targets.maxThreat * 0.85 || s.signals?.ALARM) ? 1 : 0;
      next.Builder = (s.unlocked?.construction && ((s.kittens?.length ?? 0) >= housingCap(s) || s.signals?.BUILD)) ? 1 : 0;
      next.Scholar = (n >= 5) ? 1 : 0;
      next.Toolsmith = (s.unlocked?.workshop && (Number(s.res?.tools ?? 0) < n * 8) && (Number(s.res?.science ?? 0) > getReserve(s,'science') + 10)) ? 1 : 0;
    }

    if (name === 'Advance') {
      // Keep compounding engines online (Scholar/Toolsmith/Builder) while not dropping basics.
      next.Forager = 1;
      if (s.unlocked?.farm) next.Farmer = 1;
      next.Woodcutter = 1;
      next.Firekeeper = (season.name === 'Winter') ? 1 : 0;
      next.Scholar = 1;
      next.Toolsmith = s.unlocked?.workshop ? 1 : 0;
      next.Builder = s.unlocked?.construction ? 1 : 0;
      next.Guard = (threat > targets.maxThreat * 0.92 || s.signals?.ALARM) ? 1 : 0;
    }

    // Clamp to population and to unlocks.
    if (!s.unlocked?.farm) next.Farmer = 0;
    if (!s.unlocked?.construction) next.Builder = 0;
    if (!s.unlocked?.workshop) next.Toolsmith = 0;

    for (const k of Object.keys(next)) next[k] = Math.max(0, Math.min(99, Number(next[k] ?? 0) | 0));

    // If the preset exceeds population, shave in a predictable order.
    const shaveOrder = ['Firekeeper','Guard','Toolsmith','Builder','Scholar','Woodcutter','Farmer','Forager'];
    let sum = Object.values(next).reduce((a,b)=>a+b,0);
    while (sum > n) {
      let changed = false;
      for (const k of shaveOrder) {
        if (sum <= n) break;
        if ((next[k] ?? 0) > 0) { next[k] -= 1; sum -= 1; changed = true; }
      }
      if (!changed) break;
    }

    s.roleQuota = next;
    log(`Role quota preset → ${name} (${Object.entries(next).filter(([,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(', ') || 'all 0'})`);
    save();
    render();
  }

  function condEditor(cond, idx){
    ensureCurator(state);
    const ro = !state.director?.curator?.devMode;
    const type = cond.type;
    const opts = [
      ['always','always'],
      ['hungry_gt','hungry >'],
      ['tired_gt','tired >'],
      ['health_lt','health <'],
      ['food_lt','food <'],
      ['edible_lt','edible <'],
      ['wood_lt','wood <'],
      ['warmth_lt','warmth <'],
      ['threat_gt','threat >'],
      ['foodperkitten_lt','food/kitten <'],
      ['signal','signal(...)'],
      ['threat_gt_or_alarm','threat> OR ALARM'],
    ];
    const sel = `<select data-act="condType" data-i="${idx}" ${ro?'disabled':''}>${opts.map(([v,l])=>`<option value="${v}" ${v===type?'selected':''}>${l}</option>`).join('')}</select>`;
    let extra = '';
    if (['hungry_gt','tired_gt','health_lt'].includes(type)) extra = `<input type="number" min="0" max="1" step="0.05" value="${cond.v}" data-act="condV" data-i="${idx}" style="width:90px" ${ro?'disabled':''}>`;
    else if (['food_lt','edible_lt','wood_lt','warmth_lt','threat_gt','foodperkitten_lt'].includes(type)) extra = `<input type="number" min="0" step="1" value="${cond.v}" data-act="condV" data-i="${idx}" style="width:90px" ${ro?'disabled':''}>`;
    else if (type === 'signal') extra = `<select data-act="condV" data-i="${idx}" ${ro?'disabled':''}>${['BUILD','FOOD','ALARM'].map(s=>`<option value="${s}" ${String(cond.v)===s?'selected':''}>${s}</option>`).join('')}</select>`;
    return sel + extra;
  }

  function actEditor(act, idx){
    ensureCurator(state);
    const ro = !state.director?.curator?.devMode;
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
    return `<select data-act="actType" data-i="${idx}" ${ro?'disabled':''}>${opts.map(v=>`<option value="${v}" ${act.type===v?'selected':''}>${v}</option>`).join('')}</select>`;
  }

  // --- Buttons / Inputs
  document.getElementById('btnPause').addEventListener('click', () => {
    togglePause();
  });

  const soundBtn = document.getElementById('btnSound');
  if (soundBtn) soundBtn.addEventListener('click', () => {
    ensureAudioState(state);
    state.sound.enabled = !state.sound.enabled;
    playSfx('toggle');
    log(`Sound effects ${state.sound.enabled ? 'enabled' : 'disabled'}.`);
    save();
    render();
  });

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#btnSound')) return;
    if (target.closest('button, .btn, .mode')) playSfx('click');
  }, { capture:true });

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const incidentChoice = target.closest('[data-incident-choice]');
    if (incidentChoice) {
      e.preventDefault();
      const id = String(incidentChoice.getAttribute('data-incident-choice') ?? '');
      if (applyFieldIncidentChoice(state, id)) render();
      return;
    }

    const hit = target.closest('#activePlayEventBtn');
    if (!hit) return;
    e.preventDefault();
    if (claimActivePlayEvent(state)) render();
  });

  // --- Save export/import/reset (moved behind UI boundary)
  initSaveIO({
    saveKey: SAVE_KEY,
    save,
    load,
    defaultState,
    getState: () => state,
    setState: (next) => { state = next; },
    log,
    render,
    btnResetEl: document.getElementById('btnReset'),
    btnExportEl: document.getElementById('btnExport'),
    btnImportEl: document.getElementById('btnImport'),
  });

  document.getElementById('btnTick').addEventListener('click', () => { for (let i=0;i<100;i++) step(0.1); render(); });

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
        prioSocial: prioMul(state,'prioSocial'),
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
      if ('prioSocial' in snap.director) state.director.prioSocial = Math.max(0.50, Math.min(1.50, Number(snap.director.prioSocial ?? 1.00) || 1.00));
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
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRecruit:false, autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', autoDangerPause:false, autoDangerPauseNextAt:0, autoDangerPauseWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, workPace: 1.00 };
    state.director.autoDrills = !!e.target.checked;
    if (state.director.autoDrills) state.director.autoDrillsNextAt = 0;
    state.director.autoDrillsWhy = '';
    log(`Auto Drills → ${state.director.autoDrills ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoCouncilEl = document.getElementById('autoCouncil');
  if (autoCouncilEl) autoCouncilEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRecruit:false, autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', autoCouncil:false, autoCouncilNextAt:0, autoCouncilWhy:'', autoDangerPause:false, autoDangerPauseNextAt:0, autoDangerPauseWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, workPace: 1.00 };
    state.director.autoCouncil = !!e.target.checked;
    if (state.director.autoCouncil) state.director.autoCouncilNextAt = 0;
    state.director.autoCouncilWhy = '';
    log(`Auto Council → ${state.director.autoCouncil ? 'ON' : 'OFF'}`);
    save();
    render();
  });

  const autoDPauseEl = document.getElementById('autoDangerPause');
  if (autoDPauseEl) autoDPauseEl.addEventListener('change', (e) => {
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRecruit:false, autoCrisis:false, autoCrisisTriggered:false, autoCrisisNextChangeAt:0, autoCrisisWhy:'', autoDrills:false, autoDrillsNextAt:0, autoDrillsWhy:'', autoDangerPause:false, autoDangerPauseNextAt:0, autoDangerPauseWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, workPace: 1.00 };
    state.director.autoDangerPause = !!e.target.checked;
    if (state.director.autoDangerPause) state.director.autoDangerPauseNextAt = 0;
    state.director.autoDangerPauseWhy = '';
    log(`Auto Pause (danger) → ${state.director.autoDangerPause ? 'ON' : 'OFF'}`);
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

  const clearPinEl = document.getElementById('btnClearPin');
  if (clearPinEl) clearPinEl.addEventListener('click', () => {
    clearPinnedProject(state, 'Pinned project cleared.');
    save();
    render();
  });

  const pinSelEl = document.getElementById('pinProjectSelect');
  if (pinSelEl) pinSelEl.addEventListener('change', () => {
    // Pure UI; real pin happens on button press (keeps it hard to misclick).
    render();
  });

  const pinBtnEl = document.getElementById('btnPinProject');
  if (pinBtnEl) pinBtnEl.addEventListener('click', () => {
    const sel = String(document.getElementById('pinProjectSelect')?.value || '');
    if (!sel) { log('Pick a project to pin.'); render(); return; }

    const def = pinnedProjectDef(sel);
    if (!def) { log('Pin failed: unknown project.'); render(); return; }

    state.director = state.director ?? { projectFocus:'Auto' };

    // Only meaningful once Construction exists.
    if (!state.unlocked?.construction) { log('Unlock Construction before pinning projects.'); render(); return; }

    const startOwned = Number(def.owned?.(state) ?? 0);
    state.director.pinnedProject = { type: def.type, startOwned, at: state.t };

    // Convenience: pin also sets focus to the matching track.
    if (def.focus) state.director.projectFocus = def.focus;

    log(`Pinned project: ${def.type} (finish 1).`);
    save();
    render();
  });

  document.getElementById('btnAddKitten').addEventListener('click', (e) => {
    const cost = kittenCost();
    if (state.res.food < cost) { playSfx('error'); log(`Need ${cost} food for a kitten.`); render(); return; }
    if (state.kittens.length >= housingCap(state)) { playSfx('error'); log(`No housing. Build huts.`); render(); return; }
    state.res.food -= cost;
    const id = state.kittens.length ? Math.max(...state.kittens.map(k=>k.id))+1 : 1;
    state.kittens.push(makeKitten(id, state.t));
    microUiFx.newKittenUntilById[id] = performance.now() + 1400;
    playMicroClass(e.currentTarget, 'purchase-confirm', 520);
    playSfx('kitten');
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
    uiDebouncedLog('discipline', `Discipline → ${Math.round(state.director.discipline * 100)}%`);
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
    uiDebouncedLog('workPace', `Work pace → ${Math.round(state.director.workPace * 100)}%`);
    save();
    render();
  });

  // Director priorities (Food/Safety/Progress/Social)
  const prioFoodInput = document.getElementById('prioFood');
  if (prioFoodInput) prioFoodInput.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00, prioSocial: 1.00 };
    const pct = Math.max(50, Math.min(150, Number(e.target.value) || 100));
    state.director.prioFood = Math.max(0.50, Math.min(1.50, pct / 100));
    uiDebouncedLog('prioFood', `Priority (Food) → ${Math.round(state.director.prioFood * 100)}%`);
    save();
    render();
  });

  const prioSafetyInput = document.getElementById('prioSafety');
  if (prioSafetyInput) prioSafetyInput.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00, prioSocial: 1.00 };
    const pct = Math.max(50, Math.min(150, Number(e.target.value) || 100));
    state.director.prioSafety = Math.max(0.50, Math.min(1.50, pct / 100));
    uiDebouncedLog('prioSafety', `Priority (Safety) → ${Math.round(state.director.prioSafety * 100)}%`);
    save();
    render();
  });

  const prioProgressInput = document.getElementById('prioProgress');
  if (prioProgressInput) prioProgressInput.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00, prioSocial: 1.00 };
    const pct = Math.max(50, Math.min(150, Number(e.target.value) || 100));
    state.director.prioProgress = Math.max(0.50, Math.min(1.50, pct / 100));
    uiDebouncedLog('prioProgress', `Priority (Progress) → ${Math.round(state.director.prioProgress * 100)}%`);
    save();
    render();
  });

  const prioSocialInput = document.getElementById('prioSocial');
  if (prioSocialInput) prioSocialInput.addEventListener('input', (e)=>{
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00, prioSocial: 1.00 };
    const pct = Math.max(50, Math.min(150, Number(e.target.value) || 100));
    state.director.prioSocial = Math.max(0.50, Math.min(1.50, pct / 100));
    uiDebouncedLog('prioSocial', `Priority (Social) → ${Math.round(state.director.prioSocial * 100)}%`);
    save();
    render();
  });

  function setPriorities(pFood, pSafety, pProg, pSoc, why){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced', prioFood: 1.00, prioSafety: 1.00, prioProgress: 1.00, prioSocial: 1.00 };
    state.director.prioFood = Math.max(0.50, Math.min(1.50, Number(pFood) || 1.00));
    state.director.prioSafety = Math.max(0.50, Math.min(1.50, Number(pSafety) || 1.00));
    state.director.prioProgress = Math.max(0.50, Math.min(1.50, Number(pProg) || 1.00));
    state.director.prioSocial = Math.max(0.50, Math.min(1.50, Number(pSoc) || 1.00));
    log(`Priority preset → ${why}: Food ${(state.director.prioFood*100).toFixed(0)}% | Safety ${(state.director.prioSafety*100).toFixed(0)}% | Progress ${(state.director.prioProgress*100).toFixed(0)}% | Social ${(state.director.prioSocial*100).toFixed(0)}%`);
    save();
    render();
  }

  const prBal = document.getElementById('btnPrioBalanced');
  if (prBal) prBal.addEventListener('click', ()=> setPriorities(1.00, 1.00, 1.00, 1.00, 'Balanced'));

  const prFoodBtn = document.getElementById('btnPrioFood');
  if (prFoodBtn) prFoodBtn.addEventListener('click', ()=> setPriorities(1.25, 1.00, 0.90, 1.00, 'Food'));

  const prSafeBtn = document.getElementById('btnPrioSafety');
  if (prSafeBtn) prSafeBtn.addEventListener('click', ()=> setPriorities(1.00, 1.25, 0.90, 1.00, 'Safety'));

  const prProgBtn = document.getElementById('btnPrioProgress');
  if (prProgBtn) prProgBtn.addEventListener('click', ()=> setPriorities(0.95, 0.90, 1.25, 0.90, 'Progress'));

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
      pSoc: map(so),
      avg: { Food:f, Safety:sa, Progress:pr, Social:so }
    };
  }

  const prConBtn = document.getElementById('btnPrioConsensus');
  if (prConBtn) prConBtn.addEventListener('click', ()=>{
    const c = consensusPrioritiesFromValues(state);
    setPriorities(c.pFood, c.pSafety, c.pProg, c.pSoc, 'Consensus');
    // Listening moment: a tiny, immediate dissent reduction.
    state.social = state.social ?? { dissent: 0 };
    state.social.dissent = clamp01(Number(state.social.dissent ?? 0) * 0.90);
    log(`Consensus priorities (avg values F${Math.round(c.avg.Food*100)} S${Math.round(c.avg.Safety*100)} P${Math.round(c.avg.Progress*100)} So${Math.round(c.avg.Social*100)}): Food ${(c.pFood*100).toFixed(0)}% | Safety ${(c.pSafety*100).toFixed(0)}% | Progress ${(c.pProg*100).toFixed(0)}% | Social ${(c.pSoc*100).toFixed(0)}%`);
    save();
    render();
  });

  // --- Directive tools (batch per-kitten directives)
  function countActiveDirectives(s){
    const ks = Array.isArray(s?.kittens) ? s.kittens : [];
    let active = 0;
    for (const k of ks) {
      const dir = String(k?.directive ?? 'Auto');
      if (dir && dir !== 'Auto') active++;
    }
    return { active, total: ks.length };
  }

  function setDirectivesMatchBlocs(s){
    const ks = Array.isArray(s?.kittens) ? s.kittens : [];
    const counts = { Food:0, Safety:0, Progress:0, Social:0 };
    for (const k of ks) {
      const axis = dominantValueAxis(k);
      const dir = (axis === 'Food' || axis === 'Safety' || axis === 'Progress' || axis === 'Social') ? axis : 'Auto';
      k.directive = dir;
      if (dir !== 'Auto') counts[dir] = (counts[dir] ?? 0) + 1;
    }
    const parts = Object.entries(counts).filter(([,n])=>n>0).map(([k,n])=>`${k}:${n}`);
    log(`Directive tools → Match blocs (${parts.join(' | ') || 'none'})`);
  }

  function clearAllDirectives(s){
    const ks = Array.isArray(s?.kittens) ? s.kittens : [];
    for (const k of ks) k.directive = 'Auto';
    log('Directive tools → Clear all (Directives reset to Auto).');
  }

  initDirectiveTools({
    btnDirBlocEl: document.getElementById('btnDirBloc'),
    btnDirClearAllEl: document.getElementById('btnDirClearAll'),
    getState: () => state,
    setDirectivesMatchBlocs,
    clearAllDirectives,
    save,
    render,
  });

  function setDoctrine(vRaw){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced' };
    const v = String(vRaw || 'Balanced');
    state.director.doctrine = (v === 'Specialize' || v === 'Rotate' || v === 'Balanced') ? v : 'Balanced';
    return state.director.doctrine;
  }

  initDoctrineControls({
    doctrineEl: document.getElementById('doctrine'),
    setDoctrine,
    log,
    save,
    render,
  });

  function setAutoWinterPrep(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoWinterPrep = !!on;
    return !!state.director.autoWinterPrep;
  }

  initAutoWinterPrepControls({
    autoWinterPrepEl: document.getElementById('autoWinterPrep'),
    setAutoWinterPrep,
    log,
    save,
    render,
  });

  function setAutoFoodCrisis(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoFoodCrisis = !!on;
    return !!state.director.autoFoodCrisis;
  }

  initAutoFoodCrisisControls({
    autoFoodCrisisEl: document.getElementById('autoFoodCrisis'),
    setAutoFoodCrisis,
    log,
    save,
    render,
  });

  function setAutoReserves(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoReserves = !!on;
    return !!state.director.autoReserves;
  }

  initAutoReservesControls({
    autoReservesEl: document.getElementById('autoReserves'),
    setAutoReserves,
    log,
    save,
    render,
  });

  function setAutoPolicy(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoPolicy:false, autoPolicyNextAt:0, autoPolicyWhy:'', projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoPolicy = !!on;
    if (state.director.autoPolicy) state.director.autoPolicyNextAt = 0;
    state.director.autoPolicyWhy = '';
    return !!state.director.autoPolicy;
  }

  initAutoPolicyControls({
    autoPolicyEl: document.getElementById('autoPolicy'),
    setAutoPolicy,
    log,
    save,
    render,
  });

  function setAutoBuildPush(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoBuildPush:false, projectFocus:'Auto', autonomy: 0.60 };
    state.director.autoBuildPush = !!on;
    return !!state.director.autoBuildPush;
  }

  initAutoBuildPushControls({
    autoBuildPushEl: document.getElementById('autoBuildPush'),
    setAutoBuildPush,
    log,
    save,
    render,
  });

  function setConfirmPolitics(on){
    state.director = state.director ?? { confirmFactions:true };
    // Default is "on"; allow user to opt-out.
    if (!('confirmFactions' in state.director)) state.director.confirmFactions = true;
    state.director.confirmFactions = !!on;
    return !!state.director.confirmFactions;
  }

  initConfirmPoliticsControls({
    confirmFactionsEl: document.getElementById('confirmFactions'),
    setConfirmPolitics,
    log,
    save,
    render,
  });

  function setAutoMode(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced' };
    state.director.autoMode = !!on;
    // Allow an immediate switch when toggled on.
    if (state.director.autoMode) state.director.autoModeNextChangeAt = 0;
    if (!state.director.autoMode) state.director.autoModeWhy = '';
    return !!state.director.autoMode;
  }

  initAutoModeControls({
    autoModeEl: document.getElementById('autoMode'),
    setAutoMode,
    log,
    save,
    render,
  });

  function setAutoDoctrine(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced' };
    state.director.autoDoctrine = !!on;
    // Allow an immediate switch when toggled on.
    if (state.director.autoDoctrine) state.director.autoDoctrineNextChangeAt = 0;
    state.director.autoDoctrineWhy = '';
    return !!state.director.autoDoctrine;
  }

  initAutoDoctrineControls({
    autoDoctrineEl: document.getElementById('autoDoctrine'),
    setAutoDoctrine,
    log,
    save,
    render,
  });

  function setAutoRations(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced' };
    state.director.autoRations = !!on;
    // Allow an immediate change when toggled on.
    if (state.director.autoRations) state.director.autoRationsNextChangeAt = 0;
    if (!state.director.autoRations) state.director.autoRationsWhy = '';
    return !!state.director.autoRations;
  }

  initAutoRationsControls({
    autoRationsEl: document.getElementById('autoRations'),
    setAutoRations,
    log,
    save,
    render,
  });

  function setAutoRecruit(on){
    state.director = state.director ?? { winterPrep:false, saved:null, crisis:false, crisisSaved:null, autoWinterPrep:false, autoFoodCrisis:false, autoReserves:false, autoMode:false, autoModeNextChangeAt:0, autoModeWhy:'', autoDoctrine:false, autoDoctrineNextChangeAt:0, autoDoctrineWhy:'', autoRations:false, autoRationsNextChangeAt:0, autoRationsWhy:'', autoRecruit:false, autoRecruitWhy:'', recruitYear:-1, projectFocus:'Auto', autonomy: 0.60, discipline: 0.40, workPace: 1.00, doctrine:'Balanced' };
    state.director.autoRecruit = !!on;
    if (!state.director.autoRecruit) state.director.autoRecruitWhy = '';
    return !!state.director.autoRecruit;
  }

  initAutoRecruitControls({
    autoRecruitEl: document.getElementById('autoRecruit'),
    setAutoRecruit,
    log,
    save,
    render,
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

  const legacyPanel = document.getElementById('legacyPanel');
  if (legacyPanel) legacyPanel.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('button[data-legacy-tab]');
    if (tabBtn) {
      ensureLegacyState(state);
      state.legacy.activeBranch = (tabBtn.dataset.legacyTab === 'military') ? 'military' : 'lore';
      save();
      render();
      return;
    }

    const btn = e.target.closest('button[data-legacy-buy]');
    if (!btn) return;
    const id = String(btn.dataset.legacyBuy || '');
    const res = buyLegacyUpgrade(id);
    if (res.ok) {
      playMicroClass(btn, 'purchase-confirm', 520);
    } else if (res.reason === 'cost') {
      playSfx('error');
      log('Not enough Legacy Shards for that upgrade.');
    }
  });

  const eternityPanel = document.getElementById('eternityPanel');
  if (eternityPanel) eternityPanel.addEventListener('click', (e) => {
    const mandateBtn = e.target.closest('button[data-eternity-mandate]');
    if (mandateBtn) {
      ensureEternityState(state);
      const next = String(mandateBtn.dataset.eternityMandate || 'harmony');
      if (ETERNITY_MANDATES.some(m => m.id === next)) {
        state.eternity.mandate = next;
        save();
        render();
      }
      return;
    }

    const preserveBtn = e.target.closest('button[data-eternity-preserve]');
    if (preserveBtn) {
      ensureEternityState(state);
      const next = String(preserveBtn.dataset.eternityPreserve || 'balanced');
      if (PRESERVATION_PACKAGES.some(p => p.id === next)) {
        state.eternity.preserve = next;
        save();
        render();
      }
      return;
    }

    const buyBtn = e.target.closest('button[data-eternity-buy]');
    if (!buyBtn) return;
    const id = String(buyBtn.dataset.eternityBuy || '');
    const res = buyEternityUpgrade(id);
    if (res.ok) {
      playMicroClass(buyBtn, 'purchase-confirm', 520);
    } else if (res.reason === 'cost') {
      playSfx('error');
      log('Not enough Sigils for that Eternity upgrade.');
    }
  });

  const researchPanel = document.getElementById('researchPanel');
  if (researchPanel) researchPanel.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('button[data-research-tab]');
    if (tabBtn) {
      ensureResearchState(state);
      const next = String(tabBtn.dataset.researchTab || 'economy');
      state.research.activeBranch = RESEARCH_BRANCH_ORDER.includes(next) ? next : 'economy';
      const firstTech = RESEARCH_TECHS.find((t) => t.branch === state.research.activeBranch);
      state.research.selectedTechId = firstTech ? firstTech.id : null;
      save();
      render();
      return;
    }

    const selectBtn = e.target.closest('button[data-research-select]');
    if (selectBtn) {
      ensureResearchState(state);
      state.research.selectedTechId = String(selectBtn.dataset.researchSelect || '');
      save();
      render();
      return;
    }

    const buyBtn = e.target.closest('button[data-research-buy]');
    if (!buyBtn) return;
    const id = String(buyBtn.dataset.researchBuy || '');
    const res = buyResearchTech(id);
    if (res.ok) {
      playMicroClass(buyBtn, 'purchase-confirm', 520);
    } else {
      playSfx('error');
      log('Research locked: check science/prerequisites/doctrine exclusivity.');
    }
  });

  const prestigeBtn = document.getElementById('btnPrestige');
  if (prestigeBtn) prestigeBtn.addEventListener('click', () => {
    const gain = computeLegacyShardGain(state);
    if (gain <= 0) { playSfx('error'); log('Legacy Reset unavailable: build up your colony first.'); return; }
    const ok = confirm(`Legacy Reset now?\n\nYou will gain +${fmt(gain)} Legacy Shards.\nYour colony resources/buildings/population reset.\nLegacy upgrades and shard balance persist.`);
    if (!ok) return;
    performLegacyReset();
  });

  const eternityBtn = document.getElementById('btnEternity');
  if (eternityBtn) eternityBtn.addEventListener('click', () => {
    const gate = eternityGateStatus(state);
    const gain = computeEternitySigilGain(state);
    if (!gate.ok || gain <= 0) {
      playSfx('error');
      log(`Eternity Reset locked (${gate.count}/4 gates met).`);
      return;
    }
    const ok = confirm(`Eternity Reset now?\n\nYou will gain +${fmt(gain)} Ancestral Sigils.\nLegacy shards/upgrades/research reset.\nEternity upgrades, mandate, and sigils persist.`);
    if (!ok) return;
    performEternityReset();
  });

  policyEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    // Undo button (rendered inside the Policy panel)
    if (btn.dataset.policyUndo) {
      const res = applyPolicyUndo(state);
      if (res?.msg) log(res.msg);
      save();
      render();
      return;
    }

    const bulk = String(btn.dataset.polbulk || '');
    if (bulk) {
      state.director = state.director ?? {};
      state.director.policyLocks = state.director.policyLocks ?? {};

      // Targets: everything visible in Policy panel.
      const allKeys = Object.keys(state.policyMult ?? {});
      const basics = ['Forage','Farm','PreserveFood','ChopWood','StokeFire','Guard'];

      if (bulk === 'lockAll') {
        for (const k of allKeys) state.director.policyLocks[k] = true;
        log('Policy locks: LOCKED ALL (Auto Policy will skip all multipliers).');
      } else if (bulk === 'unlockAll') {
        state.director.policyLocks = {};
        log('Policy locks: unlocked all (Auto Policy can resume nudging).');
      } else if (bulk === 'lockBasics') {
        for (const k of basics) state.director.policyLocks[k] = true;
        log('Policy locks: locked basics (food/warmth/threat levers).');
      }

      save();
      render();
      return;
    }

    const a = btn.dataset.a;
    const pol = btn.dataset.pol;
    if (!a || !pol) return;

    // Lock toggle (Auto Policy guardrail)
    if (pol === 'lock') {
      state.director = state.director ?? {};
      state.director.policyLocks = state.director.policyLocks ?? {};
      const next = !state.director.policyLocks[a];
      state.director.policyLocks[a] = next;
      log(`Policy lock: ${a} ${next ? 'LOCKED' : 'unlocked'} (Auto Policy will ${next ? 'skip' : 'resume'} nudging it).`);
      save();
      render();
      return;
    }

    // Record undo snapshot BEFORE changing.
    recordPolicyUndo(state, `tweak ${a}`);

    state.policyMult = state.policyMult ?? {};
    const cur = Number(state.policyMult[a] ?? 1);

    // QoL: modifier keys for faster tuning.
    // - default: 0.25 steps
    // - Shift:   0.50 steps
    // - Alt:     1.00 steps
    // - Ctrl/⌘:  snap to 0 (dec) or 2 (inc)
    const snap = !!(e.ctrlKey || e.metaKey);
    const step = e.altKey ? 1.00 : e.shiftKey ? 0.50 : 0.25;

    let next = cur;
    if (snap) next = (pol === 'inc') ? 2 : 0;
    else next = (pol === 'inc') ? (cur + step) : (cur - step);

    state.policyMult[a] = Math.max(0, Math.min(2, Math.round(next * 100) / 100));
    save();
    render();
  });

  if (roleQuotasEl) roleQuotasEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    const preset = String(btn.dataset.rqpreset || '');
    if (preset) {
      applyRoleQuotaPreset(state, preset);
      return;
    }

    const role = btn.dataset.role;
    const rq = btn.dataset.rq;
    if (!role || !rq) return;

    // Record undo snapshot BEFORE changing.
    recordPolicyUndo(state, `role quota ${role}`);

    state.roleQuota = state.roleQuota ?? { Forager:0, Farmer:0, Woodcutter:0, Firekeeper:0, Guard:0, Builder:0, Scholar:0, Toolsmith:0 };
    const cur = Number(state.roleQuota[role] ?? 0);
    const next = (rq === 'inc') ? (cur + 1) : (cur - 1);
    state.roleQuota[role] = Math.max(0, Math.min(99, next|0));
    log(`Role quota → ${role}=${state.roleQuota[role]}`);
    save();
    render();
  });

  function setPolicy(mult, note){
    // Record undo snapshot BEFORE applying any preset/reset.
    recordPolicyUndo(state, note || 'policy preset');

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

  const rulesControlsEl = document.getElementById('rulesControls');

  // Safety rules are read-only in Curator mode.
  // (Still visible for transparency, but only editable in Developer Mode.)
  document.getElementById('btnAddRule').addEventListener('click', () => {
    ensureCurator(state);
    if (!state.director?.curator?.devMode) { feed('Safety rules are read-only. Enable Developer Mode to edit.'); return; }
    state.rules.push(rule('New safety rule', {type:'always', v:0}, {type:'Rest'}));
    save();
    render();
  });

  document.getElementById('btnDefaultRules').addEventListener('click', () => {
    ensureCurator(state);
    if (!state.director?.curator?.devMode) { feed('Safety rules are read-only. Enable Developer Mode to edit.'); return; }
    if (!confirm('Restore defaults?')) return;
    state.rules = defaultRules();
    save();
    render();
  });

  rulesEl.addEventListener('click', (e) => {
    ensureCurator(state);
    if (!state.director?.curator?.devMode) return;

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
    ensureCurator(state);
    if (!state.director?.curator?.devMode) { render(); return; }

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
      else if (t.value === 'edible_lt') r.cond.v = 60;
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
    saveGame(state, { GAME_VERSION, SAVE_KEY, LOG_MAX });
  }

  function load(){
    return loadGame({
      SAVE_KEY,
      LOG_MAX,
      clamp01,
      ensureKittenName,
      genPersonality,
      genTraits,
    });
  }

  window.KKC_DEBUG = window.KKC_DEBUG ?? {};
  window.KKC_DEBUG.getRevealStage = () => revealStageOf(state);
  window.KKC_DEBUG.setRevealStage = (n) => {
    state.meta = state.meta ?? {};
    state.meta.revealStage = Math.max(0, Math.min(REVEAL_STAGE_MAX, Math.floor(Number(n) || 0)));
    render();
    save();
    return state.meta.revealStage;
  };
  window.KKC_DEBUG.nextRevealStage = () => {
    const cur = revealStageOf(state);
    return window.KKC_DEBUG.setRevealStage(Math.min(REVEAL_STAGE_MAX, cur + 1));
  };
  window.KKC_DEBUG.getRevealInfo = () => ({
    stage: revealStageOf(state),
    name: REVEAL_STAGE_NAMES[revealStageOf(state)],
    t: Number(state.t ?? 0),
    gates: REVEAL_GATES.map((g, i) => i === 0 ? null : { stage: i, timeSec: g.timeSec }),
  });

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
    const seen = String(state?.meta?.seenVersion ?? '');
    if (!seen) {
      // first run; do not auto-open
      state.meta = state.meta ?? {};
      state.meta.seenVersion = GAME_VERSION;
      save();
      return;
    }
    if (seen === GAME_VERSION) return;

    patchNotesUI.setFromVersion(seen);
    state.meta = state.meta ?? {};
    state.meta.seenVersion = GAME_VERSION;
    save();
    patchNotesUI.open();
  }

  function maybeShowOfflineSummary(){
    const summary = state?._offlineSummary;
    if (!summary) return;
    openOfflineModal(summary);
    state._offlineSummary = null;
    save();
  }

  function applyOfflineProgressOnBoot(){
    const away = Number(state?._offlinePending ?? 0) || 0;
    if (away < 3) { state._offlinePending = 0; return; }

    const effectiveAway = away <= OFFLINE_KNEE_SEC
      ? away
      : (OFFLINE_KNEE_SEC + Math.sqrt((away - OFFLINE_KNEE_SEC) * OFFLINE_KNEE_SEC));
    const simSeconds = Math.min(24 * 60 * 60, effectiveAway) * OFFLINE_RATE;
    if (simSeconds < 1) {
      state._offlinePending = 0;
      state._offlineWasCapped = false;
      return;
    }

    state.meta = state.meta ?? { version: GAME_VERSION, seenVersion: '', lastTs: 0, offlineReturnDay: 0, offlineReturnStreak: 0, revealStage: 0 };
    const today = Math.floor(Date.now() / 86400000);
    const prevDay = Math.floor(Number(state.meta.offlineReturnDay ?? 0) || 0);
    let streak = Math.max(0, Number(state.meta.offlineReturnStreak ?? 0) || 0);
    if (away >= OFFLINE_STREAK_MIN_AWAY_SEC) {
      if (prevDay === today - 1) streak += 1;
      else if (prevDay !== today) streak = 1;
      state.meta.offlineReturnDay = today;
      state.meta.offlineReturnStreak = streak;
    }

    const streakBonusPct = Math.min(25, Math.max(0, (streak - 1) * 5));
    const streakBonusMul = 1 + (streakBonusPct / 100);

    const keys = ['food','jerky','wood','science','tools'];
    const liveState = state;
    const probeState = structuredClone(state);

    // Estimate current economy rates by running a short deterministic probe sim.
    state = probeState;
    state._suppressLog = true;
    state._suppressedLogCount = 0;

    const probeBefore = {};
    for (const k of keys) probeBefore[k] = Number(state.res?.[k] ?? 0) || 0;

    let probeLeft = 8;
    while (probeLeft > 0) {
      const dt = Math.min(0.25, probeLeft);
      step(dt);
      probeLeft -= dt;
    }

    const perSec = {};
    for (const k of keys) {
      const after = Number(state.res?.[k] ?? 0) || 0;
      perSec[k] = Math.max(0, (after - probeBefore[k]) / 8);
    }

    state = liveState;

    const gains = {};
    for (const k of keys) {
      const add = perSec[k] * simSeconds * streakBonusMul;
      gains[k] = add;
      state.res[k] = Math.max(0, Number(state.res?.[k] ?? 0) + add);
    }

    const capped = !!state._offlineWasCapped;
    const tier = away >= (8 * 60 * 60) ? 'Legendary return' : away >= (2 * 60 * 60) ? 'Recharged return' : away >= (15 * 60) ? 'Rested return' : 'Quick return';
    log(
      `Offline progress: away ${fmt(away)}s, effective ${fmt(effectiveAway)}s, simulated ${fmt(simSeconds)}s at 50% base` +
      (streakBonusPct > 0 ? ` (+${streakBonusPct}% streak bonus)` : '') +
      (capped ? ' (capped at 24h).' : '.')
    );

    state._offlineSummary = { away, simulated: simSeconds, capped, gains, tier, streak, streakBonusPct };
    state._offlinePending = 0;
    state._offlineWasCapped = false;
    state._suppressedLogCount = 0;
    state._suppressLog = false;

    // Persist immediately so refreshing doesn't repeatedly grant offline rewards.
    save();
  }

  applyOfflineProgressOnBoot();

  render();
  requestAnimationFrame(frame);
  maybeShowPatchNotes();
  maybeShowOfflineSummary();
})();




