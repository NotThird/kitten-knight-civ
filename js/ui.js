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
 * @param {()=>void} deps.openCulture
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
    openCulture,
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
    if (key === 'culture') openCulture?.();
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
 * Curator controls ("aquarium mode"): minimal levers that drive the Director automation.
 *
 * @param {object} deps
 * @param {HTMLSelectElement|null} deps.goalEl
 * @param {HTMLSelectElement|null} deps.ethosEl
 * @param {HTMLInputElement|null} deps.interventionEl
 * @param {HTMLElement|null} deps.interventionHintEl
 * @param {HTMLElement|null} deps.steeringSummaryEl
 * @param {()=>any} deps.getState
 * @param {(goal:string)=>void} deps.setGoal
 * @param {(ethos:string)=>void} deps.setEthos
 * @param {(v:number)=>void} deps.setIntervention
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 * @param {(s:any)=>string} deps.getSteeringSummary
 */
export function initCuratorControls(deps){
  const {
    goalEl,
    ethosEl,
    interventionEl,
    interventionHintEl,
    steeringSummaryEl,
    getState,
    setGoal,
    setEthos,
    setIntervention,
    log,
    save,
    render,
    getSteeringSummary,
  } = deps || {};

  function interventionLabel(v){
    const n = Math.max(0, Math.min(100, Number(v) || 0));
    if (n <= 10) return 'Hands-off';
    if (n <= 40) return 'Light touch';
    if (n <= 70) return 'Occasional';
    return 'Hands-on';
  }

  function syncFromState(){
    const s = getState?.();
    const c = s?.director?.curator ?? {};
    if (goalEl && c.goal) goalEl.value = String(c.goal);
    if (ethosEl && c.ethos) ethosEl.value = String(c.ethos);
    if (interventionEl) interventionEl.value = String(Math.max(0, Math.min(100, Number(c.intervention ?? 30) || 30)));
    if (interventionHintEl && interventionEl) interventionHintEl.textContent = `(${interventionLabel(interventionEl.value)})`;
    if (steeringSummaryEl && typeof getSteeringSummary === 'function') steeringSummaryEl.textContent = getSteeringSummary(s);
  }

  goalEl?.addEventListener('change', () => {
    const v = String(goalEl.value || 'Thrive');
    setGoal?.(v);
    log?.(`Curator goal → ${v}`);
    save?.();
    render?.();
    syncFromState();
  });

  ethosEl?.addEventListener('change', () => {
    const v = String(ethosEl.value || 'Balanced');
    setEthos?.(v);
    log?.(`Curator ethos → ${v}`);
    save?.();
    render?.();
    syncFromState();
  });

  interventionEl?.addEventListener('input', () => {
    const v = Math.max(0, Math.min(100, Number(interventionEl.value) || 0));
    if (interventionHintEl) interventionHintEl.textContent = `(${interventionLabel(v)})`;
    setIntervention?.(v);
    save?.();
    // no log spam
    render?.();
    if (steeringSummaryEl && typeof getSteeringSummary === 'function') steeringSummaryEl.textContent = getSteeringSummary(getState?.());
  });

  // initial paint
  syncFromState();

  return { syncFromState };
}

/**
 * Save export/import/reset wiring.
 *
 * This stays in ui.js so main.js can stay focused on sim/mechanics.
 *
 * @param {object} deps
 * @param {string} deps.saveKey
 * @param {()=>void} deps.save               - force a clean snapshot into localStorage
 * @param {()=>any} deps.load                - load state from localStorage
 * @param {()=>any} deps.defaultState
 * @param {()=>any} deps.getState
 * @param {(s:any)=>void} deps.setState
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.render
 * @param {HTMLElement|null} deps.btnResetEl
 * @param {HTMLElement|null} deps.btnExportEl
 * @param {HTMLElement|null} deps.btnImportEl
 */
