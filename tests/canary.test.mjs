import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { extractArtifact } from '../reverse-tracker/extraction/dispatcher.mjs';
import { extractStrings } from '../reverse-tracker/extraction/strings.mjs';
import { matchSignalsInText, CATEGORIES } from '../reverse-tracker/finder/rules.mjs';
import { scoreFinding, TIERS } from '../reverse-tracker/finder/scorer.mjs';

test('Canary Proof Test (Section 12): detects planted leaks across nested ASAR and UTF-16 encodings', () => {
  // 1. Build an ASAR containing canary payloads
  // Payload A (UTF-16LE): claude-4-preview with internal marker
  const textPayloadA = 'export const MODEL = "claude-4-preview"; // internal dogfood build\n';
  const utf16leBuf = Buffer.from(textPayloadA, 'utf16le');

  // Payload B (UTF-8): hidden command
  const textPayloadB = 'module.exports = { name: "undocumented-agent-eval", hidden: true, desc: "canary" };\n';
  const utf8Buf = Buffer.from(textPayloadB, 'utf8');

  // ASAR Header with 2 files: app/model.js (utf16le) and app/cmd.js (utf8)
  const headerObj = {
    files: {
      app: {
        files: {
          'model.bin': { size: utf16leBuf.length, offset: '0' },
          'cmd.js': { size: utf8Buf.length, offset: String(utf16leBuf.length) },
        },
      },
    },
  };
  const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const asarBuf = Buffer.alloc(16 + headerJson.length + utf16leBuf.length + utf8Buf.length);

  asarBuf.writeUInt32LE(4, 0);
  asarBuf.writeUInt32LE(headerJson.length + 8, 4);
  asarBuf.writeUInt32LE(headerJson.length + 4, 8);
  asarBuf.writeUInt32LE(headerJson.length, 12);
  headerJson.copy(asarBuf, 16);
  utf16leBuf.copy(asarBuf, 16 + headerJson.length);
  utf8Buf.copy(asarBuf, 16 + headerJson.length + utf16leBuf.length);

  // 2. Wrap the ASAR inside a Tarball (simulating an installer package with nested ASAR)
  const tarBuf = Buffer.alloc(4096, 0);
  tarBuf.write('resources/app.asar', 0, 'utf8');
  tarBuf.write(asarBuf.length.toString(8).padStart(11, '0') + ' ', 124, 'ascii');
  tarBuf.write('0', 156, 'ascii');
  asarBuf.copy(tarBuf, 512);

  const gzippedTar = zlib.gzipSync(tarBuf);

  // 3. Extract the artifact
  const { files } = extractArtifact(gzippedTar, 'tgz', 'darwin-arm64', 'https://example.com/app.tar.gz');

  // Verify nested asar files were unpacked
  assert.ok(files.length >= 2, 'Must unpack nested ASAR files from tarball');

  // 4. Scan strings & match signals
  const foundSignals = [];
  for (const f of files) {
    // Both text and multi-encoding binary strings
    const strList = extractStrings(f.buffer);
    for (const item of strList) {
      const matches = matchSignalsInText(item.value, f.path);
      foundSignals.push(...matches);
    }
  }

  // 5. Verify Canary 1: Model ID caught
  const canaryModel = foundSignals.find((s) => s.category === CATEGORIES.MODEL_ID && s.value.includes('claude-4'));
  assert.ok(canaryModel, 'CANARY FAILED: claude-4 model ID was not detected!');
  assert.equal(canaryModel.hasDormantMarker, true);

  // 6. Verify Canary 2: Hidden command caught
  const canaryCmd = foundSignals.find((s) => s.category === CATEGORIES.HIDDEN_COMMAND && s.value === 'undocumented-agent-eval');
  assert.ok(canaryCmd, 'CANARY FAILED: undocumented-agent-eval hidden command was not detected!');

  // 7. Score canaries: both must reach MAJOR EARLY SIGNAL / HIGH-CONFIDENCE
  const scoredModel = scoreFinding(canaryModel, { isNewInDiff: true, isFirstEverSeen: true });
  assert.equal(scoredModel.isMajorEarlySignal, true);
  assert.equal(scoredModel.tier, TIERS.HIGH_CONFIDENCE);

  const scoredCmd = scoreFinding(
    { ...canaryCmd, platforms: ['macOS', 'Windows'] },
    { isNewInDiff: true, isFirstEverSeen: true }
  );
  assert.equal(scoredCmd.isMajorEarlySignal, true);
  assert.equal(scoredCmd.tier, TIERS.HIGH_CONFIDENCE);
});
