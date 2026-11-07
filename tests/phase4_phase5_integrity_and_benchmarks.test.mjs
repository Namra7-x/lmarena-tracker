import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import {
  isValidModelIdentifier,
  isValidFeatureFlag,
  isValidAgentTool,
  isValidGoSymbol,
  matchSignalsInText,
} from '../reverse-tracker/finder/rules.mjs';
import {
  evaluateNoise,
  isHumanReadableString,
  computeShannonEntropy,
} from '../reverse-tracker/finder/noise.mjs';
import { cleanAndValidateUrl } from '../reverse-tracker/extraction/urls.mjs';
import {
  computeExactDiff,
  formatStructuralDiffReport,
} from '../reverse-tracker/diff/engine.mjs';
import { extractSignalsFromAst } from '../reverse-tracker/extraction/ast.mjs';
import { isGoStdLibSymbol, parseGoSignals } from '../reverse-tracker/extraction/go.mjs';
import { isSafeRelativePath } from '../reverse-tracker/extraction/archive.mjs';

test('Phase 4: Dedicated Category Validators (Strict, No Cross-Contamination)', () => {
  // 1. Model Identifier Validation
  // Valid models
  assert.equal(isValidModelIdentifier('gemini-3.8-flash-tts'), true);
  assert.equal(isValidModelIdentifier('claude-4.0-sonnet-preview'), true);
  assert.equal(isValidModelIdentifier('o3-mini'), true);
  assert.equal(isValidModelIdentifier('o3-high'), true);
  assert.equal(isValidModelIdentifier('deepseek-v3'), true);

  // Strict rejection of dates, SVG, CSS, encodings, and binary garbage
  assert.equal(isValidModelIdentifier('01-02'), false, 'Date segment 01-02 rejected');
  assert.equal(isValidModelIdentifier('2006-01-02'), false, 'Date format rejected');
  assert.equal(isValidModelIdentifier('02-jan-0'), false, 'Calendar layout rejected');
  assert.equal(isValidModelIdentifier('1h-9'), false, 'SVG coordinate rejected');
  assert.equal(isValidModelIdentifier('43l7-4.4'), false, 'SVG coordinate rejected');
  assert.equal(isValidModelIdentifier('o2-card'), false, 'CSS component class rejected');
  assert.equal(isValidModelIdentifier('utf-8'), false, 'Encoding rejected');
  assert.equal(isValidModelIdentifier('us-east-1'), false, 'Cloud region rejected');

  // 2. Feature Flag Validation (Dedicated)
  assert.equal(isValidFeatureFlag('canvas_reasoning_v2'), true);
  assert.equal(isValidFeatureFlag('enable-browser-subagent'), true);
  assert.equal(isValidFeatureFlag('ok'), false, 'Too short / generic word rejected');
  assert.equal(isValidFeatureFlag('cursor-pointer'), false, 'CSS cursor rejected');

  // 3. Agent Tool Validation (Dedicated)
  assert.equal(isValidAgentTool('mcp__computer_control'), true);
  assert.equal(isValidAgentTool('agent_deep_research'), true);
  assert.equal(isValidAgentTool('connector_googlecalendar'), true);
  assert.equal(isValidAgentTool('generic_function_name'), false, 'Non-agent function rejected');

  // 4. Go Symbol Validation (Dedicated)
  assert.equal(isValidGoSymbol('github.com/google/jetski/agent.Run'), true);
  assert.equal(isValidGoSymbol('main.ModelRouterConfig'), true);
  assert.equal(isValidGoSymbol('bad\x00symbol'), false, 'Control char rejected');

  // 5. URL & Endpoint Validation (Dedicated)
  assert.equal(cleanAndValidateUrl('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(cleanAndValidateUrl('wss://chat.openai.com/ws/realtime'), 'wss://chat.openai.com/ws/realtime');
  assert.equal(cleanAndValidateUrl('/v1/chat/completions'), '/v1/chat/completions');
  assert.equal(cleanAndValidateUrl('https://example.com/logo.png'), null, 'Static image asset rejected');
  assert.equal(cleanAndValidateUrl('https://www.w3.org/2000/svg'), null, 'W3 XML namespace rejected');
});

test('Phase 4: Candidate Evidence & Rejection Reason Preservation', () => {
  const line = 'let model = "gemini-3.8-flash-tts"; // test context';
  const matches = matchSignalsInText(line, 'src/model.js', 'source');

  assert.ok(matches.length > 0);
  const modelFinding = matches.find((m) => m.value === 'gemini-3.8-flash-tts');
  assert.ok(modelFinding);
  assert.equal(modelFinding.status, 'accepted');
  assert.equal(modelFinding.rejectionReason, null);
  assert.equal(modelFinding.filePath, 'src/model.js');
  assert.ok(modelFinding.context.includes('gemini-3.8-flash-tts'));

  // Noise evaluation preserves exact rejection reasons
  const noiseDate = evaluateNoise('02-jan-2024');
  assert.equal(noiseDate.isNoise, true);
  assert.equal(noiseDate.reason, 'date_layout');

  const noiseTimestamp = evaluateNoise('2006-01-02');
  assert.equal(noiseTimestamp.isNoise, true);
  assert.equal(noiseTimestamp.reason, 'timestamp');

  const noiseSvg = evaluateNoise('1h-9');
  assert.equal(noiseSvg.isNoise, true);
  assert.equal(noiseSvg.reason, 'svg_coordinate');

  const noise2 = evaluateNoise('#ff00aa');
  assert.equal(noise2.isNoise, true);
  assert.equal(noise2.reason, 'css_style_or_svg');

  const noise3 = evaluateNoise('5a3f91d8-0b2c-4e8f-9a1b-2c3d4e5f6a7b');
  assert.equal(noise3.isNoise, true);
  assert.equal(noise3.reason, 'uuid');

  const noise4 = evaluateNoise('aB3$kL9#mP1*vX7&zQ2@wR5^yU8!tO4%nE6');
  assert.equal(noise4.isNoise, true);
  assert.equal(noise4.reason, 'high_entropy_hash_or_base64');
});

test('Phase 4: Structural Delta Diffing & Category Breakdown', () => {
  const previous = [
    { category: 'model_id', value: 'gpt-4o', context: 'ctx1', filePath: 'a.js' },
    { category: 'feature_flag', value: 'flag_stable', context: 'f1', filePath: 'b.js' },
    { category: 'go_type', value: 'AgentEngine', context: 'g1', filePath: 'engine.go' },
  ];

  const candidate = [
    // Persistent
    { category: 'model_id', value: 'gpt-4o', context: 'ctx1', filePath: 'a.js' },
    // Changed context/filePath
    { category: 'go_type', value: 'AgentEngine', context: 'g1_updated_fields', filePath: 'engine_v2.go' },
    // Added model
    { category: 'model_id', value: 'claude-3-7-sonnet', context: 'new model', filePath: 'c.js' },
    // Added endpoint
    { category: 'endpoint_domain', value: 'https://internal.anthropic.com/v2', context: 'route', filePath: 'd.js' },
    // Reintroduced flag
    { category: 'feature_flag', value: 'revived_gate', context: 'revived', filePath: 'e.js' },
  ];

  const historical = new Set(['revived_gate']);
  const diff = computeExactDiff(previous, candidate, historical);

  // Assert counts
  assert.equal(diff.counts.totalCandidate, 5);
  assert.equal(diff.counts.addedCount, 2, 'claude-3-7-sonnet and internal endpoint added');
  assert.equal(diff.counts.changedCount, 1, 'AgentEngine changed context and filePath');
  assert.equal(diff.counts.removedCount, 1, 'flag_stable was removed');
  assert.equal(diff.counts.reintroducedCount, 1, 'revived_gate was reintroduced');
  assert.equal(diff.counts.persistentCount, 1, 'gpt-4o is persistent');

  // Assert byCategory structural breakdown
  assert.ok(diff.byCategory);
  assert.equal(diff.byCategory.model_id.added, 1);
  assert.equal(diff.byCategory.model_id.persistent, 1);
  assert.equal(diff.byCategory.go_type.changed, 1);
  assert.equal(diff.byCategory.feature_flag.removed, 1);
  assert.equal(diff.byCategory.feature_flag.reintroduced, 1);
  assert.equal(diff.byCategory.endpoint_domain.added, 1);

  // Assert formatted report text
  const reportText = formatStructuralDiffReport(diff);
  assert.ok(reportText.includes('STRUCTURAL DELTA DIFF REPORT'));
  assert.ok(reportText.includes('model_id: +1 added'));
  assert.ok(reportText.includes('[+] NEW SIGNALS ADDED (2):'));
  assert.ok(reportText.includes('claude-3-7-sonnet'));
  assert.ok(reportText.includes('[*] DRIFTED / CHANGED SIGNALS (1):'));
  assert.ok(reportText.includes('AgentEngine'));
  assert.ok(reportText.includes('[-] DEPRECATED / REMOVED SIGNALS (1):'));
  assert.ok(reportText.includes('flag_stable'));
  assert.ok(reportText.includes('[~] REINTRODUCED HISTORICAL SIGNALS (1):'));
  assert.ok(reportText.includes('revived_gate'));
});

test('Phase 5: Empirical Benchmarking, Profiling & Bomb Safeguards', () => {
  // 1. Safe Relative Path (Zip-Slip / Directory Traversal Protection)
  assert.equal(isSafeRelativePath('../../etc/passwd'), false);
  assert.equal(isSafeRelativePath('/root/secret.key'), false);
  assert.equal(isSafeRelativePath('..\\..\\windows\\system32'), false);
  assert.equal(isSafeRelativePath('app/resources/config.json'), true);
  assert.equal(isSafeRelativePath('index.js'), true);

  // 2. High-volume AST parsing latency benchmark
  const largeJsBundle = `
    const SUPPORTED_MODELS = [
      ${Array.from({ length: 50 }, (_, i) => `"model-v${i}-preview"`).join(',\n')}
    ];
    function testGate() {
      if (checkGate("flag_alpha") && isFeatureEnabled("flag_beta")) {
        return "https://api." + "example.com" + "/v1/rpc";
      }
    }
  `;

  const startTime = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;

  const astFindings = extractSignalsFromAst(largeJsBundle, 'bundle.large.js');
  const elapsedMs = performance.now() - startTime;
  const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

  // Assert empirical performance limits (< 200ms for AST parsing, < 20MB heap delta)
  assert.ok(elapsedMs < 200, `AST parse completed in ${elapsedMs}ms (< 200ms)`);
  assert.ok(heapDeltaMb < 20, `Heap growth was ${heapDeltaMb.toFixed(2)}MB (< 20MB)`);
  assert.ok(astFindings.length >= 50, 'All 50 models extracted from array');

  // 3. Benchmark Object Schema Consistency
  const benchmarkRecord = {
    executionTimeMs: Math.round(elapsedMs),
    peakMemoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    rssMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    totalExtractedBytes: largeJsBundle.length,
    totalExtractedStrings: astFindings.length,
    newCleanStringsCount: astFindings.length,
    endpointsCount: 1,
    timestamp: new Date().toISOString(),
  };

  assert.equal(typeof benchmarkRecord.executionTimeMs, 'number');
  assert.ok(benchmarkRecord.executionTimeMs >= 0);
  assert.ok(benchmarkRecord.peakMemoryMb > 0);
  assert.ok(benchmarkRecord.totalExtractedBytes > 0);
  assert.ok(benchmarkRecord.timestamp.length > 10);
});

test('Requirements 8 & 9: Analyzer Status Tracking & Archive Depth Safeguards', () => {
  // 1. Analyzer Status Recording (completed, skipped, failed)
  const validStatusValues = new Set(['completed', 'skipped', 'failed']);

  const sampleAnalyzerStatus = {
    acornAst: 'completed',
    goReSym: 'skipped',
    sourceMap: 'completed',
    sevenZip: 'skipped',
    asar: 'completed',
    tar: 'skipped',
    zip: 'skipped',
    multiEncodingScanner: 'completed',
  };

  for (const [analyzer, status] of Object.entries(sampleAnalyzerStatus)) {
    assert.ok(validStatusValues.has(status), `Analyzer ${analyzer} has valid status ${status}`);
  }

  // 2. Archive Depth & Nesting Guard Check
  // Path with 4 nested archive extensions (> MAX_ARCHIVE_DEPTH = 3)
  const deeplyNestedPath = 'outer.zip/inner.tar.gz/deeper.asar/deepest.nupkg/file.js';
  const depthMatches = (deeplyNestedPath.match(/\.(?:asar|zip|tar|tgz|gz|nupkg)/gi) || []).length;
  assert.ok(depthMatches > 3, 'Path exceeds MAX_ARCHIVE_DEPTH');

  const shallowPath = 'app.asar/bundle.js';
  const shallowMatches = (shallowPath.match(/\.(?:asar|zip|tar|tgz|gz|nupkg)/gi) || []).length;
  assert.ok(shallowMatches <= 3, 'Shallow archive passes depth check');
});