export function initSaveIO(deps){
  const {
    saveKey,
    save,
    load,
    defaultState,
    getState,
    setState,
    log,
    render,
    btnResetEl,
    btnExportEl,
    btnImportEl,
  } = deps || {};

  const SAVE_KEY = String(saveKey || '');

  function getSaveString(){
    // Force a clean snapshot first.
    try { save?.(); } catch (e) {}
    try { return localStorage.getItem(SAVE_KEY) ?? ''; } catch (e) { return ''; }
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
      ta.value = String(text ?? '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch {
      return false;
    }
  }

  function downloadText(filename, text){
    const blob = new Blob([String(text ?? '')], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(filename || 'save.json');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }

  if (btnResetEl) btnResetEl.addEventListener('click', () => {
    if (!confirm('Hard reset?')) return;
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
    try { setState?.(defaultState?.() ?? {}); } catch (e) { setState?.({}); }
    render?.();
  });

  if (btnExportEl) btnExportEl.addEventListener('click', async () => {
    const txt = getSaveString();
    if (!txt) { log?.('No save data found to export.'); render?.(); return; }

    const ok = await copyToClipboard(txt);
    if (ok) log?.('Save exported: copied to clipboard. (Also downloading a .json file)');
    else log?.('Save exported: clipboard copy failed (downloaded a .json file instead).');

    const stamp = new Date().toISOString().replaceAll(':','-');
    downloadText(`kitten-knight-civ-save-${stamp}.json`, txt);
    render?.();
  });

  if (btnImportEl) btnImportEl.addEventListener('click', () => {
    const pasted = prompt('Paste a save string (JSON). This will overwrite your current save.');
    if (!pasted) return;
    try {
      const obj = JSON.parse(pasted);
      if (!obj || !obj.res || !obj.kittens || !obj.rules) throw new Error('Missing required keys.');
      localStorage.setItem(SAVE_KEY, JSON.stringify(obj));
      const next = load?.() ?? defaultState?.();
      setState?.(next);
      log?.('Save imported successfully.');
      render?.();
    } catch (e) {
      log?.(`Import failed: ${(e && e.message) ? e.message : 'invalid JSON'}`);
      render?.();
    }
  });

  return {
    getSaveString,
    exportNow: () => btnExportEl?.click?.(),
  };
}

/**
 * Director Profiles (A/B/C) save/load/clear wiring.
 *
 * Keeps the snapshot/apply logic injected from main.js (sim/state concern).
 *
 * @param {object} deps
 * @param {HTMLElement|null} deps.profilesEl
 * @param {()=>any} deps.getState
 * @param {(s:any)=>void} deps.ensureProfiles
 * @param {()=>any} deps.snapshotDirectorSettings
 * @param {(snap:any)=>void} deps.applyDirectorSettings
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initDirectorProfiles(deps){
  const {
    profilesEl,
    getState,
    ensureProfiles,
    snapshotDirectorSettings,
    applyDirectorSettings,
    log,
    save,
    render,
  } = deps || {};

  if (!profilesEl) return;

  profilesEl.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button[data-prof]');
    if (!btn) return;

    const slot = String(btn.dataset.prof || '');
    const act = String(btn.dataset.pact || '');
    if (!['A','B','C'].includes(slot)) return;

    const s = getState?.();
    if (!s) return;

    ensureProfiles?.(s);

    if (act === 'save') {
      s.director.profiles[slot] = {
        savedAt: Date.now(),
        snap: snapshotDirectorSettings?.(),
      };
      log?.(`Saved profile ${slot}.`);
    } else if (act === 'load') {
      const p = s.director.profiles?.[slot];
      if (!p?.snap) { log?.(`Profile ${slot} is empty.`); render?.(); return; }
      applyDirectorSettings?.(p.snap);
      log?.(`Loaded profile ${slot}.`);
    } else if (act === 'clear') {
      if (s.director?.profiles) s.director.profiles[slot] = null;
      log?.(`Cleared profile ${slot}.`);
    }

    save?.();
    render?.();
  });
}

/**
 * Render Director Profiles (A/B/C) UI (slot buttons + hint text).
 *
 * Pure render helper: does NOT mutate state.
 *
 * @param {object} deps
 * @param {HTMLElement|null} deps.profilesEl
 * @param {HTMLElement|null} deps.profilesHintEl
 * @param {object|null} deps.profiles             - state.director.profiles
 */
export function renderDirectorProfiles(deps){
  const { profilesEl, profilesHintEl, profiles } = deps || {};
  if (!profilesEl) return;

  const fmtTime = (ts) => {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); } catch { return ''; }
  };

  const slotBtn = (slot) => {
    const p = profiles?.[slot];
    const has = !!(p && p.snap);
    const when = has ? fmtTime(p.savedAt) : '';
    const label = has ? `saved ${when}` : 'empty';
    return `
      <div class="row" style="gap:6px; margin-right:10px">
        <span class="tag">${slot}</span>
        <button class="btn" data-prof="${slot}" data-pact="load" ${has ? '' : 'disabled'}>Load</button>
        <button class="btn" data-prof="${slot}" data-pact="save">Save</button>
        <button class="btn bad" data-prof="${slot}" data-pact="clear" ${has ? '' : 'disabled'}>Clear</button>
        <span class="small" style="opacity:.8">${label}</span>
      </div>`;
  };

  profilesEl.innerHTML = ['A','B','C'].map(slotBtn).join('');
  if (profilesHintEl) profilesHintEl.textContent = 'Tip: save a Winter Prep setup in A, an Expand setup in B, and an Advance setup in C.';
}

/**
 * Render the "Project focus" hint line (Director panel).
 *
 * Pure render helper: does NOT mutate state.
 *
 * @param {object} deps
 * @param {any} deps.state
 * @param {HTMLSelectElement|null} deps.projectFocusSelectEl
 * @param {HTMLElement|null} deps.projectFocusHintEl
 * @param {(s:any)=>{focus:string, why:string, auto:boolean}} deps.getEffectiveProjectFocus
 */
export function renderProjectFocusHint(deps){
  const { state, projectFocusSelectEl, projectFocusHintEl, getEffectiveProjectFocus } = deps || {};

  if (projectFocusSelectEl) projectFocusSelectEl.value = String(state?.director?.projectFocus ?? 'Auto');
  if (!projectFocusHintEl) return;

  const setPf = String(state?.director?.projectFocus ?? 'Auto');
  const eff = getEffectiveProjectFocus?.(state) ?? { focus:'Auto', why:'', auto:true };
  const pf = String(eff.focus ?? 'Auto');

  const desc = (x) => (x === 'Housing') ? 'push huts until housing is comfy'
    : (x === 'Defense') ? 'keep a builder on palisade'
    : (x === 'Industry') ? 'try to finish a workshop / keep tools maintained (needs wood+science)'
    : (x === 'Storage') ? 'try to finish a granary (needs wood)'
    : (x === 'Knowledge') ? 'try to finish a library (needs wood+science+tools)'
    : '';

  if (setPf === 'Auto') {
    projectFocusHintEl.textContent = (pf === 'Auto')
      ? `(auto) no focus - ${eff.why}`
      : `(auto) ${pf}: ${desc(pf)} - ${eff.why}`;
  } else {
    projectFocusHintEl.textContent = `${desc(setPf)} (manual)`;
  }
}

/**
 * Render the Director pinned-project selector + hint text.
 *
 * Pure render helper: does NOT mutate state.
 *
 * @param {object} deps
 * @param {any} deps.state
 * @param {HTMLElement|null} deps.pinHintEl
 * @param {HTMLElement|null} deps.btnClearPinEl
 * @param {HTMLElement|null} deps.pinSelectEl
 * @param {HTMLElement|null} deps.btnPinEl
 * @param {HTMLElement|null} deps.pinProjectHintEl
 * @param {(s:any)=>any|null} deps.pinnedProjectInfo
 * @param {(type:string)=>any|null} deps.pinnedProjectDef
 */
