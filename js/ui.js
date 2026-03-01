// ui.js — UI helpers + lightweight event wiring (modularization step)
// This module intentionally keeps logic small + dependency-injected.

/**
 * Wire lightweight UI listeners and provide transient UI helpers.
 *
 * @param {object} deps
 * @param {HTMLElement|null} deps.statsEl
 * @param {HTMLElement|null} deps.kittensTableEl
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 * @param {()=>void} deps.openSocial
 * @param {()=>void} deps.openStorage
 * @param {()=>void} deps.openThreat
 */
export function initUI(deps){
  const {
    statsEl,
    kittensTableEl,
    log,
    save,
    render,
    openSocial,
    openStorage,
    openThreat,
  } = deps || {};

  // Transient UI state (NOT saved)
  const uiSort = { key:'', dir:0 }; // dir: +1 asc, -1 desc

  // UI log debounce (prevents Event log spam when dragging sliders)
  const _uiLogTimers = Object.create(null);
  function uiDebouncedLog(key, msg, delayMs=350){
    const k = String(key || 'ui');
    if (_uiLogTimers[k]) clearTimeout(_uiLogTimers[k]);
    _uiLogTimers[k] = setTimeout(() => {
      try { log?.(String(msg || '')); } catch (e) {}
    }, Math.max(0, Number(delayMs) || 0));
  }

  // Clickable stat cards (explainability)
  if (statsEl) statsEl.addEventListener('click', (e) => {
    const card = e.target?.closest?.('[data-stat]');
    if (!card) return;
    const key = String(card.dataset.stat || '');
    if (key === 'dissent' || key === 'compliance' || key === 'focusfit' || key === 'grievance') openSocial?.();
    if (key === 'storage') openStorage?.();
    if (key === 'threat') openThreat?.();
  });

  // Colony table sorting (QoL)
  function defaultSortDirFor(key){
    // dir: +1 asc, -1 desc
    return (key === 'hunger') ? +1 : -1;
  }

  function setSort(key){
    const k = String(key || '');
    if (!k) { uiSort.key = ''; uiSort.dir = 0; return; }
    if (uiSort.key === k) {
      // cycle: desc/asc/none
      if (uiSort.dir === -1) uiSort.dir = +1;
      else if (uiSort.dir === +1) { uiSort.key = ''; uiSort.dir = 0; }
      else uiSort.dir = defaultSortDirFor(k);
    } else {
      uiSort.key = k;
      uiSort.dir = defaultSortDirFor(k);
    }
    render?.();
  }

  if (kittensTableEl) {
    const thead = kittensTableEl.querySelector('thead');
    if (thead) thead.addEventListener('click', (e) => {
      const th = e.target?.closest?.('th[data-sort]');
      if (!th) return;
      setSort(String(th.dataset.sort || ''));
    });
  }

  // Return helpers used elsewhere in main render/handlers.
  return { uiSort, uiDebouncedLog };
}

/**
 * Decision/Inspect modal wiring (click kitten row for full scoring breakdown).
 * Rendering is dependency-injected to keep this module UI-only.
 *
 * @param {object} deps
 * @param {()=>any} deps.getState
 * @param {(n:number)=>string} deps.fmt
 * @param {(n:number)=>number} deps.clamp01
 * @param {(id:number)=>any} deps.genPersonality
 * @param {(s:any,k:any)=>any} deps.buddyOf
 * @param {(s:any,k:any)=>number} deps.valuesAlignment01
 * @param {(k:any)=>string} deps.dominantValueAxis
 * @param {(k:any)=>string} deps.valuesShort
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 * @param {HTMLElement|null} deps.inspectModalEl
 * @param {HTMLElement|null} deps.inspectTitleEl
 * @param {HTMLElement|null} deps.inspectSubEl
 * @param {HTMLElement|null} deps.inspectBodyEl
 * @param {HTMLElement|null} deps.inspectControlsEl
 * @param {HTMLElement|null} deps.btnInspectClose
 */
