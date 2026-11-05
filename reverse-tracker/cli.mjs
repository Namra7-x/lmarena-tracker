#!/usr/bin/env node
/**
 * Early Feature & Major Signal Finder — Unified CLI Runner
 * Personal tool for static reverse analysis of desktop apps & CLIs across macOS & Windows.
 */

import path from 'node:path';
import fs from 'node:fs';
import { FAMILIES, COMPONENTS, generateScanId } from './registry/components.mjs';
import { discoverComponent } from './sources/index.mjs';
import { classifyChange, CHANGE_TYPE } from './fingerprint/classifier.mjs';
import { computeIdentityFingerprint } from './fingerprint/identity.mjs';
import { loadComponentState, saveComponentState, validateStateAdvancement } from './state/store.mjs';
import { downloadArtifact } from './acquisition/downloader.mjs';
import { extractArtifact } from './extraction/dispatcher.mjs';
import { extractStrings } from './extraction/strings.mjs';
import { matchSignalsInText } from './finder/rules.mjs';
import { detectPlatformAsymmetry } from './finder/asymmetry.mjs';
import { scoreFinding, sortFindings } from './finder/scorer.mjs';
import { computeExactDiff } from './diff/engine.mjs';
import { generateReportBundle } from './reports/bundle.mjs';
import { TelegramClient } from './telegram/client.mjs';
import { formatImmediateAlert, formatCompletionMessage } from './telegram/formatter.mjs';

const STATE_DIR = process.env.STATE_DIR || path.resolve(process.cwd(), 'state');
const REPORTS_DIR = process.env.REPORTS_DIR || path.resolve(process.cwd(), 'reports');

