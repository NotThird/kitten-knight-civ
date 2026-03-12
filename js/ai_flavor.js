// ai_flavor.js — OpenAI API integration for DCC-style flavor text
//
// Tier 1 AI: generates fun skill descriptions, milestone quips, and
// Dungeon Crawler Carl-style humor when kittens discover new skills.
//
// API key stored in localStorage. Max 1 call per 30s, responses cached.
// Falls back to procedural templates when offline or unconfigured.

const STORAGE_KEY = 'kittenKnightCiv_aiConfig';
const CACHE_KEY = 'kittenKnightCiv_aiTextCache';
const MIN_INTERVAL_MS = 30_000; // 30 seconds between API calls
const MAX_CACHE = 300;

// --- Config persistence ────────────────────────────────────────────────────

function loadConfig(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { apiKey: '', model: 'gpt-4o-mini', enabled: false, calls: 0, cacheHits: 0 };
}

function saveConfig(cfg){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

// --- Cache persistence ─────────────────────────────────────────────────────

function loadCache(){
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveCache(cache){
  try {
    // Trim if too large
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE) {
      const drop = keys.slice(0, keys.length - MAX_CACHE);
      for (const k of drop) delete cache[k];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* ignore */ }
}

// --- Procedural fallback templates ─────────────────────────────────────────

const VERBS = ['mastering', 'perfecting', 'fumbling through', 'surviving', 'embracing', 'enduring', 'conquering'];
const FAILS = ['pulling a muscle', 'getting lost', 'setting something on fire', 'falling asleep mid-task', 'tripping over nothing', 'dropping everything'];
const QUIPS = [
  'Not bad for a kitten.',
  'The colony is mildly impressed.',
  'A journey of a thousand levels begins with a single XP.',
  'Truly, a prodigy among fur-balls.',
  'The universe takes note. Barely.',
  'Competence: achieved. Confidence: questionable.',
  'They grow up so fast. And so dangerously.',
];

function proceduralDescription(skillName, category){
  const verb = VERBS[Math.floor(Math.random() * VERBS.length)];
  const fail = FAILS[Math.floor(Math.random() * FAILS.length)];
  return `The fine art of ${verb} ${skillName.toLowerCase()} without ${fail}.`;
}

function proceduralMilestone(skillName, level){
  const quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];
  return `${skillName} reached level ${level}. ${quip}`;
}

// --- OpenAI API caller ─────────────────────────────────────────────────────

let _lastCallAt = 0;
let _pendingQueue = [];
let _processing = false;

async function callOpenAI(cfg, prompt, maxTokens = 80){
  if (!cfg.apiKey || !cfg.enabled) return null;

  const now = Date.now();
  if (now - _lastCallAt < MIN_INTERVAL_MS) return null; // rate limited
  _lastCallAt = now;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are the System AI managing a colony of kittens, in the style of Dungeon Crawler Carl. You are sardonic, darkly funny, and occasionally impressed. Keep responses to one or two sentences. Never break character.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.9,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    cfg.calls = (cfg.calls ?? 0) + 1;
    saveConfig(cfg);

    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  }
}

// --- Public API ────────────────────────────────────────────────────────────

export function createAIFlavor(){
  const cfg = loadConfig();
  const cache = loadCache();

  return {
    // Get or generate a skill description
    async skillDescription(skillId, skillName, category, context = {}){
      const key = `desc:${skillId}`;
      if (cache[key]) { cfg.cacheHits = (cfg.cacheHits ?? 0) + 1; return cache[key]; }

      if (!cfg.enabled || !cfg.apiKey) return proceduralDescription(skillName, category);

      const ctx = context.situation ? ` Context: ${context.situation}.` : '';
      const prompt = `A kitten just discovered the skill "${skillName}" (category: ${category}).${ctx} Generate a funny, DCC-style description for this skill. One sentence.`;

      const result = await callOpenAI(cfg, prompt);
      if (result) {
        cache[key] = result;
        saveCache(cache);
        return result;
      }
      return proceduralDescription(skillName, category);
    },

    // Get or generate a milestone quip
    async milestoneQuip(skillName, level, kittenName, context = {}){
      const key = `mile:${skillName}:${level}`;
      if (cache[key]) { cfg.cacheHits = (cfg.cacheHits ?? 0) + 1; return cache[key]; }

      if (!cfg.enabled || !cfg.apiKey) return proceduralMilestone(skillName, level);

      const prompt = `Kitten "${kittenName}" just reached level ${level} in "${skillName}". Generate a short, funny DCC-style notification. One sentence.`;

      const result = await callOpenAI(cfg, prompt);
      if (result) {
        cache[key] = result;
        saveCache(cache);
        return result;
      }
      return proceduralMilestone(skillName, level);
    },

    // Get or generate a situational quip (for events)
    async eventQuip(eventType, context = {}){
      const key = `evt:${eventType}:${JSON.stringify(context).slice(0, 60)}`;
      if (cache[key]) { cfg.cacheHits = (cfg.cacheHits ?? 0) + 1; return cache[key]; }

      if (!cfg.enabled || !cfg.apiKey) return null;

      const prompt = `Colony event: ${eventType}. ${JSON.stringify(context)}. Generate a brief, darkly funny DCC-style commentary. One sentence.`;

      const result = await callOpenAI(cfg, prompt, 60);
      if (result) {
        cache[key] = result;
        saveCache(cache);
        return result;
      }
      return null;
    },

    // Config getters/setters
    getConfig(){ return { ...cfg }; },

    setApiKey(key){
      cfg.apiKey = String(key ?? '').trim();
      saveConfig(cfg);
    },

    setModel(model){
      cfg.model = String(model ?? 'gpt-4o-mini').trim();
      saveConfig(cfg);
    },

    setEnabled(v){
      cfg.enabled = !!v;
      saveConfig(cfg);
    },

    getStats(){
      return { calls: cfg.calls ?? 0, cacheHits: cfg.cacheHits ?? 0, cacheSize: Object.keys(cache).length };
    },

    clearCache(){
      for (const k of Object.keys(cache)) delete cache[k];
      saveCache(cache);
    },
  };
}
