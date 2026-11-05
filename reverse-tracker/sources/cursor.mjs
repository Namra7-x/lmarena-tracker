/**
 * Cursor Source Adapter
 * Discovers Cursor Desktop and Cursor CLI (agent)
 */

import { assertUrlAllowed } from '../registry/allowlist.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchCursorDesktop() {
  const base = 'https://download.todesktop.com/230313mzl4w4u92';
  assertUrlAllowed(`${base}/latest-mac.yml`);
  assertUrlAllowed(`${base}/latest.yml`);

  const [macRes, winRes] = await Promise.all([
    fetch(`${base}/latest-mac.yml`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }),
    fetch(`${base}/latest.yml`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }),
  ]);

  if (!macRes.ok && !winRes.ok) {
    throw new Error(`Failed to fetch Cursor ToDesktop feeds: Mac ${macRes.status}, Win ${winRes.status}`);
  }

  const macYml = macRes.ok ? await macRes.text() : '';
  const winYml = winRes.ok ? await winRes.text() : '';

  // Parse version from yml
  const vMatch = macYml.match(/version:\s*([^\r\n]+)/) || winYml.match(/version:\s*([^\r\n]+)/);
  const version = vMatch ? vMatch[1].trim() : 'latest';

  const artifacts = [];

  // Parse files from mac yml
  const macFiles = parseToDesktopYml(macYml, base, 'darwin');
  artifacts.push(...macFiles);

  // Parse files from win yml
  const winFiles = parseToDesktopYml(winYml, base, 'win32');
  artifacts.push(...winFiles);

  return {
    componentId: 'cursor-desktop',
    family: 'cursor',
    version,
    releaseId: `cursor-desktop@${version}`,
    channel: 'stable',
    artifacts,
    metadata: {
      macArtifactCount: macFiles.length,
      winArtifactCount: winFiles.length,
    },
  };
}

function parseToDesktopYml(ymlText, baseUrl, osPrefix) {
  const artifacts = [];
  const lines = ymlText.split('\n');
  let currentFile = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- url:') || trimmed.startsWith('url:')) {
      const rawUrl = trimmed.split(/:\s*/)[1].trim();
      const filename = rawUrl.replace(/^['"]|['"]$/g, '');
      const fullUrl = `${baseUrl}/${encodeURIComponent(filename)}`;
      assertUrlAllowed(fullUrl);

      const isArm = filename.toLowerCase().includes('arm64') || filename.toLowerCase().includes('aarch64');
      const target = isArm ? `${osPrefix}-arm64` : `${osPrefix}-x64`;
      const format = filename.endsWith('.exe') ? 'exe' : filename.endsWith('.dmg') ? 'dmg' : 'zip';

      currentFile = {
        target,
        url: fullUrl,
        format,
        type: format,
        checksum: null,
      };
      artifacts.push(currentFile);
    } else if (currentFile && (trimmed.startsWith('sha512:') || trimmed.startsWith('sha256:'))) {
      const [algo, hash] = trimmed.split(/:\s*/);
      currentFile.checksum = `${algo}:${hash.trim()}`;
    }
  }

  return artifacts;
}

export async function fetchCursorCli() {
  const shUrl = 'https://cursor.com/install';
  const psUrl = 'https://cursor.com/install?win32=true';
  assertUrlAllowed(shUrl);
  assertUrlAllowed(psUrl);

  const [shRes, psRes] = await Promise.all([
    fetch(shUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }),
    fetch(psUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }),
  ]);

  if (!shRes.ok && !psRes.ok) {
    throw new Error('Failed to fetch Cursor CLI install scripts');
  }

  const shText = shRes.ok ? await shRes.text() : '';
  const psText = psRes.ok ? await psRes.text() : '';

  // Extract version from scripts
  let version = null;
  const psMatch = psText.match(/\$version\s*=\s*['"]([^'"]+)['"]/);
  if (psMatch) {
    version = psMatch[1];
  } else {
    const shMatch = shText.match(/downloads\.cursor\.com\/lab\/([^\/]+)\//);
    if (shMatch) version = shMatch[1];
  }

  if (!version) version = 'latest';

  const artifacts = [
    {
      target: 'darwin-arm64',
      url: `https://downloads.cursor.com/lab/${version}/darwin/arm64/agent-cli-package.tar.gz`,
      format: 'tgz',
      type: 'tarball',
    },
    {
      target: 'darwin-x64',
      url: `https://downloads.cursor.com/lab/${version}/darwin/x64/agent-cli-package.tar.gz`,
      format: 'tgz',
      type: 'tarball',
    },
    {
      target: 'linux-x64',
      url: `https://downloads.cursor.com/lab/${version}/linux/x64/agent-cli-package.tar.gz`,
      format: 'tgz',
      type: 'tarball',
    },
    {
      target: 'win32-x64',
      url: `https://downloads.cursor.com/lab/${version}/windows/x64/agent-cli-package.tar.gz`,
      format: 'tgz',
      type: 'tarball',
    },
  ];

  for (const a of artifacts) {
    assertUrlAllowed(a.url);
  }

  return {
    componentId: 'cursor-cli',
    family: 'cursor',
    version,
    releaseId: `cursor-cli@${version}`,
    channel: 'stable',
    artifacts,
    metadata: {},
  };
}
