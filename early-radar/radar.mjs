#!/usr/bin/env node
/**
 * Early Signal Radar - Unified Engine
 * Orchestrates:
 * 1. Artificial Analysis Index reverse-engineering
 * 2. ChatGPT Web App manifest hash reverse-engineering
 * 3. Claude Web App Vite entry reverse-engineering
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
import {
  buildArtificialAnalysisEmbed,
  buildChatGPTBuildEmbed,
  buildClaudeBuildEmbed,
  buildSdkCommitEmbed,
  sendDiscordEmbeds,
} from './discord.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, 'radar_snapshot.json');

// Resolve Webhook URL from environment variables
function getWebhookUrl() {
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
  const isInitPing = options.initPing || process.env.INIT_PING === '1' || process.argv.includes('--init-ping');
  const githubToken = process.env.GITHUB_TOKEN || null;
  const webhookUrl = getWebhookUrl();

  console.log(`[RADAR] Starting Early Signal Radar...`);
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

    if (isFirstRun) {
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

  // 2. Process ChatGPT Manifest
  if (gptRes.status === 'fulfilled' && gptRes.value) {
    const { manifestHash, manifestUrl } = gptRes.value;
    console.log(`[ChatGPT] Current manifest hash: ${manifestHash}`);

    if (isFirstRun) {
      snapshot.chatgpt_manifest_hash = manifestHash;
    } else if (snapshot.chatgpt_manifest_hash && snapshot.chatgpt_manifest_hash !== manifestHash) {
      console.log(`[ChatGPT] 🔥 Production build updated! ${snapshot.chatgpt_manifest_hash} -> ${manifestHash}`);
      
      let totalChunks = 0;
      try {
        const chunkInfo = await fetchChatGPTChunkList(manifestHash);
        totalChunks = chunkInfo.totalChunks;
      } catch {}

      const event = {
        type: 'CHATGPT_BUILD_UPDATED',
        manifestHash,
        prevHash: snapshot.chatgpt_manifest_hash,
        manifestUrl,
        totalChunks,
      };

      allEvents.push(event);
      embedsToSend.push(buildChatGPTBuildEmbed(event));
      snapshot.chatgpt_manifest_hash = manifestHash;
    }
  } else {
    console.warn(`[ChatGPT] Warning: ${gptRes.reason?.message}`);
  }

  // 3. Process Claude Manifest
  if (claudeRes.status === 'fulfilled' && claudeRes.value) {
    const { entryHash, entryUrl } = claudeRes.value;
    console.log(`[Claude] Current Vite entry hash: ${entryHash}`);

    if (isFirstRun) {
      snapshot.claude_entry_hash = entryHash;
    } else if (snapshot.claude_entry_hash && snapshot.claude_entry_hash !== entryHash) {
      console.log(`[Claude] 🔥 Production deployment updated! ${snapshot.claude_entry_hash} -> ${entryHash}`);
      const event = {
        type: 'CLAUDE_BUILD_UPDATED',
        entryHash,
        prevHash: snapshot.claude_entry_hash,
        entryUrl,
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

    if (isFirstRun) {
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

    if (isFirstRun) {
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

  // 6. Handle INIT_PING mode (Test card delivery)
  if (isInitPing && webhookUrl) {
    console.log(`[RADAR] 🧪 INIT_PING active: Sending radar preview embed...`);
    const previewEmbed = {
      title: '⚡ Early Signal Radar | Webhook Active',
      description: 'The unified early leak radar is connected and monitoring ground-truth sources every minute.',
      color: RADAR_CONFIG.colors.init,
      fields: [
        { name: 'Artificial Analysis', value: `\`${snapshot.aa_known_slugs?.length || 0}\` models calibrated`, inline: true },
        { name: 'ChatGPT Build', value: `\`${snapshot.chatgpt_manifest_hash || 'calibrated'}\``, inline: true },
        { name: 'Claude Vite Build', value: `\`${snapshot.claude_entry_hash || 'calibrated'}\``, inline: true },
        { name: 'OpenAI SDK Commit', value: `\`${snapshot.openai_sdk_sha?.slice(0, 7) || 'calibrated'}\``, inline: true },
        { name: 'Anthropic SDK Commit', value: `\`${snapshot.anthropic_sdk_sha?.slice(0, 7) || 'calibrated'}\``, inline: true },
      ],
      footer: { text: 'Early Signal Radar • Zero Spam' },
      timestamp: new Date().toISOString(),
    };
    await sendDiscordEmbeds(webhookUrl, [previewEmbed]);
  }

  // 7. Dispatch embeds if any events occurred
  if (embedsToSend.length > 0 && webhookUrl) {
    console.log(`[RADAR] Delivering ${embedsToSend.length} alert card(s) to Discord...`);
    await sendDiscordEmbeds(webhookUrl, embedsToSend);
  }

  // 8. STRICT ANTI-BLOAT RULE:
  // Write snapshot to disk ONLY if it was the first calibration run OR genuine new events were detected.
  if (isFirstRun) {
    console.log(`[RADAR] Calibrated baseline saved to snapshot (${snapshot.aa_known_slugs.length} AA models).`);
    saveSnapshot(snapshot);
  } else if (allEvents.length > 0) {
    console.log(`[RADAR] Saved updated snapshot with ${allEvents.length} new event(s).`);
    snapshot.last_updated = new Date().toISOString();
    saveSnapshot(snapshot);
  } else {
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
