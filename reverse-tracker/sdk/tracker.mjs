/**
 * Official AI SDK Version Tracker & Deep Reverser — Main Orchestrator
 * Checks npm registry, reverses .d.ts types, generates diffs, and sends Telegram alerts with attachments.
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
 * Queries npm registry for package dist-tags and latest version metadata.
 */
async function fetchNpmMetadata(pkgName) {
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
  const latestVer = json['dist-tags']?.latest;
  const versionMeta = json.versions?.[latestVer];
  const tarballUrl = versionMeta?.dist?.tarball;
  const shasum = versionMeta?.dist?.shasum || null;

  return {
    latestVer,
    tarballUrl,
    shasum,
    distTags: json['dist-tags'] || {},
  };
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
    let meta;
    try {
      meta = await fetchNpmMetadata(pkg.name);
    } catch (err) {
      console.warn(`[SDK Tracker] Warning fetching ${pkg.name}: ${err.message}`);
      continue;
    }

    const { latestVer, tarballUrl, shasum } = meta;
    const prevEntry = snapshot[pkg.name];

    const isUnchanged = prevEntry && prevEntry.version === latestVer && prevEntry.shasum === shasum;

    if (isUnchanged && !isForceAlert) {
      console.log(`[SDK Tracker] ${pkg.name} v${latestVer} is unchanged. (Cache Hit)`);
      continue;
    }

    console.log(`[SDK Tracker] Reversing ${pkg.name} v${latestVer} from tarball...`);
    let reversed;
    try {
      reversed = await downloadAndReverseSdk(tarballUrl, pkg.name);
    } catch (err) {
      console.error(`[SDK Tracker] Failed to reverse ${pkg.name}: ${err.message}`);
      continue;
    }

    const diff = computeSdkDiff(pkg.name, latestVer, reversed, prevEntry);
    console.log(
      `[SDK Tracker] Extracted: ${reversed.models.length} models, ${reversed.betaHeaders.length} beta headers from ${reversed.totalDtsFiles} .d.ts files.`
    );

    // Alert dispatch condition
    const shouldAlert = isForceAlert || (!diff.isFirstBaseline && diff.hasChanges);

    if (shouldAlert) {
      console.log(`[SDK Tracker] 🚨 Discarding baseline: Sending SDK release alert for ${pkg.name} v${latestVer}...`);
      const client = new TelegramClient(null, null, pkg.family, pkg.name);

      if (client.isConfigured() || isForceAlert) {
        const topicId = client.getTopicId(pkg.family, pkg.name);
        const summaryText = formatSdkTelegramSummary(diff, pkg.displayName);

        // 1. Send concise summary text (strictly < 4000 chars)
        await client.sendMessage(summaryText, { topicId });

        // 2. Generate and attach technical diff file
        const safePkgName = pkg.name.replace(/[^a-zA-Z0-9]/g, '_');
        const tempDiffPath = path.join(STATE_DIR, `sdk_diff_${safePkgName}_v${latestVer}.txt`);
        const docContent = formatSdkDiffDocument(diff);
        fs.writeFileSync(tempDiffPath, docContent, 'utf8');

        try {
          await client.sendDocument(tempDiffPath, `Technical SDK Diff: ${pkg.name} v${latestVer}`, { topicId });
        } finally {
          if (fs.existsSync(tempDiffPath)) fs.unlinkSync(tempDiffPath);
        }

        totalAlertsSent++;
      } else {
        console.log(`[SDK Tracker] Notice: Telegram not configured for ${pkg.family}. Skipping delivery.`);
      }
    } else if (diff.isFirstBaseline) {
      console.log(`[SDK Tracker] Baseline calibrated for ${pkg.name} v${latestVer}. (${reversed.models.length} models).`);
    }

    // Update snapshot with latest state
    snapshot[pkg.name] = {
      ...diff.currentSnapshot,
      shasum,
      displayName: pkg.displayName,
      family: pkg.family,
    };
    snapshotUpdated = true;
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
    // Graceful exit 0 ensures scheduled GitHub Action never fails on transient network drops
    process.exit(0);
  });
}
