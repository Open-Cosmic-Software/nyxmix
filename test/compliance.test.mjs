import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../server/features/compliance.js';

const base = { integratedLufs: -16, truePeakDbtp: -1.5, loudnessRangeLu: 6, rmsDbfs: -20, samplePeakDbfs: -4, noiseFloorDbfs: -65, clippedSamples: 0 };

test('podcast passes at -16 LUFS / -1.5 dBTP', () => {
  const r = evaluate('podcast', base);
  assert.equal(r.pass, true, JSON.stringify(r.checks));
});
test('podcast fails when too quiet and says how to fix it', () => {
  const r = evaluate('podcast', { ...base, integratedLufs: -22 });
  const c = r.checks.find((x) => x.name === 'Integrated loudness');
  assert.equal(c.pass, false);
  assert.match(c.fix, /-16 LUFS/);
});
test('ACX checks RMS, peak and noise floor', () => {
  const r = evaluate('acx', { ...base, samplePeakDbfs: -1, noiseFloorDbfs: -50 });
  assert.deepEqual(r.checks.filter((c) => !c.pass).map((c) => c.name).sort(), ['Noise floor', 'Peak level']);
});
