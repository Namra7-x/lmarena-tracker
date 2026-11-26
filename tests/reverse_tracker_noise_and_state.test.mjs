import test from 'node:test';
import assert from 'node:assert/strict';

import { computeExactDiff } from '../reverse-tracker/diff/engine.mjs';
import {
  normalizePathForDiff,
  normalizeContextForDiff,
  collapseNearDuplicateStrings,
  clusterRelatedFindings,
} from '../reverse-tracker/finder/similarity.mjs';
import { matchSignalsInText, isValidFeatureFlag, CATEGORIES } from '../reverse-tracker/finder/rules.mjs';
import { evaluateNoise } from '../reverse-tracker/finder/noise.mjs';
import { unpackGluedTokens, extractStrings } from '../reverse-tracker/extraction/strings.mjs';
import { extractSignalsFromAst } from '../reverse-tracker/extraction/ast.mjs';
import { cleanAndValidateUrl } from '../reverse-tracker/extraction/urls.mjs';
import { extractMachOStringSlices } from '../reverse-tracker/extraction/macho.mjs';

test('Semantic diff normalizes bundler chunk hashes and 1-letter minified renames without false CHANGED spam', () => {
  assert.equal(
    normalizePathForDiff('Contents/Resources/app.asar/out/chunks/chat-a1b2c3d4.js'),
    normalizePathForDiff('Contents/Resources/app.asar/out/chunks/chat-9f8e7d6c.js'),
  );

  assert.equal(
    normalizeContextForDiff('const e={defaultModel:"gpt-5-preview"};e.models(["gpt-5-preview"])'),
    normalizeContextForDiff('let t={defaultModel:"gpt-5-preview"};t.models(["gpt-5-preview"])'),
  );

  const prev = [
    {
      category: 'model_id',
      value: 'gpt-5-preview',
      activationStatus: 'CONFIGURED',
      context: 'const e={defaultModel:"gpt-5-preview"};',
      filePath: 'Contents/Resources/app.asar/out/chunks/app-1122aabb.js',
    },
  ];
  const curr = [
    {
      category: 'model_id',
      value: 'gpt-5-preview',
      activationStatus: 'CONFIGURED',
      context: 'const t={defaultModel:"gpt-5-preview"};',
      filePath: 'Contents/Resources/app.asar/out/chunks/app-ccdd3344.js',
    },
  ];

  const diff = computeExactDiff(prev, curr);
  assert.equal(diff.changedFindings.length, 0, 'Rebuild chunk/minifier churn must NOT trigger CHANGED');
  assert.equal(diff.persistentFindings.length, 1, 'Unchanged signal must remain PERSISTENT');
});

test('Semantic diff detects genuine activation shift and price changes with delta summary', () => {
  const prev = [
    {
      category: 'feature_flag',
      value: 'enable_voice_canvas',
      activationStatus: 'CONFIGURED',
      context: 'checkGate("enable_voice_canvas", false)',
      filePath: 'out/flags.js',
    },
  ];
  const curr = [
    {
      category: 'feature_flag',
      value: 'enable_voice_canvas',
      activationStatus: 'ENABLED',
      context: 'checkGate("enable_voice_canvas", true)',
      filePath: 'out/flags.js',
    },
  ];

  const diff = computeExactDiff(prev, curr);
  assert.equal(diff.changedFindings.length, 1);
  assert.equal(diff.changedFindings[0].previousStatus, 'CONFIGURED');
  assert.equal(diff.changedFindings[0].activationStatus, 'ENABLED');
  assert.ok(diff.changedFindings[0].contextDeltaSummary.includes('false'));
  assert.ok(diff.changedFindings[0].contextDeltaSummary.includes('true'));
});

