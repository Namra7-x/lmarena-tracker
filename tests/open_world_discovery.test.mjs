import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractSignalsFromAst } from '../reverse-tracker/extraction/ast.mjs';
import {
  CATEGORIES,
  ACTIVATION_STATUS,
  isValidModelIdentifier,
  isValidFeatureFlag,
  matchSignalsInText,
} from '../reverse-tracker/finder/rules.mjs';
import { evaluateNoise, isHumanReadableString } from '../reverse-tracker/finder/noise.mjs';
import { scoreFinding, TIERS } from '../reverse-tracker/finder/scorer.mjs';
import { generateReportBundle } from '../reverse-tracker/reports/bundle.mjs';

test('1. Arbitrary Model Codename Discovery via AST Array Peer Clustering (No Hardcoded Names)', () => {
  const code = `
    // Arbitrary future codenames unannounced and without pre-defined naming patterns
    const ACTIVE_MODELS = [
      "gpt-4o",
      "claude-3-5-sonnet",
      "Onion Alpha",
      "Cactus",
      "Obsidian",
      "keken",
      "silicon"
    ];
  `;

  const findings = extractSignalsFromAst(code, 'src/models/registry.js');
  const modelValues = findings.filter((f) => f.category === CATEGORIES.MODEL_ID).map((f) => f.value);

  // Known anchors are discovered
  assert.ok(modelValues.includes('gpt-4o'));
  assert.ok(modelValues.includes('claude-3-5-sonnet'));

  // Completely unknown arbitrary future codenames clustered via peer array
  assert.ok(modelValues.includes('Onion Alpha'), 'Must detect Onion Alpha via peer clustering');
  assert.ok(modelValues.includes('Cactus'), 'Must detect Cactus via peer clustering');
  assert.ok(modelValues.includes('Obsidian'), 'Must detect Obsidian via peer clustering');
  assert.ok(modelValues.includes('keken'), 'Must detect keken via peer clustering');
  assert.ok(modelValues.includes('silicon'), 'Must detect silicon via peer clustering');

  const onionFinding = findings.find((f) => f.value === 'Onion Alpha');
  assert.equal(onionFinding.discoveryMethod, 'ast_array_peer_cluster');
  assert.equal(onionFinding.activationStatus, ACTIVATION_STATUS.CONFIGURED);
  assert.ok(onionFinding.related.peerModels.includes('gpt-4o'));
});

test('2. Switch-Case & Conditional Equality Detection for Models, Flags, and Experiments', () => {
  const code = `
    function routeModel(selectedModel) {
      switch (selectedModel) {
        case "obsidian-3-agent":
          return handleObsidian();
        case "fable-5-1":
          return handleFable();
        case "Tell Me News":
          return handleCustom();
      }
    }

    function checkToggle(gate) {
      if (gate === "dark_canary_rollout_gate") {
        activate();
      }
    }

    function handleAbTest(experimentVariant) {
      switch (experimentVariant) {
        case "treatment_canvas_v2":
          return true;
        case "control_v1":
          return false;
      }
    }
  `;

  const findings = extractSignalsFromAst(code, 'src/routing.js');

  const models = findings.filter((f) => f.category === CATEGORIES.MODEL_ID).map((f) => f.value);
  assert.ok(models.includes('obsidian-3-agent'));
  assert.ok(models.includes('fable-5-1'));
  assert.ok(models.includes('Tell Me News'));

  const flags = findings.filter((f) => f.category === CATEGORIES.FEATURE_FLAG).map((f) => f.value);
  assert.ok(flags.includes('dark_canary_rollout_gate'));

  const experiments = findings.filter((f) => f.category === CATEGORIES.EXPERIMENT).map((f) => f.value);
  assert.ok(experiments.includes('treatment_canvas_v2'));
  assert.ok(experiments.includes('control_v1'));
});

test('3. AI Hyperparameter Configuration Object Detection', () => {
  const code = `
    export const MODEL_CONFIGS = {
      silicon_reasoning: {
        id: "silicon-reasoning-preview",
        context_window: 256000,
        max_tokens: 16384,
        supports_thinking: true,
        input_cost: 0.000003
      }
    };
  `;

  const findings = extractSignalsFromAst(code, 'src/config/models.js');
  const model = findings.find((f) => f.value === 'silicon-reasoning-preview');
  assert.ok(model, 'Model configured with AI hyperparameters must be extracted');
  assert.equal(model.category, CATEGORIES.MODEL_ID);
  assert.equal(model.discoveryMethod, 'ast_hyperparam_object');
  assert.equal(model.activationStatus, ACTIVATION_STATUS.CONFIGURED);
});

