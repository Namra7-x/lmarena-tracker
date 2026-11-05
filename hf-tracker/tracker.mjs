/**
 * Hugging Face Signal Tracker - Main Entrypoint
 * Monitors 28 Tier-1 AI Labs for unreleased models, collections, and spaces.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABS, TRACKED_ORG_IDS } from './config.mjs';
import { fetchOrgState, buildOrgIndex, diffOrgState, runConcurrentPool } from './detector.mjs';
import { sendDiscordAlerts } from './discord.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(__dirname, 'hf_snapshot.json');

async function main() {
  console.log(`[HF Tracker] Starting scan across ${TRACKED_ORG_IDS.length} frontier AI labs...`);
  const startTime = Date.now();

  let previousSnapshot = null;
  const isFirstRun = !fs.existsSync(SNAPSHOT_FILE);

  if (!isFirstRun) {
    try {
      previousSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    } catch (err) {
      console.warn('[HF Tracker] Failed to parse previous snapshot. Resetting baseline:', err.message);
    }
  }

  // Fetch all org states with concurrency of 6
  const orgStates = await runConcurrentPool(TRACKED_ORG_IDS, 6, async (org) => {
    try {
      const state = await fetchOrgState(org);
      return { org, state, ok: true };
    } catch (err) {
      console.error(`[HF Tracker] Failed fetching ${org}:`, err.message);
      return { org, state: { models: [], spaces: [], collections: [] }, ok: false };
    }
  });

  const newSnapshot = {};
  const allEvents = [];

  for (const { org, state, ok } of orgStates) {
    if (!ok && previousSnapshot?.[org]) {
      // Preserve previous snapshot on transient network failure
      newSnapshot[org] = previousSnapshot[org];
      continue;
    }

    const currentIndex = buildOrgIndex(state);
    newSnapshot[org] = currentIndex;

    if (previousSnapshot?.[org]) {
      const events = diffOrgState(org, state, previousSnapshot[org]);
      if (events.length > 0) {
        allEvents.push(...events);
      }
    }
  }

  // Handle initialization or test preview ping
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const isTestPing = process.env.INIT_PING === 'true' || process.env.INIT_PING === '1';

  if (isTestPing && webhookUrl) {
    console.log('[HF Tracker] Generating test preview cards for Qwen and DeepSeek...');
    const testEvents = [];
    
    const qwenModel = orgStates.find(o => o.org === 'Qwen')?.state?.models?.[0];
    const deepseekModel = orgStates.find(o => o.org === 'deepseek-ai')?.state?.models?.[0];

    if (qwenModel) {
      testEvents.push({
        type: 'NEW_MODEL',
        org: 'Qwen',
        item: qwenModel,
        details: { summary: '🧪 **Setup Test Card**: Sample preview of how Qwen releases will appear in Discord.' }
      });
    }
    if (deepseekModel) {
      testEvents.push({
        type: 'NEW_MODEL',
        org: 'deepseek-ai',
        item: deepseekModel,
        details: { summary: '🧪 **Setup Test Card**: Sample preview of how DeepSeek releases will appear in Discord.' }
      });
    }

    if (testEvents.length > 0) {
      await sendDiscordAlerts(testEvents, webhookUrl);
      console.log(`[HF Tracker] Sent ${testEvents.length} test preview cards (Qwen + DeepSeek) to Discord.`);
    }
  }

  // Handle first run baseline save
  if (isFirstRun) {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(newSnapshot, null, 2), 'utf8');
    console.log(`[HF Tracker] Baseline established for ${TRACKED_ORG_IDS.length} labs. Saved to ${SNAPSHOT_FILE}.`);
    return;
  }

  // Handle detected updates
  if (allEvents.length === 0) {
    console.log(`[HF Tracker] No new models, spaces, or collections detected. (took ${((Date.now() - startTime) / 1000).toFixed(2)}s)`);
    // Save updated index to keep counters fresh
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(newSnapshot, null, 2), 'utf8');
    return;
  }

  console.log(`[HF Tracker] 🚨 Detected ${allEvents.length} events across tracked labs!`);
  for (const ev of allEvents) {
    console.log(`  - [${ev.type}] ${ev.org}: ${ev.item?.id || ev.item?.title || ev.item?.slug}`);
  }

  // Dispatch to Discord
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    const res = await sendDiscordAlerts(allEvents, webhookUrl);
    console.log(`[HF Tracker] Dispatched ${res.sent}/${res.total} alerts to Discord webhook.`);
  } else {
    console.log('[HF Tracker] DISCORD_WEBHOOK_URL not set. Alerts logged to console only.');
  }

  // Persist updated snapshot
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(newSnapshot, null, 2), 'utf8');
  console.log(`[HF Tracker] Snapshot updated. Completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s.`);
}

main().catch((err) => {
  console.error('[HF Tracker] Fatal execution error:', err);
  process.exit(1);
});