test('Rules & AST reject React hooks, UI boilerplate, generic model slots, and Map.get false endpoints', () => {
  const reactHooks = ['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'showModal'];
  for (const hook of reactHooks) {
    assert.equal(isValidFeatureFlag(hook), false, `${hook} must not be classified as feature flag`);
    assert.equal(evaluateNoise(hook).isNoise || !matchSignalsInText(hook).some((f) => f.category === CATEGORIES.FEATURE_FLAG), true);
  }

  // Lowercase prose and generic framework attribution must not leak as Dark UI
  const proseFindings = matchSignalsInText('experience the following issues when built on electron; welcome to the settings view');
  assert.equal(proseFindings.filter((f) => f.category === CATEGORIES.UI_STRING).length, 0);

  // AST false positives: generic { model: "tree-view" }, switch(provider), map.get('/tmp/x')
  const noisyJs = `
    const uiState = { model: "vscode-text-model" };
    const store = new Map();
    store.get("/Users/dev/temp");
    function pickProvider(provider) {
      switch (provider) {
        case "github": return 1;
        case "local": return 2;
      }
    }
    const realAiCatalog = {
      aurora: {
        model: "aurora-reasoning-alpha",
        context_window: 128000,
        max_tokens: 8192
      }
    };
    fetch("https://api.internal.example.ai/v1/models");
  `;
  const astFindings = extractSignalsFromAst(noisyJs, 'src/workbench.js');
  const values = astFindings.map((f) => f.value);
  assert.ok(!values.includes('vscode-text-model'), 'Generic UI model field must be rejected');
  assert.ok(!values.includes('github'), 'Generic switch(provider) literal must be rejected');
  assert.ok(!values.includes('/Users/dev/temp'), 'Map.get local path must be rejected');
  assert.ok(values.includes('aurora-reasoning-alpha'), 'AI hyperparameter-backed model must still be extracted');
  assert.ok(values.includes('https://api.internal.example.ai/v1/models'), 'Real API endpoint must still be extracted');
});

test('unpackGluedTokens preserves prose and camelCase identifiers while unpacking binary glued models', () => {
  assert.deepEqual(unpackGluedTokens('Welcome to settings - low memory mode'), ['Welcome to settings - low memory mode']);
  assert.deepEqual(unpackGluedTokens('code-baseComponent'), ['code-baseComponent']);
  const binaryUnpacked = unpackGluedTokens('gpt-6-lunaaurora-alphahalo-alpha');
  assert.ok(binaryUnpacked.includes('gpt-6-luna'));
  assert.ok(binaryUnpacked.includes('aurora-alpha'));
});

test('Near-duplicate clustering & string collapsing reduces chatter without dropping discoveries', () => {
  const strings = [
    'Loading asset bundle chunk 1001 from server',
    'Loading asset bundle chunk 1002 from server',
    'Loading asset bundle chunk 1003 from server',
    'claude-sonnet-4-5',
  ];
  const groups = collapseNearDuplicateStrings(strings);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].variants.length, 2);
  assert.equal(groups[1].primary, 'claude-sonnet-4-5');

  const clustered = clusterRelatedFindings([
    { category: 'model_id', value: 'claude-4-sonnet', score: 80, diffStatus: 'NEW' },
    { category: 'ui_string', value: 'Introducing Claude 4 Sonnet', score: 42, diffStatus: 'NEW' },
    { category: 'feature_flag', value: 'enable_claude_4_sonnet', score: 50, diffStatus: 'NEW' },
  ]);
  assert.equal(clustered.length, 2, 'Echo UI copy should attach to parent model finding while preserving flag');
  assert.equal(clustered[0].relatedSignals.length, 1);
  assert.equal(clustered[0].relatedSignals[0].value, 'Introducing Claude 4 Sonnet');
});

test('Telemetry URLs are filtered out while API routes remain valid', () => {
  assert.equal(cleanAndValidateUrl('https://o12345.ingest.sentry.io/api/999/envelope/'), null);
  assert.equal(cleanAndValidateUrl('https://react.dev/errors/418'), null);
  assert.equal(cleanAndValidateUrl('https://api.openai.com/v1/models'), 'https://api.openai.com/v1/models');
});

test('Mach-O 64-bit string section parser isolates __cstring and skips __text machine opcodes', () => {
  // Build a minimal 64-bit LE Mach-O header with 1 LC_SEGMENT_64 and 2 sections: __text + __cstring
  const buf = Buffer.alloc(1024, 0);
  buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  buf.writeUInt32LE(1, 16); // ncmds = 1
  const segSize = 72 + 2 * 80; // 232 bytes
  buf.writeUInt32LE(segSize, 20); // sizeofcmds
  // LC_SEGMENT_64 at offset 32
  buf.writeUInt32LE(0x19, 32);
  buf.writeUInt32LE(segSize, 36);
  buf.writeUInt32LE(2, 32 + 64); // nsects = 2

  // Section 1: __text (opcodes at offset 512..600)
  const s1 = 32 + 72;
  buf.write('__text', s1, 'ascii');
  buf.write('__TEXT', s1 + 16, 'ascii');
  buf.writeBigUInt64LE(80n, s1 + 40);
  buf.writeUInt32LE(512, s1 + 48);
  buf.write('1h-9_opcode_noise\x00', 512, 'ascii');

  // Section 2: __cstring (real model strings at offset 640..720)
  const s2 = s1 + 80;
  buf.write('__cstring', s2, 'ascii');
  buf.write('__TEXT', s2 + 16, 'ascii');
  buf.writeBigUInt64LE(64n, s2 + 40);
  buf.writeUInt32LE(640, s2 + 48);
  buf.write('claude-4-5-sonnet-preview\x00', 640, 'ascii');

  const slices = extractMachOStringSlices(buf);
  assert.equal(slices.length, 1);
  assert.equal(slices[0].section, '__TEXT,__cstring');

  const extracted = extractStrings(buf);
  const values = extracted.map((e) => e.value);
  assert.ok(values.includes('claude-4-5-sonnet-preview'), 'Must extract __cstring model');
  assert.ok(!values.includes('1h-9_opcode_noise'), 'Must ignore __text opcode garbage');
});

