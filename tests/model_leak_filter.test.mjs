import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSignalsInText, isValidModelIdentifier, CATEGORIES } from '../reverse-tracker/finder/rules.mjs';
import { scoreFinding, TIERS } from '../reverse-tracker/finder/scorer.mjs';
import { evaluateNoise } from '../reverse-tracker/finder/noise.mjs';
import { extractStrings } from '../reverse-tracker/extraction/strings.mjs';

test('isValidModelIdentifier rejects noise, dates, SVG, CSS, and common code tokens', () => {
  const FALSE_POSITIVES = [
    '01-02',
    '02-jan-0',
    '02-jan-200',
    '1970-01-01',
    '1983nf_z_62-01',
    '1h-9',
    '2023-01-01',
    '2023-07-16',
    '43l7-4.4',
    '58-4.2',
    'o2-card',
    'o2-btn',
    'o2-ring',
    'o2-border',
    'o2-muted',
    'utf-8',
    'utf-16',
    'iso-8859-1',
    '8859-1',
    'sha-25',
    'sha-256',
    'ap-southeast-2',
    'us-west-1',
    'za-z0-9',
    'in-pro',
    'go-pro',
    're-pro',
    'ruby-base',
    'file-base',
    'exit-code',
    'status-code',
    'user-agent',
    'multi-agent',
    'char-low',
  ];

  for (const fp of FALSE_POSITIVES) {
    assert.equal(
      isValidModelIdentifier(fp),
      false,
      `False positive '${fp}' must be rejected by isValidModelIdentifier`
    );
    const findings = matchSignalsInText(fp);
    const model = findings.find((f) => f.category === CATEGORIES.MODEL_ID);
    assert.equal(model, undefined, `False positive '${fp}' must never produce a MODEL_ID finding`);
  }
});

test('matchSignalsInText extracts real models and unseen arbitrary models with zero false positives', () => {
  const TRUE_MODELS = [
    'gemini-3.8-flash-tts',
    'lyria-3-clip-preview',
    'banana-pro-preview',
    'gemini-3.1-ultra',
    'gemini-3.1-pro-preview',
    'gemini-3.5-flash-lite',
    'claude-sonnet-4-5',
    'deep-research-pro-preview-12-2025',
    'gemini-robotics-er-2-preview',
    'gemini-3.5-flash-extra-low',
    'gemini-3.1-flash-image-preview',
    'claude-3.5-sonnet',
    'claude-3.7-sonnet',
    'claude-fable-5-1',
    'claude-donut-eap',
    'claude-onigiri-e',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-5o-preview',
    'o1',
    'o1-mini',
    'o1-preview',
    'o3-mini',
    'o4-preview',
    'gemini-2.0-flash',
    'gemini-exp-1206',
    'gemini-ultra',
    'mythos-5.1',
    'fable-5.1',
    'swe-1-6-fast',
    'swe-2-high',
    'cactus-preview',
    'silicon-low',
    'silicon-max',
    'obsidian-3-max',
    'quantum-max',
    'zephyr-ultra',
    'stargate-pro',
    'nebula-turbo',
    'carbon-low',
    'supernova-preview',
    'hyper-v3-coder',
  ];

  for (const tm of TRUE_MODELS) {
    const findings = matchSignalsInText(tm);
    const model = findings.find((f) => f.category === CATEGORIES.MODEL_ID);
    assert.ok(model, `Expected model finding for '${tm}'`);
    assert.equal(model.value, tm);
  }
});

test('glued binary strings are unpacked cleanly and models are extracted without garbage', () => {
  const gluedBuffer = Buffer.from(
    '_callgemini-3.8-flash-ttslyria-3-clip-preview\x00' +
    '20250929gemini-3.5-flash-extra-low\x00' +
    'closesendgemini-3.1-flash-image-preview\x00' +
    'Managegemini-1.5-pro\x00' +
    'mcp_tool_execution_errorconnector_googlecalendarconnector_microsoftteams2006-01-02\x00',
    'utf8'
  );

  const strings = extractStrings(gluedBuffer);
  const values = new Set(strings.map((s) => s.value));

  // Must find unpacked models
  assert.ok(values.has('gemini-3.8-flash-tts'), 'Must unpack gemini-3.8-flash-tts');
  assert.ok(values.has('lyria-3-clip-preview'), 'Must unpack lyria-3-clip-preview');
  assert.ok(values.has('gemini-3.5-flash-extra-low'), 'Must unpack gemini-3.5-flash-extra-low');
  assert.ok(values.has('gemini-3.1-flash-image-preview'), 'Must unpack gemini-3.1-flash-image-preview');
  assert.ok(values.has('gemini-1.5-pro'), 'Must unpack gemini-1.5-pro');
  assert.ok(values.has('connector_googlecalendar'), 'Must unpack connector_googlecalendar');
  assert.ok(values.has('connector_microsoftteams'), 'Must unpack connector_microsoftteams');

  // Match signals across all extracted strings
  const allFindings = [];
  for (const s of values) {
    allFindings.push(...matchSignalsInText(s));
  }

  const modelFindings = allFindings.filter((f) => f.category === CATEGORIES.MODEL_ID);
  const modelValues = new Set(modelFindings.map((f) => f.value));

  assert.ok(modelValues.has('gemini-3.8-flash-tts'), 'Must identify gemini-3.8-flash-tts as MODEL_ID');
  assert.ok(modelValues.has('lyria-3-clip-preview'), 'Must identify lyria-3-clip-preview as MODEL_ID');
  assert.ok(modelValues.has('gemini-3.5-flash-extra-low'), 'Must identify gemini-3.5-flash-extra-low as MODEL_ID');
  assert.ok(modelValues.has('gemini-3.1-flash-image-preview'), 'Must identify gemini-3.1-flash-image-preview as MODEL_ID');
  assert.ok(modelValues.has('gemini-1.5-pro'), 'Must identify gemini-1.5-pro as MODEL_ID');

  // Must NEVER have dates, SVG, or concatenated strings as models
  assert.equal(modelValues.has('01-02'), false, 'Must NOT identify 01-02 as model');
  assert.equal(modelValues.has('2006-01-02'), false, 'Must NOT identify 2006-01-02 as model');
  assert.equal(modelValues.has('_callgemini-3.8-flash-ttslyria-3-clip-preview'), false, 'Must NOT identify glued string as model');
});

test('scorer strictly rejects invalid models as HIDDEN with score 0', () => {
  const badFinding = {
    category: CATEGORIES.MODEL_ID,
    value: '01-02',
    hasDormantMarker: true,
    dormantMarker: 'preview',
  };

  const scored = scoreFinding(badFinding, { isNewInDiff: true, isFirstEverSeen: true });
  assert.equal(scored.score, 0, 'Invalid model must receive score 0');
  assert.equal(scored.tier, TIERS.HIDDEN, 'Invalid model must be HIDDEN tier');
  assert.equal(scored.isMajorEarlySignal, false, 'Invalid model must not be major early signal');
});
