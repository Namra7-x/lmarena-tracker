#!/usr/bin/env node
/**
 * Early Feature & Major Signal Finder — Unified CLI Runner
 * Dynamic reverse-engineering engine for desktop apps & CLIs.
 */

import path from 'node:path';
import fs from 'node:fs';
import { FAMILIES, COMPONENTS, generateScanId } from './registry/components.mjs';
import { discoverComponent } from './sources/index.mjs';
import { classifyChange, CHANGE_TYPE } from './fingerprint/classifier.mjs';
import { computeIdentityFingerprint } from './fingerprint/identity.mjs';
import { loadComponentState, saveComponentState } from './state/store.mjs';
import { downloadArtifact } from './acquisition/downloader.mjs';
import { extractArtifact } from './extraction/dispatcher.mjs';
import { extractStrings } from './extraction/strings.mjs';
import { matchSignalsInText } from './finder/rules.mjs';
import { evaluateNoise } from './finder/noise.mjs';
import { detectPlatformAsymmetry } from './finder/asymmetry.mjs';
import { scoreFinding, sortFindings } from './finder/scorer.mjs';
import { computeExactDiff } from './diff/engine.mjs';
import { generateReportBundle } from './reports/bundle.mjs';
import { TelegramClient } from './telegram/client.mjs';
import {
  formatImmediateAlert,
  formatCompletionMessage,
  formatBaselineCalibrationMessage,
} from './telegram/formatter.mjs';

const STATE_DIR = process.env.STATE_DIR || path.resolve(process.cwd(), 'state');
const REPORTS_DIR = process.env.REPORTS_DIR || path.resolve(process.cwd(), 'reports');

/**
 * Detect changes for a family or all components.
 * Manages clean first-run calibration without spamming files.
 */
async function handleDetect(familyId) {
  console.log(`\n🔍 [Detect] Checking components for family: ${familyId || 'ALL'}`);
  const componentsToCheck = familyId
    ? FAMILIES[familyId]?.components || []
    : Object.keys(COMPONENTS);

  const changes = [];
  const firstRuns = [];
  const tg = new TelegramClient();
  const topicId = tg.getTopicId(familyId);

  for (const compId of componentsToCheck) {
    try {
      const baseline = loadComponentState(STATE_DIR, compId);
      const candidate = await discoverComponent(compId);
      const classification = classifyChange(baseline, candidate);

      if (classification.changeType === CHANGE_TYPE.NO_CHANGE || classification.changeType === CHANGE_TYPE.DIAGNOSTIC_DRIFT) {
        console.log(`  ✓ ${compId}: Unchanged (${candidate.version})`);
      } else if (classification.changeType === CHANGE_TYPE.FIRST_RUN) {
        console.log(`  🆕 ${compId}: First run detected (${candidate.version}). Initializing baseline.`);
        firstRuns.push({
          componentId: compId,
          name: COMPONENTS[compId].name,
          version: candidate.version,
          candidate,
        });
      } else {
        console.log(`  🚨 ${compId}: ${classification.changeType} -> ${classification.reason}`);
        changes.push({
          componentId: compId,
          family: COMPONENTS[compId].family,
          candidate,
          baseline,
          classification,
        });
      }
    } catch (err) {
      console.error(`  ✗ Error checking ${compId}: ${err.message}`);
    }
  }

  // Handle FIRST_RUN cleanly: Initialize baseline without spamming files
  if (firstRuns.length > 0 && changes.length === 0) {
    console.log(`\n🚀 Initializing clean baseline for ${firstRuns.length} component(s)...`);
    for (const item of firstRuns) {
      const identityFingerprint = computeIdentityFingerprint(item.candidate);
      saveComponentState(STATE_DIR, item.componentId, {
        version: item.candidate.version,
        releaseId: item.candidate.releaseId,
        channel: item.candidate.channel || 'stable',
        identityFingerprint,
        scanId: generateScanId(item.componentId),
        coverageState: 'COMPLETE',
        hotSignals: [],
        recentSignals: [],
        historicalSeenHashes: [],
      });
    }

    // Initial run calibrated silently - zero spam messages sent
    console.log(`📡 Baseline calibrated silently for ${familyId || 'ALL'}. Zero spam messages sent.`);
    return []; // Return empty so handleScan doesn't dump spam files on first run!
  }

  return changes;
}

/**
 * Perform deep diff analysis on a changed component.
 */
