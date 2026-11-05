import test from 'node:test';
import assert from 'node:assert/strict';
import { computeExactDiff } from '../reverse-tracker/diff/engine.mjs';
import { detectPlatformAsymmetry } from '../reverse-tracker/finder/asymmetry.mjs';

test('computeExactDiff correctly calculates new, removed, persistent, and reintroduced', () => {
  const prevFindings = [
    { category: 'feature_flag', value: 'old_flag_a' },
    { category: 'model_id', value: 'gpt-4o' },
  ];

  const candFindings = [
    { category: 'model_id', value: 'gpt-4o' }, // Persistent
    { category: 'feature_flag', value: 'new_flag_b' }, // New
    { category: 'endpoint_domain', value: '/api/v2/test' }, // Reintroduced
  ];

  const historicalHashes = new Set(['endpoint_domain:/api/v2/test']);

  const diff = computeExactDiff(prevFindings, candFindings, historicalHashes);

  assert.equal(diff.counts.persistentCount, 1);
  assert.equal(diff.counts.newCount, 1);
  assert.equal(diff.counts.removedCount, 1);
  assert.equal(diff.counts.reintroducedCount, 1);

  assert.equal(diff.persistentFindings[0].value, 'gpt-4o');
  assert.equal(diff.newFindings[0].value, 'new_flag_b');
  assert.equal(diff.removedFindings[0].value, 'old_flag_a');
  assert.equal(diff.reintroducedFindings[0].value, '/api/v2/test');
});

test('detectPlatformAsymmetry identifies platform-only features between macOS and Windows', () => {
  const macFindings = [
    { category: 'feature_flag', value: 'apple_intelligence_bridge' },
    { category: 'model_id', value: 'gemini-2.5-pro' },
  ];

  const winFindings = [
    { category: 'feature_flag', value: 'windows_copilot_runtime' },
    { category: 'model_id', value: 'gemini-2.5-pro' },
  ];

  const result = detectPlatformAsymmetry(macFindings, winFindings);

  assert.equal(result.common.length, 1);
  assert.equal(result.common[0].value, 'gemini-2.5-pro');

  assert.equal(result.macOnly.length, 1);
  assert.equal(result.macOnly[0].value, 'apple_intelligence_bridge');
  assert.equal(result.macOnly[0].platformOnly, 'macOS');

  assert.equal(result.winOnly.length, 1);
  assert.equal(result.winOnly[0].value, 'windows_copilot_runtime');
  assert.equal(result.winOnly[0].platformOnly, 'Windows');
});
