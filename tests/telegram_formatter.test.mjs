import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatImmediateAlert, formatCompletionMessage } from '../reverse-tracker/telegram/formatter.mjs';

test('escapeHtml safely handles &, <, and >', () => {
  assert.equal(escapeHtml('<script>alert("xss & fun")</script>'), '&lt;script&gt;alert("xss &amp; fun")&lt;/script&gt;');
});

test('formatImmediateAlert matches Section 8 specification', () => {
  const alert = formatImmediateAlert({
    componentName: 'Codex CLI',
    oldVersion: '0.160.1',
    newVersion: '0.160.2',
    scanId: 'CX-20261103-004',
    targets: ['darwin-arm64', 'win32-x64'],
    releaseUrl: 'https://registry.npmjs.org/@openai/codex',
  });

  assert.ok(alert.includes('🚨 <b>CODEX CLI 0.160.1 → 0.160.2</b>'));
  assert.ok(alert.includes('Targets: macOS ✓  Windows ✓'));
  assert.ok(alert.includes('Scan: <code>CX-20261103-004</code>'));
  assert.ok(alert.includes('[Official Release]'));
});

test('formatCompletionMessage formats major signals, blockquotes, and respects 4096 char limit', () => {
  const msg = formatCompletionMessage({
    scanId: 'CX-20261103-004',
    counts: { commands: 12, flags: 7, configs: 5, endpoints: 3 },
    majorSignals: [
      { category: 'model_id', value: 'gpt-5-preview', platforms: ['macOS', 'Windows'] },
    ],
    highSignals: [
      { category: 'feature_flag', value: 'agentic_reasoning_gate', score: 65 },
    ],
    moreFindings: Array.from({ length: 50 }, (_, i) => ({
      category: 'feature_flag',
      value: `flag_${i}`,
      score: 40,
    })),
    countCheckText: 'Extracted 100 = New 10 + Persistent 90\nListed in files 10 / 10 ✓\nCoverage 100% (macOS ✓ Windows ✓)',
  });

  assert.ok(msg.includes('🔬 <b>ANALYSIS COMPLETE · CX-20261103-004</b>'));
  assert.ok(msg.includes('🔥 <b>MAJOR EARLY SIGNALS</b>'));
  assert.ok(msg.includes('• <b>model_id:</b> <code>gpt-5-preview</code> (macOS+Windows)'));
  assert.ok(msg.includes('<blockquote expandable>'));
  assert.ok(msg.length <= 4096);
});

test('TelegramClient resolves topicId from environment variables', async () => {
  const { TelegramClient } = await import('../reverse-tracker/telegram/client.mjs');
  process.env.TELEGRAM_TOPIC_OPENAI = '42';
  process.env.TELEGRAM_TOPIC_MAP = JSON.stringify({ anthropic: 99 });

  const client = new TelegramClient('test-token', '-100123456789');
  assert.equal(client.getTopicId('openai'), 42);
  assert.equal(client.getTopicId('anthropic'), 99);
  assert.equal(client.getTopicId('google'), undefined);

  delete process.env.TELEGRAM_TOPIC_OPENAI;
  delete process.env.TELEGRAM_TOPIC_MAP;
});
