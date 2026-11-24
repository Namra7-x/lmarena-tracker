/**
 * Official AI SDK Version Tracker & Deep Reverser — Main Orchestrator
 * Checks npm registry across `latest` and pre-release tags (`next`, `beta`, `canary`, `alpha`, `rc`),
 * reverses .d.ts & client JS files, generates diffs, and sends Telegram alerts with attachments.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SDK_CONFIG } from './config.mjs';
import { downloadAndReverseSdk } from './extractor.mjs';
import { computeSdkDiff, formatSdkTelegramSummary, formatSdkDiffDocument } from './diff.mjs';
import { TelegramClient } from '../telegram/client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, '../state');
const SNAPSHOT_FILE = path.join(STATE_DIR, 'sdk_snapshot.json');

/**
 * Loads snapshot from disk.
 */
function loadSnapshot() {
  if (fs.existsSync(SNAPSHOT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    } catch (err) {
      console.warn('[SDK Tracker] Failed to parse previous snapshot, resetting:', err.message);
      return null;
    }
  }
  return null;
}

/**
 * Saves snapshot to disk.
 */
function saveSnapshot(data) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Compare two semver strings (major.minor.patch, ignoring prerelease suffix for major-floor check).
 * Returns >0 if a > b, <0 if a < b, 0 if core parts match.
 */
export function compareSemverCore(a, b) {
  const parse = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Queries npm registry for package dist-tags and resolved tag metadata.
 */
async function fetchNpmMetadata(pkgName, configuredTags = ['latest']) {
  const encName = encodeURIComponent(pkgName).replace('%40', '@');
  const url = `${SDK_CONFIG.registryBase}/${encName}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
      'User-Agent': 'Mozilla/5.0 (compatible; AISDKTracker/1.0)',
    },
    signal: AbortSignal.timeout(SDK_CONFIG.timeouts.registry),
  });

  if (!res.ok) {
    throw new Error(`Failed to query npm registry for ${pkgName} (${res.status})`);
  }

  const json = await res.json();
  const distTags = json['dist-tags'] || {};
  const latestVer = distTags.latest;
  const targets = [];

  if (latestVer && json.versions?.[latestVer]) {
    const meta = json.versions[latestVer];
    targets.push({
      tag: 'latest',
      snapshotKey: pkgName,
      version: latestVer,
      tarballUrl: meta?.dist?.tarball,
      shasum: meta?.dist?.shasum || null,
    });
  }

  for (const tag of configuredTags) {
    if (tag === 'latest') continue;
    const tagVer = distTags[tag];
    if (!tagVer || tagVer === latestVer) continue;
    // Skip stale pre-release tags older than current latest (e.g. 4.0.0-beta when latest is 7.x)
    if (latestVer && compareSemverCore(tagVer, latestVer) < 0) continue;
    const meta = json.versions?.[tagVer];
    if (!meta?.dist?.tarball) continue;
    targets.push({
      tag,
      snapshotKey: `${pkgName}#${tag}`,
      version: tagVer,
      tarballUrl: meta.dist.tarball,
      shasum: meta?.dist?.shasum || null,
    });
  }

  return targets;
}

/**
 * Main execution function.
 */
export async function runSdkTracker(options = {}) {
  const startTime = Date.now();
  const isForceAlert =
    options.forceAlert ||
    process.env.FORCE_ALERT === '1' ||
    process.argv.includes('--force-alert') ||
    process.argv.includes('--test-alert');

  console.log(`[SDK Tracker] Starting check (mode: ${isForceAlert ? 'LIVE TEST ALERT' : 'WATCHDOG'})...`);

  let snapshot = loadSnapshot() || {};
  let totalAlertsSent = 0;
  let snapshotUpdated = false;

  for (const pkg of SDK_CONFIG.packages) {
    console.log(`[SDK Tracker] Checking ${pkg.name}...`);
    let targets;
    try {
      targets = await fetchNpmMetadata(pkg.name, pkg.tags || ['latest']);
    } catch (err) {
      console.warn(`[SDK Tracker] Warning fetching ${pkg.name}: ${err.message}`);
      continue;
    }

    for (const target of targets) {
      const { tag, snapshotKey, version, tarballUrl, shasum } = target;
      const prevEntry = snapshot[snapshotKey];

      const isUnchanged = prevEntry && prevEntry.version === version && prevEntry.shasum === shasum;

      if (isUnchanged && !isForceAlert) {
        console.log(`[SDK Tracker] ${snapshotKey} v${version} is unchanged. (Cache Hit)`);
        continue;
      }

      console.log(`[SDK Tracker] Reversing ${snapshotKey} v${version} from tarball...`);
      let reversed;
      try {
        reversed = await downloadAndReverseSdk(tarballUrl, pkg.name);
      } catch (err) {
        console.error(`[SDK Tracker] Failed to reverse ${snapshotKey}: ${err.message}`);
        continue;
      }

      const diff = computeSdkDiff(pkg.name, version, reversed, prevEntry);
      console.log(
        `[SDK Tracker] Extracted (${tag}): ${reversed.models.length} models, ${reversed.apiEndpoints.length} routes, ${reversed.betaHeaders.length} beta headers, ${reversed.requestParams.length} params from ${reversed.totalDtsFiles} .d.ts files.`
      );

      const shouldAlert = isForceAlert || (!diff.isFirstBaseline && diff.hasChanges);

      if (shouldAlert) {
        console.log(`[SDK Tracker] 🚨 Sending SDK release alert for ${snapshotKey} v${version}...`);
        const client = new TelegramClient(null, null, pkg.family, pkg.name);

        if (client.isConfigured() || isForceAlert) {
          const topicId = client.getTopicId(pkg.family, pkg.name);
          const summaryText = formatSdkTelegramSummary(diff, pkg.displayName, tag);

          await client.sendMessage(summaryText, { topicId });

          const safePkgName = snapshotKey.replace(/[^a-zA-Z0-9]/g, '_');
          const tempDiffPath = path.join(STATE_DIR, `sdk_diff_${safePkgName}_v${version}.txt`);
          const docContent = formatSdkDiffDocument(diff);
          fs.writeFileSync(tempDiffPath, docContent, 'utf8');

          try {
            await client.sendDocument(tempDiffPath, `Technical SDK Diff: ${pkg.name} (${tag}) v${version}`, { topicId });
          } finally {
            if (fs.existsSync(tempDiffPath)) fs.unlinkSync(tempDiffPath);
          }

          totalAlertsSent++;
        } else {
          console.log(`[SDK Tracker] Notice: Telegram not configured for ${pkg.family}. Skipping delivery.`);
        }
      } else if (diff.isFirstBaseline) {
        console.log(`[SDK Tracker] Baseline calibrated for ${snapshotKey} v${version}. (${reversed.models.length} models, ${reversed.apiEndpoints.length} routes).`);
      }

      snapshot[snapshotKey] = {
        ...diff.currentSnapshot,
        tag,
        shasum,
        displayName: pkg.displayName,
        family: pkg.family,
      };
      snapshotUpdated = true;
    }
  }

  if (snapshotUpdated) {
    saveSnapshot(snapshot);
    console.log(`[SDK Tracker] Snapshot updated. Completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s.`);
  } else {
    console.log(`[SDK Tracker] 0 package changes. Snapshot untouched. (took ${((Date.now() - startTime) / 1000).toFixed(2)}s).`);
  }

  return { ok: true, totalAlertsSent, snapshotUpdated };
}

// Direct CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runSdkTracker().catch((err) => {
    console.warn('[SDK Tracker] Unexpected execution error:', err.message);
    process.exit(0);
  });
}
