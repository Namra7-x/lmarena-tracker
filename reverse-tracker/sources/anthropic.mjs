/**
 * Anthropic Source Adapter
 * Discovers Claude Code and Claude Desktop
 */

import { assertUrlAllowed } from '../registry/allowlist.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchClaudeCode() {
  const url = 'https://registry.npmjs.org/@anthropic-ai/claude-code';
  assertUrlAllowed(url);

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Claude Code npm registry returned HTTP ${res.status}`);
  const data = await res.json();
  const latest = data['dist-tags']?.latest;
  if (!latest) throw new Error('No latest dist-tag found for @anthropic-ai/claude-code');

  const verData = data.versions?.[latest];
  const tarball = verData?.dist?.tarball;
  const integrity = verData?.dist?.integrity || verData?.dist?.shasum;
  if (!tarball) throw new Error(`No tarball found for @anthropic-ai/claude-code@${latest}`);

  assertUrlAllowed(tarball);

  return {
    componentId: 'claude-code',
    family: 'anthropic',
    version: latest,
    releaseId: `@anthropic-ai/claude-code@${latest}`,
    channel: 'stable',
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

export async function fetchClaudeDesktop() {
  const manifestUrl = 'https://downloads.claude.ai/releases/darwin/universal/RELEASES.json';
  assertUrlAllowed(manifestUrl);

  const res = await fetch(manifestUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Claude Desktop RELEASES.json returned HTTP ${res.status}`);
  const data = await res.json();
  const currentRelease = data.currentRelease || data.releases?.[0]?.version;
  if (!currentRelease) throw new Error('No currentRelease found in Claude Desktop RELEASES.json');

  const releaseInfo = data.releases?.[0]?.updateTo;
  const downloadUrl = releaseInfo?.url;
  if (!downloadUrl) throw new Error('No download URL found in Claude Desktop RELEASES.json');
  assertUrlAllowed(downloadUrl);

  return {
    componentId: 'claude-desktop',
    family: 'anthropic',
    version: currentRelease,
    stableVersion: currentRelease,
    versionScheme: 'semver',
    releaseId: `claude-desktop@${currentRelease}`,
    channel: 'stable',
    artifacts: [
      {
        target: 'darwin-arm64',
        url: downloadUrl,
        format: 'zip',
        type: 'zip',
      },
    ],
    metadata: {
      publishedAt: releaseInfo?.pub_date || null,
      name: releaseInfo?.name || null,
    },
  };
}
