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
  let resolvedVersion = null;

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

      const etag = headRes.headers.get('etag')?.replace(/"/g, '') || null;
      const contentLength = headRes.headers.get('content-length') || null;

      if (!primaryEtag && etag) primaryEtag = etag;

      artifacts.push({
        target: r.target,
        url: location,
        checksum: etag ? `etag:${etag}` : null,
        format: r.format,
        type: r.format,
        contentLength,
      });
    } catch (err) {
      // Diagnostics recorded
    }
  }

  const normalizedVersion = primaryEtag ? `build-${primaryEtag.slice(0, 16)}` : 'latest';

  return {
    componentId: 'gemini-desktop',
    family: 'google',
    version: normalizedVersion,
    releaseId: `gemini-desktop-${normalizedVersion}`,
    channel: 'stable',
    artifacts,
    metadata: {
      etag: primaryEtag,
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
    version,
    releaseId: `antigravity-desktop@${version}-${execution_id}`,
    channel: 'stable',
    artifacts,
    metadata: {
      executionId: execution_id,
    },
  };
}

export async function fetchAntigravityCli() {
  const base = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
  const platforms = [
    { target: 'darwin-arm64', key: 'darwin_arm64', format: 'tgz' },
    { target: 'darwin-x64', key: 'darwin_amd64', format: 'tgz' },
    { target: 'win32-x64', key: 'windows_amd64', format: 'exe' },
    { target: 'win32-arm64', key: 'windows_arm64', format: 'exe' },
    { target: 'linux-x64', key: 'linux_amd64', format: 'tgz' },
  ];

  let resolvedVersion = null;
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
        if (!resolvedVersion && manifest.version) resolvedVersion = manifest.version;

        artifacts.push({
          target: p.target,
          url: manifest.url,
          checksum: manifest.sha512 ? `sha512:${manifest.sha512}` : null,
          format: p.format,
          type: p.format === 'exe' ? 'binary' : 'tarball',
        });
      }
    } catch (err) {
      // Diagnostics
    }
  }

  if (!resolvedVersion) throw new Error('Failed to resolve Antigravity CLI version from manifests');

  return {
    componentId: 'antigravity-cli',
    family: 'google',
    version: resolvedVersion,
    releaseId: `antigravity-cli@${resolvedVersion}`,
    channel: 'stable',
    artifacts,
    metadata: {},
  };
}
