import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStateAdvancement } from '../reverse-tracker/state/store.mjs';

test('validateStateAdvancement rejects baseline advance when scan is PARTIAL or FAILED', () => {
  const baseline = { identityFingerprint: 'base-hash-1' };

  const partialCandidate = {
    coverageState: 'PARTIAL',
    basedOnFingerprint: 'base-hash-1',
  };
  const check1 = validateStateAdvancement(baseline, partialCandidate);
  assert.equal(check1.canAdvance, false);
  assert.ok(check1.reason.includes('PARTIAL'));

  const failedCandidate = {
    coverageState: 'FAILED',
    basedOnFingerprint: 'base-hash-1',
  };
  const check2 = validateStateAdvancement(baseline, failedCandidate);
  assert.equal(check2.canAdvance, false);
  assert.ok(check2.reason.includes('FAILED'));
});

test('validateStateAdvancement rejects stale candidate when basedOnFingerprint no longer matches baseline', () => {
  const baseline = { identityFingerprint: 'latest-hash' };
  const staleCandidate = {
    coverageState: 'COMPLETE',
    basedOnFingerprint: 'old-stale-hash',
  };

  const check = validateStateAdvancement(baseline, staleCandidate);
  assert.equal(check.canAdvance, false);
  assert.ok(check.reason.includes('concurrently'));
});

test('validateStateAdvancement permits advance when scan is COMPLETE and basedOnFingerprint matches', () => {
  const baseline = { identityFingerprint: 'valid-base-hash' };
  const validCandidate = {
    coverageState: 'COMPLETE',
    basedOnFingerprint: 'valid-base-hash',
  };

  const check = validateStateAdvancement(baseline, validCandidate);
  assert.equal(check.canAdvance, true);
});
