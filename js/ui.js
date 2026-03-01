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
