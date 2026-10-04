// The entry point: loads every screen and starts the app.
//
// Shared state is in store.js, page helpers in dom.js. Each screen has its own
// module, and they call each other's functions to move between screens.

import { DEV, storage, settings, seedCalibrationFromFile, state } from './store.js';
import { showScreen } from './dom.js';
import { renderSetup } from './setup.js';
import { startLoop, updateMute } from './ride-view.js';
import './pace.js';
import './stats.js';
import './connection.js';
import './learning.js';
import './summary.js';
import './calibration.js';
import './model-view.js';

updateMute();
renderSetup();
showScreen('setup');
startLoop();

// A hook for the smoke test and for poking about in the console (dev only).
if (DEV) window.pacer = { state, settings: () => settings, storage };

// A new browser on the dev server picks up the saved calibration file.
seedCalibrationFromFile().then((seeded) => {
  if (seeded && state.screen === 'setup') renderSetup();
});