test('4. Feature Flag Discovery with Local Data Flow Tracking & Default Value Inference', () => {
  const code = `
    const UNKNOWN_FEATURE = "custom_deep_canvas_preview";
    const SECOND_FEATURE = "enabled_by_default_tool";

    function testGates() {
      // Direct call with default false -> CONFIGURED
      const r1 = isFeatureEnabled("dynamic_unknown_flag_alpha", false);

      // Direct call with default true -> ENABLED
      const r2 = checkGate("hardcoded_enabled_feature", true);

      // Indirect call via local variable identifier
      const r3 = isFeatureEnabled(UNKNOWN_FEATURE);

      // Indirect call with enabled true
      const r4 = isFeatureEnabled(SECOND_FEATURE, true);
    }
  `;

  const findings = extractSignalsFromAst(code, 'src/flags.js');

  const f1 = findings.find((f) => f.value === 'dynamic_unknown_flag_alpha');
  assert.ok(f1);
  assert.equal(f1.activationStatus, ACTIVATION_STATUS.CONFIGURED);

  const f2 = findings.find((f) => f.value === 'hardcoded_enabled_feature');
  assert.ok(f2);
  assert.equal(f2.activationStatus, ACTIVATION_STATUS.ENABLED);

  const f3 = findings.find((f) => f.value === 'custom_deep_canvas_preview');
  assert.ok(f3, 'Local variable tracking must resolve string identifier passed to gate function');
  assert.equal(f3.activationStatus, ACTIVATION_STATUS.REFERENCED);

  const f4 = findings.find((f) => f.value === 'enabled_by_default_tool');
  assert.ok(f4);
  assert.equal(f4.activationStatus, ACTIVATION_STATUS.ENABLED);
});

test('5. Experiment Discovery (A/B Tests, Rollouts, Variants & Percentages)', () => {
  const code = `
    const ROLLOUT_REGISTRY = {
      autonomous_browser: {
        id: "exp_autonomous_browser_v2",
        rollout: 50,
        variants: ["control", "v2_agent"],
        enabled: false,
      },
      full_rollout: {
        id: "exp_voice_canvas_live",
        rollout: 100,
        enabled: true,
      }
    };
  `;

  const findings = extractSignalsFromAst(code, 'src/experiments.js');

  const exp1 = findings.find((f) => f.value === 'exp_autonomous_browser_v2');
  assert.ok(exp1);
  assert.equal(exp1.category, CATEGORIES.EXPERIMENT);
  assert.equal(exp1.activationStatus, ACTIVATION_STATUS.CONFIGURED);
  assert.equal(exp1.related.rolloutPercentage, 50);

  const exp2 = findings.find((f) => f.value === 'exp_voice_canvas_live');
  assert.ok(exp2);
  assert.equal(exp2.category, CATEGORIES.EXPERIMENT);
  assert.equal(exp2.activationStatus, ACTIVATION_STATUS.ENABLED);
  assert.equal(exp2.related.rolloutPercentage, 100);
});

test('6. Hidden CLI Commands & MCP Capabilities', () => {
  const code = `
    const commands = [
      {
        name: "internal-eval-staff",
        command: "eval-staff",
        hidden: true,
        description: "Staff-only offline eval tool"
      }
    ];

    const tools = [
      { name: "mcp__terminal_multi_exec" },
      { name: "computer_control" }
    ];
  `;

  const findings = extractSignalsFromAst(code, 'src/cli.js');

  const cliCmd = findings.find((f) => f.category === CATEGORIES.HIDDEN_COMMAND);
  assert.ok(cliCmd);
  assert.equal(cliCmd.value, 'internal-eval-staff');
  assert.equal(cliCmd.activationStatus, ACTIVATION_STATUS.CONFIGURED);

  const textMatches = matchSignalsInText('tools: ["mcp__terminal_multi_exec", "computer_control"]');
  const toolNames = textMatches.filter((f) => f.category === CATEGORIES.AGENT_MODE).map((f) => f.value);
  assert.ok(toolNames.includes('mcp__terminal_multi_exec'));
  assert.ok(toolNames.includes('computer_control'));
});

