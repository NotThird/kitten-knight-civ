// skills.js — Living Skill Registry (DCC-inspired)
//
// Every skill is FUNCTIONAL: it modifies the simulation through its effects.
// Skills are discovered organically — they only appear when a kitten first earns XP in them.
// Skills are era-gated — they require technology unlocks to become available.
// The registry auto-creates skills dynamically when new IDs are encountered.
//
// Three tiers:
//   1. Built-in skills (this file) — core gameplay, always available
//   2. Generated skills (skills_generated.js) — added by OpenClaw at runtime
//   3. Dynamic skills — created procedurally or via AI when unprecedented situations arise

// ─── Skill Categories ──────────────────────────────────────────────────────────
export const SKILL_CATEGORIES = {
  Foraging:    { name: 'Foraging',    color: '#34d399', shortColor: 'rgba(52,211,153,.95)' },
  Farming:     { name: 'Farming',     color: '#22c55e', shortColor: 'rgba(34,197,94,.90)' },
  Woodcutting: { name: 'Woodcutting', color: '#fbbf24', shortColor: 'rgba(251,191,36,.90)' },
  Building:    { name: 'Building',    color: '#7dd3fc', shortColor: 'rgba(125,211,252,.85)' },
  Scholarship: { name: 'Scholarship', color: '#a78bfa', shortColor: 'rgba(167,139,250,.95)' },
  Combat:      { name: 'Combat',      color: '#fb7185', shortColor: 'rgba(251,113,133,.90)' },
  Cooking:     { name: 'Cooking',     color: '#fdba74', shortColor: 'rgba(253,186,116,.90)' },
  Social:      { name: 'Social',      color: '#c4b5fd', shortColor: 'rgba(196,181,253,.90)' },
  Survival:    { name: 'Survival',    color: '#94a3b8', shortColor: 'rgba(148,163,184,.85)' },
  Athletics:   { name: 'Athletics',   color: '#22d3ee', shortColor: 'rgba(34,211,238,.85)' },
};

// ─── Era Definitions ────────────────────────────────────────────────────────────
// Maps era IDs to unlock requirements. Skills with an era won't earn XP until that era is active.
export const ERAS = {
  primitive:    { name: 'Primitive',    check: () => true },
  construction: { name: 'Construction', check: (s) => !!s?.unlocked?.construction },
  workshop:     { name: 'Workshop',     check: (s) => !!s?.unlocked?.workshop },
  farming:      { name: 'Farming',      check: (s) => !!s?.unlocked?.farm },
  security:     { name: 'Security',     check: (s) => !!s?.unlocked?.security },
  granary:      { name: 'Granary',      check: (s) => !!s?.unlocked?.granary },
  library:      { name: 'Library',      check: (s) => !!s?.unlocked?.library },
};

// ─── Effect Types ───────────────────────────────────────────────────────────────
// Each effect type has a merge function: how multiple effects of the same type combine.
export const EFFECT_TYPES = {
  taskOutput:   { merge: 'additive',      desc: 'Resource output multiplier for a task' },
  fatigue:      { merge: 'additive',      desc: 'Energy cost modifier for a task' },
  hunger:       { merge: 'additive',      desc: 'Hunger rate modifier for a task' },
  speed:        { merge: 'additive',      desc: 'Work pace modifier for a task' },
  statPassive:  { merge: 'additive',      desc: 'Passive per-tick stat modifier' },
  socialBonus:  { merge: 'additive',      desc: 'Dissent/mood modifier during social tasks' },
  unlockGate:   { merge: 'max',           desc: 'At level N, enables a new action' },
  taskQuality:  { merge: 'additive',      desc: 'Improves quality of task outputs' },
};

