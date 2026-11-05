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

  if (tarball) assertUrlAllowed(tarball);

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

  // Derive version/identifier from etag or last modified
  const normalizedVersion = etag ? `etag-${etag.slice(0, 16)}` : `build-${lastModified || 'unknown'}`;

  return {
    componentId: 'codex-desktop',
    family: 'openai',
    version: normalizedVersion,
    releaseId: `codex-desktop-${normalizedVersion}`,
    channel: 'prod',
    artifacts: [
      {
        target: 'darwin-universal',
        url: dmgUrl,
        checksum: etag ? `etag:${etag}` : null,
        format: 'dmg',
        type: 'dmg',
        contentLength,
      },
    ],
    metadata: {
      lastModified,
      etag,
    },
  };
}
