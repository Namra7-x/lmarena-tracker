/**
 * Devin Source Adapter
 * Discovers Devin Desktop (ex-Windsurf) and Devin CLI
 */

import { assertUrlAllowed } from '../registry/allowlist.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function formatFromDownloadUrl(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.dmg')) return { format: 'dmg', type: 'dmg' };
  if (pathname.endsWith('.exe')) return { format: 'exe', type: 'exe' };
  if (pathname.endsWith('.zip')) return { format: 'zip', type: 'zip' };
  if (pathname.endsWith('.tar.gz') || pathname.endsWith('.tgz')) return { format: 'tgz', type: 'tarball' };
  return { format: 'binary', type: 'binary' };
}

function compareVersions(a, b) {
  const pa = String(a).match(/\d+/g)?.map(Number) || [];
  const pb = String(b).match(/\d+/g)?.map(Number) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return String(a).localeCompare(String(b));
}

export async function fetchDevinDesktop() {
  const builds = [
    { code: 'darwin-arm64-dmg', target: 'darwin-arm64' },
    { code: 'darwin-x64-dmg', target: 'darwin-x64' },
    { code: 'win32-x64', target: 'win32-x64' },
    { code: 'win32-arm64', target: 'win32-arm64' },
    { code: 'linux-x64', target: 'linux-x64' },
  ];

  const results = await Promise.allSettled(builds.map(async (build) => {
    const apiUrl = `https://windsurf.com/api/windsurf/download-redirect?build=${build.code}&isNext=false`;
    assertUrlAllowed(apiUrl);

    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (res.status < 300 || res.status >= 400) {
      throw new Error(`${build.code} download redirect returned HTTP ${res.status}`);
    }

    const location = res.headers.get('location');
    if (!location) throw new Error(`${build.code} download redirect had no Location header`);
    const url = new URL(location, 'https://windsurf.com').toString();
    assertUrlAllowed(url);

    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const versionMatch = filename.match(/(\d+\.\d+\.\d+)/);
    if (!versionMatch) throw new Error(`${build.code} download URL has no version: ${filename}`);
    const commitMatch = new URL(url).pathname.match(/\/stable\/([0-9a-f]{7,40})\//i);

    return {
      target: build.target,
      url,
      version: versionMatch[1],
      commitHash: commitMatch?.[1] || null,
      ...formatFromDownloadUrl(url),
    };
  }));

  const successful = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);
  if (successful.length === 0) {
    const reasons = results
      .map((result) => (result.status === 'rejected' ? result.reason?.message : null))
      .filter(Boolean)
      .join('; ');
    throw new Error(`Devin Desktop download redirects failed for every platform: ${reasons}`);
  }

  const version = successful
    .map((item) => item.version)
    .sort(compareVersions)
    .pop();
  const selected = successful.filter((item) => item.version === version);
  if (selected.length === 0) throw new Error('Devin Desktop resolved no artifacts for the newest version');

  const selectedPlatforms = new Set(selected.map((item) => item.target.split('-')[0]));
  const missingPlatforms = ['darwin', 'win32', 'linux'].filter((platform) => !selectedPlatforms.has(platform));
  if (missingPlatforms.length > 0) {
    throw new Error(`Devin Desktop is missing artifacts for: ${missingPlatforms.join(', ')}`);
  }

  const commitHash = selected.find((item) => item.commitHash)?.commitHash || null;
  const artifacts = selected.map(({ version: _version, commitHash: _commitHash, ...artifact }) => artifact);

  return {
    componentId: 'devin-desktop',
    family: 'devin',
    version: String(version || '').trim(),
    stableVersion: String(version || '').trim(),
    versionScheme: 'semver',
    releaseId: `devin-desktop@${version}${commitHash ? `-${commitHash}` : ''}`,
    channel: 'stable',
    artifacts,
    metadata: {
      commitHash,
      source: 'windsurf.com/api/windsurf/download-redirect',
      platformVersionSkew: successful.length > selected.length
        ? Array.from(new Set(successful.map((item) => item.version)))
        : undefined,
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

  if (artifacts.length === 0) {
    throw new Error('Devin CLI manifest contained no downloadable platform artifacts');
  }

  return {
    componentId: 'devin-cli',
    family: 'devin',
    version: String(version || '').trim(),
    stableVersion: String(version || '').trim(),
    versionScheme: 'semver',
    releaseId: `devin-cli@${version}`,
    channel: 'stable',
    artifacts,
    metadata: {
      source: 'static.devin.ai/cli/current/manifest.json',
    },
  };
}