test('Live regression guards: blocks icon arrays, CSS/a11y/ICU suffix noise, React 19/proto flags, and unanchored score inflation', async () => {
  const { scoreFinding, TIERS } = await import('../reverse-tracker/finder/scorer.mjs');

  // 1. Live false-positive model strings from cursor/claude/gemini/droid
  const fakeModels = [
    'concentr-millimole-per-lite',
    'aria-hidden-body-eval',
    'focusable-disabled-eval',
    'cds-skel-sweep-clip',
    'animate-code-reply-flash',
    'artifact-markdown-preview',
    'access-control-max',
    'animated-vector-pro',
    'claude-ai.staging.ant.dev',
    'claude-ai-data-import',
    'foo-pro',
    'jsx-pro',
    'psjsx-pro',
    'dapper-pro',
    'envoy-max',
    'armenian-low',
  ];
  for (const m of fakeModels) {
    assert.equal(
      matchSignalsInText(m).some((f) => f.category === CATEGORIES.MODEL_ID),
      false,
      `Fake model '${m}' must be rejected`,
    );
  }

  // 2. Live false-positive feature flags, React 19 hooks, UI props & protobuf enums
  const fakeFlags = [
    'useActionState',
    'allowMouseEnter',
    'allowWheelScrub',
    'allowAuthorization',
    'showPrintPanels',
    'shouldHideArrow',
    'shouldAutoTriggerSso',
    'EXP_HOTEL',
    'EXP_FLIGHT',
    'exp_mod_normal_cdf',
    'gpt-5',
    'claude-4.5-sonnet',
  ];
  for (const flag of fakeFlags) {
    assert.equal(isValidFeatureFlag(flag), false, `Fake flag '${flag}' must be rejected`);
  }

  // 3. Icon array with a cursor- prefix must NOT trigger peer clustering bomb
  const iconArrayCode = `
    const ICONS = [
      "cursor-default",
      "agent-circle",
      "alarm-clock",
      "alarm-clock-filled",
      "arrow-bend-up-left",
      "arrow-block-down-filled"
    ];
    const menuItem = { id: "closePanel", enabled: true };
  `;
  const astOut = extractSignalsFromAst(iconArrayCode, 'src/icons.js');
  assert.equal(astOut.filter((f) => f.category === CATEGORIES.MODEL_ID).length, 0, 'Icon array must not produce model IDs');
  assert.equal(astOut.filter((f) => f.category === CATEGORIES.FEATURE_FLAG).length, 0, 'Plain enabled menu item must not produce feature flag');

  // 4. Unanchored raw suffix token cannot inflate to MAJOR EARLY SIGNAL
  const unanchored = scoreFinding(
    { category: CATEGORIES.MODEL_ID, value: 'nebulon-preview', filePath: 'bin/app', activationStatus: 'REFERENCED' },
    { isNewInDiff: true, isFirstEverSeen: true },
  );
  assert.equal(unanchored.tier, TIERS.WEAK_SIGNAL);
  assert.equal(unanchored.isMajorEarlySignal, false);
  assert.ok(unanchored.score <= 34);

  // 5. All-products live regression guards (CanIUse O4 array, CodeResources, CSS .comment-preview, binary glue, Bun/TS flags, script exts)
  const canIUseAst = extractSignalsFromAst(
    'const rule = { browsers: ["E12", "FF1", "FFA4", "S1.1", "SM1", "C1", "CA18", "IE5", "O4"] }; const cmd = { name: "flex size-4 shrink-0", hidden: true }; const c2 = { name: "WHITESPACE", hidden: true };',
    'extensions/css-language-features/server.js',
  );
  assert.equal(canIUseAst.filter((f) => f.category === CATEGORIES.MODEL_ID).length, 0, 'CanIUse O4 array must not leak CA18');
  assert.equal(canIUseAst.filter((f) => f.category === CATEGORIES.HIDDEN_COMMAND).length, 0, 'CSS class list & WHITESPACE must not leak as hidden_command');

  assert.equal(matchSignalsInText('.comment-preview { color: red; }', 'preload.js').length, 0, 'CSS rule line must be skipped');
  assert.equal(matchSignalsInText('chunk-preview', 'Devin.app/Contents/_CodeSignature/CodeResources').length, 0, 'CodeSignature XML must be skipped');

  assert.equal(
    matchSignalsInText('availableswe-1-6-fastchisel_mock_backend_addrfailed').some((f) => f.value.includes('chisel_mock')),
    false,
    'Glued chisel_mock suffix blob must never survive as a finding',
  );

  for (const extraNoise of ['rendered-preview', 'agent.ps1', 'anysphere.co', 'mcp_browser_scale_coordinatesRecordingSealer', 'agent_idtitlecompleted', 'allowBunRuntime', 'allowBareNamedParameters', 'shouldFetchVersion']) {
    assert.equal(
      matchSignalsInText(extraNoise).filter((f) => ['model_id', 'feature_flag', 'agent_mode'].includes(f.category)).length,
      0,
      `Live cross-product noise '${extraNoise}' must be rejected`,
    );
  }
});
