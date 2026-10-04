// Learning the bike's resistance model from the readings it sends during rides.

import { fitBins } from '../core/learn.js';
import { calibration, saveCalibration, activeModel, learner, state } from './store.js';
import { toast } from './dom.js';

/** The saved calibration belongs to one bike; a different bike has to be calibrated first. */
export function isCalibratedBike() {
  return !calibration?.bike || calibration.bike === state.bike?.name;
}

/** A bike that reports its resistance measures its own formula on every ride. */
let learnedSaved = 0; // readings already folded into the saved model
let lastLearnAt = 0;

export function learnWhileRiding() {
  const l = state.latest;
  if (state.bikeKind !== 'ble' || l.resistance === undefined || !isCalibratedBike()) return;
  const now = performance.now();
  const since = now - lastLearnAt;
  if (since < 900) return; // one reading a second, however the bike splits its packets
  if (since > 3000) learner.rest();
  lastLearnAt = now;
  learner.observe({ resistance: l.resistance, cadence: l.cadence, power: l.powerW });
}

export function saveLearning() {
  const fresh = learner.added - learnedSaved;
  if (!fresh) return;
  const model = fitBins(learner.bins, activeModel());
  if (!model) return;
  learnedSaved = learner.added;
  const now = new Date().toISOString();
  const filed = saveCalibration({
    bike: state.bike?.name ?? calibration?.bike,
    date: calibration?.date ?? now,
    updated: now,
    model,
    bins: learner.bins,
  });
  if (filed) toast(`Bike model updated with ${fresh} readings from this ride.`);
}