async function handleScan(componentId, options = {}) {
  const comp = COMPONENTS[componentId];
  if (!comp) throw new Error(`Unknown component ${componentId}`);

  console.log(`\n🚀 [Scan] Initiating deep scan for: ${comp.name} (${componentId})`);
  const baseline = loadComponentState(STATE_DIR, componentId) || {};
  const candidate = await discoverComponent(componentId);
  const scanId = generateScanId(componentId);
  const tg = new TelegramClient();
  const topicId = tg.getTopicId(comp.family);

  // Step 1: Update-First Rule - Send Immediate Alert BEFORE downloading
  console.log(`📡 Sending immediate alert to Telegram for ${scanId}...`);
  const alertText = formatImmediateAlert({
    componentName: comp.name,
    family: comp.family,
    oldVersion: baseline.version,
    newVersion: candidate.version,
    scanId,
    targets: comp.primaryTargets,
    releaseUrl: candidate.artifacts?.[0]?.url,
  });

  let alertMessageId = null;
  try {
    const alertRes = await tg.sendMessage(alertText, { topicId });
    alertMessageId = alertRes?.result?.message_id;
  } catch (tgErr) {
    console.warn(`Could not send immediate alert: ${tgErr.message}`);
  }

  // Step 2: Acquisition & Multi-Encoding Extraction
  console.log(`📦 Acquiring ${candidate.artifacts.length} target artifacts...`);
  const acquiredArtifacts = [];
  const allExtractedStrings = new Set();
  const macFindings = [];
  const winFindings = [];

  for (const art of candidate.artifacts) {
    try {
      console.log(`   Downloading ${art.target} (${art.format})...`);
      const dl = await downloadArtifact(art);
      acquiredArtifacts.push(dl);

      console.log(`   Extracting artifacts for ${art.target}...`);
      const { files } = extractArtifact(dl.buffer, art.format, art.target, art.url);

      for (const f of files) {
        // Fast string extraction from text
        const textContent = f.buffer.toString('utf8');
        const lines = textContent.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length >= 4 && trimmed.length <= 1000) {
            allExtractedStrings.add(trimmed);
          }
        }

        // Multi-encoding binary string scan on priority binaries
        if (f.priority === 2) {
          const binaryStrings = extractStrings(f.buffer);
          for (const s of binaryStrings) {
            if (s.value && s.value.length >= 4 && s.value.length <= 1000) {
              allExtractedStrings.add(s.value);
            }
          }
        }
      }
    } catch (artErr) {
      console.error(`   ✗ Target ${art.target} acquisition error: ${artErr.message}`);
    }
  }

  const totalExtractedStrings = allExtractedStrings.size;
  console.log(`   Total distinct strings extracted: ${totalExtractedStrings}`);

  // Step 3: Compute String Set Delta (S_new = S_current \ S_baseline)
  const historicalSeenHashes = new Set(baseline.historicalSeenHashes || []);
  const newCleanStrings = [];

  for (const str of allExtractedStrings) {
    if (historicalSeenHashes.has(str)) continue;

    // Filter through Noise Sieve (Shannon entropy, CSS, Webpack boilerplate, base64)
    const noise = evaluateNoise(str);
    if (!noise.isNoise) {
      newCleanStrings.push(str);
    }
  }

  console.log(`   New clean strings in delta: ${newCleanStrings.length}`);

  // Step 4: Dynamic Heuristic Leak Detection on newCleanStrings
  const rawFindings = [];
  for (const str of newCleanStrings) {
    const matches = matchSignalsInText(str, '', 'delta');
    for (const m of matches) {
      rawFindings.push(m);
    }
  }

  console.log(`   Potential leak signals matched: ${rawFindings.length}`);

  // Step 5: Cross-platform Asymmetry
  const platformAsymmetry = detectPlatformAsymmetry(macFindings, winFindings);

  // Step 6: Exact Diff Engine
  const diffResults = computeExactDiff(
    baseline.recentSignals || [],
    rawFindings,
    historicalSeenHashes
  );

  // Step 7: Deterministic Scoring & Ranking
  const scoredFindings = rawFindings.map((f) => {
    const isNew = diffResults.newFindings.some((nf) => nf.value === f.value);
    const isFirstEver = !historicalSeenHashes.has(f.value);
    return scoreFinding(f, { isNewInDiff: isNew, isFirstEverSeen: isFirstEver });
  });

  const sortedScored = sortFindings(scoredFindings);
  const majorSignals = sortedScored.filter((f) => f.isMajorEarlySignal);
  const highSignals = sortedScored.filter((f) => f.tier === 'HIGH-CONFIDENCE SIGNAL');
  const moreFindings = sortedScored.filter((f) => f.tier === 'EARLY SIGNAL');

  // Step 8: Generate Report Bundle (leaks.txt, diff.txt, strings.txt)
  const coveragePercentage = candidate.artifacts.length > 0
    ? Math.round((acquiredArtifacts.length / candidate.artifacts.length) * 100)
    : 100;
  const coverageState = acquiredArtifacts.length === candidate.artifacts.length
    ? 'COMPLETE'
    : acquiredArtifacts.length > 0
    ? 'PARTIAL'
    : 'FAILED';

  const scanReportsDir = path.join(REPORTS_DIR, scanId);
  const reportBundle = generateReportBundle(scanReportsDir, {
    scanId,
    componentId,
    family: comp.family,
    version: candidate.version,
    oldVersion: baseline.version || 'unknown',
    diffResults: {
      ...diffResults,
      newFindings: newCleanStrings.map((s) => ({ value: s })),
    },
    scoredFindings: sortedScored,
    platformAsymmetry,
    coverage: {
      percentage: coveragePercentage,
      state: coverageState,
      macOk: macFindings.length > 0,
      winOk: winFindings.length > 0,
      failedArtifacts: candidate.artifacts.length - acquiredArtifacts.length,
    },
    totalExtractedStrings,
    artifactInventory: acquiredArtifacts,
  });

  console.log(`\n📊 Count Check Result:\n${reportBundle.countCheck.text}`);

  // Step 9: Send Telegram Completion Message with Attached Files
  const completionText = formatCompletionMessage({
    componentName: comp.name,
    family: comp.family,
    oldVersion: baseline.version || 'none',
    newVersion: candidate.version,
    scanId,
    counts: {
      commands: sortedScored.filter((f) => f.category === 'hidden_command').length,
      flags: sortedScored.filter((f) => f.category === 'feature_flag').length,
      configs: sortedScored.filter((f) => f.category === 'env_var').length,
      endpoints: sortedScored.filter((f) => f.category === 'endpoint_domain').length,
    },
    majorSignals,
    highSignals,
    moreFindings,
    leakCount: reportBundle.leaksCount,
    newStringsCount: newCleanStrings.length,
    countCheckText: reportBundle.countCheck.text,
  });

  try {
    if (alertMessageId) {
      await tg.sendMessage(completionText, { replyToMessageId: alertMessageId, topicId });
    } else {
      await tg.sendMessage(completionText, { topicId });
    }
  } catch (tgErr) {
    console.warn(`Could not send completion message: ${tgErr.message}`);
  }

  // Upload the 3 clean report files (leaks.txt, diff.txt, strings.txt)
  for (const file of reportBundle.telegramFiles) {
    try {
      console.log(`   Uploading ${path.basename(file)} to Telegram...`);
      await tg.sendDocument(file, `Scan ${scanId} - ${path.basename(file)}`, { topicId });
      await new Promise((r) => setTimeout(r, 500));
    } catch (docErr) {
      console.warn(`Could not upload ${path.basename(file)} to Telegram: ${docErr.message}`);
    }
  }

  // Step 10: Compact State Persistence
  if (coverageState !== 'FAILED') {
    const identityFingerprint = candidate.identityFingerprint || computeIdentityFingerprint(candidate);
    const updatedSeenHashes = Array.from(
      new Set([...historicalSeenHashes, ...newCleanStrings])
    ).slice(0, 25000); // Retain up to 25,000 recent unique hashes

    saveComponentState(STATE_DIR, componentId, {
      version: candidate.version,
      releaseId: candidate.releaseId,
      channel: candidate.channel,
      identityFingerprint,
      scanId,
      coverageState,
      hotSignals: majorSignals.slice(0, 100),
      recentSignals: sortedScored.slice(0, 2000),
      historicalSeenHashes: updatedSeenHashes,
    });
    console.log(`✅ Deep scan complete for ${componentId} (${scanId}). State updated (${coverageState}).`);
  } else {
    console.warn(`⚠️ Scan for ${componentId} FAILED required coverage. Baseline will not advance.`);
  }

  return { scanId, candidate, diffResults, reportBundle, coverageState };
}

// CLI Command Parser
const args = process.argv.slice(2);
const command = args[0] || 'detect';

async function main() {
  if (command === 'detect') {
    const familyArg = args[1]?.replace(/^--family=/, '') || null;
    const changes = await handleDetect(familyArg);
    if (changes.length > 0) {
      console.log(`\nFound ${changes.length} changed component(s).`);
    } else {
      console.log('\nAll components up-to-date.');
    }
  } else if (command === 'scan') {
    const compId = args[1]?.replace(/^--component=/, '') || 'codex-cli';
    await handleScan(compId);
  } else if (command === 'run') {
    const familyArg = args[1]?.replace(/^--family=/, '') || null;
    const changes = await handleDetect(familyArg);
    for (const change of changes) {
      try {
        await handleScan(change.componentId);
      } catch (scanErr) {
        console.error(`✗ Error processing ${change.componentId}: ${scanErr.message}`);
      }
    }
  } else {
    console.log(`Unknown command: ${command}. Usage: node cli.mjs [detect|scan|run] [--family=<id>] [--component=<id>]`);
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