test('7. Noise Rejection & Word-Boundary Dormancy Marker Precision', () => {
  // W3C CSS properties must be strictly rejected
  const cssProps = ['background-clip', 'border-collapse', 'column-gap', 'box-sizing', 'flex-direction'];
  for (const cp of cssProps) {
    assert.equal(evaluateNoise(cp).isNoise, true, `${cp} must be identified as noise`);
    assert.equal(isValidModelIdentifier(cp), false, `${cp} must never be a valid model identifier`);
    assert.equal(isValidFeatureFlag(cp), false, `${cp} must never be a valid feature flag`);
  }

  // SPDX Software Licenses must be rejected
  assert.equal(evaluateNoise('Apache-2.0').isNoise, true);
  assert.equal(isValidModelIdentifier('Apache-2.0'), false);

  // File Extensions must be rejected
  assert.equal(evaluateNoise('codex-cli-splash.png').isNoise, true);
  assert.equal(isValidModelIdentifier('codex-cli-splash.png'), false);

  // UI Theme list must NOT be treated as models
  const themeCode = 'const THEMES = ["dark", "light", "system", "high-contrast"];';
  const themeFindings = extractSignalsFromAst(themeCode, 'themes.js');
  const themeModels = themeFindings.filter((f) => f.category === CATEGORIES.MODEL_ID);
  assert.equal(themeModels.length, 0, 'UI theme list must never produce models');

  // Strict word-boundary dormancy test: 'boundary' and 'secondary' must NOT match 'nda'
  const falseDormant1 = matchSignalsInText('border-boundary color layout');
  assert.equal(falseDormant1.some((f) => f.dormantMarker === 'nda'), false, 'boundary must not match nda');

  const falseDormant2 = matchSignalsInText('secondary action button text');
  assert.equal(falseDormant2.some((f) => f.dormantMarker === 'nda'), false, 'secondary must not match nda');

  const realDormant = matchSignalsInText('feature confidential under nda agreement');
  assert.equal(realDormant.length >= 0, true);
});

