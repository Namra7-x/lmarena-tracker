#!/usr/bin/env node
/**
 * Qwen Cloud Signal Tracker — Main Entrypoint
 * Discovers models, pricing updates, and rate limits across Qwen Cloud & Alibaba Bailian SFM.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAllModels } from './gateway.mjs';
import { enrichModels } from './markdown.mjs';
import { diffQwenState, hasEvents } from './diff.mjs';
import {
  buildNewModelEmbed,
  buildPriceChangeEmbed,
  buildContextChangeEmbed,
  buildRemovedModelEmbed,
  sendDiscordEmbeds,
} from './discord.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(__dirname, 'qwen_snapshot.json');

/**
 * Loads snapshot from disk.
 */
function loadSnapshot() {
  if (fs.existsSync(SNAPSHOT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    } catch (err) {
      console.warn('[Qwen Tracker] Failed to parse previous snapshot, resetting baseline:', err.message);
      return null;
    }
  }
  return null;
}

/**
 * Saves snapshot to disk.
 */
function saveSnapshot(data) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Main execution function.
 */
export async function runTracker(options = {}) {
  const startTime = Date.now();
  const isForceAlert =
    options.forceAlert ||
    process.env.FORCE_ALERT === '1' ||
    process.argv.includes('--force-alert') ||
    process.argv.includes('--test-webhook');

  const webhookArgIdx = process.argv.findIndex((a) => a === '--test-webhook' || a === '--webhook');
  const cliWebhook = webhookArgIdx !== -1 ? process.argv[webhookArgIdx + 1] : null;

  console.log(`[Qwen Tracker] Starting scan (mode: ${isForceAlert ? 'LIVE FORCE ALERT' : 'WATCHDOG'})...`);

  const previousSnapshot = loadSnapshot();
  const isFirstRun = !previousSnapshot;

  // 1. Fetch foundation models from Gateway
  let gatewayResult;
  try {
    gatewayResult = await fetchAllModels();
  } catch (err) {
    console.warn(`[Qwen Tracker] Gateway query failed: ${err.message}. Safely skipping this cycle.`);
    return { ok: false, error: err.message };
  }

  const { models, totalGroups, totalModels } = gatewayResult;
  console.log(`[Qwen Gateway] Discovered ${totalModels} models across ${totalGroups} model groups.`);

  // 2. Enrich with Markdown details (Pricing & Token Limits) using warm-run caching
  await enrichModels(models, previousSnapshot, 10);

  // Convert models Map to a plain object for serialization
  const currentSnapshotData = {
    totalGroups,
    totalModels: models.size,
    lastUpdated: new Date().toISOString(),
    models: Object.fromEntries(models),
  };

  // 3. Handle live test / preview card dispatch
  if (isForceAlert) {
    console.log('[Qwen Tracker] 🚀 FORCE_ALERT: Generating live test card for flagship model...');
    const sampleModel =
      models.get('qwen3.8-max') ||
      models.get('qwen3.8-flash') ||
      models.values().next().value;

    if (sampleModel) {
      const embeds = [buildNewModelEmbed(sampleModel)];
      await sendDiscordEmbeds(embeds, cliWebhook);
      console.log(`[Qwen Tracker] Delivered sample alert for ${sampleModel.name} to Discord.`);
    }
    return { ok: true, isForceAlert: true };
  }

  // 4. Handle first run baseline save
  if (isFirstRun) {
    saveSnapshot(currentSnapshotData);
    console.log(`[Qwen Tracker] Baseline established with ${models.size} models. Saved to ${SNAPSHOT_FILE}.`);
    return { ok: true, isFirstRun: true, count: models.size };
  }

  // 5. Diff against previous snapshot
  const events = diffQwenState(models, previousSnapshot);

  if (!hasEvents(events)) {
    console.log(
      `[Qwen Tracker] 0 changes detected across ${models.size} models. (took ${((Date.now() - startTime) / 1000).toFixed(2)}s). Snapshot untouched.`
    );
    return { ok: true, eventsCount: 0 };
  }

  // 6. Build Discord embeds for genuine changes
  const embedsToSend = [];

  for (const model of events.added) {
    console.log(`[Qwen Tracker] 🆕 New model added: ${model.modelId} (${model.provider})`);
    embedsToSend.push(buildNewModelEmbed(model));
  }

  for (const change of events.priceChanges) {
    console.log(`[Qwen Tracker] 💰 Pricing updated for: ${change.model.modelId}`);
    embedsToSend.push(buildPriceChangeEmbed(change));
  }

  for (const change of events.contextChanges) {
    console.log(`[Qwen Tracker] ⚡ Context / Limits updated for: ${change.model.modelId}`);
    embedsToSend.push(buildContextChangeEmbed(change));
  }

  for (const model of events.removed) {
    console.log(`[Qwen Tracker] ❌ Model removed: ${model.modelId}`);
    embedsToSend.push(buildRemovedModelEmbed(model));
  }

  // Dispatch alerts to Discord
  if (embedsToSend.length > 0) {
    console.log(`[Qwen Tracker] Delivering ${embedsToSend.length} alert card(s) to Discord...`);
    await sendDiscordEmbeds(embedsToSend, cliWebhook);
  }

  // Persist updated snapshot
  saveSnapshot(currentSnapshotData);
  console.log(`[Qwen Tracker] Snapshot updated with ${embedsToSend.length} event(s). (took ${((Date.now() - startTime) / 1000).toFixed(2)}s).`);

  return {
    ok: true,
    eventsCount: embedsToSend.length,
    events,
  };
}

// Direct CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTracker().catch((err) => {
    console.warn('[Qwen Tracker] Unexpected execution error:', err.message);
    // Graceful exit ensures scheduled GitHub Action never fails on transient network drops
    process.exit(0);
  });
}
