// charts.js — Canvas chart renderers for the inspect modal
//
// Provides: radar chart (category skills), skill trend line chart,
// vitals trend line chart, and activity breakdown bar chart.
// All renderers take a canvas element + kitten data and draw directly.

import { SKILL_CATEGORIES } from './skills.js';

const CAT_KEYS = Object.keys(SKILL_CATEGORIES);
const CAT_COLORS = CAT_KEYS.map(k => SKILL_CATEGORIES[k].color);
const BG = '#1a1a2e';
const GRID = 'rgba(255,255,255,.08)';
const TEXT = 'rgba(255,255,255,.7)';
const TEXT_DIM = 'rgba(255,255,255,.4)';
const AXIS = 'rgba(255,255,255,.15)';

// ─── Radar / Spider Chart ──────────────────────────────────────────────────

export function renderRadar(canvas, k, compareK = null){
  if (!canvas || !k) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(cx, cy) - Math.max(12, Math.min(30, Math.min(cx, cy) * 0.22));
  const n = CAT_KEYS.length;
  const angleStep = (2 * Math.PI) / n;
  const maxLvl = 20; // max displayable level for radar scale

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Grid rings
  for (let ring = 1; ring <= 4; ring++){
    const r = R * (ring / 4);
    ctx.beginPath();
    for (let i = 0; i <= n; i++){
      const angle = -Math.PI / 2 + i * angleStep;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Axis lines + labels
  ctx.font = `${Math.max(7, Math.min(10, W / 28))}px monospace`;
  ctx.fillStyle = TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++){
    const angle = -Math.PI / 2 + i * angleStep;
    const ex = cx + Math.cos(angle) * R;
    const ey = cy + Math.sin(angle) * R;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = AXIS;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label
    const labelOff = Math.max(8, Math.min(16, W / 18));
    const lx = cx + Math.cos(angle) * (R + labelOff);
    const ly = cy + Math.sin(angle) * (R + labelOff);
    ctx.fillStyle = CAT_COLORS[i];
    ctx.fillText(CAT_KEYS[i].slice(0, W < 150 ? 3 : 6), lx, ly);
  }

  // Draw filled polygon for kitten
  function drawPoly(kitten, fill, stroke, lineW = 2){
    ctx.beginPath();
    for (let i = 0; i < n; i++){
      const lvl = Math.min(maxLvl, Number(kitten.skills?.[CAT_KEYS[i]] ?? 1));
      const r = R * (lvl / maxLvl);
      const angle = -Math.PI / 2 + i * angleStep;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineW;
    ctx.stroke();
  }

  // Comparison kitten (dashed, behind)
  if (compareK){
    ctx.setLineDash([4, 4]);
    drawPoly(compareK, 'rgba(255,255,255,.04)', 'rgba(255,255,255,.3)', 1.5);
    ctx.setLineDash([]);
  }

  // Primary kitten
  drawPoly(k, 'rgba(99,102,241,.15)', 'rgba(99,102,241,.8)', 2);

  // Dots at vertices
  for (let i = 0; i < n; i++){
    const lvl = Math.min(maxLvl, Number(k.skills?.[CAT_KEYS[i]] ?? 1));
    const r = R * (lvl / maxLvl);
    const angle = -Math.PI / 2 + i * angleStep;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, 2 * Math.PI);
    ctx.fillStyle = CAT_COLORS[i];
    ctx.fill();
  }
}

// ─── Skill Trend (line chart over time) ─────────────────────────────────────

export function renderSkillTrend(canvas, k){
  if (!canvas || !k) return;
  const data = Array.isArray(k._skillTrend) ? k._skillTrend : [];
  if (data.length < 2) { clearWithMsg(canvas, 'Collecting skill data...'); return; }

  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const pad = { l: 36, r: 10, t: 14, b: 20 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  // Time range
  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;
  const tRange = Math.max(1, tMax - tMin);

  // Level range
  let lvlMax = 3;
  for (const d of data) for (const cat of CAT_KEYS) lvlMax = Math.max(lvlMax, Number(d[cat] ?? 1));
  lvlMax = Math.ceil(lvlMax * 1.15);

  // Axes
  drawAxes(ctx, pad, W, H, tMin, tMax, 1, lvlMax);

  // Lines per category
  for (let ci = 0; ci < CAT_KEYS.length; ci++){
    const cat = CAT_KEYS[ci];
    ctx.beginPath();
    for (let i = 0; i < data.length; i++){
      const x = pad.l + ((data[i].t - tMin) / tRange) * cw;
      const y = pad.t + ch - ((Number(data[i][cat] ?? 1) - 1) / (lvlMax - 1)) * ch;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = CAT_COLORS[ci];
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// ─── Vitals Trend (mood, energy, health, hunger) ────────────────────────────

const VITAL_KEYS = ['mood', 'energy', 'health', 'hunger'];
const VITAL_COLORS = ['#c4b5fd', '#34d399', '#fb7185', '#fbbf24'];
const VITAL_LABELS = ['Mood', 'Energy', 'Health', 'Hunger'];

export function renderVitalsTrend(canvas, k){
  if (!canvas || !k) return;
  const data = Array.isArray(k._vitalsTrend) ? k._vitalsTrend : [];
  if (data.length < 2) { clearWithMsg(canvas, 'Collecting vitals data...'); return; }

  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const pad = { l: 36, r: 10, t: 14, b: 20 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;
  const tRange = Math.max(1, tMax - tMin);

  drawAxes(ctx, pad, W, H, tMin, tMax, 0, 1);

  for (let vi = 0; vi < VITAL_KEYS.length; vi++){
    const vk = VITAL_KEYS[vi];
    ctx.beginPath();
    for (let i = 0; i < data.length; i++){
      const x = pad.l + ((data[i].t - tMin) / tRange) * cw;
      const y = pad.t + ch - (Number(data[i][vk] ?? 0)) * ch;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = VITAL_COLORS[vi];
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Legend at top
  ctx.font = '9px monospace';
  let lx = pad.l + 4;
  for (let vi = 0; vi < VITAL_KEYS.length; vi++){
    ctx.fillStyle = VITAL_COLORS[vi];
    ctx.fillRect(lx, 3, 8, 8);
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    ctx.fillText(VITAL_LABELS[vi], lx + 11, 10);
    lx += ctx.measureText(VITAL_LABELS[vi]).width + 20;
  }
}

// ─── Activity Breakdown (horizontal stacked bar) ────────────────────────────

const TASK_COLORS = {
  Forage: '#34d399', Farm: '#22c55e', ChopWood: '#fbbf24', StokeFire: '#f97316',
  Guard: '#fb7185', BuildHut: '#7dd3fc', BuildPalisade: '#38bdf8', BuildGranary: '#06b6d4',
  BuildWorkshop: '#67e8f9', BuildLibrary: '#a78bfa', CraftTools: '#e879f9', Research: '#818cf8',
  Mentor: '#c4b5fd', Socialize: '#c084fc', Care: '#f0abfc', PreserveFood: '#4ade80',
  Eat: '#fdba74', Rest: '#94a3b8', Loaf: '#64748b',
};

export function renderActivityBar(canvas, k){
  if (!canvas || !k) return;
  const at = k.activityTime;
  if (!at || typeof at !== 'object') { clearWithMsg(canvas, 'No activity data yet.'); return; }

  const entries = Object.entries(at).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { clearWithMsg(canvas, 'No activity data yet.'); return; }

  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) { clearWithMsg(canvas, 'No activity data yet.'); return; }

  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const pad = { l: 6, r: 6, t: 6, b: 18 };
  const barH = 22;
  const barY = pad.t;
  const barW = W - pad.l - pad.r;

  // Stacked bar
  let x = pad.l;
  for (const [task, secs] of entries){
    const w = (secs / total) * barW;
    if (w < 1) continue;
    ctx.fillStyle = TASK_COLORS[task] ?? '#6b7280';
    ctx.fillRect(x, barY, w, barH);
    // Label if wide enough
    if (w > 28){
      ctx.fillStyle = '#000';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(task.slice(0, 5), x + w / 2, barY + barH / 2 + 3);
    }
    x += w;
  }

  // Legend below
  ctx.font = '8px monospace';
  let lx = pad.l;
  const ly = barY + barH + 12;
  for (const [task, secs] of entries.slice(0, 8)){
    const pct = ((secs / total) * 100).toFixed(0);
    const label = `${task} ${pct}%`;
    ctx.fillStyle = TASK_COLORS[task] ?? '#6b7280';
    ctx.fillRect(lx, ly - 6, 6, 6);
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.fillText(label, lx + 8, ly);
    lx += ctx.measureText(label).width + 16;
    if (lx > W - 40) break;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clearWithMsg(canvas, msg){
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = TEXT_DIM;
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
}

function drawAxes(ctx, pad, W, H, tMin, tMax, vMin, vMax){
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  // Y axis
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + ch);
  ctx.lineTo(pad.l + cw, pad.t + ch);
  ctx.stroke();

  // Y labels
  ctx.font = '8px monospace';
  ctx.fillStyle = TEXT_DIM;
  ctx.textAlign = 'right';
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++){
    const v = vMin + (vMax - vMin) * (i / ySteps);
    const y = pad.t + ch - (i / ySteps) * ch;
    ctx.fillText(Number.isInteger(v) ? String(v) : v.toFixed(1), pad.l - 4, y + 3);
    // Grid line
    if (i > 0 && i < ySteps){
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + cw, y);
      ctx.strokeStyle = GRID;
      ctx.stroke();
    }
  }

  // X labels (time)
  ctx.textAlign = 'center';
  const tRange = Math.max(1, tMax - tMin);
  const xSteps = 4;
  for (let i = 0; i <= xSteps; i++){
    const t = tMin + tRange * (i / xSteps);
    const x = pad.l + (i / xSteps) * cw;
    ctx.fillText(fmtTime(t), x, pad.t + ch + 14);
  }
}

function fmtTime(t){
  const s = Math.round(t);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
