import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isValidModelIdentifier,
  isValidFeatureFlag,
  matchSignalsInText,
  CATEGORIES,
} from '../reverse-tracker/finder/rules.mjs';
import { extractSignalsFromAst } from '../reverse-tracker/extraction/ast.mjs';
import {
  generateReportBundle,
  renderAsciiTable,
  renderAsciiBox,
} from '../reverse-tracker/reports/bundle.mjs';

test('1. Dynamic Frontier Model Discovery via Catalogs and Peer Arrays (Zero Hardcoding)', () => {
  // A. Arbitrary frontier codenames in peer arrays
  const peerCode = `
    const SUPPORTED_MODELS = [
      "gpt-4o",
      "Hydrogen",
      "Argon",
      "Krypton",
      "Fable",
      "Terra",
      "Jupiter 6.1",
      "DeepSeek V4 Flash"
    ];
  `;
  const astPeerFindings = extractSignalsFromAst(peerCode, 'src/models.js');
  const foundPeerModels = astPeerFindings.filter((f) => f.category === CATEGORIES.MODEL_ID).map((f) => f.value);

  assert.ok(foundPeerModels.includes('gpt-4o'), 'Must detect anchor model');
  assert.ok(foundPeerModels.includes('Hydrogen'), 'Must detect Hydrogen dynamically via peer array');
  assert.ok(foundPeerModels.includes('Argon'), 'Must detect Argon dynamically via peer array');
  assert.ok(foundPeerModels.includes('Krypton'), 'Must detect Krypton dynamically via peer array');
  assert.ok(foundPeerModels.includes('Fable'), 'Must detect Fable dynamically via peer array');
  assert.ok(foundPeerModels.includes('Terra'), 'Must detect Terra dynamically via peer array');
  assert.ok(foundPeerModels.includes('Jupiter 6.1'), 'Must detect Jupiter 6.1 dynamically via peer array');

  // B. Arbitrary frontier codenames in structural AI hyperparameter objects
  const catalogCode = `
    export const CATALOG = {
      hydrogen: {
        id: "Hydrogen",
        context_window: 1000000,
        max_tokens: 32768,
        reasoning_effort: "high"
      },
      jupiter: {
        model: "Jupiter-6.1-Thinking",
        context_window: 200000,
        supports_thinking: true
      }
    };
  `;
  const astCatalogFindings = extractSignalsFromAst(catalogCode, 'src/catalog.js');
  const catalogModelValues = astCatalogFindings.filter((f) => f.category === CATEGORIES.MODEL_ID).map((f) => f.value);
  assert.ok(catalogModelValues.includes('Hydrogen'), 'Must detect Hydrogen from AI hyperparameter catalog');
  assert.ok(catalogModelValues.includes('Jupiter-6.1-Thinking'), 'Must detect Jupiter-6.1-Thinking from AI catalog');

  // C. Structural Model Slots in properties
  const slotCode = `
    export const config = {
      default_model: "Argon",
      reasoning_model: "Terra",
      fallback_model: "Krypton"
    };
  `;
  const slotFindings = extractSignalsFromAst(slotCode, 'src/config.js');
  const slotModelValues = slotFindings.filter((f) => f.category === CATEGORIES.MODEL_ID).map((f) => f.value);
  assert.ok(slotModelValues.includes('Argon'), 'Must detect Argon from default_model slot');
  assert.ok(slotModelValues.includes('Terra'), 'Must detect Terra from reasoning_model slot');
  assert.ok(slotModelValues.includes('Krypton'), 'Must detect Krypton from fallback_model slot');
});

test('2. Strict Rejection of Non-Model Software Tokens, CSS, and Code Identifiers', () => {
  const NOISE_TOKENS = [
    'ajv-pro',
    'cross-pro',
    'vite-plus',
    'axum-0.8',
    'hyper-1.8',
    'box-0.8',
    'serde-json',
    'react-pro',
    'button-pro',
    'table-low',
    'cursor-default',
    'flex-row',
    'text-sm',
    'font-bold',
    '01-02',
    '1970-01-01',
    'utf-8',
    'sha-256',
    'ap-southeast-2',
  ];

  for (const token of NOISE_TOKENS) {
    assert.equal(
      isValidModelIdentifier(token),
      false,
      `Non-model token '${token}' must be rejected by isValidModelIdentifier`
    );
  }

  // Feature flag rejection of CSS and DOM properties
  assert.equal(isValidFeatureFlag('flex-row'), false, 'flex-row is CSS, not feature flag');
  assert.equal(isValidFeatureFlag('text-sm'), false, 'text-sm is CSS, not feature flag');
  assert.equal(isValidFeatureFlag('onClick'), false, 'onClick is DOM handler, not feature flag');
  assert.equal(isValidFeatureFlag('preview_id'), false, 'preview_id is DOM property, not feature flag');
});

test('3. ASCII Table and Box Formatters produce perfect Unicode alignment', () => {
  const headers = ['STATUS', 'CATEGORY', 'IDENTIFIER', 'SCORE'];
  const rows = [
    ['🔥 NEW', '🤖 model_id', 'hydrogen-preview', '95 pts'],
    ['🔥 NEW', '🚩 feature_flag', 'enable_canvas_v2', '80 pts'],
  ];

  const table = renderAsciiTable(headers, rows);
  assert.ok(table.includes('┌─'));
  assert.ok(table.includes('STATUS'));
  assert.ok(table.includes('hydrogen-preview'));
  assert.ok(table.includes('enable_canvas_v2'));
  assert.ok(table.includes('└─'));

  const box = renderAsciiBox(['Component: test-cli', 'Version: 1.0.0'], 'SCAN METRICS');
  assert.ok(box.includes('┌─ SCAN METRICS'));
  assert.ok(box.includes('Component: test-cli'));
  assert.ok(box.includes('└─'));
});