async function handleDetect(familyId) {
  console.log(`\n🔍 [Detect] Checking components for family: ${familyId || 'ALL'}`);
  const componentsToCheck = familyId
    ? FAMILIES[familyId]?.components || []
    : Object.keys(COMPONENTS);

  const changes = [];

  for (const compId of componentsToCheck) {
    try {
      const baseline = loadComponentState(STATE_DIR, compId);
      const candidate = await discoverComponent(compId);
      const classification = classifyChange(baseline, candidate);

      if (classification.changeType === CHANGE_TYPE.NO_CHANGE) {
        console.log(`  ✓ ${compId}: Unchanged (${candidate.version})`);
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

  return changes;
}

async function handleScan(componentId, options = {}) {
  const comp = COMPONENTS[componentId];
  if (!comp) throw new Error(`Unknown component ${componentId}`);

  console.log(`\n🚀 [Scan] Initiating deep scan for: ${comp.name} (${componentId})`);
  const baseline = loadComponentState(STATE_DIR, componentId) || {};
  const candidate = await discoverComponent(componentId);
  const scanId = generateScanId(componentId);
  const tg = new TelegramClient();

  const topicId = tg.getTopicId(comp.family);

  // Step 1: Update-First Rule (Section 1.2) - Send Immediate Alert BEFORE downloading
  console.log(`📡 Sending immediate alert to Telegram for ${scanId} (topic: ${topicId || 'default'})...`);
  const alertText = formatImmediateAlert({
    componentName: comp.name,
    family: comp.family,
    oldVersion: baseline.version,
    newVersion: candidate.version,
    scanId,
    targets: comp.primaryTargets,
    releaseUrl: candidate.artifacts?.[0]?.url,
  });
  const alertRes = await tg.sendMessage(alertText, { topicId });
  const alertMessageId = alertRes?.result?.message_id;

  // Step 2: Acquisition & Integrity
  console.log(`📦 Acquiring ${candidate.artifacts.length} target artifacts...`);
  const acquiredArtifacts = [];
  const macFindings = [];
  const winFindings = [];
  let totalExtractedStrings = 0;
  const rawFindings = [];

  for (const art of candidate.artifacts) {
    try {
      console.log(`   Downloading ${art.target} (${art.format})...`);
      const dl = await downloadArtifact(art);
      acquiredArtifacts.push(dl);

      // Step 3: Extraction
      console.log(`   Extracting and scanning strings for ${art.target}...`);
      const { files, status } = extractArtifact(dl.buffer, art.format, art.target, art.url);

      for (const f of files) {
        const textContent = f.buffer.toString('utf8');
        const lines = textContent.split('\n');

        // Text & signal matching
        for (const line of lines) {
          if (line.trim().length > 3) {
            const matches = matchSignalsInText(line, f.path, 'text');
            for (const m of matches) {
              m.platforms = art.target.includes('darwin') ? ['macOS'] : art.target.includes('win32') ? ['Windows'] : ['Linux'];
              rawFindings.push(m);
              if (art.target.includes('darwin')) macFindings.push(m);
              if (art.target.includes('win32')) winFindings.push(m);
            }
          }
        }

        // Multi-encoding string scan on binary files
        if (f.priority === 2) {
          const binaryStrings = extractStrings(f.buffer);
          totalExtractedStrings += binaryStrings.length;
          for (const s of binaryStrings) {
            const matches = matchSignalsInText(s.value, f.path, 'binary');
            for (const m of matches) {
              m.artifactClasses = ['binary'];
              rawFindings.push(m);
            }
          }
        }
      }
    } catch (artErr) {
      console.error(`   ✗ Target ${art.target} acquisition error: ${artErr.message}`);
    }
  }

  // Step 4: Cross-platform Asymmetry (Section 4.2)
  const platformAsymmetry = detectPlatformAsymmetry(macFindings, winFindings);

  // Step 5: Exact Diff Engine (Section 7)
  const historicalSeenHashes = new Set(baseline.historicalSeenHashes || []);
  const diffResults = computeExactDiff(baseline.recentSignals || [], rawFindings, historicalSeenHashes);

  // Step 6: Scoring & Tier Assignment (Section 4.3 & 4.4)
  const scoredFindings = rawFindings.map((f) => {
    const isNew = diffResults.newFindings.some((nf) => nf.value === f.value);
    const isFirstEver = !historicalSeenHashes.has(f.value);
    return scoreFinding(f, { isNewInDiff: isNew, isFirstEverSeen: isFirstEver });
  });

  const sortedScored = sortFindings(scoredFindings);
  const majorSignals = sortedScored.filter((f) => f.isMajorEarlySignal);
  const highSignals = sortedScored.filter((f) => f.tier === 'HIGH-CONFIDENCE SIGNAL');
  const moreFindings = sortedScored.filter((f) => f.tier === 'EARLY SIGNAL');

  // Step 7: Generate Report Bundle & Mandatory Count Check (Section 8.1)
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
    version: candidate.version,
    diffResults,
    scoredFindings: sortedScored,
    platformAsymmetry,
    coverage: {
      percentage: coveragePercentage,
      state: coverageState,
      macOk: macFindings.length > 0,
      winOk: winFindings.length > 0,
      failedArtifacts: candidate.artifacts.length - acquiredArtifacts.length,
    },
    totalExtractedStrings: totalExtractedStrings || rawFindings.length,
  });

  console.log(`\n📊 Count Check Result:\n${reportBundle.countCheck.text}`);

  // Step 8: Telegram Completion Message
  const completionText = formatCompletionMessage({
    componentName: comp.name,
    family: comp.family,
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
    countCheckText: reportBundle.countCheck.text,
  });

  if (alertMessageId) {
    await tg.sendMessage(completionText, { replyToMessageId: alertMessageId, topicId });
  } else {
    await tg.sendMessage(completionText, { topicId });
  }

  // Upload report files to Telegram
  for (const file of reportBundle.files) {
    try {
      await tg.sendDocument(file, `Scan ${scanId} - ${path.basename(file)}`, { topicId });
      // Gentle 500ms pacing between file uploads
      await new Promise((r) => setTimeout(r, 500));
    } catch (docErr) {
      console.warn(`Could not upload ${path.basename(file)} to Telegram: ${docErr.message}`);
    }
  }

  // Step 9: Compact State Persistence
  if (coverageState !== 'FAILED') {
    const identityFingerprint = candidate.identityFingerprint || computeIdentityFingerprint(candidate);
    const updatedSeenHashes = Array.from(
      new Set([...historicalSeenHashes, ...rawFindings.map((f) => f.value)])
    );

    saveComponentState(STATE_DIR, componentId, {
      version: candidate.version,
      releaseId: candidate.releaseId,
      channel: candidate.channel,
      identityFingerprint,
      scanId,
      coverageState,
      hotSignals: majorSignals.slice(0, 100),
      recentSignals: sortedScored.slice(0, 2000),
      historicalSeenHashes: updatedSeenHashes.slice(0, 10000),
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
