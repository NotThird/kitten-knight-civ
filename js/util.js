// util.js — tiny shared helpers
// Keep this file dependency-free so it can be imported from any module.

export const fmt = (n) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(1)).replace(/\.0$/, '');
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const now = () => performance.now();