test('4. Report Bundle outputs formidable ASCII tables in leaks.txt, diff.txt, models-and-pricing.txt, urls.txt', () => {
  const tmpDir = path.join(os.tmpdir(), `ascii-report-test-${Date.now()}`);

  const scanData = {
    scanId: 'CX-20261117-099',
    componentId: 'cursor-desktop',
    family: 'cursor',
    version: '0.45.0',
    oldVersion: '0.44.0',
    diffResults: {
      newFindings: [
        { category: 'model_id', value: 'hydrogen-preview', score: 95, tier: 'HIGH-CONFIDENCE SIGNAL', diffStatus: 'NEW' },
        { category: 'feature_flag', value: 'enable_canvas_v2', score: 85, tier: 'HIGH-CONFIDENCE SIGNAL', diffStatus: 'NEW' },
      ],
      persistentFindings: [
        { category: 'model_id', value: 'claude-3-7-sonnet', score: 90, tier: 'HIGH-CONFIDENCE SIGNAL', diffStatus: 'PERSISTENT' },
      ],
      removedFindings: [],
      reintroducedFindings: [],
      byCategory: {
        model_id: { added: 1, changed: 0, removed: 0, total: 2 },
        feature_flag: { added: 1, changed: 0, removed: 0, total: 1 },
      },
    },
    scoredFindings: [
      { category: 'model_id', value: 'hydrogen-preview', score: 95, tier: 'HIGH-CONFIDENCE SIGNAL', diffStatus: 'NEW', activationStatus: 'CONFIGURED', filePath: 'src/catalog.js' },
      { category: 'feature_flag', value: 'enable_canvas_v2', score: 85, tier: 'HIGH-CONFIDENCE SIGNAL', diffStatus: 'NEW', activationStatus: 'ENABLED', filePath: 'src/gates.js' },
      { category: 'model_id', value: 'claude-3-7-sonnet', score: 90, tier: 'HIGH-CONFIDENCE SIGNAL', diffStatus: 'PERSISTENT', activationStatus: 'CONFIGURED', filePath: 'src/catalog.js' },
      { category: 'pricing', value: 'hydrogen-preview | input $3.0/1M | output $15.0/1M', model: 'hydrogen-preview', inputPrice: 3.0, outputPrice: 15.0, diffStatus: 'NEW', filePath: 'src/catalog.js' },
    ],
    urlsInventory: [
      { url: 'https://api.cursor.com/v1/models', category: 'MODEL_AND_AI_APIS' },
      { url: 'https://internal.cursor.com/v2/canary', category: 'INTERNAL_AND_STAGING' },
    ],
    newUrls: [
      { url: 'https://internal.cursor.com/v2/canary', category: 'INTERNAL_AND_STAGING' },
    ],
    platformAsymmetry: { macOnly: [], winOnly: [] },
    coverage: { percentage: 100, macOk: true, winOk: true },
    totalExtractedStrings: 125000,
    artifactInventory: [
      { target: 'darwin-arm64', format: 'dmg', size: 120 * 1024 * 1024, sha256: 'fedcba9876543210' },
    ],
  };

  const bundle = generateReportBundle(tmpDir, scanData);

  // 1. leaks.txt check
  const leaksContent = fs.readFileSync(path.join(tmpDir, 'leaks.txt'), 'utf8');
  assert.ok(leaksContent.includes('SECTION 1: VERIFIED NEW LEAKS IN THIS VERSION (DELTA)'));
  assert.ok(leaksContent.includes('SECTION 2: KNOWN BASELINE SIGNALS (PREVIOUS RELEASES)'));
  assert.ok(leaksContent.includes('hydrogen-preview'));
  assert.ok(leaksContent.includes('enable_canvas_v2'));
  assert.ok(leaksContent.includes('claude-3-7-sonnet'));
  assert.ok(leaksContent.includes('┌─'));
  assert.ok(leaksContent.includes('└─'));

  // 2. models-and-pricing.txt check
  const modelsContent = fs.readFileSync(path.join(tmpDir, 'models-and-pricing.txt'), 'utf8');
  assert.ok(modelsContent.includes('MODEL CATALOG TABLE'));
  assert.ok(modelsContent.includes('PRICING RATES TABLE'));
  assert.ok(modelsContent.includes('hydrogen-preview'));
  assert.ok(modelsContent.includes('$3'));
  assert.ok(modelsContent.includes('$15'));

  // 3. diff.txt check
  const diffContent = fs.readFileSync(path.join(tmpDir, 'diff.txt'), 'utf8');
  assert.ok(diffContent.includes('VERSION DELTA & STRUCTURAL DIFF'));
  assert.ok(diffContent.includes('STRING DELTA METRICS:'));
  assert.ok(diffContent.includes('STRUCTURAL SIGNAL CATEGORIES BREAKDOWN:'));

  // 4. urls.txt check
  const urlsContent = fs.readFileSync(path.join(tmpDir, 'urls.txt'), 'utf8');
  assert.ok(urlsContent.includes('APPLICATION ENDPOINTS & ROUTES INVENTORY'));
  assert.ok(urlsContent.includes('NEWLY INTRODUCED ENDPOINTS IN THIS RELEASE'));
  assert.ok(urlsContent.includes('https://internal.cursor.com/v2/canary'));

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
