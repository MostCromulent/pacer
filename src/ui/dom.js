// Page helpers shared by every screen: element lookup, the toast, and switching
// between screens.

import { state } from './store.js';

// Element lookup that also finds elements after the ride panel has moved into
// the mini window's document (getElementById only searches one document).
let pipDoc = null;
const elCache = new Map();

export const $ = (id) => {
  const hit = elCache.get(id);
  if (hit?.isConnected) return hit;
  const found = document.getElementById(id) ?? pipDoc?.getElementById(id) ?? null;
  if (found) elCache.set(id, found);
  return found;
};

/** Tell $ about the mini window's document (or null when it closes). */
export function setPipDoc(doc) {
  pipDoc = doc;
}

let toastTimer = null;

/** A short message at the bottom of the screen. */
export function toast(msg, ms = 4200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const SCREENS = ['setup', 'stats', 'ride', 'summary'];

export function showScreen(name) {
  state.screen = name;
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  // No wandering off mid-ride.
  $('top-nav').hidden = name === 'ride';
  $('app-foot').hidden = name === 'ride';
  document.body.classList.toggle('riding', name === 'ride');
  for (const b of document.querySelectorAll('#top-nav [data-screen]')) {
    if (b.dataset.screen === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}
