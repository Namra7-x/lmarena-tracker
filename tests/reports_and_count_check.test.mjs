import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateReportBundle } from '../reverse-tracker/reports/bundle.mjs';

test('generateReportBundle produces all 6 files, manifest and passes count check', () => {
  const tmpDir = path.join(os.tmpdir(), `tracker-report-test-${Date.now()}`);

  const scanData = {
    scanId: 'CX-20261105-001',
    componentId: 'codex-cli',
    version: '0.160.2',
    diffResults: {
      newFindings: [
        { category: 'model_id', value: 'gpt-5-preview', isMajorEarlySignal: true, score: 75, tier: 'HIGH-CONFIDENCE SIGNAL' },
        { category: 'feature_flag', value: 'enable_agentic_flow', score: 45, tier: 'EARLY SIGNAL' },
      ],
      persistentFindings: [
        { category: 'model_id', value: 'gpt-4o' },
      ],
      removedFindings: [
        { category: 'feature_flag', value: 'old_experiment_v1' },
      ],
      reintroducedFindings: [],
    },
    scoredFindings: [
      { category: 'model_id', value: 'gpt-5-preview', isMajorEarlySignal: true, score: 75, tier: 'HIGH-CONFIDENCE SIGNAL', context: 'internal gpt-5', filePath: 'src/m.ts' },
      { category: 'feature_flag', value: 'enable_agentic_flow', score: 45, tier: 'EARLY SIGNAL', context: 'flag enable_agentic_flow', filePath: 'src/f.ts' },
    ],
    platformAsymmetry: {
      macOnly: [{ category: 'feature_flag', value: 'mac_native_menu' }],
      winOnly: [],
    },
    coverage: { percentage: 100, macOk: true, winOk: true },
    totalExtractedStrings: 1000,
  };

  const bundle = generateReportBundle(tmpDir, scanData);

  assert.equal(bundle.countCheck.passed, true);
  assert.ok(bundle.countCheck.text.includes('Listed in files 2 / 2 ✓'));
  assert.ok(bundle.countCheck.text.includes('Coverage 100% (macOS ✓ Windows ✓)'));

  // Verify generated files exist
  assert.ok(fs.existsSync(path.join(tmpDir, '1-major-and-high.txt')));
  assert.ok(fs.existsSync(path.join(tmpDir, '2-early-and-weak.txt')));
  assert.ok(fs.existsSync(path.join(tmpDir, '3-by-category.txt')));
  assert.ok(fs.existsSync(path.join(tmpDir, '4-all-new-strings.txt.gz')));
  assert.ok(fs.existsSync(path.join(tmpDir, '5-platform-only.txt')));
  assert.ok(fs.existsSync(path.join(tmpDir, '6-removed.txt.gz')));
  assert.ok(fs.existsSync(path.join(tmpDir, 'manifest.json')));

  // Clean up tmp test directory
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
