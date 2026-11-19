#!/usr/bin/env node
/**
 * Leak Tracker — Main Orchestrator
 * Concurrent scanner for:
 * 1. Pre-Release & Early Catalogs -> Channel 1 (Early model tracker, alongside Qwen)
 *    - Google Cloud SKUs
 *    - Azure AI Foundry Asset Catalog
 *    - AWS Bedrock Master Feed (AmazonBedrock: Grok 4.7, Kimi, MiniMax, Nemotron, Nova)
 *    - Azure Retail Prices (Foundry Models, Azure OpenAI, AI+ML Master)
 *    - Google Vertex AI Pricing Table HTML (gemini-4-argon, etc.)
 *    - AWS Generic Offers Index
 *    - AWS JumpStart Proprietary Manifest
 *
 * 2. GitHub Code Staging & SDK Types -> Channel 2 (GitHub commits & analysis)
 *    - Anthropic Python SDK Model Type Unions (claude-mythos-*, claude-fable-*)
 *    - Google GenAI Python SDK Types (gemini-3.8-flash, etc.)
 *    - OpenAI Codex Model List (models.json)
 *    - OpenAI OpenAPI Commits Feed (commits/main.atom)
 *    - OpenAI OpenAPI Specification (openapi.yaml model enums)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchGcpSkus,
  fetchAzureFoundryModels,
  fetchAwsBedrockMaster,
  fetchAzureRetailFeeds,
  fetchGoogleVertexPricingHtml,
  fetchAwsOffersIndex,
  fetchJumpstartProprietary,
  fetchAnthropicPythonSdkModel,
  fetchGoogleGenaiPythonTypes,
  fetchOpenaiCodexModels,
  fetchOpenaiCommits,
  fetchOpenaiOpenapiYaml,
} from './fetcher.mjs';
import { computeLeakDiff } from './diff.mjs';
import {
  sendDiscordWebhook,
  buildGcpSkuEmbed,
  buildAzureFoundryEmbed,
  buildAwsBedrockMasterEmbed,
  buildAzureRetailPricesEmbed,
  buildGoogleVertexPricingEmbed,
  buildAwsOffersIndexEmbed,
  buildJumpstartProprietaryEmbed,
  buildAnthropicPythonSdkEmbed,
  buildGoogleGenaiPythonEmbed,
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

  // Run all 12 fetchers concurrently
  const [
    gcpRes,
    azureFoundryRes,
    awsBedrockRes,
    azureRetailRes,
    vertexHtmlRes,
    awsOffersRes,
    jumpstartRes,
    anthropicPyRes,
    googleGenaiPyRes,
    codexRes,
    commitsRes,
    openapiYamlRes,
  ] = await Promise.allSettled([
    fetchGcpSkus(),
    fetchAzureFoundryModels(),
    fetchAwsBedrockMaster(),
    fetchAzureRetailFeeds(),
    fetchGoogleVertexPricingHtml(),
    fetchAwsOffersIndex(),
    fetchJumpstartProprietary(),
    fetchAnthropicPythonSdkModel(),
    fetchGoogleGenaiPythonTypes(),
    fetchOpenaiCodexModels(),
    fetchOpenaiCommits(),
    fetchOpenaiOpenapiYaml(),
  ]);

  const current = {
    gcpSkus: gcpRes.status === 'fulfilled' ? gcpRes.value : [],
    azureFoundryModels: azureFoundryRes.status === 'fulfilled' ? azureFoundryRes.value : [],
    awsBedrockMaster: awsBedrockRes.status === 'fulfilled' ? awsBedrockRes.value : { version: 'unknown', products: [] },
    azureRetailPrices: azureRetailRes.status === 'fulfilled' ? azureRetailRes.value : [],
    googleVertexPricingModels: vertexHtmlRes.status === 'fulfilled' ? vertexHtmlRes.value : [],
    awsOffersIndex: awsOffersRes.status === 'fulfilled' ? awsOffersRes.value : { publicationDate: null, offerCodes: [] },
    jumpstartProprietary: jumpstartRes.status === 'fulfilled' ? jumpstartRes.value : [],
    anthropicPythonSdkModels: anthropicPyRes.status === 'fulfilled' ? anthropicPyRes.value : [],
    googleGenaiPythonModels: googleGenaiPyRes.status === 'fulfilled' ? googleGenaiPyRes.value : [],
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
    console.log(`  - AWS Bedrock Master Products: ${current.awsBedrockMaster.products.length}`);
    console.log(`  - Azure Retail Prices: ${current.azureRetailPrices.length}`);
    console.log(`  - Google Vertex HTML Models: ${current.googleVertexPricingModels.length}`);
    console.log(`  - AWS Offer Codes: ${current.awsOffersIndex.offerCodes.length}`);
    console.log(`  - JumpStart Proprietary: ${current.jumpstartProprietary.length}`);
    console.log(`  - Anthropic Python Models: ${current.anthropicPythonSdkModels.length}`);
    console.log(`  - Google GenAI Python Models: ${current.googleGenaiPythonModels.length}`);
    console.log(`  - OpenAI Codex Models: ${current.openaiCodexModels.length}`);
    console.log(`  - OpenAI Commits: ${current.openaiCommits.length}`);
    saveSnapshot(current);
    return { ok: true, isFirstRun: true };
  }

  // 2. Force Alert / Test Mode
  if (isForceAlert) {
    console.log('[Leak Tracker] 🚀 Generating showcase alerts across both designated channels...');
    // Channel 1 showcase
    if (current.googleVertexPricingModels.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildGoogleVertexPricingEmbed(current.googleVertexPricingModels.slice(0, 5))] });
    }
    if (current.awsBedrockMaster.products.length > 0) {
      const topBedrock = current.awsBedrockMaster.products.filter((p) =>
        p.modelName.toLowerCase().includes('grok') ||
        p.modelName.toLowerCase().includes('kimi') ||
        p.modelName.toLowerCase().includes('minimax') ||
        p.modelName.toLowerCase().includes('nemotron')
      ).slice(0, 3);
      await sendDiscordWebhook('earlyModel', { embeds: [buildAwsBedrockMasterEmbed(topBedrock.length > 0 ? topBedrock : current.awsBedrockMaster.products.slice(0, 3), current.awsBedrockMaster.version)] });
    }

    // Channel 2 showcase
    if (current.anthropicPythonSdkModels.length > 0) {
      const mythos = current.anthropicPythonSdkModels.filter((m) => m.includes('mythos') || m.includes('fable')).slice(0, 4);
      await sendDiscordWebhook('commitAnalysis', { embeds: [buildAnthropicPythonSdkEmbed(mythos.length > 0 ? mythos : current.anthropicPythonSdkModels.slice(0, 4))] });
    }
    if (current.googleGenaiPythonModels.length > 0) {
      await sendDiscordWebhook('commitAnalysis', { embeds: [buildGoogleGenaiPythonEmbed(current.googleGenaiPythonModels.slice(0, 3))] });
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
    if (diff.channel1.newBedrockMaster.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildAwsBedrockMasterEmbed(diff.channel1.newBedrockMaster, current.awsBedrockMaster.version)] });
    }
    if (diff.channel1.newAzureRetail.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildAzureRetailPricesEmbed(diff.channel1.newAzureRetail)] });
    }
    if (diff.channel1.newVertexPricingModels.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildGoogleVertexPricingEmbed(diff.channel1.newVertexPricingModels)] });
    }
    if (diff.channel1.newAwsOfferCodes.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildAwsOffersIndexEmbed(diff.channel1.newAwsOfferCodes)] });
    }
    if (diff.channel1.newJumpstart.length > 0) {
      await sendDiscordWebhook('earlyModel', { embeds: [buildJumpstartProprietaryEmbed(diff.channel1.newJumpstart)] });
    }
  }

  if (diff.channel2.hasChanges) {
    console.log('[Leak Tracker] 🚨 Channel 2 changes detected! Dispatching to GitHub Commits & Analysis channel...');
    if (diff.channel2.newAnthropicPythonModels.length > 0) {
      await sendDiscordWebhook('commitAnalysis', { embeds: [buildAnthropicPythonSdkEmbed(diff.channel2.newAnthropicPythonModels)] });
    }
    if (diff.channel2.newGoogleGenaiPythonModels.length > 0) {
      await sendDiscordWebhook('commitAnalysis', { embeds: [buildGoogleGenaiPythonEmbed(diff.channel2.newGoogleGenaiPythonModels)] });
    }
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

  // Update snapshot on disk ONLY when there are actual diff changes
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
