import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { TelegramClient } from '../reverse-tracker/telegram/client.mjs';
import {
  saveComponentState,
  loadComponentState,
  validateStateAdvancement,
} from '../reverse-tracker/state/store.mjs';
import { generateReportBundle } from '../reverse-tracker/reports/bundle.mjs';

test('Phase 6: Multi-Bot Token Resolution & Topic Routing Across All 6 Families', () => {
  const originalEnv = { ...process.env };

  try {
    // Configure dedicated family tokens
    process.env.TELEGRAM_TOKEN_GOOGLE = 'bot-google-token-111';
    process.env.TELEGRAM_CHAT_ID_GOOGLE = 'chat-google-111';
    process.env.TELEGRAM_TOPIC_GOOGLE = '101';

    process.env.TELEGRAM_TOKEN_ANTHROPIC = 'bot-anthropic-token-222';
    process.env.TELEGRAM_CHAT_ID_ANTHROPIC = 'chat-anthropic-222';
    process.env.TELEGRAM_TOPIC_ANTHROPIC = '202';

    process.env.TELEGRAM_TOKEN_OPENAI = 'bot-openai-token-333';
    process.env.TELEGRAM_CHAT_ID_OPENAI = 'chat-openai-333';
    process.env.TELEGRAM_TOPIC_OPENAI = '303';

    process.env.TELEGRAM_TOKEN_CURSOR = 'bot-cursor-token-444';
    process.env.TELEGRAM_CHAT_ID_CURSOR = 'chat-cursor-444';
    process.env.TELEGRAM_TOPIC_CURSOR = '404';

    process.env.TELEGRAM_TOKEN_DEVIN = 'bot-devin-token-555';
    process.env.TELEGRAM_CHAT_ID_DEVIN = 'chat-devin-555';
    process.env.TELEGRAM_TOPIC_DEVIN = '505';

    process.env.TELEGRAM_TOKEN_OTHER = 'bot-other-token-666';
    process.env.TELEGRAM_CHAT_ID_OTHER = 'chat-other-666';
    process.env.TELEGRAM_TOPIC_OTHER = '606';

    process.env.TELEGRAM_BOT_TOKEN = 'bot-universal-fallback-999';
    process.env.TELEGRAM_CHAT_ID = 'chat-universal-fallback-999';

    // 1. Google Client
    const googleClient = new TelegramClient(null, null, 'google', 'antigravity-cli');
    assert.equal(googleClient.token, 'bot-google-token-111');
    assert.equal(googleClient.chatId, 'chat-google-111');
    assert.equal(googleClient.getTopicId('google', 'antigravity-cli'), 101);

    // 2. Anthropic Client
    const anthropicClient = new TelegramClient(null, null, 'anthropic', 'claude-desktop');
    assert.equal(anthropicClient.token, 'bot-anthropic-token-222');
    assert.equal(anthropicClient.chatId, 'chat-anthropic-222');
    assert.equal(anthropicClient.getTopicId('anthropic', 'claude-desktop'), 202);

    // 3. OpenAI Client
    const openaiClient = new TelegramClient(null, null, 'openai', 'codex-cli');
    assert.equal(openaiClient.token, 'bot-openai-token-333');
    assert.equal(openaiClient.chatId, 'chat-openai-333');
    assert.equal(openaiClient.getTopicId('openai', 'codex-cli'), 303);

    // 4. Cursor Client
    const cursorClient = new TelegramClient(null, null, 'cursor', 'cursor-desktop');
    assert.equal(cursorClient.token, 'bot-cursor-token-444');
    assert.equal(cursorClient.chatId, 'chat-cursor-444');
    assert.equal(cursorClient.getTopicId('cursor', 'cursor-desktop'), 404);

    // 5. Devin Client
    const devinClient = new TelegramClient(null, null, 'devin', 'devin-cli');
    assert.equal(devinClient.token, 'bot-devin-token-555');
    assert.equal(devinClient.chatId, 'chat-devin-555');
    assert.equal(devinClient.getTopicId('devin', 'devin-cli'), 505);

    // 6. Other Client
    const otherClient = new TelegramClient(null, null, 'other', 'droid-cli');
    assert.equal(otherClient.token, 'bot-other-token-666');
    assert.equal(otherClient.chatId, 'chat-other-666');
    assert.equal(otherClient.getTopicId('other', 'droid-cli'), 606);

    // Universal fallback test: unconfigured family
    const fallbackClient = new TelegramClient(null, null, 'unknown-family');
    assert.equal(fallbackClient.token, 'bot-universal-fallback-999');
    assert.equal(fallbackClient.chatId, 'chat-universal-fallback-999');
  } finally {
    process.env = originalEnv;
  }
});

