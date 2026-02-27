# Kitten Knight Civ — DEVLOG

## 2026-02-27 12:07 PM (America/Chicago) — v0.8.3
- Added **Crisis Protocol** (Director button): an emergency stabilization overlay you can toggle on/off.
- When ON it forces Survive + Tight rations, raises buffers (reserves), and turns on FOOD CRISIS (+ ALARM if unlocked).
- When OFF it restores your previous Director settings (mode/targets/reserves/policy/role quotas/signals) for clean “panic → recover → resume” play.
- Updated patch notes to reflect the new control.
- Kept changes save-safe via director-field migrations (older saves get sensible defaults).

Files touched:
- prototype/index.html
- dist/index.html
- DEVLOG.md

What to try:
- Let threat/food drift into danger, toggle **Crisis Protocol** ON for ~20–40s, then OFF and see if the colony cleanly returns to your prior plan.
