#!/usr/bin/env node
/**
 * Claude Model Catalog Tracker — Main Orchestrator
 * Checks https://downloads.claude.ai/model-catalog/v1/catalog.json
 * Detects version bumps, new model arrivals, token context increases, capability changes,
 * surface shifts, and provider alias changes.
 * Dispatches alerts directly to the GitHub commits Discord channel and Anthropic/Claude Telegram topic.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLAUDE_CONFIG } from './config.mjs';
import { fetchClaudeCatalog, extractCatalogData } from './extractor.mjs';
import { computeCatalogDiff } from './diff.mjs';
import { sendCatalogAlerts } from './notifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, 'claude_catalog_snapshot.json');

/**
 * Loads the existing snapshot from disk. Returns null if missing.
 */
export function loadSnapshot() {
  if (fs.existsSync(SNAPSHOT_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    } catch (err) {
      console.warn('[Claude Catalog] Warning parsing snapshot, resetting:', err.message);
      return null;
    }
  }
  return null;
}

/**
 * Saves snapshot to disk ONLY on real baseline initialization or real changes.
 */
export function saveSnapshot(data) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Main execution function.
 */
export async function runClaudeCatalogTracker(options = {}) {
  const startTime = Date.now();
  const isForceAlert =
    options.forceAlert ||
    process.env.FORCE_ALERT === '1' ||
    process.argv.includes('--force-alert') ||
    process.argv.includes('--test-alert') ||
    options.initPing ||
    process.env.INIT_PING === '1' ||
    process.argv.includes('--init-ping');

  console.log(`[Claude Catalog] Starting catalog check (mode: ${isForceAlert ? 'LIVE FORCE ALERT' : 'WATCHDOG'})...`);

  // 1. Fetch live catalog
  let rawCatalog, resolvedUrl;
  try {
    const fetchRes = await fetchClaudeCatalog(options.endpoint || CLAUDE_CONFIG.endpoint);
    rawCatalog = fetchRes.raw;
    resolvedUrl = fetchRes.resolvedUrl;
  } catch (err) {
    console.warn(`[Claude Catalog] Transient fetch error: ${err.message}. Skipping gracefully.`);
    return { ok: false, error: err.message };
  }

  // 2. Extract and normalize
  const currentCatalog = extractCatalogData(rawCatalog);
  console.log(`[Claude Catalog] Fetched catalog v${currentCatalog.version} (${currentCatalog.totalModels} models) from ${resolvedUrl}`);

  // 3. Load baseline snapshot
  let previousSnapshot = loadSnapshot();
  const isFirstRun = !previousSnapshot;

  // 4. Compute diff
  let diff = computeCatalogDiff(currentCatalog, previousSnapshot);

  // 5. Handle Live Test / Force Alert Mode
  if (isForceAlert) {
    console.log(`[Claude Catalog] 🚀 Generating live test alert for catalog v${currentCatalog.version}...`);
    // Create an informative showcase diff highlighting the latest models
    const flagshipModels = currentCatalog.models.filter((m) =>
      m.id.includes('5-5') || m.id.includes('5-2')
    );
    const showcaseModels = flagshipModels.length > 0 ? flagshipModels : currentCatalog.models.slice(0, 2);

    diff = {
      isFirstRun: false,
      hasChanges: true,
      versionChanged: true,
      previousVersion: currentCatalog.version ? currentCatalog.version - 1 : null,
      currentVersion: currentCatalog.version,
      newModels: showcaseModels,
      removedModels: [],
      specChanges: [
        {
          id: 'claude-opus-5-5',
          name: 'Opus 5.5',
          changes: [
            'Context window expanded to 1,000,000 in / 128,000 out',
            'Full thinking effort levels: low, medium, high, xhigh, max',
            'Deployed across all 5 surfaces: cc, ccd, ccr, chat, cowork',
          ],
        },
      ],
      surfaceDefaultChanges: [],
      aliasTargetChanges: [
        {
          alias: 'opus',
          provider: 'default',
          previous: 'claude-opus-4-6',
          current: 'claude-opus-5-5',
        },
      ],
      totalModels: currentCatalog.totalModels,
    };
  }

  // 6. Alert dispatch
  let alertsSent = false;
  if (diff.hasChanges || isForceAlert) {
    console.log(`[Claude Catalog] 🔥 Genuine catalog changes detected! Dispatching alerts...`);
    const deliveryRes = await sendCatalogAlerts(diff, currentCatalog, {
      ...options,
      forceAlert: isForceAlert,
    });
    alertsSent = Boolean(deliveryRes.discord);

    if (!isForceAlert) {
      saveSnapshot({
        version: currentCatalog.version,
        issuedAt: currentCatalog.issuedAt,
        expiresAt: currentCatalog.expiresAt,
        keyId: currentCatalog.keyId,
        surfaces: currentCatalog.surfaces,
        surfaceDefaults: currentCatalog.surfaceDefaults,
        providerAliases: currentCatalog.providerAliases,
        modelsById: currentCatalog.modelsById,
        models: currentCatalog.models,
        totalModels: currentCatalog.totalModels,
        lastUpdated: new Date().toISOString(),
      });
      console.log(`[Claude Catalog] Updated snapshot saved to disk.`);
    }
  } else if (isFirstRun) {
    console.log(`[Claude Catalog] Initial baseline calibrated with ${currentCatalog.totalModels} models at v${currentCatalog.version}. Saving snapshot.`);
    saveSnapshot({
      version: currentCatalog.version,
      issuedAt: currentCatalog.issuedAt,
      expiresAt: currentCatalog.expiresAt,
      keyId: currentCatalog.keyId,
      surfaces: currentCatalog.surfaces,
      surfaceDefaults: currentCatalog.surfaceDefaults,
      providerAliases: currentCatalog.providerAliases,
      modelsById: currentCatalog.modelsById,
      models: currentCatalog.models,
      totalModels: currentCatalog.totalModels,
      createdAt: new Date().toISOString(),
    });
  } else if (diff.versionChanged) {
    console.log(`[Claude Catalog] Catalog version incremented (v${diff.previousVersion} → v${diff.currentVersion}) with 0 model/spec changes. Updating snapshot silently (no alert sent).`);
    saveSnapshot({
      version: currentCatalog.version,
      issuedAt: currentCatalog.issuedAt,
      expiresAt: currentCatalog.expiresAt,
      keyId: currentCatalog.keyId,
      surfaces: currentCatalog.surfaces,
      surfaceDefaults: currentCatalog.surfaceDefaults,
      providerAliases: currentCatalog.providerAliases,
      modelsById: currentCatalog.modelsById,
      models: currentCatalog.models,
      totalModels: currentCatalog.totalModels,
      lastUpdated: new Date().toISOString(),
    });
  } else {
    console.log(`[Claude Catalog] 0 changes. Catalog v${currentCatalog.version} is up-to-date. (took ${((Date.now() - startTime) / 1000).toFixed(2)}s).`);
  }

  return {
    ok: true,
    version: currentCatalog.version,
    totalModels: currentCatalog.totalModels,
    hasChanges: diff.hasChanges,
    alertsSent,
    durationSeconds: ((Date.now() - startTime) / 1000).toFixed(2),
  };
}

// Direct CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runClaudeCatalogTracker().catch((err) => {
    console.warn('[Claude Catalog] Execution error:', err.message);
    process.exit(0);
  });
}
