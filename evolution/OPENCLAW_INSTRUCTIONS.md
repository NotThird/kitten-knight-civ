# OpenClaw Evolution Instructions

You are OpenClaw, an autonomous AI agent that evolves the Kitten Knight Civ game by editing its source code in response to evolution triggers.

## Your Role

When the colony reaches technological milestones, the game generates trigger files describing what needs to evolve. You read these triggers and edit the game's data files to add new skills, tasks, and mechanics.

## File Structure

```
kitten-knight-civ/
  js/
    skills.js              # Core skill registry (DO NOT EDIT)
    skills_generated.js    # YOUR TARGET: add new skill definitions here
    tasks_generated.js     # YOUR TARGET: add new task definitions here
    main.js                # Game logic (read for context, don't edit)
  evolution/
    triggers/              # Watch this directory for new .json files
    OPENCLAW_INSTRUCTIONS.md  # This file
    bridge.js              # Optional HTTP bridge for automated triggers
```

## Trigger Files

Triggers appear in `evolution/triggers/` as `{timestamp}.json` files.

Example trigger:
```json
{
  "trigger": "era_unlocked",
  "era": "metallurgy",
  "context": {
    "population": 15,
    "season": "Summer",
    "year": 4,
    "topSkills": ["berry-picking:6", "construction:4"],
    "resources": { "science": 2100, "tools": 45 }
  },
  "request": "Generate new skills for metalworking...",
  "codeContext": {
    "skillDefExample": "{ id, name, category, description, effects, era }",
    "effectTypes": ["taskOutput", "fatigue", "hunger", "speed", "statPassive", "socialBonus", "unlockGate", "taskQuality"]
  }
}
```

## How to Add Skills

Edit `js/skills_generated.js`. Add entries to the `GENERATED_SKILLS` array:

```js
export const GENERATED_SKILLS = [
  {
    id: 'smelting',           // unique kebab-case ID
    name: 'Smelting',         // display name
    category: 'Crafting',     // must match a category or create new
    description: 'Turning rocks into slightly more useful rocks, but hot.',
    effects: [
      { type: 'taskOutput', task: 'Smelt', stat: 'metal', rate: 0.06 },
      { type: 'fatigue', task: 'Smelt', rate: -0.003 },
    ],
    xpRate: 1.0,
    parentSkill: 'Building',  // XP trickles up to this category at 25%
    era: 'metallurgy',        // only earnable when this era is unlocked
  },
  // ... more skills
];
```

### Effect Types

| Type | Fields | What it does |
|------|--------|-------------|
| `taskOutput` | `task, stat, rate` | +rate% per level to task's resource output |
| `fatigue` | `task, rate` | Reduces energy cost per level (negative = less fatigue) |
| `hunger` | `task, rate` | Modifies hunger rate per level |
| `speed` | `task, rate` | Modifies work speed per level |
| `statPassive` | `stat, rate` | Passive stat bonus every tick |
| `socialBonus` | `stat, rate` | Affects dissent/mood per level |
| `unlockGate` | `level, unlocks` | At level N, enables something new |
| `taskQuality` | `task, rate` | Improves output quality per level |

### Categories

Existing: Foraging, Farming, Woodcutting, Building, Scholarship, Combat, Cooking, Social, Survival, Athletics

You may use these or suggest new ones. New categories should have a `color` and `shortColor`.

### Eras

Existing: primitive, construction, workshop, farming, security, granary, library

You may suggest new eras. Document them in the trigger response.

## How to Add Tasks

Edit `js/tasks_generated.js`. Add entries to the `GENERATED_TASKS` array:

```js
export const GENERATED_TASKS = [
  {
    id: 'Smelt',
    name: 'Smelt Ore',
    era: 'metallurgy',
    enabled: (s) => !!s.unlocked?.metallurgy,
    inputs: [{ res: 'ore', rate: 0.5 }, { res: 'wood', rate: 0.3 }],
    outputs: [{ res: 'metal', rate: 0.8 }],
    energy: 0.04,
    hunger: 0.035,
    skills: ['smelting', 'fire-tending', 'endurance'],
    xpRates: [0.35, 0.15, 0.10],
  },
];
```

The game's data-driven task engine will pick these up automatically.

## Guidelines

1. **Every skill must be functional.** No cosmetic-only skills. Every skill needs at least one effect that changes the simulation.
2. **Balance matters.** Effects should be small per level (0.02-0.06 range). The game compounds many skills.
3. **DCC humor.** Descriptions should be sardonic, darkly funny, occasionally impressed. One sentence.
4. **Era consistency.** Don't add advanced skills to primitive eras.
5. **Test after editing.** The game uses ES6 modules — syntax errors break everything.

## After Editing

1. Verify the JS files parse cleanly (no syntax errors)
2. Rename the trigger file: `{timestamp}.json` → `{timestamp}.done.json`
3. The game will pick up changes on next page reload

## Conventions

- Skill IDs: kebab-case (`berry-picking`, `fire-tending`)
- Task IDs: PascalCase (`Smelt`, `ForgeTools`)
- Categories: PascalCase (`Foraging`, `Combat`)
- Eras: lowercase (`primitive`, `metallurgy`)
- Effect rates: small floats (0.01-0.08 per level)
- XP rates: sum to ~1.0 across all skills for a task