// ─── Built-in Skill Definitions ─────────────────────────────────────────────────
const BUILTIN_SKILLS = [
  // ── Foraging ──
  { id: 'berry-picking', name: 'Berry Picking', category: 'Foraging', era: 'primitive',
    description: 'Finding edible berries without poisoning yourself.',
    effects: [{ type: 'taskOutput', task: 'Forage', stat: 'food', rate: 0.04 }],
    graph: 'food-output' },
  { id: 'mushroom-hunting', name: 'Mushroom Hunting', category: 'Foraging', era: 'primitive',
    description: 'One wrong mushroom and it\'s nap time forever.',
    effects: [{ type: 'taskOutput', task: 'Forage', stat: 'food', rate: 0.03 }, { type: 'statPassive', stat: 'health', rate: 0.0008 }],
    graph: 'food-output' },
  { id: 'herb-gathering', name: 'Herb Gathering', category: 'Foraging', era: 'primitive',
    description: 'Sniffing plants and hoping for the best.',
    effects: [{ type: 'statPassive', stat: 'health', rate: 0.0012 }],
    graph: 'health' },
  { id: 'root-digging', name: 'Root Digging', category: 'Foraging', era: 'primitive',
    description: 'Clawing at the earth like dignity is optional.',
    effects: [{ type: 'taskOutput', task: 'Forage', stat: 'food', rate: 0.025 }, { type: 'fatigue', task: 'Forage', rate: -0.003 }],
    graph: 'food-output' },
  { id: 'nut-cracking', name: 'Nut Cracking', category: 'Foraging', era: 'primitive',
    description: 'Tiny paws, hard shells, infinite determination.',
    effects: [{ type: 'taskOutput', task: 'Forage', stat: 'food', rate: 0.02 }],
    graph: 'food-output' },
  { id: 'weather-reading', name: 'Weather Reading', category: 'Foraging', era: 'primitive',
    description: 'Ears twitch before storms. Science or superstition? Yes.',
    effects: [{ type: 'taskOutput', task: 'Forage', stat: 'food', rate: 0.015, condition: 'winter' }],
    graph: 'food-output' },
  { id: 'trail-finding', name: 'Trail Finding', category: 'Foraging', era: 'primitive',
    description: 'Following the scent of snacks through the wilderness.',
    effects: [{ type: 'fatigue', task: 'Forage', rate: -0.004 }],
    graph: 'energy-efficiency' },
  { id: 'foraging-efficiency', name: 'Foraging Efficiency', category: 'Foraging', era: 'primitive',
    description: 'The optimal snack-to-step ratio, perfected.',
    effects: [{ type: 'speed', task: 'Forage', rate: 0.02 }],
    graph: 'food-output' },

  // ── Farming ──
  { id: 'crop-tending', name: 'Crop Tending', category: 'Farming', era: 'farming',
    description: 'Talking to plants. They haven\'t answered yet.',
    effects: [{ type: 'taskOutput', task: 'Farm', stat: 'food', rate: 0.045 }],
    graph: 'food-output' },
  { id: 'soil-reading', name: 'Soil Reading', category: 'Farming', era: 'farming',
    description: 'Staring at dirt with the intensity of a philosopher.',
    effects: [{ type: 'taskOutput', task: 'Farm', stat: 'food', rate: 0.025 }],
    graph: 'food-output' },
  { id: 'seed-saving', name: 'Seed Saving', category: 'Farming', era: 'farming',
    description: 'Resisting the urge to eat the seeds. Character building.',
    effects: [{ type: 'taskQuality', task: 'Farm', rate: 0.03 }],
    graph: 'food-output' },
  { id: 'irrigation', name: 'Irrigation', category: 'Farming', era: 'farming',
    description: 'Water goes where you want. Usually.',
    effects: [{ type: 'taskOutput', task: 'Farm', stat: 'food', rate: 0.03 }, { type: 'fatigue', task: 'Farm', rate: -0.003 }],
    graph: 'food-output' },
  { id: 'weeding', name: 'Weeding', category: 'Farming', era: 'farming',
    description: 'Destroying plants to save plants. Morally complex.',
    effects: [{ type: 'taskOutput', task: 'Farm', stat: 'food', rate: 0.02 }],
    graph: 'food-output' },
  { id: 'harvest-timing', name: 'Harvest Timing', category: 'Farming', era: 'farming',
    description: 'Not too early, not too late. The Goldilocks of agriculture.',
    effects: [{ type: 'speed', task: 'Farm', rate: 0.025 }],
    graph: 'food-output' },
  { id: 'composting', name: 'Composting', category: 'Farming', era: 'farming',
    description: 'Rotting things on purpose, but make it productive.',
    effects: [{ type: 'taskQuality', task: 'Farm', rate: 0.02 }, { type: 'statPassive', stat: 'health', rate: 0.0005 }],
    graph: 'food-output' },

  // ── Woodcutting ──
  { id: 'wood-chopping', name: 'Wood Chopping', category: 'Woodcutting', era: 'primitive',
    description: 'Swing, chop, repeat. Surprisingly therapeutic.',
    effects: [{ type: 'taskOutput', task: 'ChopWood', stat: 'wood', rate: 0.04 }],
    graph: 'wood-output' },
  { id: 'log-splitting', name: 'Log Splitting', category: 'Woodcutting', era: 'primitive',
    description: 'Finding the grain and exploiting it. Nature\'s therapy.',
    effects: [{ type: 'taskOutput', task: 'ChopWood', stat: 'wood', rate: 0.025 }],
    graph: 'wood-output' },
  { id: 'timber-hauling', name: 'Timber Hauling', category: 'Woodcutting', era: 'primitive',
    description: 'Dragging trees. Builds character and lower back problems.',
    effects: [{ type: 'fatigue', task: 'ChopWood', rate: -0.004 }],
    graph: 'energy-efficiency' },
  { id: 'tree-felling', name: 'Tree Felling', category: 'Woodcutting', era: 'primitive',
    description: 'Knowing which way a tree will fall. Usually.',
    effects: [{ type: 'speed', task: 'ChopWood', rate: 0.03 }],
    graph: 'wood-output' },
  { id: 'bark-stripping', name: 'Bark Stripping', category: 'Woodcutting', era: 'primitive',
    description: 'Peeling trees. Don\'t ask why, just trust the process.',
    effects: [{ type: 'taskQuality', task: 'ChopWood', rate: 0.02 }],
    graph: 'wood-output' },
  { id: 'knot-reading', name: 'Knot Reading', category: 'Woodcutting', era: 'primitive',
    description: 'Predicting wood grain from bark patterns. It\'s an art.',
    effects: [{ type: 'taskOutput', task: 'ChopWood', stat: 'wood', rate: 0.015 }],
    graph: 'wood-output' },

  // ── Building ──
  { id: 'construction', name: 'Construction', category: 'Building', era: 'construction',
    description: 'Making things that don\'t fall down. Hopefully.',
    effects: [{ type: 'taskOutput', task: 'BuildHut', stat: 'progress', rate: 0.04 }, { type: 'taskOutput', task: 'BuildPalisade', stat: 'progress', rate: 0.04 }, { type: 'taskOutput', task: 'BuildGranary', stat: 'progress', rate: 0.04 }],
    graph: 'build-speed' },
  { id: 'planning', name: 'Planning', category: 'Building', era: 'construction',
    description: 'Thinking before doing. Revolutionary concept.',
    effects: [{ type: 'speed', task: 'BuildHut', rate: 0.02 }, { type: 'speed', task: 'BuildPalisade', rate: 0.02 }],
    graph: 'build-speed' },
  { id: 'scaffolding', name: 'Scaffolding', category: 'Building', era: 'construction',
    description: 'Building things to stand on while building other things.',
    effects: [{ type: 'fatigue', task: 'BuildHut', rate: -0.003 }, { type: 'fatigue', task: 'BuildPalisade', rate: -0.003 }],
    graph: 'energy-efficiency' },
  { id: 'finishing', name: 'Finishing', category: 'Building', era: 'construction',
    description: 'The last 10% that takes 90% of the effort.',
    effects: [{ type: 'taskQuality', task: 'BuildHut', rate: 0.03 }, { type: 'taskQuality', task: 'BuildGranary', rate: 0.03 }],
    graph: 'build-speed' },
  { id: 'measuring', name: 'Measuring', category: 'Building', era: 'construction',
    description: 'Measure twice, cut once. Or measure never and wing it.',
    effects: [{ type: 'taskOutput', task: 'BuildWorkshop', stat: 'progress', rate: 0.03 }, { type: 'taskOutput', task: 'BuildLibrary', stat: 'progress', rate: 0.03 }],
    graph: 'build-speed' },
  { id: 'load-bearing', name: 'Load Bearing', category: 'Building', era: 'construction',
    description: 'Knowing which walls you can\'t knock out. Important.',
    effects: [{ type: 'taskQuality', task: 'BuildHut', rate: 0.02 }, { type: 'taskQuality', task: 'BuildPalisade', rate: 0.025 }],
    graph: 'build-speed' },
  { id: 'thatching', name: 'Thatching', category: 'Building', era: 'construction',
    description: 'Roof-making with grass. Surprisingly waterproof.',
    effects: [{ type: 'speed', task: 'BuildHut', rate: 0.025 }],
    graph: 'build-speed' },
  { id: 'joint-fitting', name: 'Joint Fitting', category: 'Building', era: 'construction',
    description: 'Making wood pieces agree to stay together.',
    effects: [{ type: 'taskOutput', task: 'BuildHut', stat: 'progress', rate: 0.02 }],
    graph: 'build-speed' },

  // ── Scholarship ──
  { id: 'studying', name: 'Studying', category: 'Scholarship', era: 'library',
    description: 'Staring at things until they make sense.',
    effects: [{ type: 'taskOutput', task: 'Research', stat: 'science', rate: 0.04 }],
    graph: 'science-output' },
  { id: 'reading', name: 'Reading', category: 'Scholarship', era: 'library',
    description: 'Decoding squiggles on flat things. Apparently important.',
    effects: [{ type: 'taskOutput', task: 'Research', stat: 'science', rate: 0.025 }],
    graph: 'science-output' },
  { id: 'note-taking', name: 'Note Taking', category: 'Scholarship', era: 'library',
    description: 'Writing things down so future you doesn\'t have to remember.',
    effects: [{ type: 'speed', task: 'Research', rate: 0.02 }],
    graph: 'science-output' },
  { id: 'theorizing', name: 'Theorizing', category: 'Scholarship', era: 'library',
    description: 'Making stuff up but with evidence.',
    effects: [{ type: 'taskOutput', task: 'Research', stat: 'science', rate: 0.03 }],
    graph: 'science-output' },
  { id: 'memorization', name: 'Memorization', category: 'Scholarship', era: 'library',
    description: 'Cramming knowledge into a tiny furry brain.',
    effects: [{ type: 'fatigue', task: 'Research', rate: -0.003 }],
    graph: 'energy-efficiency' },
  { id: 'teaching', name: 'Teaching', category: 'Scholarship', era: 'library',
    description: 'Explaining things to someone who\'d rather nap.',
    effects: [{ type: 'taskOutput', task: 'Mentor', stat: 'xp', rate: 0.05 }],
    graph: 'science-output' },
  { id: 'pattern-recognition', name: 'Pattern Recognition', category: 'Scholarship', era: 'primitive',
    description: 'Seeing order in chaos. Or imagining it. Either way, useful.',
    effects: [{ type: 'taskOutput', task: 'Research', stat: 'science', rate: 0.02 }],
    graph: 'science-output' },
  { id: 'experiment-design', name: 'Experiment Design', category: 'Scholarship', era: 'library',
    description: 'Breaking things methodically and calling it progress.',
    effects: [{ type: 'taskOutput', task: 'Research', stat: 'science', rate: 0.035 }, { type: 'hunger', task: 'Research', rate: -0.002 }],
    graph: 'science-output' },

  // ── Combat ──
  { id: 'patrolling', name: 'Patrolling', category: 'Combat', era: 'primitive',
    description: 'Walking around looking tough. 90% of the job.',
    effects: [{ type: 'taskOutput', task: 'Guard', stat: 'threat', rate: 0.05 }],
    graph: 'threat-reduction' },
  { id: 'alertness', name: 'Alertness', category: 'Combat', era: 'primitive',
    description: 'Ears up, eyes wide, tail twitching. Always ready.',
    effects: [{ type: 'taskOutput', task: 'Guard', stat: 'threat', rate: 0.03 }],
    graph: 'threat-reduction' },
  { id: 'dodging', name: 'Dodging', category: 'Combat', era: 'primitive',
    description: 'Not being where the bad thing is. Simple in theory.',
    effects: [{ type: 'statPassive', stat: 'health', rate: 0.001 }],
    graph: 'health' },
  { id: 'intimidation', name: 'Intimidation', category: 'Combat', era: 'security',
    description: 'Making yourself look bigger. Works on raccoons.',
    effects: [{ type: 'statPassive', stat: 'threat', rate: -0.0008 }],
    graph: 'threat-reduction' },
  { id: 'formation-keeping', name: 'Formation Keeping', category: 'Combat', era: 'security',
    description: 'Standing in a line with other kittens. Harder than it sounds.',
    effects: [{ type: 'taskOutput', task: 'Guard', stat: 'threat', rate: 0.035 }],
    graph: 'threat-reduction' },
  { id: 'threat-assessment', name: 'Threat Assessment', category: 'Combat', era: 'security',
    description: 'Is that a bear or a bush? The answer matters.',
    effects: [{ type: 'speed', task: 'Guard', rate: 0.025 }],
    graph: 'threat-reduction' },
  { id: 'night-watch', name: 'Night Watch', category: 'Combat', era: 'security',
    description: 'Staying awake in the dark. Eyes glowing. Spooky.',
    effects: [{ type: 'fatigue', task: 'Guard', rate: -0.005 }],
    graph: 'energy-efficiency' },
  { id: 'weapon-handling', name: 'Weapon Handling', category: 'Combat', era: 'workshop',
    description: 'Pointy end toward enemy. The rest is practice.',
    effects: [{ type: 'taskOutput', task: 'Guard', stat: 'threat', rate: 0.04 }],
    graph: 'threat-reduction' },

  // ── Cooking ──
  { id: 'fire-tending', name: 'Fire Tending', category: 'Cooking', era: 'primitive',
    description: 'Keeping the flame alive without burning the village down.',
    effects: [{ type: 'taskOutput', task: 'StokeFire', stat: 'warmth', rate: 0.04 }],
    graph: 'warmth-output' },
  { id: 'preserving', name: 'Preserving', category: 'Cooking', era: 'granary',
    description: 'Making food last longer than a kitten\'s attention span.',
    effects: [{ type: 'taskOutput', task: 'PreserveFood', stat: 'jerky', rate: 0.04 }],
    graph: 'food-output' },
  { id: 'seasoning', name: 'Seasoning', category: 'Cooking', era: 'primitive',
    description: 'Adding flavor. Because existence is suffering enough.',
    effects: [{ type: 'taskQuality', task: 'PreserveFood', rate: 0.025 }],
    graph: 'food-output' },
  { id: 'smoking', name: 'Smoking', category: 'Cooking', era: 'granary',
    description: 'Hanging meat in smoke. Not as relaxing as it sounds.',
    effects: [{ type: 'taskOutput', task: 'PreserveFood', stat: 'jerky', rate: 0.03 }],
    graph: 'food-output' },
  { id: 'drying', name: 'Drying', category: 'Cooking', era: 'granary',
    description: 'Removing water from food. Patience in its purest form.',
    effects: [{ type: 'speed', task: 'PreserveFood', rate: 0.02 }],
    graph: 'food-output' },
  { id: 'herb-mixing', name: 'Herb Mixing', category: 'Cooking', era: 'primitive',
    description: 'Combining plants into something that doesn\'t taste like regret.',
    effects: [{ type: 'statPassive', stat: 'health', rate: 0.0008 }, { type: 'statPassive', stat: 'mood', rate: 0.001 }],
    graph: 'health' },
  { id: 'temperature-control', name: 'Temperature Control', category: 'Cooking', era: 'primitive',
    description: 'The difference between cooked and carbonized.',
    effects: [{ type: 'taskOutput', task: 'StokeFire', stat: 'warmth', rate: 0.03 }],
    graph: 'warmth-output' },
  { id: 'food-safety', name: 'Food Safety', category: 'Cooking', era: 'granary',
    description: 'Knowing when food has gone from aged to alarming.',
    effects: [{ type: 'statPassive', stat: 'health', rate: 0.001 }],
    graph: 'health' },

  // ── Social ──
  { id: 'socializing', name: 'Socializing', category: 'Social', era: 'primitive',
    description: 'Meowing at each other with purpose.',
    effects: [{ type: 'socialBonus', task: 'Socialize', stat: 'dissent', rate: -0.003 }],
    graph: 'social-cohesion' },
  { id: 'persuasion', name: 'Persuasion', category: 'Social', era: 'primitive',
    description: 'Getting others to do what you want through charm. Or purring.',
    effects: [{ type: 'socialBonus', task: 'Socialize', stat: 'dissent', rate: -0.004 }],
    graph: 'social-cohesion' },
  { id: 'caregiving', name: 'Caregiving', category: 'Social', era: 'primitive',
    description: 'Grooming, cuddling, and emotional support. The good stuff.',
    effects: [{ type: 'socialBonus', task: 'Care', stat: 'dissent', rate: -0.005 }, { type: 'statPassive', stat: 'mood', rate: 0.0015 }],
    graph: 'social-cohesion' },
  { id: 'storytelling', name: 'Storytelling', category: 'Social', era: 'primitive',
    description: 'Meowing dramatically by the fire. Everyone listens.',
    effects: [{ type: 'socialBonus', task: 'Socialize', stat: 'mood', rate: 0.003 }],
    graph: 'social-cohesion' },
  { id: 'negotiating', name: 'Negotiating', category: 'Social', era: 'primitive',
    description: 'The art of compromise. Usually involves fish.',
    effects: [{ type: 'socialBonus', task: 'Care', stat: 'dissent', rate: -0.003 }],
    graph: 'social-cohesion' },
  { id: 'conflict-resolution', name: 'Conflict Resolution', category: 'Social', era: 'primitive',
    description: 'Settling disputes without hissing. Usually.',
    effects: [{ type: 'socialBonus', task: 'Care', stat: 'dissent', rate: -0.004 }],
    graph: 'social-cohesion' },
  { id: 'morale-boosting', name: 'Morale Boosting', category: 'Social', era: 'primitive',
    description: 'Making everyone feel like things aren\'t that bad. They might be.',
    effects: [{ type: 'socialBonus', task: 'Socialize', stat: 'mood', rate: 0.004 }],
    graph: 'social-cohesion' },
  { id: 'mentoring-skill', name: 'Mentoring', category: 'Social', era: 'library',
    description: 'Passing wisdom to the young. They mostly ignore it.',
    effects: [{ type: 'taskOutput', task: 'Mentor', stat: 'xp', rate: 0.04 }],
    graph: 'science-output' },

  // ── Survival ──
  { id: 'resting', name: 'Resting', category: 'Survival', era: 'primitive',
    description: 'Sleeping efficiently. A competitive sport among kittens.',
    effects: [{ type: 'taskOutput', task: 'Rest', stat: 'energy', rate: 0.03 }],
    graph: 'energy-efficiency' },
  { id: 'eating-efficiently', name: 'Eating Efficiently', category: 'Survival', era: 'primitive',
    description: 'Maximum nutrition per chew. No crumb left behind.',
    effects: [{ type: 'taskOutput', task: 'Eat', stat: 'hunger-relief', rate: 0.03 }],
    graph: 'food-efficiency' },
  { id: 'endurance', name: 'Endurance', category: 'Survival', era: 'primitive',
    description: 'Keeping going when every fiber says stop.',
    effects: [{ type: 'fatigue', task: '*', rate: -0.002 }],
    graph: 'energy-efficiency' },
  { id: 'warmth-sense', name: 'Warmth Sense', category: 'Survival', era: 'primitive',
    description: 'Finding the warmest spot in any room. Innate talent.',
    effects: [{ type: 'statPassive', stat: 'warmth', rate: 0.0005 }],
    graph: 'warmth-output' },
  { id: 'scavenging', name: 'Scavenging', category: 'Survival', era: 'primitive',
    description: 'Finding value in what others overlook.',
    effects: [{ type: 'taskOutput', task: 'Forage', stat: 'food', rate: 0.015 }],
    graph: 'food-output' },
  { id: 'shelter-instinct', name: 'Shelter Instinct', category: 'Survival', era: 'primitive',
    description: 'Knowing when to come inside. Cats are natural experts.',
    effects: [{ type: 'statPassive', stat: 'health', rate: 0.0006 }],
    graph: 'health' },
  { id: 'danger-awareness', name: 'Danger Awareness', category: 'Survival', era: 'primitive',
    description: 'The hair-raising, ear-flattening sixth sense.',
    effects: [{ type: 'statPassive', stat: 'health', rate: 0.0005 }],
    graph: 'health' },
  { id: 'self-care', name: 'Self Care', category: 'Survival', era: 'primitive',
    description: 'Grooming, stretching, and the occasional existential nap.',
    effects: [{ type: 'taskOutput', task: 'Rest', stat: 'health', rate: 0.02 }],
    graph: 'health' },
  { id: 'meditation', name: 'Meditation', category: 'Survival', era: 'primitive',
    description: 'Sitting very still and pretending to be enlightened.',
    effects: [{ type: 'statPassive', stat: 'mood', rate: 0.001 }],
    graph: 'social-cohesion' },

  // ── Athletics ──
  { id: 'walking', name: 'Walking', category: 'Athletics', era: 'primitive',
    description: 'Putting one paw in front of the other. Mastery takes years.',
    effects: [{ type: 'fatigue', task: '*', rate: -0.001 }],
    graph: 'energy-efficiency' },
  { id: 'running', name: 'Running', category: 'Athletics', era: 'primitive',
    description: 'Walking but faster and with more panic.',
    effects: [{ type: 'speed', task: '*', rate: 0.01 }],
    graph: 'energy-efficiency' },
  { id: 'carrying', name: 'Carrying', category: 'Athletics', era: 'primitive',
    description: 'Holding things in your mouth while walking. Multitasking.',
    effects: [{ type: 'speed', task: 'ChopWood', rate: 0.02 }, { type: 'speed', task: 'Forage', rate: 0.015 }],
    graph: 'energy-efficiency' },
  { id: 'climbing', name: 'Climbing', category: 'Athletics', era: 'primitive',
    description: 'Going up is easy. Coming down is the adventure.',
    effects: [{ type: 'fatigue', task: 'BuildHut', rate: -0.003 }, { type: 'fatigue', task: 'ChopWood', rate: -0.002 }],
    graph: 'energy-efficiency' },
  { id: 'stamina', name: 'Stamina', category: 'Athletics', era: 'primitive',
    description: 'The difference between quitting and complaining while continuing.',
    effects: [{ type: 'fatigue', task: '*', rate: -0.002 }],
    graph: 'energy-efficiency' },
  { id: 'balance', name: 'Balance', category: 'Athletics', era: 'primitive',
    description: 'Not falling over. A surprisingly high bar for some.',
    effects: [{ type: 'fatigue', task: 'BuildPalisade', rate: -0.003 }, { type: 'statPassive', stat: 'health', rate: 0.0003 }],
    graph: 'energy-efficiency' },
  { id: 'lifting', name: 'Lifting', category: 'Athletics', era: 'primitive',
    description: 'Picking up heavy things and putting them somewhere else.',
    effects: [{ type: 'speed', task: 'BuildHut', rate: 0.015 }, { type: 'speed', task: 'BuildGranary', rate: 0.015 }],
    graph: 'build-speed' },
  { id: 'agility', name: 'Agility', category: 'Athletics', era: 'primitive',
    description: 'Quick paws and quicker reflexes. Born for obstacle courses.',
    effects: [{ type: 'speed', task: '*', rate: 0.008 }, { type: 'statPassive', stat: 'health', rate: 0.0004 }],
    graph: 'energy-efficiency' },

  // ── Workshop-era skills ──
  { id: 'tool-making', name: 'Tool Making', category: 'Building', era: 'workshop',
    description: 'Crafting tools from raw materials. Opposable thumbs not required.',
    effects: [{ type: 'taskOutput', task: 'CraftTools', stat: 'tools', rate: 0.05 }],
    graph: 'tool-output' },
  { id: 'precision', name: 'Precision', category: 'Building', era: 'workshop',
    description: 'Getting it right to the nearest whisker-width.',
    effects: [{ type: 'taskQuality', task: 'CraftTools', rate: 0.03 }, { type: 'taskOutput', task: 'BuildWorkshop', stat: 'progress', rate: 0.025 }],
    graph: 'tool-output' },
  { id: 'engineering', name: 'Engineering', category: 'Building', era: 'workshop',
    description: 'Applied laziness. Making things work so you don\'t have to.',
    effects: [{ type: 'taskOutput', task: 'BuildWorkshop', stat: 'progress', rate: 0.04 }, { type: 'taskOutput', task: 'BuildLibrary', stat: 'progress', rate: 0.035 }],
    graph: 'build-speed' },

  // ── Cross-category primitive skills ──
  { id: 'plant-identification', name: 'Plant Identification', category: 'Foraging', era: 'primitive',
    description: 'That one is food. That one is death. Choose wisely.',
    effects: [{ type: 'statPassive', stat: 'health', rate: 0.001 }, { type: 'taskOutput', task: 'Forage', stat: 'food', rate: 0.01 }],
    graph: 'health' },
];

