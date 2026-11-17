import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeStringSet,
  decodeStringSet,
  diffStringSets,
  computeReleaseKey,
} from '../reverse-tracker/state/baseline.mjs';
import {
  classifyChange,
  CHANGE_TYPE,
  parseBuildStamp,
  compareBuildVersions,
} from '../reverse-tracker/fingerprint/classifier.mjs';
import { computeIdentityFingerprint } from '../reverse-tracker/fingerprint/identity.mjs';

function candidate(version, extra = {}) {
  return {
    componentId: 'codex-cli',
    family: 'openai',
    version,
    releaseId: `@openai/codex@${version}`,
    channel: 'stable',
    artifacts: [
      {
        target: 'all',
        url: `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`,
        checksum: `sha512-${version}`,
      },
    ],
    metadata: { npmPublished: '2026-11-16T00:00:00.000Z' },
    ...extra,
  };
}

function baselineFor(value) {
  return {
    componentId: value.componentId,
    version: value.version,
    releaseId: value.releaseId,
    channel: value.channel,
    identityFingerprint: computeIdentityFingerprint(value),
    diagnosticFingerprint: null,
  };
}

test('compressed string baseline round-trips and computes exact set transitions', () => {
  const values = ['gpt-5-preview', 'enable_agentic_flow', 'https://api.example.com/v1'];
  const encoded = encodeStringSet(values);
  assert.deepEqual(decodeStringSet(encoded).sort(), [...values].sort());

  const diff = diffStringSets(
    ['old-model', 'persistent-model'],
    ['persistent-model', 'new-model', 'returned-model'],
    ['old-model', 'persistent-model', 'returned-model'],
  );
  assert.deepEqual(diff.added, ['new-model']);
  assert.deepEqual(diff.removed, ['old-model']);
  assert.deepEqual(diff.persistent, ['persistent-model']);
  assert.deepEqual(diff.reintroduced, ['returned-model']);
  assert.equal(diff.counts.current, 3);
});

test('release key ignores volatile metadata but identity changes with artifacts', () => {
  const a = candidate('1.0.0');
  const b = candidate('1.0.0', { metadata: { etag: 'replica-2', contentLength: 999 } });
  const c = candidate('1.0.0', {
    artifacts: [{ ...a.artifacts[0], url: 'https://registry.npmjs.org/other.tgz' }],
  });

  assert.equal(computeReleaseKey('codex-cli', a), computeReleaseKey('codex-cli', b));
  assert.notEqual(computeIdentityFingerprint(a), computeIdentityFingerprint(c));
});

test('classifier accepts newer versions but rejects rollbacks and same-version flaps', () => {
  const old = candidate('2.1.319');
  const baseline = baselineFor(old);

  assert.equal(
    classifyChange(baseline, candidate('2.1.320')).changeType,
    CHANGE_TYPE.VERSION_CHANGE,
  );
  assert.equal(
    classifyChange(baseline, candidate('2.1.318')).changeType,
    CHANGE_TYPE.DIAGNOSTIC_DRIFT,
  );

  const sameVersionNewArtifact = candidate('2.1.319', {
    artifacts: [{ ...old.artifacts[0], checksum: 'sha512-replica' }],
  });
  assert.equal(
    classifyChange(baseline, sameVersionNewArtifact).changeType,
    CHANGE_TYPE.BYTE_CHANGE,
  );

  const etagOnly = candidate('2.1.319', {
    metadata: { etag: 'changed-etag', contentLength: 123 },
  });
  assert.equal(
    classifyChange(baseline, etagOnly).changeType,
    CHANGE_TYPE.NO_CHANGE,
  );
});

test('build stamps are monotonic and drive desktop rollback suppression', () => {
  assert.equal(parseBuildStamp('build-20261113-194811') > parseBuildStamp('build-20261112-000000'), true);
  assert.equal(
    compareBuildVersions('build-20261113-194811', 'build-20261112-000000'),
    1,
  );

  const newer = {
    componentId: 'gemini-desktop',
    family: 'google',
    version: 'build-20261113-194811',
    releaseId: 'gemini-desktop-build-20261113-194811',
    channel: 'stable',
    artifacts: [{ target: 'darwin-arm64', url: 'https://example.com/gemini.dmg' }],
  };
  const baseline = baselineFor(newer);
  const rollback = {
    ...newer,
    version: 'build-20261112-000000',
    releaseId: 'gemini-desktop-build-20261112-000000',
    artifacts: [{ target: 'darwin-arm64', url: 'https://example.com/gemini-old.dmg' }],
  };
  assert.equal(
    classifyChange(baseline, rollback).changeType,
    CHANGE_TYPE.DIAGNOSTIC_DRIFT,
  );

  const forward = {
    ...newer,
    version: 'build-20261114-000000',
    releaseId: 'gemini-desktop-build-20261114-000000',
    artifacts: [{ target: 'darwin-arm64', url: 'https://example.com/gemini-new.dmg' }],
  };
  assert.equal(
    classifyChange(baseline, forward).changeType,
    CHANGE_TYPE.VERSION_CHANGE,
  );
});