export function renderPinnedProjectControls(deps){
  const {
    state,
    pinHintEl,
    btnClearPinEl,
    pinSelectEl,
    btnPinEl,
    pinProjectHintEl,
    pinnedProjectInfo,
    pinnedProjectDef,
  } = deps || {};

  const pin = pinnedProjectInfo?.(state);

  // Pinned project hint (discoverability)
  if (pin && !pin.completed) {
    if (pinHintEl) pinHintEl.textContent = `Pinned: ${pin.type} (finish 1)`;
    if (btnClearPinEl) btnClearPinEl.style.display = '';
  } else {
    if (pinHintEl) pinHintEl.textContent = '';
    if (btnClearPinEl) btnClearPinEl.style.display = 'none';
  }

  // Pin project selector (QoL: same pin mechanic, but discoverable from the Director panel)
  if (pinSelectEl) {
    // Disable options that aren't unlocked yet (keeps it explainable).
    const opt = (val) => pinSelectEl.querySelector(`option[value="${val}"]`);
    const lock = {
      Hut: !state?.unlocked?.construction,
      Palisade: !state?.unlocked?.construction,
      Granary: !(state?.unlocked?.construction && state?.unlocked?.granary),
      Workshop: !(state?.unlocked?.construction && state?.unlocked?.workshop),
      Library: !(state?.unlocked?.construction && state?.unlocked?.library),
    };
    for (const [k, locked] of Object.entries(lock)) {
      const o = opt(k);
      if (o) o.disabled = !!locked;
    }

    // Sync selection to current pin.
    const cur = (pin && !pin.completed) ? String(pin.type ?? '') : '';
    if (String(pinSelectEl.value || '') !== cur) pinSelectEl.value = cur;

    if (pinProjectHintEl) {
      if (!state?.unlocked?.construction) pinProjectHintEl.textContent = 'Unlock Construction to pin builds.';
      else pinProjectHintEl.textContent = cur ? 'Pin clears when 1 completes.' : 'Pick a project to pin (finish 1).';
    }

    if (btnPinEl) {
      const sel = String(pinSelectEl.value || '');
      const def = sel ? pinnedProjectDef?.(sel) : null;
      btnPinEl.disabled = !def;
    }
  }
}

/**
 * Render Directive tools hint + basic enable/disable state.
 *
 * Pure render helper: does NOT mutate state.
 *
 * @param {object} deps
 * @param {any} deps.state
 * @param {HTMLElement|null} deps.dirHintEl
 * @param {HTMLButtonElement|null} deps.btnMatchEl
 * @param {HTMLButtonElement|null} deps.btnClearEl
 * @param {(s:any)=>{active:number,total:number}} deps.countActiveDirectives
 */
export function renderDirectiveTools(deps){
  const { state, dirHintEl, btnMatchEl, btnClearEl, countActiveDirectives } = deps || {};

  const ks = Array.isArray(state?.kittens) ? state.kittens : [];
  const disabled = ks.length <= 0;

  if (btnMatchEl) btnMatchEl.disabled = disabled;
  if (btnClearEl) btnClearEl.disabled = disabled;

  if (dirHintEl) {
    const c = countActiveDirectives?.(state) ?? { active:0, total:ks.length };
    dirHintEl.textContent = (c.total > 0) ? `active directives: ${c.active}/${c.total}` : '';
  }
}

