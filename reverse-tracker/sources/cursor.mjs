/**
 * Cursor Source Adapter
 * Discovers Cursor Desktop and Cursor CLI (agent)
 *
 * Cursor Desktop previously used the old ToDesktop feed, which stopped being
 * authoritative and reported a February 2025 build. The official download API
 * is now the source of truth. The CLI install scripts serve a browser landing
 * page to a Chrome user-agent, so they must be fetched with a non-browser UA.
 */

import { assertUrlAllowed } from '../registry/allowlist.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SCRIPT_UA = 'curl/8.5.0';

const DESKTOP_PLATFORMS = [
  { api: 'darwin-arm64', target: 'darwin-arm64' },
  { api: 'darwin-x64', target: 'darwin-x64' },
  { api: 'win32-x64', target: 'win32-x64' },
  { api: 'win32-arm64', target: 'win32-arm64' },
  { api: 'linux-x64', target: 'linux-x64' },
];

function formatFromUrl(url) {
  let pathname = String(url || '');
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Fall back to the raw string for non-standard mirrors.
  }
  const lower = pathname.toLowerCase();
  if (lower.endsWith('.dmg')) return 'dmg';
  if (lower.endsWith('.exe')) return 'exe';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.appimage')) return 'appimage';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
  return 'binary';
}

