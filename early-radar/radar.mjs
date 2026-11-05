#!/usr/bin/env node
/**
 * Early Signal Radar - Unified Engine
 * Orchestrates:
 * 1. Artificial Analysis Index reverse-engineering
 * 2. ChatGPT Web App manifest hash & deep chunk analyzer
 * 3. Claude Web App Vite entry & deep chunk analyzer
 * 4. OpenAI Python SDK model enum commit watcher
 * 5. Anthropic TypeScript SDK model enum commit watcher
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RADAR_CONFIG } from './config.mjs';
import { fetchArtificialAnalysisModels } from './sources/artificial_analysis.mjs';
import { fetchChatGPTManifest, fetchChatGPTChunkList } from './sources/chatgpt_manifest.mjs';
import { fetchClaudeManifest } from './sources/claude_manifest.mjs';
import { fetchLatestSdkCommit, fetchCommitModelDiff } from './sources/sdk_commits.mjs';
import { analyzeChunkContent, writeBuildReport } from './analyzer.mjs';
import {
  buildArtificialAnalysisEmbed,
  buildChatGPTBuildEmbed,
  buildClaudeBuildEmbed,
  buildSdkCommitEmbed,
  buildRadarShowcaseEmbeds,
  sendDiscordEmbeds,
} from './discord.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, 'radar_snapshot.json');

// Resolve Webhook URL from CLI arguments or environment variables
function getWebhookUrl() {
  const webhookArgIdx = process.argv.findIndex((a) => a === '--test-webhook' || a === '--webhook');
  if (webhookArgIdx !== -1 && process.argv[webhookArgIdx + 1]?.startsWith('https://discord.com/api/webhooks/')) {
    return process.argv[webhookArgIdx + 1].trim();
  }

  for (const envVar of RADAR_CONFIG.webhookEnvVars) {
    const val = process.env[envVar]?.trim();
    if (val && val.startsWith('https://discord.com/api/webhooks/')) {
      return val;
    }
  }
  return '';
}

/**
 * Loads the existing snapshot from disk. Returns null if missing.
 */
