import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStrings } from '../reverse-tracker/extraction/strings.mjs';
import { matchSignalsInText, CATEGORIES } from '../reverse-tracker/finder/rules.mjs';
import { getFilePriority } from '../reverse-tracker/extraction/dispatcher.mjs';
import { fetchDevinDesktop } from '../reverse-tracker/sources/devin.mjs';

test('extractStrings unpacks concatenated Rust/Go string literals in binary buffers', () => {
  const gluedBuffer = Buffer.from(
    '\x00\x00claude-fable-5-1claude-haiku-5-5claude-donut-eap\x00\x00' +
    'obsidian-3-maxsilicon-lowsilicon-mediumsilicon-high\x00\x00' +
    'swe-1-6-fastswe-2-highsilicon-maxclaude-onigiri-e\x00\x00',
    'utf8'
  );

  const extracted = extractStrings(gluedBuffer);
  const values = new Set(extracted.map((e) => e.value));

  // Must unpack each concatenated model literal
  assert.ok(values.has('claude-fable-5-1'), 'Must unpack claude-fable-5-1');
  assert.ok(values.has('claude-donut-eap'), 'Must unpack claude-donut-eap');
  assert.ok(values.has('silicon-low'), 'Must unpack silicon-low');
  assert.ok(values.has('silicon-max'), 'Must unpack silicon-max');
  assert.ok(values.has('obsidian-3-max'), 'Must unpack obsidian-3-max');
  assert.ok(values.has('swe-1-6-fast'), 'Must unpack swe-1-6-fast');
  assert.ok(values.has('claude-onigiri-e'), 'Must unpack claude-onigiri-e');
});

test('matchSignalsInText matches unannounced codenames and non-standard model families', () => {
  const modelsToTest = [
    { input: 'claude-donut-eap', expected: 'claude-donut-eap' },
    { input: 'claude-onigiri-e', expected: 'claude-onigiri-e' },
    { input: 'claude-fable-5-1', expected: 'claude-fable-5-1' },
    { input: 'claude-3.5-sonnet', expected: 'claude-3.5-sonnet' },
    { input: 'claude-3.7-sonnet', expected: 'claude-3.7-sonnet' },
    { input: 'silicon-low', expected: 'silicon-low' },
    { input: 'silicon-max', expected: 'silicon-max' },
    { input: 'obsidian-3-max', expected: 'obsidian-3-max' },
    { input: 'swe-1-6-fast', expected: 'swe-1-6-fast' },
    { input: 'swe-2-high', expected: 'swe-2-high' },
    { input: 'cactus-preview', expected: 'cactus-preview' },
    { input: 'gpt-4o', expected: 'gpt-4o' },
    { input: 'gpt-4o-mini', expected: 'gpt-4o-mini' },
    { input: 'gpt-5o-preview', expected: 'gpt-5o-preview' },
    { input: 'o3-mini', expected: 'o3-mini' },
    { input: 'gemini-2.0-flash', expected: 'gemini-2.0-flash' },
    { input: 'gemini-exp-1206', expected: 'gemini-exp-1206' },
    { input: 'gemini-ultra', expected: 'gemini-ultra' },
    { input: 'mythos-5.1', expected: 'mythos-5.1' },
    { input: 'fable-5.1', expected: 'fable-5.1' },
  ];

  for (const { input, expected } of modelsToTest) {
    const findings = matchSignalsInText(input);
    const modelFinding = findings.find((f) => f.category === CATEGORIES.MODEL_ID);
    assert.ok(modelFinding, `Expected MODEL_ID finding for '${input}'`);
    assert.equal(modelFinding.value, expected);
  }
});

test('getFilePriority assigns priority 2 to extensionless binaries and ELF/Mach-O/PE headers', () => {
  assert.equal(getFilePriority('bin/devin'), 2, 'bin/devin must be priority 2');
  assert.equal(getFilePriority('devin'), 2, 'devin must be priority 2');
  assert.equal(getFilePriority('Codex.dmg'), 2, 'Codex.dmg must be priority 2');
  assert.equal(getFilePriority('Claude.dmg'), 2, 'Claude.dmg must be priority 2');
  assert.equal(getFilePriority('installer.msi'), 2, 'installer.msi must be priority 2');
  assert.equal(getFilePriority('app.js'), 1, 'app.js must be priority 1');

  const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
  assert.equal(getFilePriority('unknown-file', elfHeader), 2, 'ELF magic header must be priority 2');
});

test('zero-hardcoding dynamic extraction catches arbitrary unseen lab models and slots', () => {
  // Test arbitrary, completely unseen model names from unknown future labs
  const arbitraryModels = [
    { input: 'quantum-max', expected: 'quantum-max' },
    { input: 'zephyr-ultra', expected: 'zephyr-ultra' },
    { input: 'stargate-pro', expected: 'stargate-pro' },
    { input: 'nebula-turbo', expected: 'nebula-turbo' },
    { input: 'carbon-low', expected: 'carbon-low' },
    { input: 'supernova-preview', expected: 'supernova-preview' },
    { input: 'hyper-v3-coder', expected: 'hyper-v3-coder' },
    { input: 'const cfg = { defaultModel: "alien-brain-x" }', expected: 'alien-brain-x' },
    { input: 'export const run = { primary_model: "omega-9" }', expected: 'omega-9' },
  ];

  for (const { input, expected } of arbitraryModels) {
    const findings = matchSignalsInText(input);
    const modelFinding = findings.find((f) => f.category === CATEGORIES.MODEL_ID);
    assert.ok(modelFinding, `Zero-hardcoded rules must dynamically find '${expected}' in '${input}'`);
    assert.equal(modelFinding.value, expected);
  }

  // Dynamic binary unpack of arbitrary unseen models
  const arbitraryGlued = Buffer.from(
    '\x00\x00quantum-maxzephyr-ultrastargate-pro\x00\x00' +
    'nebula-turbocarbon-lowsupernova-preview\x00\x00',
    'utf8'
  );
  const unpacked = extractStrings(arbitraryGlued);
  const vals = new Set(unpacked.map((u) => u.value));

  assert.ok(vals.has('quantum-max'), 'Must dynamically unpack quantum-max');
  assert.ok(vals.has('zephyr-ultra'), 'Must dynamically unpack zephyr-ultra');
  assert.ok(vals.has('stargate-pro'), 'Must dynamically unpack stargate-pro');
  assert.ok(vals.has('nebula-turbo'), 'Must dynamically unpack nebula-turbo');
  assert.ok(vals.has('carbon-low'), 'Must dynamically unpack carbon-low');
  assert.ok(vals.has('supernova-preview'), 'Must dynamically unpack supernova-preview');
});

test('fetchDevinDesktop points to direct native archive URLs (.zip and .tar.gz)', async () => {
  const desktop = await fetchDevinDesktop();
  assert.ok(desktop.artifacts.length >= 4, 'Must provide desktop artifacts');
  for (const art of desktop.artifacts) {
    assert.ok(art.format === 'zip' || art.format === 'tgz', `Format must be zip or tgz, got ${art.format}`);
    assert.ok(art.url.endsWith('.zip') || art.url.endsWith('.tar.gz'), `URL must be archive, got ${art.url}`);
  }
});