export function initInspectModal(deps){
  const {
    getState,
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
  } = deps || {};

  const uiInspect = { open:false, kidx:-1 };

  function close(){
    uiInspect.open = false;
    uiInspect.kidx = -1;
    if (inspectModalEl) inspectModalEl.classList.add('hidden');
  }

  function open(kidx){
    uiInspect.open = true;
    uiInspect.kidx = Number(kidx ?? -1);
    if (inspectModalEl) inspectModalEl.classList.remove('hidden');
    renderInspect();
  }

  function renderInspect(){
    const state = getState?.();
    if (!inspectModalEl || !inspectTitleEl || !inspectSubEl || !inspectBodyEl) return;

    const kids = state?.kittens ?? [];
    if (!uiInspect.open || uiInspect.kidx < 0 || uiInspect.kidx >= kids.length) {
      inspectModalEl.classList.add('hidden');
      return;
    }

    const k = kids[uiInspect.kidx];
    const p = k.personality ?? genPersonality?.(k.id ?? 0);
    const nm = String(k.name ?? '').trim();
    inspectTitleEl.textContent = `${nm || 'Kitten'} (#${k.id}) - ${k.role ?? 'Generalist'} (${k.task ?? '-'})`;

    const likes = (p?.likes ?? []).join(', ') || '-';
    const hates = (p?.dislikes ?? []).join(', ') || '-';
    const at = (typeof k._lastScoredAt === 'number') ? `t=${fmt?.(k._lastScoredAt)}s` : '';
    const autoFresh = (k._autonomyPickNote && (state.t - Number(k._autonomyPickAt ?? 0)) < 2) ? k._autonomyPickNote : '';
    const traits = Array.isArray(k.traits) ? k.traits.join(', ') : '-';
    const buddy = buddyOf?.(state, k);
    const buddyNote = buddy ? ` | buddy: #${buddy.id}` : '';
    const needNote = buddy ? ` | buddy-need: ${Math.round((clamp01?.(Number(k.buddyNeed ?? 0)) ?? 0)*100)}%` : '';
    const align = valuesAlignment01?.(state, k) ?? 0;
    const bloc = dominantValueAxis?.(k) ?? 'Food';
    const driftFresh = (k._valuesDriftNote && (state.t - Number(k._valuesDriftAt ?? 0)) < 30);
    const driftNote = driftFresh ? ` | ${String(k._valuesDriftNote ?? '')}` : '';
    inspectSubEl.textContent = `traits: ${traits} | bloc: ${bloc} | values: ${valuesShort?.(k) ?? '-'} | focus-fit: ${Math.round(align*100)}% | likes: ${likes} | hates: ${hates}${buddyNote}${needNote}${driftNote}${autoFresh ? ' | ' + autoFresh : ''}${at ? ' | ' + at : ''}`;

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

          if (next !== prev) log?.(`Directive: ${String(k.name ?? 'Kitten')} (#${k.id}) → ${next}`);
          save?.();
          renderInspect();
          render?.();
        });
      }
      const btn = inspectControlsEl.querySelector('#btnDirectiveClear');
      if (btn) {
        btn.addEventListener('click', () => {
          const prev = String(k.directive ?? 'Auto');
          k.directive = 'Auto';
          if (prev !== 'Auto') log?.(`Directive cleared: ${String(k.name ?? 'Kitten')} (#${k.id})`);
          save?.();
          renderInspect();
          render?.();
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
      const ageNote = (age !== null && Number.isFinite(age)) ? ` (age ${fmt?.(age)}s)` : '';

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
        lines.push(`Decision: ${kind || 'SCORE'} → ${task}${ageNote}`);
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
        lines.push(`Execution: ${String(lb.action ?? '')} blocked → ${String(lb.to ?? '')} (age ${fmt?.(age)}s)`);
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

  if (btnInspectClose) btnInspectClose.addEventListener('click', close);
  if (inspectModalEl) inspectModalEl.addEventListener('click', (e) => {
    if (e.target === inspectModalEl) close();
  });

  return { uiInspect, open, close, render: renderInspect };
}

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

/**
 * Patch notes modal wiring.
 *
 * @param {object} deps
 * @param {string} deps.gameVersion
 * @param {Array<{v:string, notes:string[]}>} deps.patchHistory
 * @param {HTMLElement|null} deps.patchModalEl
 * @param {HTMLElement|null} deps.patchTitleEl
 * @param {HTMLElement|null} deps.patchSubEl
 * @param {HTMLElement|null} deps.patchBodyEl
 * @param {HTMLElement|null} deps.btnPatchNotesEl
 * @param {HTMLElement|null} deps.btnPatchCloseEl
 */
export function initPatchNotes(deps){
  const {
    gameVersion,
    patchHistory,
    patchModalEl,
    patchTitleEl,
    patchSubEl,
    patchBodyEl,
    btnPatchNotesEl,
    btnPatchCloseEl,
  } = deps || {};

  const uiPatch = { open:false, fromVersion:'' };

  function close(){
    uiPatch.open = false;
    if (patchModalEl) patchModalEl.classList.add('hidden');
  }

  function render(){
    if (!patchModalEl || !patchTitleEl || !patchSubEl || !patchBodyEl) return;
    if (!uiPatch.open) return;

    const from = String(uiPatch.fromVersion || '');
    const items = (patchHistory ?? [])
      .slice()
      .sort((a,b) => verCmp(a.v, b.v))
      .filter(e => (from ? (verCmp(e.v, from) > 0) : (e.v === gameVersion)) && verCmp(e.v, gameVersion) <= 0);

    patchTitleEl.textContent = `v${gameVersion} - Patch notes`;
    patchSubEl.textContent = from
      ? `Changes since v${from} (you can always reopen this from the header).`
      : 'Changes in this version.';

    const lines = [];
    for (const entry of (items.length ? items : (patchHistory ?? []).filter(e => e.v === gameVersion))) {
      lines.push(`v${entry.v}`);
      for (const n of (entry.notes ?? [])) lines.push(`• ${n}`);
      lines.push('');
    }

    patchBodyEl.textContent = lines.join('\n').trim();
  }

  function open(){
    uiPatch.open = true;
    if (patchModalEl) patchModalEl.classList.remove('hidden');
    render();
  }

  if (btnPatchNotesEl) btnPatchNotesEl.addEventListener('click', open);
  if (btnPatchCloseEl) btnPatchCloseEl.addEventListener('click', close);
  if (patchModalEl) patchModalEl.addEventListener('click', (e) => {
    if (e.target === patchModalEl) close();
  });

  return {
    uiPatch,
    open,
    close,
    render,
    setFromVersion(v){ uiPatch.fromVersion = String(v || ''); },
  };
}
