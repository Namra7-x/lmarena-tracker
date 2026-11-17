/**
 * Google Source Adapter
 * Discovers Gemini Desktop, Antigravity Desktop, and Antigravity CLI
 */

import { assertUrlAllowed } from '../registry/allowlist.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchGeminiDesktop() {
  const routes = [
    { target: 'darwin-arm64', url: 'https://gemini.google/download/mac/', format: 'dmg' },
    { target: 'win32-x64', url: 'https://gemini.google/download/windows/', format: 'exe' },
  ];

  const artifacts = [];
  let primaryEtag = null;
  let primaryModified = null;
  let latestModified = null;
  let latestModifiedMs = 0;

  for (const r of routes) {
    assertUrlAllowed(r.url);
    try {
      const res = await fetch(r.url, {
        headers: { 'User-Agent': UA },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });

      const location = res.headers.get('location') || r.url;
      assertUrlAllowed(location);

      // Check the final target URL with HEAD
      const headRes = await fetch(location, {
        method: 'HEAD',
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      });
      if (!headRes.ok) continue;

      const etag = headRes.headers.get('etag')?.replace(/"/g, '') || null;
      const lastModified = headRes.headers.get('last-modified') || null;
      const contentLength = headRes.headers.get('content-length') || null;
      const modifiedMs = lastModified ? new Date(lastModified).getTime() : 0;

      if (!primaryEtag && etag) primaryEtag = etag;
      if (!primaryModified && lastModified) primaryModified = lastModified;
      if (Number.isFinite(modifiedMs) && modifiedMs > latestModifiedMs) {
        latestModifiedMs = modifiedMs;
        latestModified = lastModified;
      }

      artifacts.push({
        target: r.target,
        url: location,
        checksum: lastModified && contentLength ? `build:${lastModified}:${contentLength}` : null,
        format: r.format,
        type: r.format,
        contentLength,
      });
    } catch (err) {
      // Diagnostics recorded
    }
  }

  if (artifacts.length === 0) {
    throw new Error('Gemini Desktop HEAD requests returned no downloadable artifacts');
  }

  // Primary-platform stamp = one release identity even if Windows publishes a
  // few hours later.
  const identityModified = primaryModified || latestModified;
  const modifiedDate = identityModified ? new Date(identityModified) : null;
  const stamp = modifiedDate && !Number.isNaN(modifiedDate.getTime())
    ? modifiedDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-').replace('Z', '')
    : null;
  const normalizedVersion = stamp ? `build-${stamp}` : (primaryEtag ? `build-etag-${primaryEtag.slice(0, 16)}` : 'build-latest');

  return {
    componentId: 'gemini-desktop',
    family: 'google',
    version: normalizedVersion,
    stableVersion: normalizedVersion,
    versionScheme: 'build',
    releaseId: `gemini-desktop-${normalizedVersion}`,
    channel: 'stable',
    artifacts,
    metadata: {
      etag: primaryEtag,
      lastModified: latestModified,
    },
  };
}