// ─── Task → Skills Mapping ──────────────────────────────────────────────────────
// Which micro-skills each task awards XP to, and at what rate multiplier.
export const TASK_SKILL_MAP = {
  Eat:           [['eating-efficiently', 0.40], ['self-care', 0.30], ['endurance', 0.15], ['warmth-sense', 0.15]],
  Rest:          [['resting', 0.40], ['self-care', 0.30], ['warmth-sense', 0.15], ['meditation', 0.15]],
  Loaf:          [['resting', 0.25], ['meditation', 0.35], ['socializing', 0.20], ['self-care', 0.20]],
  Socialize:     [['socializing', 0.30], ['persuasion', 0.20], ['storytelling', 0.20], ['morale-boosting', 0.15], ['walking', 0.15]],
  Care:          [['caregiving', 0.30], ['negotiating', 0.20], ['conflict-resolution', 0.20], ['socializing', 0.15], ['walking', 0.15]],
  Forage:        [['berry-picking', 0.25], ['trail-finding', 0.12], ['carrying', 0.12], ['walking', 0.10], ['weather-reading', 0.12], ['endurance', 0.08], ['plant-identification', 0.08], ['mushroom-hunting', 0.08], ['scavenging', 0.05]],
  PreserveFood:  [['preserving', 0.30], ['fire-tending', 0.20], ['seasoning', 0.15], ['food-safety', 0.15], ['herb-mixing', 0.10], ['temperature-control', 0.10]],
  Farm:          [['crop-tending', 0.25], ['soil-reading', 0.15], ['irrigation', 0.15], ['weeding', 0.10], ['harvest-timing', 0.10], ['seed-saving', 0.10], ['carrying', 0.08], ['endurance', 0.07]],
  ChopWood:      [['wood-chopping', 0.25], ['log-splitting', 0.15], ['timber-hauling', 0.15], ['tree-felling', 0.12], ['carrying', 0.10], ['stamina', 0.08], ['bark-stripping', 0.08], ['knot-reading', 0.07]],
  StokeFire:     [['fire-tending', 0.35], ['temperature-control', 0.25], ['warmth-sense', 0.20], ['endurance', 0.10], ['walking', 0.10]],
  Guard:         [['patrolling', 0.20], ['alertness', 0.18], ['intimidation', 0.12], ['formation-keeping', 0.12], ['stamina', 0.10], ['night-watch', 0.10], ['danger-awareness', 0.08], ['dodging', 0.05], ['walking', 0.05]],
  BuildHut:      [['construction', 0.25], ['planning', 0.12], ['thatching', 0.12], ['joint-fitting', 0.10], ['scaffolding', 0.10], ['lifting', 0.10], ['measuring', 0.08], ['carrying', 0.08], ['endurance', 0.05]],
  BuildPalisade: [['construction', 0.25], ['planning', 0.12], ['load-bearing', 0.15], ['scaffolding', 0.10], ['lifting', 0.10], ['balance', 0.10], ['carrying', 0.10], ['endurance', 0.08]],
  BuildGranary:  [['construction', 0.20], ['finishing', 0.15], ['planning', 0.12], ['measuring', 0.12], ['lifting', 0.10], ['carrying', 0.10], ['scaffolding', 0.10], ['endurance', 0.06], ['load-bearing', 0.05]],
  BuildWorkshop: [['construction', 0.15], ['engineering', 0.20], ['precision', 0.15], ['measuring', 0.12], ['planning', 0.12], ['lifting', 0.08], ['carrying', 0.08], ['finishing', 0.10]],
  BuildLibrary:  [['construction', 0.12], ['engineering', 0.18], ['finishing', 0.15], ['measuring', 0.12], ['planning', 0.12], ['precision', 0.10], ['lifting', 0.08], ['carrying', 0.08], ['scaffolding', 0.05]],
  CraftTools:    [['tool-making', 0.30], ['precision', 0.20], ['engineering', 0.15], ['carrying', 0.10], ['stamina', 0.10], ['endurance', 0.08], ['planning', 0.07]],
  Mentor:        [['teaching', 0.30], ['mentoring-skill', 0.25], ['socializing', 0.15], ['persuasion', 0.10], ['pattern-recognition', 0.10], ['walking', 0.10]],
  Research:      [['pattern-recognition', 0.20], ['studying', 0.20], ['theorizing', 0.15], ['note-taking', 0.12], ['reading', 0.10], ['memorization', 0.10], ['experiment-design', 0.08], ['endurance', 0.05]],
};

