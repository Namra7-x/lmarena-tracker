import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSignalsInText, CATEGORIES } from '../reverse-tracker/finder/rules.mjs';
import { scoreFinding, TIERS } from '../reverse-tracker/finder/scorer.mjs';

test('matchSignalsInText extracts unreleased models with dormant markers', () => {
  const line = 'const target = "gpt-5-preview"; // internal dogfood build';
  const findings = matchSignalsInText(line, 'src/api/client.ts');

  assert.ok(findings.length > 0);
  const modelFinding = findings.find((f) => f.category === CATEGORIES.MODEL_ID);
  assert.ok(modelFinding);
  assert.equal(modelFinding.value, 'gpt-5-preview');
  assert.equal(modelFinding.hasDormantMarker, true);
});

test('matchSignalsInText identifies hidden CLI flags and commands', () => {
  const line = '{ name: "debug-eval", hidden: true, description: "internal test" }';
  const findings = matchSignalsInText(line, 'src/cli/commands.ts');

  const cmdFinding = findings.find((f) => f.category === CATEGORIES.HIDDEN_COMMAND);
  assert.ok(cmdFinding);
  assert.equal(cmdFinding.value, 'debug-eval');
});

test('deterministic scoring awards correct points and tier boundaries', () => {
  // Model finding: category (+25), dormant marker (+15), new in diff (+10), first ever (+15)
  // Total = 65 -> HIGH-CONFIDENCE SIGNAL & MAJOR EARLY SIGNAL!
  const rawModelFinding = {
    category: CATEGORIES.MODEL_ID,
    value: 'claude-3-7-sonnet',
    context: 'internal model gate claude-3-7-sonnet',
    hasDormantMarker: true,
    dormantMarker: 'internal',
    filePath: 'src/config/models.ts',
  };

  const scored = scoreFinding(rawModelFinding, {
    isNewInDiff: true,
    isFirstEverSeen: true,
    matchesReleaseNotes: false,
  });

  assert.equal(scored.score, 65);
  assert.equal(scored.tier, TIERS.HIGH_CONFIDENCE);
  assert.equal(scored.isMajorEarlySignal, true);
});

test('third-party dependency penalty reduces score', () => {
  const depFinding = {
    category: CATEGORIES.FEATURE_FLAG,
    value: 'enable_smooth_scroll',
    context: 'flag enable_smooth_scroll',
    hasDormantMarker: false,
    filePath: 'node_modules/react-dom/index.js',
  };

  const scored = scoreFinding(depFinding, {
    isNewInDiff: true,
    isFirstEverSeen: false,
  });

  // feature flag (+15) + new (+10) - third party (-20) = 5 points -> HIDDEN tier
  assert.equal(scored.score, 5);
  assert.equal(scored.tier, TIERS.HIDDEN);
});

test('matching release notes turns finding into CONFIRMED tier', () => {
  const finding = {
    category: CATEGORIES.FEATURE_FLAG,
    value: 'enable_dark_mode',
    context: 'enable_dark_mode in release',
    hasDormantMarker: false,
    filePath: 'src/app.ts',
  };

  const scored = scoreFinding(finding, {
    isNewInDiff: true,
    isFirstEverSeen: false,
    matchesReleaseNotes: true,
  });

  assert.equal(scored.tier, TIERS.CONFIRMED);
});
