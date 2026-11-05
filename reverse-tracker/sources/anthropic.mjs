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

  if (tarball) assertUrlAllowed(tarball);

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

        if (!primaryEtag && etag) primaryEtag = etag;
        if (!primaryModified && lastModified) primaryModified = lastModified;

        artifacts.push({
          target: t.target,
          url: t.url,
          checksum: etag ? `etag:${etag}` : null,
          format: t.format,
          type: t.format,
          contentLength,
        });
      }
    } catch (err) {
      // Record diagnostics for skipped target
    }
  }

  const normalizedVersion = primaryEtag ? `build-${primaryEtag.slice(0, 16)}` : `build-${primaryModified || 'latest'}`;

  return {
    componentId: 'claude-desktop',
    family: 'anthropic',
    version: normalizedVersion,
    releaseId: `claude-desktop-${normalizedVersion}`,
    channel: 'stable',
    artifacts,
    metadata: {
      lastModified: primaryModified,
      etag: primaryEtag,
    },
  };
}