// ─── Skill Registry ─────────────────────────────────────────────────────────────

export function createSkillRegistry() {
  const skills = new Map();   // id → skill definition
  const _cache = new Map();   // task → [effects] cache (invalidated on register)

  // Register a skill definition
  function register(def) {
    if (!def || !def.id) return;
    const d = { ...def, dynamic: def.dynamic ?? false, xpRate: def.xpRate ?? 1.0 };
    if (!d.effects) d.effects = [];
    if (!d.era) d.era = 'primitive';
    if (!d.graph) d.graph = 'misc';
    if (!d.parentSkill) d.parentSkill = d.category || null;
    skills.set(d.id, d);
    _cache.clear(); // invalidate effect cache
  }

  // Register all builtins
  for (const def of BUILTIN_SKILLS) register(def);

  // Get a skill def by ID (or null)
  function get(id) {
    return skills.get(id) ?? null;
  }

  // Get or dynamically create a skill (procedural fallback)
  function getOrCreate(id, defaults = {}) {
    if (skills.has(id)) return skills.get(id);
    const name = defaults.name ?? id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const cat = defaults.category ?? 'Survival';
    const def = {
      id,
      name,
      category: cat,
      description: defaults.description ?? `The skill of ${name.toLowerCase()}. Somehow, it matters.`,
      effects: defaults.effects ?? [{ type: 'statPassive', stat: 'mood', rate: 0.0005 }],
      xpRate: defaults.xpRate ?? 1.0,
      parentSkill: defaults.parentSkill ?? cat,
      era: defaults.era ?? 'primitive',
      dynamic: true,
      graph: defaults.graph ?? 'misc',
    };
    register(def);
    return def;
  }

  // Get the primary skill for a task (first in TASK_SKILL_MAP, or null)
  function primaryForTask(task) {
    const map = TASK_SKILL_MAP[task];
    return map?.[0]?.[0] ?? null;
  }

  // List all registered skills
  function all() {
    return Array.from(skills.values());
  }

  // List skills by category
  function byCategory(cat) {
    return all().filter(s => s.category === cat);
  }

  // Check if an era is unlocked
  function isEraUnlocked(era, state) {
    const def = ERAS[era];
    return def ? def.check(state) : true; // unknown eras are treated as unlocked
  }

  // ── applySkillEffects: the core function ────────────────────────────────────
  // Returns a modifier object for a given kitten's skills during a specific task.
  // Called once per task tick to get all skill-derived bonuses.
  function applySkillEffects(state, kitten, task) {
    const result = {
      outputMult: 1.0,    // resource output multiplier
      fatigueMult: 1.0,   // energy cost multiplier (< 1 = less fatigue)
      hungerMult: 1.0,    // hunger rate multiplier
      speedMult: 1.0,     // work pace multiplier
      qualityMult: 1.0,   // output quality multiplier
    };

    const kSkills = kitten?.skills;
    if (!kSkills || typeof kSkills !== 'object') return result;

    for (const [skillId, levelRaw] of Object.entries(kSkills)) {
      const level = Number(levelRaw ?? 1);
      if (!Number.isFinite(level) || level <= 1) continue; // level 1 = no bonus

      const def = skills.get(skillId);
      if (!def || !Array.isArray(def.effects)) continue;

      const lvlMinus1 = level - 1;

      for (const eff of def.effects) {
        // Check task match: '*' matches all, otherwise must match exactly
        if (eff.task && eff.task !== '*' && eff.task !== task) continue;

        const bonus = (Number(eff.rate) || 0) * lvlMinus1;

        switch (eff.type) {
          case 'taskOutput': result.outputMult += bonus; break;
          case 'fatigue':    result.fatigueMult += bonus; break; // negative rate = less fatigue
          case 'hunger':     result.hungerMult += bonus; break;
          case 'speed':      result.speedMult += bonus; break;
          case 'taskQuality': result.qualityMult += bonus; break;
          // statPassive and socialBonus are handled separately in the tick loop
        }
      }
    }

    // Clamp to sane ranges
    result.outputMult = Math.max(0.5, Math.min(5.0, result.outputMult));
    result.fatigueMult = Math.max(0.3, Math.min(2.0, result.fatigueMult));
    result.hungerMult = Math.max(0.3, Math.min(2.0, result.hungerMult));
    result.speedMult = Math.max(0.5, Math.min(3.0, result.speedMult));
    result.qualityMult = Math.max(0.5, Math.min(5.0, result.qualityMult));

    return result;
  }

  // ── applyPassiveEffects: per-tick passive stat bonuses ──────────────────────
  // Called once per tick per kitten to apply passive bonuses from all their skills.
  function applyPassiveEffects(state, kitten, dt) {
    const kSkills = kitten?.skills;
    if (!kSkills || typeof kSkills !== 'object') return {};

    const mods = {}; // stat → total modifier this tick

    for (const [skillId, levelRaw] of Object.entries(kSkills)) {
      const level = Number(levelRaw ?? 1);
      if (!Number.isFinite(level) || level <= 1) continue;

      const def = skills.get(skillId);
      if (!def || !Array.isArray(def.effects)) continue;

      for (const eff of def.effects) {
        if (eff.type !== 'statPassive') continue;
        const stat = eff.stat;
        if (!stat) continue;
        const bonus = (Number(eff.rate) || 0) * (level - 1) * dt;
        mods[stat] = (mods[stat] ?? 0) + bonus;
      }
    }

    return mods;
  }

  // ── Colony-wide skill effect summary (for chart annotations) ──────────────
  function colonyEffectSummary(state) {
    const kittens = Array.isArray(state?.kittens) ? state.kittens : [];
    const summary = {}; // graph → { totalBonus, avgLevel, topSkill, topLevel }

    for (const k of kittens) {
      const kSkills = k?.skills;
      if (!kSkills) continue;
      for (const [skillId, levelRaw] of Object.entries(kSkills)) {
        const level = Number(levelRaw ?? 1);
        if (!Number.isFinite(level) || level <= 1) continue;
        const def = skills.get(skillId);
        if (!def) continue;
        const g = def.graph || 'misc';
        if (!summary[g]) summary[g] = { totalBonus: 0, count: 0, topSkill: '', topLevel: 0 };
        const entry = summary[g];
        for (const eff of (def.effects || [])) {
          entry.totalBonus += (Number(eff.rate) || 0) * (level - 1);
        }
        entry.count++;
        if (level > entry.topLevel) { entry.topLevel = level; entry.topSkill = def.name; }
      }
    }

    return summary;
  }

  return {
    register,
    get,
    getOrCreate,
    primaryForTask,
    all,
    byCategory,
    isEraUnlocked,
    applySkillEffects,
    applyPassiveEffects,
    colonyEffectSummary,
    get size() { return skills.size; },
  };
}
