/**
 * Devin Source Adapter
 * Discovers Devin Desktop (ex-Windsurf) and Devin CLI
 */

import { assertUrlAllowed } from '../registry/allowlist.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchDevinDesktop() {
  const brewUrl = 'https://formulae.brew.sh/api/cask/devin-desktop.json';
  assertUrlAllowed(brewUrl);

  const res = await fetch(brewUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Devin Desktop brew cask API returned HTTP ${res.status}`);
  const data = await res.json();

  const rawVersion = data.version; // e.g. "3.11.238,9e593c73d4ca24802eb3b302035f33cedad59802"
  const [version, commitHash] = rawVersion.split(',');

  const artifacts = [
    {
      target: 'darwin-arm64',
      url: `https://windsurf-stable.codeiumdata.com/darwin-arm64-dmg/stable/${commitHash}/Devin-darwin-arm64-${version}.dmg`,
      format: 'dmg',
      type: 'dmg',
    },
    {
      target: 'darwin-x64',
      url: `https://windsurf-stable.codeiumdata.com/darwin-x64-dmg/stable/${commitHash}/Devin-darwin-x64-${version}.dmg`,
      format: 'dmg',
      type: 'dmg',
    },
    {
      target: 'win32-x64',
      url: `https://windsurf-stable.codeiumdata.com/win32-x64-user/stable/${commitHash}/DevinUserSetup-x64-${version}.exe`,
      format: 'exe',
      type: 'exe',
    },
    {
      target: 'win32-arm64',
      url: `https://windsurf-stable.codeiumdata.com/win32-arm64-user/stable/${commitHash}/DevinUserSetup-arm64-${version}.exe`,
      format: 'exe',
      type: 'exe',
    },
  ];

  for (const a of artifacts) {
    assertUrlAllowed(a.url);
  }

  return {
    componentId: 'devin-desktop',
    family: 'devin',
    version,
    releaseId: `devin-desktop@${version}-${commitHash}`,
    channel: 'stable',
    artifacts,
    metadata: {
      commitHash,
    },
  };
}

export async function fetchDevinCli() {
  const manifestUrl = 'https://static.devin.ai/cli/current/manifest.json';
  assertUrlAllowed(manifestUrl);

  const res = await fetch(manifestUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Devin CLI manifest returned HTTP ${res.status}`);
  const data = await res.json();
  const version = data.version;
  if (!version) throw new Error('No version found in Devin CLI manifest');

  const artifacts = [];
  const platforms = data.platforms || {};

  const platformMap = {
    'aarch64-apple-darwin': { target: 'darwin-arm64', format: 'tgz', type: 'tarball' },
    'x86_64-apple-darwin': { target: 'darwin-x64', format: 'tgz', type: 'tarball' },
    'x86_64-pc-windows': { target: 'win32-x64', format: 'zip', type: 'zip' },
    'aarch64-pc-windows': { target: 'win32-arm64', format: 'zip', type: 'zip' },
    'x86_64-unknown-linux': { target: 'linux-x64', format: 'tgz', type: 'tarball' },
  };

  for (const [key, mapping] of Object.entries(platformMap)) {
    const entry = platforms[key];
    if (entry && entry.url) {
      assertUrlAllowed(entry.url);
      artifacts.push({
        target: mapping.target,
        url: entry.url,
        checksum: entry.sha256 ? `sha256:${entry.sha256}` : null,
        format: mapping.format,
        type: mapping.type,
      });
    }
  }

  return {
    componentId: 'devin-cli',
    family: 'devin',
    version,
    releaseId: `devin-cli@${version}`,
    channel: 'stable',
    artifacts,
    metadata: {},
  };
}
