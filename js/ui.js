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