function loadSnapshot() {
  if (fs.existsSync(SNAPSHOT_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Saves snapshot to disk ONLY when genuine changes occur.
 */
function saveSnapshot(data) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export async function runRadar(options = {}) {
  const isForceAlert = options.forceAlert || process.env.FORCE_ALERT === '1' || process.argv.includes('--force-alert');
  const isInitPing = options.initPing || process.env.INIT_PING === '1' || process.argv.includes('--init-ping') || process.argv.includes('--test-webhook');
  const githubToken = process.env.GITHUB_TOKEN || null;
  const webhookUrl = options.webhookUrl || getWebhookUrl();

  console.log(`[RADAR] Starting Early Signal Radar...`);

  // Mock showcase preview mode
  if (isInitPing && !isForceAlert) {
    if (!webhookUrl) {
      console.error(`[RADAR] ❌ Cannot send showcase: No Discord webhook URL provided.`);
      return { eventsCount: 0, testDelivered: false };
    }
    console.log(`[RADAR] 🧪 Test Showcase Active: Building all 5 alert categories for 1-message preview...`);
    const showcaseEmbeds = buildRadarShowcaseEmbeds();
    await sendDiscordEmbeds(webhookUrl, showcaseEmbeds);
    console.log(`[RADAR] ✅ Showcase cards delivered to Discord!`);
    return { eventsCount: 5, testDelivered: true };
  }

  if (!webhookUrl) {
    console.log(`[RADAR] Notice: No Discord webhook configured. Running in audit mode.`);
  }

  // Load existing snapshot
  let snapshot = loadSnapshot();
  const isFirstRun = !snapshot;

  if (isFirstRun) {
    console.log(`[RADAR] No baseline snapshot found. Initializing calibration...`);
    snapshot = {
      aa_known_slugs: [],
      chatgpt_manifest_hash: null,
      claude_entry_hash: null,
      openai_sdk_sha: null,
      anthropic_sdk_sha: null,
      created_at: new Date().toISOString(),
    };
  }

  const knownAASlugs = new Set(snapshot.aa_known_slugs || []);
  const allEvents = [];
  const embedsToSend = [];

  // Run all 5 probes concurrently
  const [aaRes, gptRes, claudeRes, oaiSdkRes, anthSdkRes] = await Promise.allSettled([
    fetchArtificialAnalysisModels(),
    fetchChatGPTManifest(),
    fetchClaudeManifest(),
    fetchLatestSdkCommit(RADAR_CONFIG.endpoints.openaiSdkRepo, RADAR_CONFIG.endpoints.openaiSdkPath, githubToken),
    fetchLatestSdkCommit(RADAR_CONFIG.endpoints.anthropicSdkRepo, RADAR_CONFIG.endpoints.anthropicSdkPath, githubToken),
  ]);

  // 1. Process Artificial Analysis
  if (aaRes.status === 'fulfilled' && aaRes.value) {
    const { models } = aaRes.value;
    console.log(`[AA] Fetched ${models.size} models from Artificial Analysis.`);

    if (isForceAlert) {
      // Pick a flagship model from live index to send as real alert
      const sampleModel = models.get('gpt-6-astra') || models.get('inkling') || models.values().next().value;
      if (sampleModel) {
        console.log(`[AA] 🚀 FORCE_ALERT: Generating live alert for ${sampleModel.name}...`);
        allEvents.push({ type: 'AA_NEW_MODEL', model: sampleModel });
        embedsToSend.push(buildArtificialAnalysisEmbed(sampleModel));
      }
    } else if (isFirstRun) {
      snapshot.aa_known_slugs = Array.from(models.keys());
    } else {
      const newModels = [];
      for (const [slug, model] of models) {
        if (!knownAASlugs.has(slug)) {
          newModels.push(model);
          knownAASlugs.add(slug);
        }
      }

      if (newModels.length > 0) {
        console.log(`[AA] 🔥 Detected ${newModels.length} NEW model(s) indexed!`);
        for (const m of newModels) {
          allEvents.push({ type: 'AA_NEW_MODEL', model: m });
          embedsToSend.push(buildArtificialAnalysisEmbed(m));
        }
        snapshot.aa_known_slugs = Array.from(knownAASlugs);
      }
    }
  } else {
    console.warn(`[AA] Warning: ${aaRes.reason?.message}`);
  }

  // 2. Process ChatGPT Manifest & Build Analyzer
  if (gptRes.status === 'fulfilled' && gptRes.value) {
    const { manifestHash, manifestUrl } = gptRes.value;
    console.log(`[ChatGPT] Current manifest hash: ${manifestHash}`);

    if (isForceAlert) {
      console.log(`[ChatGPT] 🚀 FORCE_ALERT: Generating live alert for current build ${manifestHash}...`);
      const event = {
        type: 'CHATGPT_BUILD_UPDATED',
        manifestHash,
        prevHash: '1a91f86c',
        manifestUrl,
        totalChunks: 6721,
        models: ['gpt-6.1-terra-preview', 'o4-mini-preview'],
        featureGates: ['can_see_autonomous_operator_v2', 'enable_terra_deep_routing'],
        launchCopy: ['Introducing GPT-6.1 Terra: Frontier intelligence with native autonomous environment execution.'],
      };
      allEvents.push(event);
      embedsToSend.push(buildChatGPTBuildEmbed(event));
    } else if (isFirstRun) {
      snapshot.chatgpt_manifest_hash = manifestHash;
    } else if (snapshot.chatgpt_manifest_hash && snapshot.chatgpt_manifest_hash !== manifestHash) {
      console.log(`[ChatGPT] 🔥 Production build updated! ${snapshot.chatgpt_manifest_hash} -> ${manifestHash}`);
      
      let totalChunks = 0;
      let analysis = { models: [], featureGates: [], toolSchemas: [], launchCopy: [] };
      let reportUrl = null;

      try {
        const chunkInfo = await fetchChatGPTChunkList(manifestHash);
        totalChunks = chunkInfo.totalChunks;
        
        const mRes = await fetch(manifestUrl, { headers: { 'User-Agent': RADAR_CONFIG.userAgent } });
        if (mRes.ok) {
          const mText = await mRes.text();
          analysis = analyzeChunkContent(mText);
          reportUrl = writeBuildReport('ChatGPT', manifestHash, analysis);
        }
      } catch (err) {
        console.warn(`[ChatGPT] Deep analysis warning: ${err.message}`);
      }

      const event = {
        type: 'CHATGPT_BUILD_UPDATED',
        manifestHash,
        prevHash: snapshot.chatgpt_manifest_hash,
        manifestUrl,
        totalChunks,
        models: analysis.models,
        featureGates: analysis.featureGates,
        launchCopy: analysis.launchCopy,
        reportUrl,
      };

      allEvents.push(event);
      embedsToSend.push(buildChatGPTBuildEmbed(event));
      snapshot.chatgpt_manifest_hash = manifestHash;
    }
  } else {
    console.warn(`[ChatGPT] Warning: ${gptRes.reason?.message}`);
  }

  // 3. Process Claude Manifest & Build Analyzer
  if (claudeRes.status === 'fulfilled' && claudeRes.value) {
    const { entryHash, entryUrl } = claudeRes.value;
    console.log(`[Claude] Current Vite entry hash: ${entryHash}`);

    if (isForceAlert) {
      console.log(`[Claude] 🚀 FORCE_ALERT: Generating live alert for current build ${entryHash}...`);
      const event = {
        type: 'CLAUDE_BUILD_UPDATED',
        entryHash,
        prevHash: 'PYSO3vVA',
        entryUrl,
        models: ['claude-5-5-opus-preview'],
        featureGates: ['can_see_computer_use_v3', 'enable_dynamic_thinking_budget'],
      };
      allEvents.push(event);
      embedsToSend.push(buildClaudeBuildEmbed(event));
    } else if (isFirstRun) {
      snapshot.claude_entry_hash = entryHash;
    } else if (snapshot.claude_entry_hash && snapshot.claude_entry_hash !== entryHash) {
      console.log(`[Claude] 🔥 Production deployment updated! ${snapshot.claude_entry_hash} -> ${entryHash}`);
      
      let analysis = { models: [], featureGates: [], toolSchemas: [], launchCopy: [] };
      let reportUrl = null;

      try {
        const bRes = await fetch(entryUrl, { headers: { 'User-Agent': RADAR_CONFIG.userAgent } });
        if (bRes.ok) {
          const bText = await bRes.text();
          analysis = analyzeChunkContent(bText);
          reportUrl = writeBuildReport('Claude', entryHash, analysis);
        }
      } catch (err) {
        console.warn(`[Claude] Deep analysis warning: ${err.message}`);
      }

      const event = {
        type: 'CLAUDE_BUILD_UPDATED',
        entryHash,
        prevHash: snapshot.claude_entry_hash,
        entryUrl,
        models: analysis.models,
        featureGates: analysis.featureGates,
        reportUrl,
      };

      allEvents.push(event);
      embedsToSend.push(buildClaudeBuildEmbed(event));
      snapshot.claude_entry_hash = entryHash;
    }
  } else {
    console.warn(`[Claude] Warning: ${claudeRes.reason?.message}`);
  }

  // 4. Process OpenAI SDK Commits
  if (oaiSdkRes.status === 'fulfilled' && oaiSdkRes.value) {
    const commit = oaiSdkRes.value;
    console.log(`[OpenAI SDK] Latest commit: ${commit.shortSha} (${commit.author})`);

    if (isForceAlert) {
      console.log(`[OpenAI SDK] 🚀 FORCE_ALERT: Generating live alert for real commit ${commit.shortSha}...`);
      const event = {
        type: 'OPENAI_SDK_COMMIT',
        ...commit,
        additions: ['"gpt-6.1-terra-preview"', '"o4-mini"'],
      };
      allEvents.push(event);
      embedsToSend.push(buildSdkCommitEmbed(event));
    } else if (isFirstRun) {
      snapshot.openai_sdk_sha = commit.sha;
    } else if (snapshot.openai_sdk_sha && snapshot.openai_sdk_sha !== commit.sha) {
      console.log(`[OpenAI SDK] 🔥 New model enum commit: ${snapshot.openai_sdk_sha.slice(0, 7)} -> ${commit.shortSha}`);
      const additions = await fetchCommitModelDiff(
        RADAR_CONFIG.endpoints.openaiSdkRepo,
        commit.sha,
        RADAR_CONFIG.endpoints.openaiSdkPath,
        githubToken
      );

      const event = {
        type: 'OPENAI_SDK_COMMIT',
        ...commit,
        additions,
      };

      allEvents.push(event);
      embedsToSend.push(buildSdkCommitEmbed(event));
      snapshot.openai_sdk_sha = commit.sha;
    }
  } else {
    console.warn(`[OpenAI SDK] Warning: ${oaiSdkRes.reason?.message}`);
  }

  // 5. Process Anthropic SDK Commits
  if (anthSdkRes.status === 'fulfilled' && anthSdkRes.value) {
    const commit = anthSdkRes.value;
    console.log(`[Anthropic SDK] Latest commit: ${commit.shortSha} (${commit.author})`);

    if (isForceAlert) {
      console.log(`[Anthropic SDK] 🚀 FORCE_ALERT: Generating live alert for real commit ${commit.shortSha}...`);
      const event = {
        type: 'CLAUDE_SDK_COMMIT',
        ...commit,
        additions: ['"claude-5-5-opus-20261105"', '"claude-5-5-opus-latest"'],
      };
      allEvents.push(event);
      embedsToSend.push(buildSdkCommitEmbed(event));
    } else if (isFirstRun) {
      snapshot.anthropic_sdk_sha = commit.sha;
    } else if (snapshot.anthropic_sdk_sha && snapshot.anthropic_sdk_sha !== commit.sha) {
      console.log(`[Anthropic SDK] 🔥 New model enum commit: ${snapshot.anthropic_sdk_sha.slice(0, 7)} -> ${commit.shortSha}`);
      const additions = await fetchCommitModelDiff(
        RADAR_CONFIG.endpoints.anthropicSdkRepo,
        commit.sha,
        RADAR_CONFIG.endpoints.anthropicSdkPath,
        githubToken
      );

      const event = {
        type: 'CLAUDE_SDK_COMMIT',
        ...commit,
        additions,
      };

      allEvents.push(event);
      embedsToSend.push(buildSdkCommitEmbed(event));
      snapshot.anthropic_sdk_sha = commit.sha;
    }
  } else {
    console.warn(`[Anthropic SDK] Warning: ${anthSdkRes.reason?.message}`);
  }

  // Dispatch embeds if any events occurred
  if (embedsToSend.length > 0 && webhookUrl) {
    console.log(`[RADAR] Delivering ${embedsToSend.length} alert card(s) to Discord...`);
    await sendDiscordEmbeds(webhookUrl, embedsToSend);
  }

  // Save snapshot only on real baseline initialization or real changes (not force alert simulation)
  if (isFirstRun && !isForceAlert) {
    console.log(`[RADAR] Calibrated baseline saved to snapshot (${snapshot.aa_known_slugs.length} AA models).`);
    saveSnapshot(snapshot);
  } else if (allEvents.length > 0 && !isForceAlert) {
    console.log(`[RADAR] Saved updated snapshot with ${allEvents.length} new event(s).`);
    snapshot.last_updated = new Date().toISOString();
    saveSnapshot(snapshot);
  } else if (!isForceAlert) {
    console.log(`[RADAR] 0 changes detected. Snapshot untouched (zero git bloat).`);
  }

  return {
    eventsCount: allEvents.length,
    events: allEvents,
    snapshotCalibrated: isFirstRun,
  };
}

// Direct CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runRadar().catch((err) => {
    console.error(`[RADAR] Fatal error:`, err);
    process.exit(1);
  });
}
