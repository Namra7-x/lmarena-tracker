import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadMasterState, saveMasterState } from '../reverse-tracker/state/store.mjs';
import { computeExactDiff } from '../reverse-tracker/diff/engine.mjs';
import { unpackGluedTokens } from '../reverse-tracker/extraction/strings.mjs';
import { renderAsciiTable } from '../reverse-tracker/reports/bundle.mjs';

test('Master State: isolates state per component and platform type (CLI vs Desktop)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-state-test-'));
  try {
    // 1. Anthropic CLI vs Desktop separation
    const claudeCliState = {
      knownSignals: {
        'model_id:claude-3-7-sonnet-cli': { value: 'claude-3-7-sonnet-cli', category: 'model_id' },
      },
      knownStrings: ['claude-code-binary', 'cli-runner'],
      knownUrls: ['https://api.anthropic.com/cli'],
    };
    const claudeDeskState = {
      knownSignals: {
        'model_id:claude-3-7-sonnet-desktop': { value: 'claude-3-7-sonnet-desktop', category: 'model_id' },
      },
      knownStrings: ['claude-desktop-bundle', 'renderer-ui'],
      knownUrls: ['https://downloads.claude.ai/releases'],
    };

    saveMasterState(tmpDir, 'claude-code', claudeCliState);
    saveMasterState(tmpDir, 'claude-desktop', claudeDeskState);

    assert.ok(fs.existsSync(path.join(tmpDir, 'claude-code_master.json.gz')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'claude-desktop_master.json.gz')));

    const loadedCli = loadMasterState(tmpDir, 'claude-code');
    const loadedDesk = loadMasterState(tmpDir, 'claude-desktop');

    assert.ok(loadedCli.knownSignals['model_id:claude-3-7-sonnet-cli']);
    assert.strictEqual(loadedCli.knownSignals['model_id:claude-3-7-sonnet-desktop'], undefined);

    assert.ok(loadedDesk.knownSignals['model_id:claude-3-7-sonnet-desktop']);
    assert.strictEqual(loadedDesk.knownSignals['model_id:claude-3-7-sonnet-cli'], undefined);

    // 2. Google 3 distinct products separation
    saveMasterState(tmpDir, 'gemini-desktop', { knownSignals: { 'model_id:gemini-3-pro-desktop': { value: 'gemini-3-pro-desktop' } } });
    saveMasterState(tmpDir, 'antigravity-desktop', { knownSignals: { 'model_id:gemini-3-ultra-antigravity': { value: 'gemini-3-ultra-antigravity' } } });
    saveMasterState(tmpDir, 'antigravity-cli', { knownSignals: { 'model_id:gemini-4-neon-cli': { value: 'gemini-4-neon-cli' } } });

    assert.ok(fs.existsSync(path.join(tmpDir, 'gemini-desktop_master.json.gz')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'antigravity-desktop_master.json.gz')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'antigravity-cli_master.json.gz')));

    const gDesk = loadMasterState(tmpDir, 'gemini-desktop');
    const aDesk = loadMasterState(tmpDir, 'antigravity-desktop');
    const aCli = loadMasterState(tmpDir, 'antigravity-cli');

    assert.ok(gDesk.knownSignals['model_id:gemini-3-pro-desktop']);
    assert.strictEqual(gDesk.knownSignals['model_id:gemini-3-ultra-antigravity'], undefined);
    assert.ok(aDesk.knownSignals['model_id:gemini-3-ultra-antigravity']);
    assert.ok(aCli.knownSignals['model_id:gemini-4-neon-cli']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Master Diffing Engine: skips existing strings, detects genuine modifications, and flags brand-new leaks', () => {
  const masterSignals = {
    'model_id:claude-3-5-sonnet-20241022': {
      category: 'model_id',
      value: 'claude-3-5-sonnet-20241022',
      activationStatus: 'REFERENCED',
      context: 'default_model: "claude-3-5-sonnet-20241022"',
      filePath: 'out/app.js',
    },
    'feature_flag:canvas_reasoning_mode': {
      category: 'feature_flag',
      value: 'canvas_reasoning_mode',
      activationStatus: 'CONFIGURED',
      context: 'feature_flags.enable("canvas_reasoning_mode", false)',
      filePath: 'out/features.js',
    },
  };

  const candidates = [
    // 1. Identical persistent signal (must be PERSISTENT / SKIPPED from alerts)
    {
      category: 'model_id',
      value: 'claude-3-5-sonnet-20241022',
      activationStatus: 'REFERENCED',
      context: 'default_model: "claude-3-5-sonnet-20241022"',
      filePath: 'out/app.js',
    },
    // 2. Genuinely modified signal (activation status changed to ENABLED)
    {
      category: 'feature_flag',
      value: 'canvas_reasoning_mode',
      activationStatus: 'ENABLED',
      context: 'feature_flags.enable("canvas_reasoning_mode", true)',
      filePath: 'out/features.js',
    },
    // 3. Truly brand new signal
    {
      category: 'model_id',
      value: 'claude-3-8-opus-preview-2026',
      activationStatus: 'CONFIGURED',
      context: 'tier_models: ["claude-3-8-opus-preview-2026"]',
      filePath: 'out/models.js',
    },
  ];

  const diff = computeExactDiff([], candidates, new Set(), masterSignals);

  assert.strictEqual(diff.persistentFindings.length, 1);
  assert.strictEqual(diff.persistentFindings[0].value, 'claude-3-5-sonnet-20241022');

  assert.strictEqual(diff.changedFindings.length, 1);
  assert.strictEqual(diff.changedFindings[0].value, 'canvas_reasoning_mode');
  assert.strictEqual(diff.changedFindings[0].previousStatus, 'CONFIGURED');
  assert.strictEqual(diff.changedFindings[0].activationStatus, 'ENABLED');

  assert.strictEqual(diff.newFindings.length, 1);
  assert.strictEqual(diff.newFindings[0].value, 'claude-3-8-opus-preview-2026');
});

test('Zero-Cut Integrity: intact URLs and file paths are never broken or sliced by token splitters', () => {
  const testUrl = 'https://api.anthropic.com/v1/2026-11-19/models/claude-3-7-sonnet-preview?filter=token';
  const tokens = unpackGluedTokens(testUrl);
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0], testUrl);

  const testFilePath = 'Contents/Resources/app.asar/out/vs/workbench/contrib/chat/browser/modelList.js';
  const pathTokens = unpackGluedTokens(testFilePath);
  assert.strictEqual(pathTokens.length, 1);
  assert.strictEqual(pathTokens[0], testFilePath);
});

test('Zero-Cut ASCII Table: long evidence paths and URLs are not chopped at 55 chars', () => {
  const longUrl = 'https://api.openai.com/v1/chat/completions/internal/models/gpt-5.5-preview-edition';
  const headers = ['STATUS', 'IDENTIFIER', 'EVIDENCE'];
  const rows = [['🔥 NEW', 'gpt-5.5-preview', longUrl]];

  const table = renderAsciiTable(headers, rows);
  assert.ok(table.includes(longUrl), 'Table must contain the full URL without … truncation');
});
