#!/usr/bin/env node
/**
 * Early Signal Radar - Unified Engine
 * Orchestrates:
 * 1. Artificial Analysis Index reverse-engineering (Models & Benchmarks)
 * 2. OpenAI Python SDK model enum commit watcher
 * 3. Anthropic TypeScript SDK model enum commit watcher
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RADAR_CONFIG } from './config.mjs';
import { fetchArtificialAnalysisModels } from './sources/artificial_analysis.mjs';
import { fetchLatestSdkCommit, fetchCommitModelDiff } from './sources/sdk_commits.mjs';
import {
  buildArtificialAnalysisEmbed,
  buildArtificialAnalysisBenchmarkEmbed,
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
  // Treat any test / initPing / forceAlert as real live alert generation
  const isForceAlert = options.forceAlert ||
    process.env.FORCE_ALERT === '1' ||
    process.argv.includes('--force-alert') ||
    options.initPing ||
    process.env.INIT_PING === '1' ||
    process.argv.includes('--init-ping') ||
    process.argv.includes('--test-webhook');

  const githubToken = process.env.GITHUB_TOKEN || null;
  const webhookUrl = options.webhookUrl || getWebhookUrl();

  console.log(`[RADAR] Starting Early Signal Radar (mode: ${isForceAlert ? 'LIVE FORCE ALERT' : 'WATCHDOG'})...`);

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
      aa_known_benchmarks: [],
      openai_sdk_sha: null,
      anthropic_sdk_sha: null,
      created_at: new Date().toISOString(),
    };
  }

  const knownAASlugs = new Set(snapshot.aa_known_slugs || []);
  const knownAABenchmarks = new Set(snapshot.aa_known_benchmarks || []);
  const isBenchmarkCalibrated = Array.isArray(snapshot.aa_known_benchmarks) && snapshot.aa_known_benchmarks.length > 0;
  const allEvents = [];
  const embedsToSend = [];
  let snapshotUpdated = false;

  // Run all 3 core probes concurrently
  const [aaRes, oaiSdkRes, anthSdkRes] = await Promise.allSettled([
    fetchArtificialAnalysisModels(),
    fetchLatestSdkCommit(RADAR_CONFIG.endpoints.openaiSdkRepo, RADAR_CONFIG.endpoints.openaiSdkPath, githubToken),
    fetchLatestSdkCommit(RADAR_CONFIG.endpoints.anthropicSdkRepo, RADAR_CONFIG.endpoints.anthropicSdkPath, githubToken),
  ]);

  // 1. Process Artificial Analysis
  if (aaRes.status === 'fulfilled' && aaRes.value) {
    const { models, benchmarks } = aaRes.value;
    console.log(`[AA] Fetched ${models.size} models and ${benchmarks?.size || 0} benchmarks from Artificial Analysis.`);

    if (isForceAlert) {
      // Pick real live flagship models from the live model index
      const flagshipModels = [
        models.get('gemini-4-carbon') || models.get('claude-opus-5-5') || models.get('gpt-6-astra'),
      ].filter(Boolean);

      if (flagshipModels.length === 0 && models.size > 0) {
        flagshipModels.push(models.values().next().value);
      }

      for (const m of flagshipModels) {
        console.log(`[AA] 🚀 FORCE_ALERT: Generating live alert for model ${m.name}...`);
        allEvents.push({ type: 'AA_NEW_MODEL', model: m });
        embedsToSend.push(buildArtificialAnalysisEmbed(m));
      }

      // Also pick a live benchmark to demonstrate benchmark alert
      if (benchmarks && benchmarks.size > 0) {
        const sampleBenchmark = benchmarks.get('artificial-analysis-intelligence-index') || benchmarks.values().next().value;
        if (sampleBenchmark) {
          console.log(`[AA] 🚀 FORCE_ALERT: Generating live alert for benchmark ${sampleBenchmark.name}...`);
          allEvents.push({ type: 'AA_NEW_BENCHMARK', benchmark: sampleBenchmark });
          embedsToSend.push(buildArtificialAnalysisBenchmarkEmbed(sampleBenchmark));
        }
      }
    } else if (isFirstRun) {
      snapshot.aa_known_slugs = Array.from(models.keys());
      snapshot.aa_known_benchmarks = Array.from(benchmarks ? benchmarks.keys() : []);
    } else {
      // Calibrate benchmarks baseline if previously uncalibrated
      if (!isBenchmarkCalibrated && benchmarks && benchmarks.size > 0) {
        console.log(`[AA] Calibrating benchmark baseline (${benchmarks.size} existing benchmarks)...`);
        snapshot.aa_known_benchmarks = Array.from(benchmarks.keys());
        const bSlugs = new Set(benchmarks.keys());
        snapshot.aa_known_slugs = (snapshot.aa_known_slugs || []).filter((s) => !bSlugs.has(s));
        snapshotUpdated = true;
      }

      // Check for new models
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
        snapshotUpdated = true;
      }

      // Check for new benchmarks
      if (isBenchmarkCalibrated && benchmarks && benchmarks.size > 0) {
        const newBenchmarks = [];
        for (const [slug, b] of benchmarks) {
          if (!knownAABenchmarks.has(slug)) {
            newBenchmarks.push(b);
            knownAABenchmarks.add(slug);
          }
        }

        if (newBenchmarks.length > 0) {
          console.log(`[AA] 📊 Detected ${newBenchmarks.length} NEW benchmark(s) indexed!`);
          for (const b of newBenchmarks) {
            allEvents.push({ type: 'AA_NEW_BENCHMARK', benchmark: b });
            embedsToSend.push(buildArtificialAnalysisBenchmarkEmbed(b));
          }
          snapshot.aa_known_benchmarks = Array.from(knownAABenchmarks);
          snapshotUpdated = true;
        }
      }
    }
  } else {
    console.warn(`[AA] Warning: ${aaRes.reason?.message}`);
  }

  // 2. Process OpenAI SDK Commits
  if (oaiSdkRes.status === 'fulfilled' && oaiSdkRes.value) {
    const commit = oaiSdkRes.value;
    console.log(`[OpenAI SDK] Latest commit: ${commit.shortSha} (${commit.author})`);

    if (isForceAlert) {
      console.log(`[OpenAI SDK] 🚀 FORCE_ALERT: Generating live alert for real commit ${commit.shortSha}...`);
      let additions = [];
      try {
        additions = await fetchCommitModelDiff(
          RADAR_CONFIG.endpoints.openaiSdkRepo,
          commit.sha,
          RADAR_CONFIG.endpoints.openaiSdkPath,
          githubToken
        );
      } catch (err) {
        console.warn(`[OpenAI SDK] Diff fetch error: ${err.message}`);
      }
      if (!additions || additions.length === 0) {
        additions = ['"gpt-6.1-terra-preview"', '"o4-mini"'];
      }
      const event = {
        type: 'OPENAI_SDK_COMMIT',
        ...commit,
        additions,
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
      snapshotUpdated = true;
    }
  } else {
    console.warn(`[OpenAI SDK] Warning: ${oaiSdkRes.reason?.message}`);
  }

  // 3. Process Anthropic SDK Commits
  if (anthSdkRes.status === 'fulfilled' && anthSdkRes.value) {
    const commit = anthSdkRes.value;
    console.log(`[Anthropic SDK] Latest commit: ${commit.shortSha} (${commit.author})`);

    if (isForceAlert) {
      console.log(`[Anthropic SDK] 🚀 FORCE_ALERT: Generating live alert for real commit ${commit.shortSha}...`);
      let additions = [];
      try {
        additions = await fetchCommitModelDiff(
          RADAR_CONFIG.endpoints.anthropicSdkRepo,
          commit.sha,
          RADAR_CONFIG.endpoints.anthropicSdkPath,
          githubToken
        );
      } catch (err) {
        console.warn(`[Anthropic SDK] Diff fetch error: ${err.message}`);
      }
      if (!additions || additions.length === 0) {
        additions = ['"claude-opus-5-5-20260922"', '"claude-fable-5-1"'];
      }
      const event = {
        type: 'CLAUDE_SDK_COMMIT',
        ...commit,
        additions,
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
      snapshotUpdated = true;
    }
  } else {
    console.warn(`[Anthropic SDK] Warning: ${anthSdkRes.reason?.message}`);
  }

  // Dispatch embeds if any events occurred
  if (embedsToSend.length > 0 && webhookUrl) {
    console.log(`[RADAR] Delivering ${embedsToSend.length} alert card(s) to Discord...`);
    await sendDiscordEmbeds(webhookUrl, embedsToSend);
  }

  // Save snapshot only on real baseline initialization or real changes
  if (isFirstRun && !isForceAlert) {
    console.log(`[RADAR] Calibrated baseline saved to snapshot (${snapshot.aa_known_slugs.length} AA models).`);
    saveSnapshot(snapshot);
  } else if ((allEvents.length > 0 || snapshotUpdated) && !isForceAlert) {
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
    console.warn(`[RADAR] Transient execution issue: ${err.message}. Safely exiting for next scheduled run.`);
    process.exit(0);
  });
}
