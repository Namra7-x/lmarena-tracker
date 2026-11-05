import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, COMPONENTS, generateScanId } from '../reverse-tracker/registry/components.mjs';
import { assertUrlAllowed, assertNpmPackageAllowed, ALLOWED_DOMAINS } from '../reverse-tracker/registry/allowlist.mjs';

test('registry contains all 13 required components', () => {
  const componentKeys = Object.keys(COMPONENTS);
  assert.equal(componentKeys.length, 13);

  const expected = [
    'codex-cli', 'codex-desktop',
    'claude-code', 'claude-desktop',
    'gemini-desktop', 'antigravity-desktop', 'antigravity-cli',
    'cursor-desktop', 'cursor-cli',
    'devin-desktop', 'devin-cli',
    'opencode-cli', 'droid-cli',
  ];

  for (const exp of expected) {
    assert.ok(COMPONENTS[exp], `Missing expected component: ${exp}`);
  }
});

test('registry maps components to 6 families', () => {
  const familyKeys = Object.keys(FAMILIES);
  assert.deepEqual(familyKeys.sort(), ['anthropic', 'cursor', 'devin', 'google', 'openai', 'other'].sort());

  let totalMapped = 0;
  for (const fam of Object.values(FAMILIES)) {
    totalMapped += fam.components.length;
  }
  assert.equal(totalMapped, 13);
});

test('generateScanId produces canonical PREFIX-YYYYMMDD-SEQ format', () => {
  const date = new Date(Date.UTC(2026, 10, 5)); // 2026-11-05
  const scanId = generateScanId('codex-cli', date, 4);
  assert.equal(scanId, 'CX-20261105-004');

  const scanIdGoogle = generateScanId('gemini-desktop', date, 12);
  assert.equal(scanIdGoogle, 'GD-20261105-012');
});

test('allowlist permits official domains and rejects untrusted hosts', () => {
  // Official allowed
  assert.doesNotThrow(() => assertUrlAllowed('https://registry.npmjs.org/@openai/codex'));
  assert.doesNotThrow(() => assertUrlAllowed('https://persistent.oaistatic.com/codex-app-prod/Codex.dmg'));
  assert.doesNotThrow(() => assertUrlAllowed('https://downloads.claude.ai/claude-science/latest/mac-arm64.dmg'));
  assert.doesNotThrow(() => assertUrlAllowed('https://storage.googleapis.com/antigravity-public/hub/v1/app.dmg'));
  assert.doesNotThrow(() => assertUrlAllowed('https://download.todesktop.com/230313mzl4w4u92/latest.yml'));
  assert.doesNotThrow(() => assertUrlAllowed('https://static.devin.ai/cli/current/manifest.json'));
  assert.doesNotThrow(() => assertUrlAllowed('https://downloads.factory.ai/factory-cli/releases/1.4.0/droid'));

  // Disallowed / suspicious hosts
  assert.throws(() => assertUrlAllowed('https://malicious-mirror.com/download/codex.dmg'));
  assert.throws(() => assertUrlAllowed('https://notdp-oroio.com/download'));
  assert.throws(() => assertUrlAllowed('https://api.github.com/repos/unknown-user/repo/releases'));
});

test('allowlist permits official npm packages only', () => {
  assert.doesNotThrow(() => assertNpmPackageAllowed('@openai/codex'));
  assert.doesNotThrow(() => assertNpmPackageAllowed('@anthropic-ai/claude-code'));
  assert.throws(() => assertNpmPackageAllowed('fake-malicious-package'));
});
