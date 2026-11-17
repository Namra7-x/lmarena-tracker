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
  const targets = [
    { target: 'darwin-arm64', url: 'https://downloads.claude.ai/claude-science/latest/mac-arm64.dmg', format: 'dmg' },
    { target: 'darwin-x64', url: 'https://downloads.claude.ai/claude-science/latest/mac-x64.dmg', format: 'dmg' },
    { target: 'win32-x64', url: 'https://downloads.claude.ai/claude-science/latest/windows-x64.exe', format: 'exe' },
  ];

  const artifacts = [];
  let primaryEtag = null;
  let primaryModified = null;
  let latestModifiedMs = 0;

  for (const t of targets) {
    assertUrlAllowed(t.url);
    try {
      const res = await fetch(t.url, {
        method: 'HEAD',
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok || res.status === 302) {
        const etag = res.headers.get('etag')?.replace(/"/g, '') || null;
        const lastModified = res.headers.get('last-modified') || null;
        const contentLength = res.headers.get('content-length') || null;
        const modifiedMs = lastModified ? new Date(lastModified).getTime() : 0;

        if (!primaryEtag && etag) primaryEtag = etag;
        if (!primaryModified && lastModified) primaryModified = lastModified;
        if (Number.isFinite(modifiedMs) && modifiedMs > latestModifiedMs) latestModifiedMs = modifiedMs;

        artifacts.push({
          target: t.target,
          url: t.url,
          checksum: lastModified && contentLength ? `build:${lastModified}:${contentLength}` : null,
          format: t.format,
          type: t.format,
          contentLength,
        });
      }
    } catch (err) {
      // Record diagnostics for skipped target
    }
  }

  if (artifacts.length === 0) {
    throw new Error('Claude Desktop HEAD requests returned no downloadable artifacts');
  }

  // Use the primary platform's build stamp for the release identity. Taking
  // the max across platforms makes a staggered rollout look like two releases
  // (and sends a second alert when the last platform finishes publishing).
  const latestModified = primaryModified || (latestModifiedMs > 0 ? new Date(latestModifiedMs).toISOString() : null);
  const modifiedDate = latestModified ? new Date(latestModified) : null;
  const stamp = modifiedDate && !Number.isNaN(modifiedDate.getTime())
    ? modifiedDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-').replace('Z', '')
    : null;
  const normalizedVersion = stamp ? `build-${stamp}` : (primaryEtag ? `build-etag-${primaryEtag.slice(0, 16)}` : 'build-latest');

  return {
    componentId: 'claude-desktop',
    family: 'anthropic',
    version: normalizedVersion,
    stableVersion: normalizedVersion,
    versionScheme: 'build',
    releaseId: `claude-desktop-${normalizedVersion}`,
    channel: 'stable',
    artifacts,
    metadata: {
      lastModified: latestModified,
      etag: primaryEtag,
    },
  };
}