/**
 * Directive tools wiring (Match blocs / Clear all).
 *
 * Kept in ui.js so main.js stays thinner; state mutation is dependency-injected.
 *
 * @param {object} deps
 * @param {HTMLButtonElement|null} deps.btnDirBlocEl
 * @param {HTMLButtonElement|null} deps.btnDirClearAllEl
 * @param {()=>any} deps.getState
 * @param {(s:any)=>void} deps.setDirectivesMatchBlocs
 * @param {(s:any)=>void} deps.clearAllDirectives
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initDirectiveTools(deps){
  const {
    btnDirBlocEl,
    btnDirClearAllEl,
    getState,
    setDirectivesMatchBlocs,
    clearAllDirectives,
    save,
    render,
  } = deps || {};

  if (btnDirBlocEl) btnDirBlocEl.addEventListener('click', () => {
    const s = getState?.();
    if (!s) return;
    setDirectivesMatchBlocs?.(s);
    save?.();
    render?.();
  });

  if (btnDirClearAllEl) btnDirClearAllEl.addEventListener('click', () => {
    const s = getState?.();
    if (!s) return;
    clearAllDirectives?.(s);
    save?.();
    render?.();
  });
}

/**
 * Labor doctrine selector wiring.
 *
 * Kept in ui.js so main.js stays thinner; state mutation is dependency-injected.
 *
 * @param {object} deps
 * @param {HTMLSelectElement|null} deps.doctrineEl
 * @param {(v:string)=>void} deps.setDoctrine
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initDoctrineControls(deps){
  const {
    doctrineEl,
    setDoctrine,
    log,
    save,
    render,
  } = deps || {};

  if (!doctrineEl) return;

  doctrineEl.addEventListener('change', (e) => {
    const v = String(e?.target?.value ?? 'Balanced');
    const next = (setDoctrine?.(v) ?? v);
    log?.(`Labor doctrine → ${String(next || 'Balanced')}`);
    save?.();
    render?.();
  });
}

/**
 * Auto Doctrine toggle wiring.
 *
 * Kept in ui.js so main.js stays thinner; state mutation is dependency-injected.
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.autoDoctrineEl
 * @param {(on:boolean)=>boolean} deps.setAutoDoctrine
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initAutoDoctrineControls(deps){
  const {
    autoDoctrineEl,
    setAutoDoctrine,
    log,
    save,
    render,
  } = deps || {};

  if (!autoDoctrineEl) return;

  autoDoctrineEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setAutoDoctrine?.(on));
    log?.(`Auto Doctrine → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
}

/**
 * Auto Rations toggle wiring.
 *
 * Kept in ui.js so main.js stays thinner; state mutation is dependency-injected.
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.autoRationsEl
 * @param {(on:boolean)=>boolean} deps.setAutoRations
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initAutoRationsControls(deps){
  const {
    autoRationsEl,
    setAutoRations,
    log,
    save,
    render,
  } = deps || {};

  if (!autoRationsEl) return;

  autoRationsEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setAutoRations?.(on));
    log?.(`Auto Rations → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
}

/**
 * Auto Recruit toggle wiring.
 *
 * Kept in ui.js so main.js stays thinner; state mutation is dependency-injected.
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.autoRecruitEl
 * @param {(on:boolean)=>boolean} deps.setAutoRecruit
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initAutoRecruitControls(deps){
  const {
    autoRecruitEl,
    setAutoRecruit,
    log,
    save,
    render,
  } = deps || {};

  if (!autoRecruitEl) return;

  autoRecruitEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setAutoRecruit?.(on));
    log?.(`Auto Recruit → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
}

/**
 * Auto Winter Prep toggle wiring.
 *
 * Kept in ui.js so main.js stays thinner; state mutation is dependency-injected.
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.autoWinterPrepEl
 * @param {(on:boolean)=>boolean} deps.setAutoWinterPrep
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initAutoWinterPrepControls(deps){
  const {
    autoWinterPrepEl,
    setAutoWinterPrep,
    log,
    save,
    render,
  } = deps || {};

  if (!autoWinterPrepEl) return;

  autoWinterPrepEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setAutoWinterPrep?.(on));
    log?.(`Auto Winter Prep → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
}

/**
 * Auto Food Crisis toggle wiring.
 *
 * Kept in ui.js so main.js stays thinner; state mutation is dependency-injected.
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.autoFoodCrisisEl
 * @param {(on:boolean)=>boolean} deps.setAutoFoodCrisis
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initAutoFoodCrisisControls(deps){
  const {
    autoFoodCrisisEl,
    setAutoFoodCrisis,
    log,
    save,
    render,
  } = deps || {};

  if (!autoFoodCrisisEl) return;

  autoFoodCrisisEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setAutoFoodCrisis?.(on));
    log?.(`Auto Food Crisis → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
}

/**
 * Auto Reserves toggle wiring.
 *
 * Kept in ui.js so main.js stays thinner; state mutation is dependency-injected.
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.autoReservesEl
 * @param {(on:boolean)=>boolean} deps.setAutoReserves
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initAutoReservesControls(deps){
  const {
    autoReservesEl,
    setAutoReserves,
    log,
    save,
    render,
  } = deps || {};

  if (!autoReservesEl) return;

  autoReservesEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setAutoReserves?.(on));
    log?.(`Auto Reserves → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
}

/**
 * Auto Policy toggle wiring.
 *
 * Kept in ui.js so main.js stays thinner; state mutation is dependency-injected.
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.autoPolicyEl
 * @param {(on:boolean)=>boolean} deps.setAutoPolicy
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initAutoPolicyControls(deps){
  const {
    autoPolicyEl,
    setAutoPolicy,
    log,
    save,
    render,
  } = deps || {};

  if (!autoPolicyEl) return;

  autoPolicyEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setAutoPolicy?.(on));
    log?.(`Auto Policy → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
}

/**
 * Auto Build Push toggle wiring.
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.autoBuildPushEl
 * @param {(on:boolean)=>boolean} deps.setAutoBuildPush
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initAutoBuildPushControls(deps){
  const {
    autoBuildPushEl,
    setAutoBuildPush,
    log,
    save,
    render,
  } = deps || {};

  if (!autoBuildPushEl) return;

  autoBuildPushEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setAutoBuildPush?.(on));
    log?.(`Auto Build Push → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
}

/**
 * Auto Mode toggle wiring ("director.autoMode").
 *
 * Kept in ui.js so main.js can stay focused on sim/mechanics.
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.autoModeEl
 * @param {(on:boolean)=>boolean} deps.setAutoMode
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initAutoModeControls(deps){
  const {
    autoModeEl,
    setAutoMode,
    log,
    save,
    render,
  } = deps || {};

  if (!autoModeEl) return;

  autoModeEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setAutoMode?.(on));
    log?.(`Auto Mode → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
}

/**
 * Confirm politics toggle wiring ("director.confirmFactions").
 *
 * @param {object} deps
 * @param {HTMLInputElement|null} deps.confirmFactionsEl
 * @param {(on:boolean)=>boolean} deps.setConfirmPolitics
 * @param {(msg:string)=>void} deps.log
 * @param {()=>void} deps.save
 * @param {()=>void} deps.render
 */
