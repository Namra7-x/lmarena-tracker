import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evaluateNoise, computeShannonEntropy } from '../reverse-tracker/finder/noise.mjs';
import { matchSignalsInText, CATEGORIES } from '../reverse-tracker/finder/rules.mjs';
import { generateReportBundle } from '../reverse-tracker/reports/bundle.mjs';

test('computeShannonEntropy detects high entropy hashes vs natural language', () => {
  const normalText = 'enable_autonomous_terminal_control';
  const base64Data = 'aHR0cHM6Ly9zdGFnaW5nLmFwaS5leGFtcGxlLmNvbS92MS9zZWNyZXQvcGF0aD90b2tlbj14eXoxMjM0NTY3ODk=';
  
  const normEnt = computeShannonEntropy(normalText);
  const highEnt = computeShannonEntropy(base64Data);

  assert.ok(normEnt < 3.8, `Expected normal entropy < 3.8, got ${normEnt}`);
  assert.ok(highEnt > 4.6, `Expected high entropy > 4.6, got ${highEnt}`);
});

test('evaluateNoise purges CSS classes, Webpack boilerplate, and high-entropy hashes', () => {
  assert.equal(evaluateNoise('flex items-center px-4 bg-slate-900').isNoise, true);
  assert.equal(evaluateNoise('#ffffff').isNoise, true);
  assert.equal(evaluateNoise('__webpack_require__').isNoise, true);
  assert.equal(evaluateNoise('123e4567-e89b-12d3-a456-426614174000').isNoise, true);
  assert.equal(evaluateNoise('7bf9649c6dfd67051ca20f29e57fe06436d50c3f').isNoise, true);
  
  // Real signal strings should NOT be marked as noise
  assert.equal(evaluateNoise('enable_canvas_voice_reasoning').isNoise, false);
  assert.equal(evaluateNoise('gpt-5-preview-canvas').isNoise, false);
  assert.equal(evaluateNoise('https://internal.openai.com/v1/sandbox').isNoise, false);
});

test('matchSignalsInText identifies dynamic feature gates, internal RPCs, and dark UI copy', () => {
  // 1. Dynamic SDK call
  const sdkFinding = matchSignalsInText('const isAllowed = checkGate("canary_deep_research_v2");');
  assert.ok(sdkFinding.some(f => f.category === CATEGORIES.FEATURE_FLAG && f.value === 'canary_deep_research_v2'));

  // 2. Dynamic Model definition
  const modelFinding = matchSignalsInText('reasoningModel: "orion-thinking-preview"');
  assert.ok(modelFinding.some(f => f.category === CATEGORIES.MODEL_ID && f.value === 'orion-thinking-preview'));

  // 3. Dynamic Internal RPC
  const rpcFinding = matchSignalsInText('service: "openai.internal.v1.AgentService"');
  assert.ok(rpcFinding.some(f => f.category === CATEGORIES.ENDPOINT_DOMAIN && f.value.includes('internal.v1')));

  // 4. Dark UI copy
  const uiFinding = matchSignalsInText('"Generate full application with autonomous browser use coming soon"');
  assert.ok(uiFinding.some(f => f.category === CATEGORIES.UI_STRING));
});

test('generateReportBundle produces clean leaks.txt, diff.txt, strings.txt and selects telegramFiles', () => {
  const tmpDir = path.join(os.tmpdir(), `tracker-3file-test-${Date.now()}`);

  const scanData = {
    scanId: 'CX-20261105-002',
    componentId: 'codex-cli',
    family: 'openai',
    version: '0.166.0',
    oldVersion: '0.165.0',
    diffResults: {
      newFindings: [
        { value: 'gpt-5-preview' },
        { value: 'enable_canvas_voice' },
      ],
      persistentFindings: [{ value: 'gpt-4o' }],
      removedFindings: [{ value: 'old_flag' }],
      reintroducedFindings: [],
    },
    scoredFindings: [
      { category: 'model_id', value: 'gpt-5-preview', isMajorEarlySignal: true, score: 75, tier: 'HIGH-CONFIDENCE SIGNAL', context: 'model: "gpt-5-preview"' },
      { category: 'feature_flag', value: 'enable_canvas_voice', score: 45, tier: 'EARLY SIGNAL', context: 'enable_canvas_voice' },
    ],
    platformAsymmetry: { macOnly: [], winOnly: [] },
    coverage: { percentage: 100, macOk: true, winOk: true },
    totalExtractedStrings: 500,
    artifactInventory: [{ target: 'darwin-arm64', format: 'tgz', size: 15000000 }],
  };

  const bundle = generateReportBundle(tmpDir, scanData);

  // Check 3 core files
  assert.ok(fs.existsSync(path.join(tmpDir, 'leaks.txt')));
  assert.ok(fs.existsSync(path.join(tmpDir, 'diff.txt')));
  assert.ok(fs.existsSync(path.join(tmpDir, 'strings.txt')));

  const leaksContent = fs.readFileSync(path.join(tmpDir, 'leaks.txt'), 'utf8');
  assert.ok(leaksContent.includes('gpt-5-preview'));
  assert.ok(leaksContent.includes('enable_canvas_voice'));
  assert.ok(leaksContent.includes('Total Leaks Found: 2'));

  const diffContent = fs.readFileSync(path.join(tmpDir, 'diff.txt'), 'utf8');
  assert.ok(diffContent.includes('0.165.0 -> 0.166.0'));
  assert.ok(diffContent.includes('15000000') || diffContent.includes('MB'));

  // Telegram files should only have the 3 clean files
  assert.equal(bundle.telegramFiles.length, 3);
  assert.ok(bundle.telegramFiles.some(f => f.endsWith('leaks.txt')));
  assert.ok(bundle.telegramFiles.some(f => f.endsWith('diff.txt')));
  assert.ok(bundle.telegramFiles.some(f => f.endsWith('strings.txt')));

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
