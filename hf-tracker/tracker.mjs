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

  // Handle first run
  if (isFirstRun) {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(newSnapshot, null, 2), 'utf8');
    console.log(`[HF Tracker] Baseline established for ${TRACKED_ORG_IDS.length} labs. Saved to ${SNAPSHOT_FILE}.`);

    // Send single initialization verification embed to Discord if webhook configured
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl && (process.env.INIT_PING === 'true' || process.env.INIT_PING === '1')) {
      const initPayload = {
        username: 'Hugging Face Radar',
        avatar_url: 'https://huggingface.co/front/assets/huggingface_logo-noborder.png',
        embeds: [
          {
            title: '📡 Hugging Face Signal Tracker Initialized',
            description: `Now monitoring **${TRACKED_ORG_IDS.length} Tier-1 AI Labs & Model Creators** for new releases.`,
            color: 0x10B981,
            fields: [
              {
                name: '🏢 Tracked Frontier Labs',
                value: Object.values(LABS).map(l => `• ${l.name}`).slice(0, 15).join('\n') + `\n...and ${TRACKED_ORG_IDS.length - 15} more.`,
                inline: false
              },
              {
                name: '🔍 Monitored Events',
                value: '• New Models & Weights\n• New Spaces & Live Demos\n• Curated Collections\n• Gating / Access Changes',
                inline: true
              },
              {
                name: '⚡ Cadence',
                value: 'Every 15 minutes via GitHub Actions',
                inline: true
              }
            ],
            footer: {
              text: 'Hugging Face Signal Tracker • Operational',
              icon_url: 'https://huggingface.co/front/assets/huggingface_logo-noborder.png'
            },
            timestamp: new Date().toISOString()
          }
        ]
      };

      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(initPayload)
        });
        console.log('[HF Tracker] Sent initialization welcome embed to Discord.');
      } catch (err) {
        console.warn('[HF Tracker] Could not send init ping:', err.message);
      }
    }
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