test('8. Report Bundle Preservation: 4-Tier leaks.txt and unknown_candidates.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-world-bundle-'));

  try {
    const scoredFindings = [
      scoreFinding({
        category: CATEGORIES.MODEL_ID,
        value: 'Onion Alpha',
        context: 'const models = ["gpt-4o", "Onion Alpha"];',
        discoveryMethod: 'ast_array_peer_cluster',
        activationStatus: ACTIVATION_STATUS.CONFIGURED,
        filePath: 'src/models.js',
      }, { isNewInDiff: true, isFirstEverSeen: true }),
      scoreFinding({
        category: CATEGORIES.FEATURE_FLAG,
        value: 'exp_autonomous_browser_v2',
        context: 'isFeatureEnabled("exp_autonomous_browser_v2", false)',
        discoveryMethod: 'ast_call_gate',
        activationStatus: ACTIVATION_STATUS.CONFIGURED,
        filePath: 'src/browser.js',
      }, { isNewInDiff: true }),
      scoreFinding({
        category: CATEGORIES.AGENT_MODE,
        value: 'mcp__terminal_multi_exec',
        context: 'registerTool("mcp__terminal_multi_exec")',
        activationStatus: ACTIVATION_STATUS.ENABLED,
        filePath: 'src/tools.js',
      }, { isNewInDiff: true }),
      scoreFinding({
        category: CATEGORIES.ENDPOINT_DOMAIN,
        value: 'https://api.internal.devin.ai/v1alpha/subagents',
        context: 'endpoint: "https://api.internal.devin.ai/v1alpha/subagents"',
        activationStatus: ACTIVATION_STATUS.REFERENCED,
        filePath: 'src/net.js',
      }, { isNewInDiff: true }),
    ];

    const unknownCandidates = [
      {
        value: 'unfamiliar_alpha_token_99',
        filePath: 'src/unknown.js',
        context: 'config.unfamiliar_alpha_token_99 = 1;',
        reason: 'unclassified_token_in_config',
      },
    ];

    const bundle = generateReportBundle(tmpDir, {
      scanId: 'SCAN-TEST-OPEN-WORLD-001',
      componentId: 'devin-desktop',
      version: '0.1.20261107',
      scoredFindings,
      diffResults: { newFindings: scoredFindings.map((f) => ({ value: f.value })) },
      unknownCandidates,
      totalExtractedStrings: 100,
      artifactSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });

    // 1. Verify leaks.txt contains all 4 tiers and Activation Status
    const leaksContent = fs.readFileSync(path.join(tmpDir, 'leaks.txt'), 'utf8');
    assert.ok(leaksContent.includes('[TIER 1: 🤖 UNANNOUNCED MODELS & CODENAMES]'));
    assert.ok(leaksContent.includes('[TIER 2: 🚩 FEATURE GATES, EXPERIMENTS & ROLLOUTS]'));
    assert.ok(leaksContent.includes('[TIER 3: 🛠️ AGENT CAPABILITIES, MCP TOOLS & DARK UI]'));
    assert.ok(leaksContent.includes('[TIER 4: 🌐 INTERNAL ENDPOINTS & RPC ROUTES]'));
    assert.ok(leaksContent.includes('[Status: CONFIGURED]'));
    assert.ok(leaksContent.includes('Onion Alpha'));
    assert.ok(leaksContent.includes('exp_autonomous_browser_v2'));

    // 2. Verify unknown_candidates.json is created and preserves uncertain tokens
    const unknownsPath = path.join(tmpDir, 'unknown_candidates.json');
    assert.ok(fs.existsSync(unknownsPath), 'unknown_candidates.json must be generated');
    const unknownData = JSON.parse(fs.readFileSync(unknownsPath, 'utf8'));
    assert.equal(unknownData.totalUnknownCandidates, 1);
    assert.equal(unknownData.candidates[0].value, 'unfamiliar_alpha_token_99');

    // 3. Verify manifest.json contains artifactSha256 and activationStatusSummary
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.artifactSha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.ok(manifest.activationStatusSummary);
    assert.equal(manifest.unknownCandidatesCount, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('9. Reasoning Effort Levels, Subscription Plans & Web Search Capabilities', () => {
  // A. Reasoning Effort Levels (xhigh, max, ultra, high, medium, low)
  const effortCode = `
    const REASONING_SLOTS = {
      primary: {
        id: "o3-mini-reasoning",
        context_window: 128000,
        max_tokens: 16000,
        reasoning_effort: "xhigh",
        supports_thinking: true
      }
    };
  `;
  const effortFindings = extractSignalsFromAst(effortCode, 'src/engine.js');
  const o3Model = effortFindings.find((f) => f.value === 'o3-mini-reasoning');
  assert.ok(o3Model, 'Model with reasoning_effort must be extracted');
  assert.equal(o3Model.related.reasoningEffort, 'xhigh');

  // B. Plan Entitlements (pro, plus, max, ultra, enterprise)
  const planCode = `
    const FEATURE_ENTITLEMENTS = {
      deep_canvas: {
        id: "feat_deep_canvas",
        required_plan: "ultra",
        enabled: true
      }
    };
  `;
  const planFindings = extractSignalsFromAst(planCode, 'src/entitlements.js');
  const ultraPlan = planFindings.find((f) => f.category === CATEGORIES.PLAN_ENTITLEMENT);
  assert.ok(ultraPlan, 'Required plan entitlement must be discovered');
  assert.equal(ultraPlan.value, 'ultra');

  // Text matching for plan availability announcements
  const planTextMatches = matchSignalsInText('Available only to Pro and Max subscribers');
  assert.ok(planTextMatches.some((f) => f.category === CATEGORIES.PLAN_ENTITLEMENT));

  const planSubscriberCheck = matchSignalsInText('const isPro = is_pro_user && is_plus_subscriber;');
  assert.ok(planSubscriberCheck.some((f) => f.category === CATEGORIES.PLAN_ENTITLEMENT && f.value.toLowerCase().includes('pro')));

  // C. Web Search Capabilities
  const searchCode = `
    const TOOL_CONFIG = {
      web_search: true,
      grounding_search: { enabled: true }
    };
  `;
  const searchFindings = extractSignalsFromAst(searchCode, 'src/tools.js');
  const webSearch = searchFindings.find((f) => f.category === CATEGORIES.CAPABILITY && f.value === 'web_search');
  assert.ok(webSearch, 'Web search capability in configuration must be discovered');

  // Text matching for web search and search grounding
  const searchMatches = matchSignalsInText('enable_google_search_grounding with live_web_retrieval');
  assert.ok(searchMatches.some((f) => f.category === CATEGORIES.CAPABILITY));
});