export function initConfirmPoliticsControls(deps){
  const {
    confirmFactionsEl,
    setConfirmPolitics,
    log,
    save,
    render,
  } = deps || {};

  if (!confirmFactionsEl) return;

  confirmFactionsEl.addEventListener('change', (e) => {
    const on = !!e?.target?.checked;
    const next = !!(setConfirmPolitics?.(on));
    log?.(`Confirm politics → ${next ? 'ON' : 'OFF'}`);
    save?.();
    render?.();
  });
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

/**
 * Social/Storage/Threat inspectors (explainability modals).
 * Kept dependency-injected so the UI module doesn't own simulation logic.
 *
 * @param {object} deps
 * @param {()=>any} deps.getState
 * @param {(n:number)=>string} deps.fmt
 * @param {(n:number)=>number} deps.clamp01
 * @param {(t:number)=>any} deps.seasonAt
 * @param {(s:any)=>any} deps.seasonTargets
 * @param {(s:any)=>number} deps.dissent01
 * @param {(s:any)=>number} deps.compliance01
 * @param {(s:any)=>any} deps.getRations
 * @param {(s:any)=>string} deps.doctrineKey
 * @param {(s:any)=>number} deps.workPaceMul
 * @param {(s:any)=>number} deps.discipline01
 * @param {string[]} deps.VALUE_AXES
 * @param {(k:any)=>void} deps.ensureValues
 * @param {(s:any,k:any)=>number} deps.valuesAlignment01
 * @param {(k:any)=>string} deps.dominantValueAxis
 * @param {(s:any)=>any} deps.colonyFocusVec
 * @param {(s:any)=>number} deps.foodStorageCap
 * @param {(sec:number)=>string} deps.fmtEtaSeconds
 * @param {(a:number,b:number,rate:number)=>number} deps.etaToTarget
 * @param {(rate:number)=>string} deps.fmtRate
 * @param {(s:any)=>boolean} deps.drillActive
 *
 * @param {HTMLElement|null} deps.socialModalEl
 * @param {HTMLElement|null} deps.socialTitleEl
 * @param {HTMLElement|null} deps.socialSubEl
 * @param {HTMLElement|null} deps.socialBodyEl
 * @param {HTMLElement|null} deps.btnSocialClose
 *
 * @param {HTMLElement|null} deps.storageModalEl
 * @param {HTMLElement|null} deps.storageTitleEl
 * @param {HTMLElement|null} deps.storageSubEl
 * @param {HTMLElement|null} deps.storageBodyEl
 * @param {HTMLElement|null} deps.btnStorageClose
 *
 * @param {HTMLElement|null} deps.threatModalEl
 * @param {HTMLElement|null} deps.threatTitleEl
 * @param {HTMLElement|null} deps.threatSubEl
 * @param {HTMLElement|null} deps.threatBodyEl
 * @param {HTMLElement|null} deps.btnThreatClose
 */
export function initSocietyInspectors(deps){
  const {
    getState,
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
  } = deps || {};

  const ui = { socialOpen:false, cultureOpen:false, storageOpen:false, threatOpen:false };

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
    const state = getState?.();
    if (!socialModalEl || !socialTitleEl || !socialSubEl || !socialBodyEl) return;
    if (!ui.socialOpen) { socialModalEl.classList.add('hidden'); return; }

    const dis = dissent01?.(state) ?? 0;
    const band = String(state?.social?.band ?? (dis >= 0.70 ? 'strike' : dis >= 0.45 ? 'murmur' : 'calm'));
    const comp = compliance01?.(state) ?? 1;
    const drivers = state?._dissentDrivers ?? null;

    socialTitleEl.textContent = `Dissent: ${Math.round(dis*100)}% (${band}) — Compliance x${comp.toFixed(2)}`;

    const season = seasonAt?.(state?.t ?? 0);
    const doc = doctrineKey?.(state);
    const wp = workPaceMul?.(state) ?? 1;
    const dpol = discipline01?.(state) ?? 0;

    socialSubEl.textContent = `Season: ${season?.name ?? '?'} | Rations: ${String(state?.rations ?? 'Normal')} | Work pace: ${(wp*100).toFixed(0)}% | Discipline: ${(dpol*100).toFixed(0)}% | Doctrine: ${doc}`;

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
    try {
      const n = Math.max(1, (state?.kittens ?? []).length);
      const avg = { Food:0, Safety:0, Progress:0, Social:0 };
      let avgAlign = 0;
      for (const k of (state?.kittens ?? [])) {
        ensureValues?.(k);
        for (const ax of (VALUE_AXES ?? [])) avg[ax] += Number(k?.values?.[ax] ?? 0);
        avgAlign += (valuesAlignment01?.(state, k) ?? 0);
      }
      for (const ax of (VALUE_AXES ?? [])) avg[ax] /= n;
      const focus = colonyFocusVec?.(state) ?? avg;
      avgAlign /= n;

      const pct = (x)=>Math.round(100 * (Number(x) || 0));
      const vecLine = (v)=>`Food ${pct(v.Food)}% | Safety ${pct(v.Safety)}% | Progress ${pct(v.Progress)}% | Social ${pct(v.Social)}%`;

      // Biggest mismatch axis (signed, in percentage points).
      let mm = { ax:'Food', d:0 };
      for (const ax of (VALUE_AXES ?? [])) {
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

    // Individual misalignment: show who is least aligned right now (reduces "hunt through inspectors" friction).
    try {
      const rows = (state?.kittens ?? []).map((k) => {
        const id = Number(k?.id ?? 0);
        const nm = String(k?.name ?? '').trim() || `Kitten #${id}`;
        const align = (valuesAlignment01?.(state, k) ?? 0);
        const g = clamp01?.(Number(k?.grievance ?? 0)) ?? 0;
        const bloc = dominantValueAxis?.(k);
        const role = String(k?.role ?? 'Generalist');
        const task = String(k?.task ?? '-');
        return { id, nm, align, g, bloc, role, task };
      });

      rows.sort((a,b) => (a.align - b.align) || (b.g - a.g));
      const n = Math.min(5, rows.length);
      if (n > 0) {
        lines.push('Lowest focus-fit kittens (who may grumble first):');
        for (let i=0;i<n;i++) {
          const r = rows[i];
          lines.push(`• #${r.id} ${r.nm} — fit ${Math.round(r.align*100)}% | grievance ${Math.round(r.g*100)}% | bloc ${r.bloc} | ${r.role} (${r.task})`);
        }
        lines.push('');
        lines.push('Tip: if many low-fit kittens share a bloc, try nudging Priorities/Mode toward it (or raise Autonomy to accept diversity).');
        lines.push('');
      }
    } catch (e) {
      // Never break the inspector.
    }

    // Culture inspector card (persistent norms + last transitions)
    try {
      const norms = state?.social?.norms ?? {};
      const normLines = [];
      const pct = (x)=>`${Math.round(100 * (clamp01?.(Number(x ?? 0)) ?? 0))}%`;

      const vig = clamp01?.(Number(norms.raidParanoia ?? 0)) ?? 0;
      const scar = clamp01?.(Number(norms.scarcityMindset ?? 0)) ?? 0;
      const aid = clamp01?.(Number(norms.mutualAid ?? 0)) ?? 0;
      const pun = clamp01?.(Number(norms.punitiveTolerance ?? 0)) ?? 0;

      const vigBand = String(state?.social?.normsBand ?? (vig >= 0.70 ? 'paranoid' : vig >= 0.40 ? 'wary' : 'calm'));
      const scarBand = String(state?.social?.scarcityBand ?? (scar >= 0.70 ? 'hoarding' : scar >= 0.40 ? 'thrifty' : 'calm'));
      const aidBand = String(state?.social?.mutualAidBand ?? (aid >= 0.70 ? 'communal' : aid >= 0.40 ? 'neighborly' : 'atomized'));
      const punBand = String(state?.social?.punitiveBand ?? (pun >= 0.70 ? 'punitive' : pun >= 0.40 ? 'firm' : 'lenient'));

      normLines.push('');
      normLines.push('Culture memory (persistent norms):');
      normLines.push(`• Vigilance (raid paranoia): ${pct(vig)} — ${vigBand}`);
      normLines.push(`• Scarcity mindset: ${pct(scar)} — ${scarBand}`);
      normLines.push(`• Mutual aid: ${pct(aid)} — ${aidBand}`);
      normLines.push(`• Punitive tolerance: ${pct(pun)} — ${punBand}`);

      // Last 3 norm transitions (pulled from trend markers)
      const ev = Array.isArray(state?._trendEvents) ? state._trendEvents : [];
      const normEv = ev.filter(e => String(e?.kind ?? '') === 'norm');
      if (normEv.length > 0) {
        const last = normEv.slice(-3);
        const fmtAgo = (t)=>{
          const dt = Math.max(0, Number(state?.t ?? 0) - Number(t ?? 0));
          if (dt >= 120) return `${Math.round(dt/60)}m ago`;
          return `${Math.round(dt)}s ago`;
        };
        normLines.push('Recent culture shifts:');
        for (const e of last) normLines.push(`• ${String(e?.label ?? '')} (${fmtAgo(e?.t)})`);
      }
      normLines.push('');

      lines.push(...normLines);
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

  function closeCulture(){
    ui.cultureOpen = false;
    if (cultureModalEl) cultureModalEl.classList.add('hidden');
  }

  function openCulture(){
    ui.cultureOpen = true;
    if (cultureModalEl) cultureModalEl.classList.remove('hidden');
    renderCulture();
  }

  function renderCulture(){
    const state = getState?.();
    if (!cultureModalEl || !cultureTitleEl || !cultureSubEl || !cultureBodyEl) return;
    if (!ui.cultureOpen) { cultureModalEl.classList.add('hidden'); return; }

    const norms = state?.social?.norms ?? {};
    const pct = (x)=>`${Math.round(100 * (clamp01?.(Number(x ?? 0)) ?? 0))}%`;

    const vig = clamp01?.(Number(norms.raidParanoia ?? 0)) ?? 0;
    const scar = clamp01?.(Number(norms.scarcityMindset ?? 0)) ?? 0;
    const aid = clamp01?.(Number(norms.mutualAid ?? 0)) ?? 0;
    const pun = clamp01?.(Number(norms.punitiveTolerance ?? 0)) ?? 0;

    const vigBand = String(state?.social?.normsBand ?? (vig >= 0.70 ? 'paranoid' : vig >= 0.40 ? 'wary' : 'calm'));
    const scarBand = String(state?.social?.scarcityBand ?? (scar >= 0.70 ? 'hoarding' : scar >= 0.40 ? 'thrifty' : 'calm'));
    const aidBand = String(state?.social?.mutualAidBand ?? (aid >= 0.70 ? 'communal' : aid >= 0.40 ? 'neighborly' : 'atomized'));
    const punBand = String(state?.social?.punitiveBand ?? (pun >= 0.70 ? 'punitive' : pun >= 0.40 ? 'firm' : 'lenient'));

    cultureTitleEl.textContent = 'Culture memory (Norms)';
    cultureSubEl.textContent = 'Persistent norms are slow-moving culture scalars (0..100%). They update from raids, scarcity, social strain, and governance.';

    const lines = [];
    lines.push('Norms (persistent, 0..100%):');
    lines.push(`• Vigilance (raid paranoia): ${pct(vig)} — ${vigBand}`);
    lines.push(`• Scarcity mindset: ${pct(scar)} — ${scarBand}`);
    lines.push(`• Mutual aid: ${pct(aid)} — ${aidBand}`);
    lines.push(`• Punitive tolerance: ${pct(pun)} — ${punBand}`);
    lines.push('');

    // Active culture ritual (short-lived atmosphere window)
    try {
      const r = (state && state._cultureRitual && typeof state._cultureRitual === 'object') ? state._cultureRitual : null;
      const kind = (r && Number(state?.t ?? 0) < Number(r.until ?? 0)) ? String(r.kind || '') : '';
      if (kind) {
        const rem = Math.max(0, Number(r.until ?? 0) - Number(state?.t ?? 0));
        const sfx = rem >= 120 ? `${Math.round(rem/60)}m` : `${Math.round(rem)}s`;
        const label = (kind === 'story') ? 'Story-circle' : (kind === 'oath') ? 'Work-oath' : kind;

        // Best-effort: show which influential coterie sparked it.
        const cid = (r && r.cid !== null && r.cid !== undefined) ? Number(r.cid) : null;
        const coteries = Array.isArray(state?.social?.coteries) ? state.social.coteries : [];
        const c = (cid !== null) ? coteries.find(x => Number(x?.id ?? -1) === cid) : null;
        const bits = [];
        const ax = String(c?.domAx ?? '').trim();
        const trad = String(c?.trad ?? '').trim();
        const ethos = String(c?.ethosLabel ?? '').trim();
        const rep = String(c?.repLabel ?? '').trim();
        if (ax) bits.push(ax);
        if (trad) bits.push(trad);
        if (ethos) bits.push(ethos);
        if (rep) bits.push(rep);
        const who = bits.length ? bits.join(' • ') : (cid !== null ? `Coterie #${cid}` : '');

        lines.push(`Active ritual: ${label} (${sfx} left)${who ? ` — ${who}` : ''}`);
        lines.push('');
      }
    } catch (e) {
      // Never break the inspector.
    }

    // Last 8 norm transitions (pulled from trend markers)
    const ev = Array.isArray(state?._trendEvents) ? state._trendEvents : [];
    const normEv = ev.filter(e => String(e?.kind ?? '') === 'norm');
    if (normEv.length > 0) {
      const last = normEv.slice(-8);
      const fmtAgo = (t)=>{
        const dt = Math.max(0, Number(state?.t ?? 0) - Number(t ?? 0));
        if (dt >= 120) return `${Math.round(dt/60)}m ago`;
        return `${Math.round(dt)}s ago`;
      };
      lines.push('Recent culture shifts:');
      for (const e of last) lines.push(`• ${String(e?.label ?? '')} (${fmtAgo(e?.t)})`);
      lines.push('');
    }

    lines.push('How this matters:');
    lines.push('• Vigilance biases Guard even after danger passes (the colony remembers raids).');
    lines.push('• Scarcity biases PreserveFood even after the pantry recovers (habitual thrift).');
    lines.push('• Mutual aid makes Socialize/Care more culturally "legitimate" during tension.');
    lines.push('• Punitive tolerance changes whether Discipline causes backlash or compliance.');
    lines.push('');

    // Coteries: influential circles are a second "culture" layer (micro-factions) with ethos/tradition/reputation.
    try {
      const coteries = Array.isArray(state?.social?.coteries) ? state.social.coteries : [];
      const inf = (state && state._coterieInfluence && typeof state._coterieInfluence === 'object') ? state._coterieInfluence : {};
      const influential = coteries.filter(c => !!inf?.[c.id]?.inf);
      if (influential.length > 0) {
        influential.sort((a,b)=> (Number(b.size ?? 0) - Number(a.size ?? 0)) || String(a.id).localeCompare(String(b.id)));

        const press = (state && state._coteriePressure && typeof state._coteriePressure === 'object') ? state._coteriePressure : null;
        const rels = (state && state._coterieRelations && typeof state._coterieRelations === 'object') ? state._coterieRelations : null;

        const activePressTagsFor = (cid)=>{
          const tags = [];
          if (press) {
            for (const kind of ['aid','strict']) {
              const p = press[kind];
              if (p && Number(p.cid ?? -1) === Number(cid) && Number(p.until ?? 0) > Number(state?.t ?? 0)) {
                const rem = Math.max(0, Number(p.until ?? 0) - Number(state?.t ?? 0));
                const sfx = rem >= 120 ? `${Math.round(rem/60)}m` : `${Math.round(rem)}s`;
                tags.push(`${kind.toUpperCase()} ${sfx}`);
              }
            }
          }
          // Relationship arc tags (FEUD/TRUCE)
          if (rels) {
            for (const [k,v] of Object.entries(rels)) {
              const parts = String(k).split('-');
              if (parts.length !== 2) continue;
              const a = Number(parts[0]);
              const b = Number(parts[1]);
              if (Number(cid) !== a && Number(cid) !== b) continue;
              const st = String(v?.status ?? '');
              const until = Number(v?.until ?? 0);
              if (!st || until <= Number(state?.t ?? 0)) continue;
              const rem = Math.max(0, until - Number(state?.t ?? 0));
              const sfx = rem >= 120 ? `${Math.round(rem/60)}m` : `${Math.round(rem)}s`;
              tags.push(`${st.toUpperCase()} ${sfx}`);
              break;
            }
          }
          return tags;
        };

        lines.push('Influential coteries (micro-factions):');
        for (const c of influential.slice(0, 6)) {
          const who = Array.isArray(c.members) ? c.members.slice(0, 4).map(id => `#${id}`).join(', ') : '';
          const tags = activePressTagsFor(c.id);
          const tagStr = tags.length ? ` | ${tags.join(' | ')}` : '';
          const trad = String(c.trad ?? '').trim();
          const ethos = String(c.ethosLabel ?? '').trim();
          const rep = String(c.repLabel ?? '').trim();
          const ax = String(c.domAx ?? '').trim();
          const bits = [];
          if (ax) bits.push(ax);
          if (trad) bits.push(trad);
          if (ethos) bits.push(ethos);
          if (rep) bits.push(rep);
          const head = bits.length ? bits.join(' • ') : `Coterie #${c.id}`;
          lines.push(`• ${head} (size ${Number(c.size ?? 0)})${tagStr}${who ? ` — ${who}` : ''}`);
        }
        lines.push('');
        lines.push('Tip: watch Trends markers like cot/trad/eth/rep/press for "culture beats" (they align with feed lines).');
        lines.push('');
      }
    } catch (e) {
      // Never break the inspector.
    }

    cultureBodyEl.textContent = lines.join('\n');
  }

  function closeStorage(){
    ui.storageOpen = false;
    if (storageModalEl) storageModalEl.classList.add('hidden');
  }

  function openStorage(){
    ui.storageOpen = true;
    if (storageModalEl) storageModalEl.classList.remove('hidden');
    renderStorage();
  }

  function renderStorage(){
    const state = getState?.();
    if (!storageModalEl || !storageTitleEl || !storageSubEl || !storageBodyEl) return;
    if (!ui.storageOpen) { storageModalEl.classList.add('hidden'); return; }

    const cap = foodStorageCap?.(state) ?? 0;
    const food = Number(state?.res?.food ?? 0) || 0;
    const jerky = Number(state?.res?.jerky ?? 0) || 0;
    const edible = Math.max(0, food + jerky);
    const n = Math.max(1, Number(state?.kittens?.length ?? 1) || 1);
    const ediblePk = edible / n;

    // IMPORTANT: storage cap + spoilage only apply to fresh food (food), not preserved rations (jerky).
    const oc = state?._lastFoodOvercap ?? { cap, food, mult: 1 };
    const spoilMult = (clamp01?.((Number(oc.mult ?? 1) - 1) / 3) ?? 0) * 3 + 1; // sanitize to [1..4]

    const huts = Math.max(0, Number(state?.res?.huts ?? 0));
    const gran = Math.max(0, Number(state?.res?.granaries ?? 0));
    const base = 260;
    const hutBonus = huts * 28;
    const granBonus = gran * 120;

    const season = seasonAt?.(state?.t ?? 0);
    const over = Math.max(0, food - cap);
    const overPct = cap > 0 ? (over / cap) : 0;

    storageTitleEl.textContent = `Fresh food cap: ${fmt?.(cap)} | Spoilage x${Number(spoilMult).toFixed(2)}`;
    storageSubEl.textContent = `Season: ${season?.name ?? '?'} | Fresh food: ${fmt?.(food)}${jerky > 0 ? ` | Jerky: ${fmt?.(jerky)}` : ''} | Edible total: ${fmt?.(edible)} (${fmt?.(ediblePk)}/kitten)${over > 0 ? ` | over-cap by ${fmt?.(over)} (${(overPct*100).toFixed(0)}%)` : ''}`;

    const lines = [];
    lines.push('What this is:');
    lines.push('• Fresh Food has a soft storage cap. If you stockpile above it, spoilage accelerates.');
    lines.push('• Jerky does NOT spoil and does NOT count toward the fresh-food cap (it is your winter bank).');
    lines.push('• Spoilage multiplier is capped at x4 to keep it a pressure, not a wipeout.');
    lines.push('');
    lines.push('Quick read (right now):');
    lines.push(`• edible total = food + jerky = ${fmt?.(food)} + ${fmt?.(jerky)} = ${fmt?.(edible)} (${fmt?.(ediblePk)}/kitten)`);
    lines.push(`• over-cap (fresh food only) = max(0, food - cap) = ${fmt?.(over)} → spoilage x${Number(spoilMult).toFixed(2)}`);
    lines.push('');
    lines.push('Cap breakdown (current):');
    lines.push(`• base: ${fmt?.(base)}`);
    lines.push(`• huts: +${fmt?.(hutBonus)}  (${huts} × 28)`);
    lines.push(`• granaries: +${fmt?.(granBonus)}  (${gran} × 120)`);
    lines.push(`= total cap: ${fmt?.(base + hutBonus + granBonus)}`);
    lines.push('');
    lines.push('How to respond (management levers):');
    lines.push('• If spoilage is high: build Granary (Project focus → Storage) and/or PreserveFood into Jerky.');
    lines.push('• If you are stable: don’t over-forage; redirect labor into wood/science/industry.');
    lines.push('• If Winter is soon: a *little* over-cap is fine, but prefer banking surplus as Jerky.');

    storageBodyEl.textContent = lines.join('\n');
  }

  function closeThreat(){
    ui.threatOpen = false;
    if (threatModalEl) threatModalEl.classList.add('hidden');
  }

  function openThreat(){
    ui.threatOpen = true;
    if (threatModalEl) threatModalEl.classList.remove('hidden');
    renderThreat();
  }

  function renderThreat(){
    const state = getState?.();
    if (!threatModalEl || !threatTitleEl || !threatSubEl || !threatBodyEl) return;
    if (!ui.threatOpen) { threatModalEl.classList.add('hidden'); return; }

    const season = seasonAt?.(state?.t ?? 0);
    const targets = seasonTargets?.(state) ?? { maxThreat: 70 };

    const r = state?._rate ?? {};
    const threat = Math.max(0, Number(state?.res?.threat ?? 0) || 0);
    const threatRate = Number(r.threat ?? 0);

    const pop = Math.max(1, Number(state?.kittens?.length ?? 1) || 1);
    const pal = Math.max(0, Number(state?.res?.palisade ?? 0) || 0);
    const guards = (state?.kittens ?? []).filter(k => String(k?.task ?? '') === 'Guard').length;
    const sec = state?.unlocked?.security ? 1 : 0;
    const drill = drillActive?.(state) ? 1 : 0;
    const curfew = state?.director?.curfew ? 1 : 0;

    const defScore = pal * 0.7 + guards * 1.4 + sec * 2.0 + drill * 3.0 + curfew * 1.5;
    const mitigate = Math.max(0.25, 1 - 0.035 * defScore);
    const repelChance = Math.min(0.65, 0.04 * guards + 0.012 * pal + 0.10 * drill + 0.06 * sec);

    const raidEta = (threatRate > 0.02 && threat < 100)
      ? fmtEtaSeconds?.(etaToTarget?.(threat, 100, threatRate) ?? 0)
      : (threat >= 100 ? 'NOW' : '-');

    const threatTargetEta = (threatRate > 0.02 && threat < targets.maxThreat)
      ? fmtEtaSeconds?.(etaToTarget?.(threat, targets.maxThreat, threatRate) ?? 0)
      : (threat >= targets.maxThreat ? 'over' : '-');

    threatTitleEl.textContent = `Threat: ${fmt?.(threat)} (${fmtRate?.(threatRate)}) | Raid ETA: ${raidEta}`;
    threatSubEl.textContent = `Season: ${season?.name ?? '?'} | Target max threat: ${targets.maxThreat} | You are ${threat <= targets.maxThreat ? 'OK' : 'OVER'} (ETA to target: ${threatTargetEta})`;

    const lines = [];
    lines.push('What threat is:');
    lines.push('• A rising pressure that triggers raids at 100 threat.');
    lines.push('• Threat rises over time; winter slows it a bit.');
    lines.push('• Your defenses do NOT stop raids from happening; they reduce raid damage and can repel raids outright.');
    lines.push('');

    lines.push('Defense model (current):');
    lines.push(`• palisade: ${pal}`);
    lines.push(`• guards (assigned now): ${guards} / pop ${pop}`);
    lines.push(`• security tech: ${sec ? 'yes' : 'no'} | drills active: ${drill ? 'yes' : 'no'} | curfew: ${curfew ? 'yes' : 'no'}`);
    lines.push(`• defense score = pal*0.7 + guards*1.4 + security*2 + drills*3 + curfew*1.5 = ${fmt?.(defScore)}`);
    lines.push(`• damage multiplier (mitigation) = max(0.25, 1 - 0.035*defScore) = x${mitigate.toFixed(2)} (lower is better)`);
    lines.push(`• repel chance = min(0.65, 0.04*guards + 0.012*pal + 0.10*drills + 0.06*security) = ${(repelChance*100).toFixed(0)}%`);
    lines.push('');

    lines.push('How to manage threat (levers):');
    lines.push('• Short term: assign more Guard, run Drills, toggle Curfew.');
    lines.push('• Medium term: build Palisade, unlock Security tech (science).');
    lines.push('• Policy: in Defend mode or when threat is rising, raise Guard and Palisade multipliers; lower non-essential spending.');

    threatBodyEl.textContent = lines.join('\n');
  }

  if (btnSocialClose) btnSocialClose.addEventListener('click', closeSocial);
  if (socialModalEl) socialModalEl.addEventListener('click', (e) => {
    if (e.target === socialModalEl) closeSocial();
  });

  if (btnCultureClose) btnCultureClose.addEventListener('click', closeCulture);
  if (cultureModalEl) cultureModalEl.addEventListener('click', (e) => {
    if (e.target === cultureModalEl) closeCulture();
  });

  if (btnStorageClose) btnStorageClose.addEventListener('click', closeStorage);
  if (storageModalEl) storageModalEl.addEventListener('click', (e) => {
    if (e.target === storageModalEl) closeStorage();
  });

  if (btnThreatClose) btnThreatClose.addEventListener('click', closeThreat);
  if (threatModalEl) threatModalEl.addEventListener('click', (e) => {
    if (e.target === threatModalEl) closeThreat();
  });

  return {
    ui,
    openSocial,
    closeSocial,
    renderSocial,

    openCulture,
    closeCulture,
    renderCulture,

    openStorage,
    closeStorage,
    renderStorage,

    openThreat,
    closeThreat,
    renderThreat,

    closeAll(){ closeSocial(); closeCulture(); closeStorage(); closeThreat(); },
    renderAll(){ renderSocial(); renderCulture(); renderStorage(); renderThreat(); },
  };
}