test('Phase 6: Alert Deduplication Key Digest Consistency & Suppression', () => {
  const compId = 'antigravity-cli';
  const ver = '1.5.4';
  const artifactHashes = ['sha256:1111', 'sha256:2222'];
  const findings = [
    { category: 'model_id', value: 'gemini-3.8-flash-tts' },
    { category: 'feature_flag', value: 'agentic_coding' },
  ];

  function computeAlertDigest(c, v, arts, finds) {
    const artSha = crypto.createHash('sha256').update(arts.sort().join(',')).digest('hex');
    const findDigest = crypto.createHash('sha256').update(finds.map((f) => `${f.category}:${f.value}`).sort().join(';')).digest('hex');
    return crypto.createHash('sha256').update(`${c}:${v}:${artSha}:${findDigest}`).digest('hex');
  }

  const key1 = computeAlertDigest(compId, ver, artifactHashes, findings);
  const key2 = computeAlertDigest(compId, ver, artifactHashes, findings);
  assert.equal(key1, key2, 'Alert key must be deterministic');

  // Baseline tracking suppression logic
  const mockBaseline = { alertedVersion: '1.5.4', lastAlertDigest: key1 };
  const isDuplicate = mockBaseline.lastAlertDigest === key2;
  assert.equal(isDuplicate, true, 'Matching alert key triggers duplicate suppression');

  // If findings change, suppression does not trigger
  const newFindings = [...findings, { category: 'model_id', value: 'lyria-3-preview' }];
  const key3 = computeAlertDigest(compId, ver, artifactHashes, newFindings);
  assert.equal(mockBaseline.lastAlertDigest === key3, false, 'New signals generate new digest');
});

