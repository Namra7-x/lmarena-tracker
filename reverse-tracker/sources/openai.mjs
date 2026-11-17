/**
 * OpenAI Source Adapter
 * Discovers Codex CLI and Codex Desktop (ChatGPT Desktop)
 */

import { assertUrlAllowed } from '../registry/allowlist.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchCodexCli() {
  const url = 'https://registry.npmjs.org/@openai/codex';
  assertUrlAllowed(url);

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Codex CLI npm registry returned HTTP ${res.status}`);
  const data = await res.json();
  const latest = data['dist-tags']?.latest;
  if (!latest) throw new Error('No latest dist-tag found for @openai/codex');

  const verData = data.versions?.[latest];
  const tarball = verData?.dist?.tarball;
  const integrity = verData?.dist?.integrity || verData?.dist?.shasum;
  if (!tarball) throw new Error(`No tarball found for @openai/codex@${latest}`);

  assertUrlAllowed(tarball);

  return {
    componentId: 'codex-cli',
    family: 'openai',
    version: latest,
    releaseId: `@openai/codex@${latest}`,
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

function parseBuildStamp(lastModified) {
  if (!lastModified) return null;
  const date = new Date(lastModified);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

export async function fetchCodexDesktop() {
  const dmgUrl = 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg';
  assertUrlAllowed(dmgUrl);

  const res = await fetch(dmgUrl, {
    method: 'HEAD',
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok && res.status !== 302) {
    throw new Error(`Codex Desktop HEAD returned HTTP ${res.status}`);
  }

  const etag = res.headers.get('etag')?.replace(/"/g, '') || null;
  const lastModified = res.headers.get('last-modified') || null;
  const contentLength = res.headers.get('content-length') || null;
  const stamp = parseBuildStamp(lastModified);

  // Last-Modified is the stable release identity. ETag alternates between
  // CDN replicas on this endpoint and must never be used as a version.
  const normalizedVersion = stamp
    ? `build-${stamp}`
    : (contentLength ? `build-size-${contentLength}` : 'build-unknown');

  return {
    componentId: 'codex-desktop',
    family: 'openai',
    version: normalizedVersion,
    stableVersion: normalizedVersion,
    versionScheme: 'build',
    releaseId: `codex-desktop-${normalizedVersion}`,
    channel: 'prod',
    artifacts: [
      {
        target: 'darwin-universal',
        url: dmgUrl,
        checksum: lastModified && contentLength ? `build:${lastModified}:${contentLength}` : null,
        format: 'dmg',
        type: 'dmg',
        contentLength,
      },
    ],
    metadata: {
      lastModified,
      etag,
      contentLength,
    },
  };
}
