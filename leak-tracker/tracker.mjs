#!/usr/bin/env node
/**
 * Leak Tracker — Main Orchestrator
 * Concurrent scanner for:
 * 1. Pre-Release & Early Catalogs -> Channel 1 (Early model tracker, alongside Qwen)
 * 2. OpenAI Code & Schema -> Channel 2 (GitHub commits & analysis)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchGcpSkus,
  fetchAzureFoundryModels,
  fetchAwsBedrockPricing,
  fetchAzureRetailPrices,
  fetchJumpstartProprietary,
  fetchOpenaiCodexModels,
  fetchOpenaiCommits,
  fetchOpenaiOpenapiYaml,
} from './fetcher.mjs';
import { computeLeakDiff } from './diff.mjs';
import {
  sendDiscordWebhook,
  buildGcpSkuEmbed,
  buildAzureFoundryEmbed,
  buildAwsBedrockPricingEmbed,
  buildAzureRetailPricesEmbed,
  buildJumpstartProprietaryEmbed,
  buildOpenaiCodexEmbed,
  buildOpenaiCommitEmbed,
  buildOpenaiOpenapiEmbed,
} from './notifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, 'leak_tracker_snapshot.json');

export function loadSnapshot() {
  if (fs.existsSync(SNAPSHOT_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    } catch (err) {
      console.warn('[Leak Tracker] Error parsing snapshot, resetting:', err.message);
      return null;
    }
  }
  return null;
}

export function saveSnapshot(data) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export async function runLeakTracker(options = {}) {
  const startTime = Date.now();
  const isForceAlert =
    options.forceAlert ||
    process.env.FORCE_ALERT === '1' ||
    process.argv.includes('--force-alert') ||
    process.argv.includes('--test-alert') ||
    options.initPing ||
    process.env.INIT_PING === '1' ||
    process.argv.includes('--init-ping');

  console.log(`[Leak Tracker] Scanning pre-release catalogs & code staging (${isForceAlert ? 'LIVE TEST MODE' : 'WATCHDOG'})...`);

  // Run all 8 fetchers concurrently
  const [
    gcpRes,
    azureFoundryRes,
    awsBedrockRes,
    azureRetailRes,
    jumpstartRes,
    codexRes,
    commitsRes,
    openapiYamlRes,
  ] = await Promise.allSettled([
    fetchGcpSkus(),
    fetchAzureFoundryModels(),
    fetchAwsBedrockPricing(),
    fetchAzureRetailPrices(),
    fetchJumpstartProprietary(),
    fetchOpenaiCodexModels(),
    fetchOpenaiCommits(),
    fetchOpenaiOpenapiYaml(),
  ]);

  const current = {
    gcpSkus: gcpRes.status === 'fulfilled' ? gcpRes.value : [],
    azureFoundryModels: azureFoundryRes.status === 'fulfilled' ? azureFoundryRes.value : [],
    awsBedrockPricing: awsBedrockRes.status === 'fulfilled' ? awsBedrockRes.value : { version: 'unknown', products: [] },
    azureRetailPrices: azureRetailRes.status === 'fulfilled' ? azureRetailRes.value : [],
    jumpstartProprietary: jumpstartRes.status === 'fulfilled' ? jumpstartRes.value : [],
    openaiCodexModels: codexRes.status === 'fulfilled' ? codexRes.value : [],
    openaiCommits: commitsRes.status === 'fulfilled' ? commitsRes.value : [],
    openaiOpenapiYaml: openapiYamlRes.status === 'fulfilled' ? openapiYamlRes.value : { version: 'unknown', modelEnums: [] },
    lastScanAt: new Date().toISOString(),
  };

  const baseline = loadSnapshot();
  let diff = computeLeakDiff(current, baseline);

  // 1. Initial Baseline Run
  if (diff.isFirstRun && !isForceAlert) {
    console.log('[Leak Tracker] Baseline snapshot calibrated with zero spam:');
    console.log(`  - GCP SKUs: ${current.gcpSkus.length}`);
    console.log(`  - Azure Foundry Models: ${current.azureFoundryModels.length}`);
    console.log(`  - AWS Bedrock Products: ${current.awsBedrockPricing.products.length}`);
    console.log(`  - Azure Retail Prices: ${current.azureRetailPrices.length}`);
    console.log(`  - JumpStart Proprietary: ${current.jumpstartProprietary.length}`);
    console.log(`  - OpenAI Codex Models: ${current.openaiCodexModels.length}`);
    console.log(`  - OpenAI Commits: ${current.openaiCommits.length}`);
    saveSnapshot(current);
    return { ok: true, isFirstRun: true };
  }

  // 2. Force Alert / Test Mode
  if (isForceAlert) {
    console.log('[Leak Tracker] 🚀 Generating showcase alerts across both designated channels...');
    // Channel 1 showcase
    if (current.gcpSkus.length > 0) {
      const sampleGcp = current.gcpSkus.filter((s) => s.description.toLowerCase().includes('gemini') || s.description.toLowerCase().includes('neon')).slice(0, 3);
      await sendDiscordWebhook('earlyModel', { embeds: [buildGcpSkuEmbed(sampleGcp.length > 0 ? sampleGcp : current.gcpSkus.slice(0, 3))] });
    }
    if (current.azureFoundryModels.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildAzureFoundryEmbed(current.azureFoundryModels.slice(0, 3))] });
    }

    // Channel 2 showcase
    if (current.openaiCodexModels.length > 0) {
      const latestCodex = current.openaiCodexModels.filter((m) => m.slug.includes('6.2') || m.slug.includes('6.1')).slice(0, 3);
      await sendDiscordWebhook('commitAnalysis', { embeds: [buildOpenaiCodexEmbed(latestCodex.length > 0 ? latestCodex : current.openaiCodexModels.slice(0, 3))] });
    }
    if (current.openaiCommits.length > 0) {
      await sendDiscordWebhook('commitAnalysis', { embeds: [buildOpenaiCommitEmbed(current.openaiCommits[0])] });
    }

    saveSnapshot(current);
    return { ok: true, isForceAlert: true };
  }

  // 3. Live Detection Dispatch
  if (diff.channel1.hasChanges) {
    console.log('[Leak Tracker] 🚨 Channel 1 changes detected! Dispatching to Early Model channel...');
    if (diff.channel1.newGcpSkus.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildGcpSkuEmbed(diff.channel1.newGcpSkus)] });
    }
    if (diff.channel1.newAzureFoundry.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildAzureFoundryEmbed(diff.channel1.newAzureFoundry)] });
    }
    if (diff.channel1.newBedrock.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildAwsBedrockPricingEmbed(diff.channel1.newBedrock, current.awsBedrockPricing.version)] });
    }
    if (diff.channel1.newAzureRetail.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildAzureRetailPricesEmbed(diff.channel1.newAzureRetail)] });
    }
    if (diff.channel1.newJumpstart.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildJumpstartProprietaryEmbed(diff.channel1.newJumpstart)] });
    }
  }

  if (diff.channel2.hasChanges) {
    console.log('[Leak Tracker] 🚨 Channel 2 changes detected! Dispatching to GitHub Commits & Analysis channel...');
    if (diff.channel2.newCodexModels.length > 0) {
      await sendDiscordWebhook('commitAnalysis', { embeds: [buildOpenaiCodexEmbed(diff.channel2.newCodexModels)] });
    }
    if (diff.channel2.newOpenaiCommits.length > 0) {
      for (const commit of diff.channel2.newOpenaiCommits.slice(0, 3)) {
        await sendDiscordWebhook('commitAnalysis', { embeds: [buildOpenaiCommitEmbed(commit)] });
      }
    }
    if (diff.channel2.newOpenaiEnums.length > 0) {
      await sendDiscordWebhook('commitAnalysis', { embeds: [buildOpenaiOpenapiEmbed(diff.channel2.newOpenaiEnums, current.openaiOpenapiYaml.version)] });
    }
  }

  if (diff.hasChanges) {
    saveSnapshot(current);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[Leak Tracker] Scan finished in ${duration}s (Changes: ${diff.hasChanges ? 'YES' : 'NONE'}).`);
  return { ok: true, diff };
}

if (process.argv[1] && process.argv[1].endsWith('tracker.mjs')) {
  runLeakTracker().catch((err) => {
    console.error('[Leak Tracker] Fatal execution error:', err);
    process.exit(1);
  });
}
