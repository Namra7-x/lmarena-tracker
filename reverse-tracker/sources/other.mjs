/**
 * Other Source Adapter
 * Discovers OpenCode CLI (v2 channel) and Droid CLI (Factory)
 */

import { assertUrlAllowed } from '../registry/allowlist.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchOpenCodeCli() {
  const url = 'https://registry.npmjs.org/@opencode/cli';
  assertUrlAllowed(url);

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`OpenCode CLI npm registry returned HTTP ${res.status}`);
  const data = await res.json();
  const latest = data['dist-tags']?.latest;
  if (!latest) throw new Error('No latest dist-tag found for @opencode/cli');

  const verData = data.versions?.[latest];
  const tarball = verData?.dist?.tarball;
  const integrity = verData?.dist?.integrity || verData?.dist?.shasum;

  if (tarball) assertUrlAllowed(tarball);

  return {
    componentId: 'opencode-cli',
    family: 'other',
    version: latest,
    releaseId: `@opencode/cli@${latest}`,
    channel: 'v2',
    artifacts: [
      {
        target: 'all',
        url: tarball,
        checksum: integrity,
        format: 'tgz',
        type: 'tarball',
      },
    ],
    metadata: {
      npmPublished: data.time?.[latest],
    },
  };
}

export async function fetchDroidCli() {
  // Query npm droid for current latest version
  const npmUrl = 'https://registry.npmjs.org/droid';
  assertUrlAllowed(npmUrl);

  const res = await fetch(npmUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Droid CLI npm registry returned HTTP ${res.status}`);
  const data = await res.json();
  const version = data['dist-tags']?.latest;
  if (!version) throw new Error('No latest dist-tag found for droid');

  const base = 'https://downloads.factory.ai/factory-cli/releases';
  const artifacts = [
    {
      target: 'darwin-arm64',
      url: `${base}/${version}/darwin/arm64/droid`,
      format: 'binary',
      type: 'binary',
      checksumUrl: `${base}/${version}/darwin/arm64/droid.sha256`,
    },
    {
      target: 'darwin-x64',
      url: `${base}/${version}/darwin/x64/droid`,
      format: 'binary',
      type: 'binary',
      checksumUrl: `${base}/${version}/darwin/x64/droid.sha256`,
    },
    {
      target: 'win32-x64',
      url: `${base}/${version}/windows/x64/droid.exe`,
      format: 'exe',
      type: 'binary',
      checksumUrl: `${base}/${version}/windows/x64/droid.exe.sha256`,
    },
    {
      target: 'linux-x64',
      url: `${base}/${version}/linux/x64/droid`,
      format: 'binary',
      type: 'binary',
      checksumUrl: `${base}/${version}/linux/x64/droid.sha256`,
    },
  ];

  for (const a of artifacts) {
    assertUrlAllowed(a.url);
    if (a.checksumUrl) assertUrlAllowed(a.checksumUrl);
  }

  return {
    componentId: 'droid-cli',
    family: 'other',
    version,
    releaseId: `droid@${version}`,
    channel: 'stable',
    artifacts,
    metadata: {
      npmPublished: data.time?.[version],
    },
  };
}