test('Phase 7: State Integrity & Zero-Spam Locking (Atomic Persistence & Bounded State)', () => {
  const tmpDir = path.join(os.tmpdir(), `tracker-state-test-${Date.now()}`);

  try {
    // 1. Atomic Persistence & Complete Metadata Preservation
    const stateInput = {
      version: '2.0.0',
      alertedVersion: '2.0.0',
      releaseId: 'rel-200',
      channel: 'canary',
      identityFingerprint: 'id-hash-abc',
      scanId: 'AC-20261107-001',
      coverageState: 'COMPLETE',
      lastAlertDigest: 'digest-xyz',
      analyzerStatus: { acornAst: 'completed', goReSym: 'completed', sevenZip: 'skipped' },
      benchmark: { executionTimeMs: 1420, peakMemoryMb: 48, totalExtractedBytes: 15000000 },
      hotSignals: [{ category: 'model_id', value: 'gemini-3.8-pro' }],
      recentSignals: Array.from({ length: 6000 }, (_, i) => ({ value: `sig-${i}` })), // Exceeds 5000 cap
      historicalSeenHashes: Array.from({ length: 12000 }, (_, i) => `hash-${i}`),     // Exceeds 10000 cap
      historicalSeenUrls: Array.from({ length: 6000 }, (_, i) => `https://api.com/${i}`), // Exceeds 5000 cap
    };

    saveComponentState(tmpDir, 'antigravity-cli', stateInput);
    const loaded = loadComponentState(tmpDir, 'antigravity-cli');

    assert.ok(loaded);
    assert.equal(loaded.version, '2.0.0');
    assert.equal(loaded.alertedVersion, '2.0.0');
    assert.equal(loaded.lastAlertDigest, 'digest-xyz');
    assert.equal(loaded.analyzerStatus.acornAst, 'completed');
    assert.equal(loaded.benchmark.executionTimeMs, 1420);
    assert.equal(loaded.coverageState, 'COMPLETE');

    // Bounds checks
    assert.equal(loaded.recentSignals.length, 5000, 'recentSignals capped at 5000');
    assert.equal(loaded.historicalSeenHashes.length, 10000, 'historicalSeenHashes capped at 10000');
    assert.equal(loaded.historicalSeenUrls.length, 5000, 'historicalSeenUrls capped at 5000');

    // 2. State Advancement Integrity (Never advance baseline on PARTIAL or FAILED)
    const partialAdvance = validateStateAdvancement(loaded, { coverageState: 'PARTIAL' });
    assert.equal(partialAdvance.canAdvance, false);
    assert.ok(partialAdvance.reason.includes('PARTIAL'));

    const failedAdvance = validateStateAdvancement(loaded, { coverageState: 'FAILED' });
    assert.equal(failedAdvance.canAdvance, false);
    assert.ok(failedAdvance.reason.includes('FAILED'));

    // Concurrent stale fingerprint protection
    const staleAdvance = validateStateAdvancement(loaded, {
      coverageState: 'COMPLETE',
      basedOnFingerprint: 'old-stale-fingerprint',
    });
    assert.equal(staleAdvance.canAdvance, false);
    assert.ok(staleAdvance.reason.includes('stale'));

    // Valid advance
    const validAdvance = validateStateAdvancement(loaded, {
      coverageState: 'COMPLETE',
      basedOnFingerprint: 'id-hash-abc',
    });
    assert.equal(validAdvance.canAdvance, true);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('Phase 7: Candidate Evidence Preservation in Report Bundle', () => {
  const tmpDir = path.join(os.tmpdir(), `tracker-candidates-test-${Date.now()}`);

  try {
    const rawCandidates = [
      {
        category: 'model_id',
        value: 'gemini-3.8-flash-tts',
        filePath: 'lib/core.js',
        offset: { line: 42, column: 15 },
        context: 'const model = "gemini-3.8-flash-tts";',
        rawExpression: 'Property(defaultModel)',
        origin: 'ast',
        status: 'accepted',
        score: 65,
        tier: 'HIGH-CONFIDENCE SIGNAL',
      },
      {
        category: 'endpoint_domain',
        value: 'wss://realtime.internal.google.com/agent',
        filePath: 'net/socket.js',
        offset: { line: 104, column: 8 },
        context: 'connect("wss://realtime.internal.google.com/agent")',
        rawExpression: 'Call(connect)',
        origin: 'ast',
        status: 'accepted',
        score: 55,
        tier: 'EARLY SIGNAL',
      },
      {
        category: 'feature_flag',
        value: 'unannounced_dark_canvas',
        filePath: 'flags.json',
        offset: { line: 2, column: 0 },
        context: '{"unannounced_dark_canvas": true}',
        rawExpression: 'Property(unannounced_dark_canvas)',
        origin: 'heuristic',
        status: 'accepted',
        score: 45,
        tier: 'EARLY SIGNAL',
      },
    ];

    const scanData = {
      scanId: 'AC-20261107-001',
      componentId: 'antigravity-cli',
      version: '1.5.4',
      diffResults: {
        newFindings: rawCandidates,
        persistentFindings: [],
        removedFindings: [],
        reintroducedFindings: [],
      },
      scoredFindings: rawCandidates,
      candidates: rawCandidates,
      urlsInventory: [{ url: 'wss://realtime.internal.google.com/agent', category: 'INTERNAL_AND_STAGING' }],
      newUrls: [{ url: 'wss://realtime.internal.google.com/agent', category: 'INTERNAL_AND_STAGING' }],
      platformAsymmetry: { macOnly: [], winOnly: [] },
      coverage: { percentage: 100, macOk: true, winOk: true },
      totalExtractedStrings: 500,
      benchmark: { executionTimeMs: 1250, peakMemoryMb: 42, totalExtractedBytes: 8000000 },
    };

    const bundle = generateReportBundle(tmpDir, scanData);

    // Verify candidates.json exists and preserves exact offsets and context
    const candidatesPath = path.join(tmpDir, 'candidates.json');
    assert.ok(fs.existsSync(candidatesPath));

    const candJson = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    assert.equal(candJson.totalCandidates, 3);
    assert.equal(candJson.candidates[0].value, 'gemini-3.8-flash-tts');
    assert.equal(candJson.candidates[0].offset.line, 42);
    assert.equal(candJson.candidates[0].filePath, 'lib/core.js');
    assert.equal(candJson.candidates[0].origin, 'ast');

    // Verify manifest.json contains benchmark
    const manifestPath = path.join(tmpDir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath));
    const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifestJson.benchmark.executionTimeMs, 1250);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
