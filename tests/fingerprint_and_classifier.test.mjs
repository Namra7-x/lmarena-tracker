import test from 'node:test';
import assert from 'node:assert/strict';
import { computeIdentityFingerprint, computeDiagnosticFingerprint } from '../reverse-tracker/fingerprint/identity.mjs';
import { classifyChange, CHANGE_TYPE } from '../reverse-tracker/fingerprint/classifier.mjs';

test('identity fingerprint is insensitive to volatile page HTML and timestamps', () => {
  const candidate1 = {
    componentId: 'codex-cli',
    channel: 'stable',
    version: '0.160.1',
    releaseId: '@openai/codex@0.160.1',
    artifacts: [{ target: 'all', url: 'https://registry.npmjs.org/codex-0.160.1.tgz', checksum: 'sha512:abc' }],
    metadata: { timestamp: 1000, pageHtml: '<html>Version 1</html>' },
  };

  const candidate2 = {
    componentId: 'codex-cli',
    channel: 'stable',
    version: '0.160.1',
    releaseId: '@openai/codex@0.160.1',
    artifacts: [{ target: 'all', url: 'https://registry.npmjs.org/codex-0.160.1.tgz', checksum: 'sha512:abc' }],
    metadata: { timestamp: 9999, pageHtml: '<html>Completely different changelog text</html>' },
  };

  const fp1 = computeIdentityFingerprint(candidate1);
  const fp2 = computeIdentityFingerprint(candidate2);

  assert.equal(fp1, fp2, 'Fingerprint must match when only volatile metadata changes');

  // But diagnostic fingerprints should differ
  const diag1 = computeDiagnosticFingerprint(candidate1);
  const diag2 = computeDiagnosticFingerprint(candidate2);
  assert.notEqual(diag1, diag2);
});

test('classifier classifies NO_CHANGE when candidate matches baseline', () => {
  const candidate = {
    componentId: 'claude-code',
    channel: 'stable',
    version: '2.1.300',
    releaseId: '@anthropic-ai/claude-code@2.1.300',
    artifacts: [{ target: 'all', url: 'https://registry.npmjs.org/claude.tgz', checksum: 'sha512:xyz' }],
  };
  const fp = computeIdentityFingerprint(candidate);
  const baseline = { version: '2.1.300', releaseId: candidate.releaseId, identityFingerprint: fp };

  const result = classifyChange(baseline, candidate);
  assert.equal(result.changeType, CHANGE_TYPE.NO_CHANGE);
});

test('classifier classifies VERSION_CHANGE when version bumps', () => {
  const baseline = {
    version: '2.1.300',
    releaseId: 'claude-code@2.1.300',
    identityFingerprint: 'old-hash',
  };
  const candidate = {
    componentId: 'claude-code',
    channel: 'stable',
    version: '2.1.301',
    releaseId: 'claude-code@2.1.301',
    artifacts: [{ target: 'all', url: 'https://registry.npmjs.org/claude-301.tgz', checksum: 'sha512:123' }],
  };

  const result = classifyChange(baseline, candidate);
  assert.equal(result.changeType, CHANGE_TYPE.VERSION_CHANGE);
  assert.equal(result.oldVersion, '2.1.300');
  assert.equal(result.newVersion, '2.1.301');
});

test('classifier classifies BYTE_CHANGE when same version has different checksum or URL', () => {
  const candidateOld = {
    componentId: 'gemini-desktop',
    channel: 'stable',
    version: '1.0.0',
    releaseId: 'gemini-1.0.0',
    artifacts: [{ target: 'win32-x64', url: 'https://dl.google.com/gemini/v1/app.exe', checksum: 'sha256:111' }],
  };
  const baseline = {
    version: '1.0.0',
    releaseId: 'gemini-1.0.0',
    identityFingerprint: computeIdentityFingerprint(candidateOld),
  };

  const candidateNew = {
    componentId: 'gemini-desktop',
    channel: 'stable',
    version: '1.0.0',
    releaseId: 'gemini-1.0.0',
    artifacts: [{ target: 'win32-x64', url: 'https://dl.google.com/gemini/v1/app.exe', checksum: 'sha256:999' }],
  };

  const result = classifyChange(baseline, candidateNew);
  assert.equal(result.changeType, CHANGE_TYPE.BYTE_CHANGE);
});