export async function fetchAntigravityDesktop() {
  const apiUrl = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/releases';
  assertUrlAllowed(apiUrl);

  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Antigravity Desktop updater API returned HTTP ${res.status}`);
  const releases = await res.json();
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error('Antigravity Desktop releases list is empty');
  }

  const latest = releases[0];
  const { version, execution_id } = latest;
  if (!version) throw new Error('Antigravity Desktop release has no version');
  if (!execution_id) throw new Error('Antigravity Desktop release has no execution id');
  const base = `https://storage.googleapis.com/antigravity-public/antigravity-hub/${version}-${execution_id}`;

  const artifacts = [
    {
      target: 'darwin-arm64',
      url: `${base}/darwin-arm/Antigravity.dmg`,
      format: 'dmg',
      type: 'dmg',
    },
    {
      target: 'darwin-x64',
      url: `${base}/darwin-x64/Antigravity.dmg`,
      format: 'dmg',
      type: 'dmg',
    },
    {
      target: 'win32-x64',
      url: `${base}/windows-x64/Antigravity-x64.exe`,
      format: 'exe',
      type: 'exe',
    },
    {
      target: 'win32-arm64',
      url: `${base}/windows-arm/Antigravity-arm64.exe`,
      format: 'exe',
      type: 'exe',
    },
    {
      target: 'linux-x64',
      url: `${base}/linux-x64/Antigravity.tar.gz`,
      format: 'tgz',
      type: 'tarball',
    },
  ];

  for (const a of artifacts) {
    assertUrlAllowed(a.url);
  }

  return {
    componentId: 'antigravity-desktop',
    family: 'google',
    version: String(version || '').trim(),
    stableVersion: String(version || '').trim(),
    versionScheme: 'semver',
    releaseId: `antigravity-desktop@${version}-${execution_id}`,
    channel: 'stable',
    artifacts,
    metadata: {
      executionId: execution_id,
      source: 'antigravity-hub-auto-updater',
    },
  };
}

export async function fetchAntigravityCli() {
  const base = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
  const platforms = [
    { target: 'darwin-arm64', key: 'darwin_arm64', format: 'tgz' },
    { target: 'win32-x64', key: 'windows_amd64', format: 'exe' },
  ];

  const seenVersions = new Set();
  const artifacts = [];

  for (const p of platforms) {
    const manifestUrl = `${base}/${p.key}.json`;
    assertUrlAllowed(manifestUrl);

    try {
      const res = await fetch(manifestUrl, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const manifest = await res.json();
        if (manifest.url) assertUrlAllowed(manifest.url);
        if (manifest.version) seenVersions.add(String(manifest.version).trim());

        if (manifest.url) {
          artifacts.push({
            target: p.target,
            url: manifest.url,
            checksum: manifest.sha512 ? `sha512:${manifest.sha512}` : null,
            // The Windows CLI is a standalone PE binary, not an NSIS
            // installer. Scanning it as raw binary avoids a false PARTIAL when
            // 7-Zip is unavailable.
            format: p.format === 'exe' ? 'binary' : p.format,
            type: p.format === 'exe' ? 'binary' : 'tarball',
            manifestVersion: manifest.version ? String(manifest.version).trim() : null,
          });
        }
      }
    } catch (err) {
      // Diagnostics
    }
  }

  if (seenVersions.size === 0) throw new Error('Failed to resolve Antigravity CLI version from manifests');

  // One stale platform manifest must not make the release identity flap. Pick
  // the numerically newest version; later platform catch-up is same-version
  // artifact drift and stays silent.
  const resolvedVersion = Array.from(seenVersions).sort((a, b) => {
    const pa = String(a).match(/\d+/g)?.map(Number) || [];
    const pb = String(b).match(/\d+/g)?.map(Number) || [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return String(a).localeCompare(String(b));
  }).at(-1);

  // Do not scan a stale platform artifact as if it were the newest release.
  // Platform catch-up is same-version artifact drift and stays silent.
  const selectedArtifacts = artifacts
    .filter((artifact) => artifact.manifestVersion === resolvedVersion)
    .map(({ manifestVersion: _manifestVersion, ...artifact }) => artifact);
  if (selectedArtifacts.length === 0) {
    throw new Error(`Antigravity CLI ${resolvedVersion} has no downloadable manifest artifacts`);
  }

  return {
    componentId: 'antigravity-cli',
    family: 'google',
    version: resolvedVersion,
    stableVersion: resolvedVersion,
    versionScheme: 'semver',
    releaseId: `antigravity-cli@${resolvedVersion}`,
    channel: 'stable',
    artifacts: selectedArtifacts,
    metadata: {
      source: 'antigravity-cli-auto-updater/manifests',
      versionSkew: seenVersions.size > 1 ? Array.from(seenVersions) : undefined,
    },
  };
}