export async function fetchCursorDesktop() {
  const results = await Promise.allSettled(
    DESKTOP_PLATFORMS.map(async (platform) => {
      const endpoint = `https://cursor.com/api/download?platform=${encodeURIComponent(platform.api)}&releaseTrack=stable`;
      assertUrlAllowed(endpoint);
      const res = await fetch(endpoint, {
        headers: { 'User-Agent': SCRIPT_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`${platform.api} API HTTP ${res.status}`);
      const data = await res.json();
      if (!data.version || !data.downloadUrl) {
        throw new Error(`${platform.api} API returned an incomplete payload`);
      }
      assertUrlAllowed(data.downloadUrl);
      const format = formatFromUrl(data.downloadUrl);
      return {
        target: platform.target,
        url: data.downloadUrl,
        checksum: data.commitSha ? `commit:${data.commitSha}` : null,
        format,
        type: format,
        version: data.version,
        commitSha: data.commitSha || null,
      };
    }),
  );

  const successful = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);

  if (successful.length === 0) {
    const reasons = results
      .map((result) => (result.status === 'rejected' ? result.reason?.message : null))
      .filter(Boolean)
      .join('; ');
    throw new Error(`Cursor official download API failed for every platform: ${reasons}`);
  }

  // Replica skew is common right after a rollout. Pick the version reported by
  // the most platforms (numeric max breaks ties) so one stale replica cannot
  // make the release identity flap backwards.
  const versionCounts = new Map();
  for (const item of successful) {
    versionCounts.set(item.version, (versionCounts.get(item.version) || 0) + 1);
  }
  const compareDotted = (a, b) => {
    const pa = String(a).match(/\d+/g)?.map(Number) || [];
    const pb = String(b).match(/\d+/g)?.map(Number) || [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return String(a).localeCompare(String(b));
  };
  const versions = Array.from(versionCounts.keys()).sort((a, b) => {
    const countDiff = versionCounts.get(b) - versionCounts.get(a);
    return countDiff !== 0 ? countDiff : compareDotted(b, a);
  });
  const version = versions[0];
  const commitSha = successful.find((item) => item.version === version && item.commitSha)?.commitSha || null;

  // Keep only artifacts that actually belong to the selected release. A slow
  // replica can still be serving the previous build, and scanning its binary
  // as if it were the new release corrupts platform comparison and leak data.
  const artifacts = successful
    .filter((item) => item.version === version)
    .map(({ version: _version, commitSha: _commitSha, ...artifact }) => artifact);

  return {
    componentId: 'cursor-desktop',
    family: 'cursor',
    version,
    stableVersion: version,
    versionScheme: 'semver',
    releaseId: `cursor-desktop@${version}${commitSha ? `-${commitSha.slice(0, 12)}` : ''}`,
    channel: 'stable',
    artifacts,
    metadata: {
      commitSha,
      source: 'cursor.com/api/download',
      platforms: artifacts.map((item) => item.target),
      versionSkew: versions.length > 1 ? versions : undefined,
    },
  };
}

export async function fetchCursorCli() {
  const shUrl = 'https://cursor.com/install';
  const psUrl = 'https://cursor.com/install?win32=true';
  assertUrlAllowed(shUrl);
  assertUrlAllowed(psUrl);

  const [shRes, psRes] = await Promise.all([
    fetch(shUrl, { headers: { 'User-Agent': SCRIPT_UA }, signal: AbortSignal.timeout(15000) }),
    fetch(psUrl, { headers: { 'User-Agent': SCRIPT_UA }, signal: AbortSignal.timeout(15000) }),
  ]);

  if (!shRes.ok && !psRes.ok) {
    throw new Error('Failed to fetch Cursor CLI install scripts');
  }

  const shText = shRes.ok ? await shRes.text() : '';
  const psText = psRes.ok ? await psRes.text() : '';

  let version = null;
  const candidates = [];
  const psMatch = psText.match(/\$version\s*=\s*['"]([^'"]+)['"]/);
  if (psMatch) candidates.push(psMatch[1]);
  const shMatch = shText.match(/downloads\.cursor\.com\/lab\/([^/]+)\//);
  if (shMatch) candidates.push(shMatch[1]);
  if (candidates.length > 0) {
    // The two install scripts can be deployed a few seconds apart. Use the
    // numerically newer label, not whichever response was parsed first.
    candidates.sort((a, b) => {
      const pa = String(a).match(/\d+/g)?.map(Number) || [];
      const pb = String(b).match(/\d+/g)?.map(Number) || [];
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
      }
      return String(a).localeCompare(String(b));
    });
    version = candidates[candidates.length - 1];
  }

  // Resolve the `latest` redirect if the install-script format changes.
  if (!version) {
    try {
      const probeUrl = 'https://downloads.cursor.com/lab/latest/darwin/arm64/agent-cli-package.tar.gz';
      assertUrlAllowed(probeUrl);
      const res = await fetch(probeUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': UA },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const location = res.headers.get('location') || '';
      const match = location.match(/\/lab\/([^/]+)\//);
      if (match) version = match[1];
    } catch {
      // The caller will fail the component cleanly below.
    }
  }

  if (!version || version === 'latest') {
    throw new Error('Cursor CLI version could not be resolved from the official install script');
  }

  const base = `https://downloads.cursor.com/lab/${encodeURIComponent(version)}`;
  const artifacts = [
    { target: 'darwin-arm64', path: 'darwin/arm64/agent-cli-package.tar.gz', format: 'tgz', type: 'tarball' },
    { target: 'darwin-x64', path: 'darwin/x64/agent-cli-package.tar.gz', format: 'tgz', type: 'tarball' },
    { target: 'linux-x64', path: 'linux/x64/agent-cli-package.tar.gz', format: 'tgz', type: 'tarball' },
    // Native Windows uses a ZIP package, not the Unix tarball. The path and
    // extension are fixed in Cursor's official PowerShell installer.
    { target: 'win32-x64', path: 'windows/x64/agent-cli-package.zip', format: 'zip', type: 'zip' },
  ].map((artifact) => {
    const url = `${base}/${artifact.path}`;
    assertUrlAllowed(url);
    return {
      target: artifact.target,
      url,
      format: artifact.format,
      type: artifact.type,
    };
  });

  return {
    componentId: 'cursor-cli',
    family: 'cursor',
    version,
    stableVersion: version,
    versionScheme: 'build',
    releaseId: `cursor-cli@${version}`,
    channel: 'stable',
    artifacts,
    metadata: {
      source: 'cursor.com/install',
    },
  };
}
