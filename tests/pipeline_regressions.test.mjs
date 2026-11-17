import test from 'node:test';
import assert from 'node:assert/strict';

import { isHumanReadableString } from '../reverse-tracker/finder/noise.mjs';
import { extractJsonPricingFindings } from '../reverse-tracker/finder/rules.mjs';
import { extractStrings } from '../reverse-tracker/extraction/strings.mjs';
import { splitTelegramText } from '../reverse-tracker/telegram/client.mjs';
import { classifyChange, CHANGE_TYPE } from '../reverse-tracker/fingerprint/classifier.mjs';
import { fetchCursorCli } from '../reverse-tracker/sources/cursor.mjs';

test('Unicode human copy is not discarded as high-entropy noise', () => {
  assert.equal(isHumanReadableString('这是一个全新的隐藏功能，将在下周向所有用户开放。'), true);
  assert.equal(isHumanReadableString('新しいモデルは来週すべてのユーザーに公開されます。'), true);
  assert.equal(isHumanReadableString('暗号化された新しい機能を発表します。'), true);
});

test('binary string scanning preserves human-readable copy up to 4000 characters', () => {
  const prose = `New model catalog notice: ${'user interface copy '.repeat(170)}`;
  const buffer = Buffer.from(`\x00${prose}\x00`, 'utf8');
  const results = extractStrings(buffer, { maxLength: 4000, includeUnicode: true });
  const match = results.find((item) => item.value.includes('New model catalog notice'));
  assert.ok(match, 'Long readable string should be recovered');
  assert.equal(match.value, prose.trim());
});

test('pretty-printed JSON model catalogs yield pricing rows', () => {
  const json = JSON.stringify({
    models: [
      { id: 'gpt-5.2-preview', pricing: { input: 1.25, output: 10 } },
      { id: 'claude-fable-5', inputPrice: '3', outputPrice: '15' },
    ],
  }, null, 2);
  const findings = extractJsonPricingFindings(json, 'catalog.json');
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.category === 'pricing'));
  assert.ok(findings.some((finding) => finding.value.includes('gpt-5.2-preview') && finding.value.includes('$1.25')));
  assert.ok(findings.some((finding) => finding.value.includes('claude-fable-5') && finding.value.includes('$15')));
});

test('Telegram splitting keeps long HTML lines inside complete tags', () => {
  const line = `<b><code>https://example.com/${'a'.repeat(9000)}</code></b>`;
  const chunks = splitTelegramText(`Header\n${line}\nFooter`, 3900);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3900);
    assert.ok(!chunk.endsWith('<'));
    assert.ok(!chunk.endsWith('&'));
    const opens = (chunk.match(/<(?:b|code)(?:\s[^>]*)?>/g) || []).length;
    const closes = (chunk.match(/<\/(?:b|code)>/g) || []).length;
    assert.equal(opens, closes);
  }
});

test('volatile ETag fallback labels cannot trigger a release alert', () => {
  const result = classifyChange(
    { version: 'build-20260101-000000', identityFingerprint: 'a', releaseId: 'a' },
    { version: 'build-etag-deadbeef', stableVersion: 'build-etag-deadbeef', identityFingerprint: 'b', releaseId: 'b' },
  );
  assert.equal(result.changeType, CHANGE_TYPE.DIAGNOSTIC_DRIFT);
});

test('Cursor CLI uses the native Windows ZIP package path', async () => {
  const originalFetch = global.fetch;
  const version = '2026.11.13-eacade1';
  const sh = `DOWNLOAD_URL="https://downloads.cursor.com/lab/${version}/darwin/arm64/agent-cli-package.tar.gz"`;
  const ps = `$downloadUrl = 'https://downloads.cursor.com/lab/${version}/'; $version = '${version}'`;
  global.fetch = async (url) => ({
    ok: true,
    async text() {
      return String(url).includes('win32=true') ? ps : sh;
    },
  });
  try {
    const candidate = await fetchCursorCli();
    const win = candidate.artifacts.find((artifact) => artifact.target === 'win32-x64');
    assert.ok(win);
    assert.equal(win.format, 'zip');
    assert.ok(win.url.endsWith('/windows/x64/agent-cli-package.zip'));
  } finally {
    global.fetch = originalFetch;
  }
});
