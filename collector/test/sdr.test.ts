import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSdrDown, SdrWatch } from '../../shared/sdr.ts';

const WEDGED = 'decoder exited (code 1): <3>SDR wedged, exiting! (check power supply / avoid using an USB extension / SDR might be defective)';
const TIMEOUT = 'decoder exited (code 1): Message source reports error: TIMEOUT / Abnormal exit';

test('dongle failures are told apart from other decoder failures', () => {
  assert.ok(isSdrDown(WEDGED));
  assert.ok(isSdrDown(TIMEOUT));
  assert.ok(isSdrDown('usb_claim_interface error -6'));
  assert.ok(!isSdrDown('decoder exited (code 3): RTL-SDR Blog V4 Detected / Exact sample rate is: 250000.000414 Hz'));
  assert.ok(!isSdrDown('pull ghcr.io/x failed: 500'));
});

test('two dongle failures with no proof of life between them is a hang; proof of life ends it', () => {
  const w = new SdrWatch();
  assert.equal(w.failed(TIMEOUT, 1000), false); // one alone isn't enough
  assert.equal(w.failed('decoder exited (code 2): bad config', 2000), false); // not the dongle
  assert.equal(w.hung, false);
  assert.equal(w.failed(WEDGED, 3000), true); // tips it over, once
  assert.equal(w.failed(WEDGED, 4000), false);
  assert.ok(w.hung);
  assert.equal(w.health.since, 1000);
  assert.equal(w.ok(5000), true);
  assert.deepEqual(w.health, { state: 'ok', strikes: 0, resets: 0, lastOk: 5000 });
  // A failure, then a good ADS-B run, then a failure: not hung.
  w.failed(TIMEOUT, 6000);
  w.ok(7000);
  assert.equal(w.failed(TIMEOUT, 8000), false);
});

test('automatic resets are rate limited while hung', () => {
  const w = new SdrWatch();
  assert.equal(w.resetDue(0, 600_000), false); // not hung
  w.failed(WEDGED, 1_000_000);
  w.failed(WEDGED, 1_000_100);
  assert.equal(w.resetDue(1_000_200, 600_000), true);
  w.resetTried(1_000_200);
  assert.equal(w.resetDue(1_300_000, 600_000), false);
  assert.equal(w.resetDue(1_600_300, 600_000), true);
  assert.equal(w.health.resets, 1);
});
