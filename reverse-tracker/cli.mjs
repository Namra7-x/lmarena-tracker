#!/usr/bin/env node
/**
 * Early Feature & Major Signal Finder — Unified CLI Runner
 * Dynamic reverse-engineering engine for desktop apps & CLIs.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FAMILIES, COMPONENTS, generateScanId } from './registry/components.mjs';
import { discoverComponent } from './sources/index.mjs';
import { classifyChange, CHANGE_TYPE } from './fingerprint/classifier.mjs';
import { computeIdentityFingerprint } from './fingerprint/identity.mjs';
import { loadComponentState, saveComponentState } from './state/store.mjs';
import { downloadArtifact } from './acquisition/downloader.mjs';
import { extractArtifact } from './extraction/dispatcher.mjs';
import { extractStrings } from './extraction/strings.mjs';
import { extractApplicationUrls } from './extraction/urls.mjs';
import { extractSignalsFromAst } from './extraction/ast.mjs';
import { extractGoMetadata, isGoBinary, parseGoSignals } from './extraction/go.mjs';
import { extractSourceMapMetadata } from './extraction/sourcemap.mjs';
import { matchSignalsInText } from './finder/rules.mjs';
import { evaluateNoise, isHumanReadableString } from './finder/noise.mjs';
import { detectPlatformAsymmetry } from './finder/asymmetry.mjs';
import { scoreFinding, sortFindings, deduplicateFindings } from './finder/scorer.mjs';
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
  const tg = new TelegramClient(null, null, familyId);
  const topicId = tg.getTopicId(familyId);

  for (const compId of componentsToCheck) {
    try {
      const baseline = loadComponentState(STATE_DIR, compId);
      const candidate = await discoverComponent(compId);
      const classification = classifyChange(baseline, candidate);

      // One-time pipeline test: if this component has not yet sent its test alert for this version
      const needsOneTimeTest = (!baseline?.lastTestAlertVersion || baseline.lastTestAlertVersion !== candidate.version) && process.env.SKIP_TEST_RUN !== 'true';

      if (needsOneTimeTest) {
        console.log(`  🧪 ${compId}: One-time pipeline test pending for version ${candidate.version}. Queuing for test scan.`);
        changes.push({
          componentId: compId,
          family: COMPONENTS[compId].family,
          candidate,
          baseline,
          classification: { changeType: 'ONE_TIME_TEST', reason: 'One-time pipeline test scan' },
          isTestRun: true,
        });
        continue;
      }

      if (classification.changeType === CHANGE_TYPE.NO_CHANGE || classification.changeType === CHANGE_TYPE.DIAGNOSTIC_DRIFT) {
        console.log(`  ✓ ${compId}: Unchanged (${candidate.version})`);
      } else if (baseline?.alertedVersion === candidate.version) {
        console.log(`  ℹ️ ${compId}: Version ${candidate.version} already alerted. Syncing baseline silently.`);
        saveComponentState(STATE_DIR, compId, {
          ...baseline,
          version: candidate.version,
          releaseId: candidate.releaseId,
          identityFingerprint: classification.identityFingerprint,
          alertedVersion: candidate.version,
        });
      } else if (classification.changeType === CHANGE_TYPE.FIRST_RUN) {
        console.log(`  🆕 ${compId}: First run detected (${candidate.version}). Initializing baseline.`);
        firstRuns.push({
          componentId: compId,
          name: COMPONENTS[compId].name,
          version: candidate.version,
          candidate,
        });
      } else if (
        classification.changeType === CHANGE_TYPE.BYTE_CHANGE &&
        baseline &&
        baseline.version === candidate.version &&
        baseline.releaseId === candidate.releaseId
      ) {
        // Internal artifact URL/integrity change for the exact same release version
        // Update baseline identity fingerprint silently to avoid spamming identical versions
        console.log(`  🔄 ${compId}: Silently migrating identity fingerprint for existing version (${candidate.version})`);
        saveComponentState(STATE_DIR, compId, {
          ...baseline,
          identityFingerprint: classification.identityFingerprint,
          alertedVersion: candidate.version,
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
  const isTestRun = Boolean(options.isTestRun || options.force);
  const comp = COMPONENTS[componentId];
  if (!comp) throw new Error(`Unknown component ${componentId}`);

  console.log(`\n🚀 [Scan] Initiating deep scan for: ${comp.name} (${componentId})${isTestRun ? ' [TEST RUN]' : ''}`);
  const scanStartTime = performance.now();
  const baseline = loadComponentState(STATE_DIR, componentId) || {};
  const candidate = await discoverComponent(componentId);
  const scanId = generateScanId(componentId);
  const tg = new TelegramClient(null, null, comp.family, componentId);
  const topicId = tg.getTopicId(comp.family, componentId);

  // If this is a test run and we have already sent the test alert for this exact version, skip to avoid duplicate spam
  if (isTestRun && baseline.lastTestAlertVersion === candidate.version && !options.bypassDedup) {
    console.log(`ℹ️ [Test Run] Component ${componentId} already tested on version ${candidate.version}. Skipping duplicate test message.`);
    return { scanId: baseline.scanId, skipped: true, reason: 'ALREADY_TESTED' };
  }

  const analyzerStatus = {
    acornAst: 'skipped',
    goReSym: 'skipped',
    sourceMap: 'skipped',
    sevenZip: 'skipped',
    asar: 'skipped',
    tar: 'skipped',
    zip: 'skipped',
    multiEncodingScanner: 'completed',
  };

  // Step 1: Update-First Rule - Send Immediate Alert BEFORE downloading
  let alertMessageId = null;
  const isSameVersion = Boolean(baseline.version && baseline.version === candidate.version);
  const isAlreadyAlerted = !isTestRun && (isSameVersion || baseline.alertedVersion === candidate.version);

  if (!isAlreadyAlerted) {
    console.log(`📡 Sending immediate alert to Telegram for ${scanId}...`);
    const alertText = formatImmediateAlert({
      componentName: comp.name,
      family: comp.family,
      oldVersion: baseline.version,
      newVersion: candidate.version,
      scanId,
      targets: comp.primaryTargets,
      releaseUrl: candidate.artifacts?.[0]?.url,
      isTestRun,
    });

    try {
      const alertRes = await tg.sendMessage(alertText, { topicId });
      alertMessageId = alertRes?.result?.message_id;
      // Immediately mark as alerted in local state so retries/re-runs never spam
      baseline.alertedVersion = candidate.version;
      saveComponentState(STATE_DIR, componentId, {
        ...baseline,
        alertedVersion: candidate.version,
        ...(isTestRun ? { lastTestAlertVersion: candidate.version } : {}),
      });
    } catch (tgErr) {
      console.warn(`Could not send immediate alert: ${tgErr.message}`);
    }
  } else {
    console.log(`ℹ️ Immediate alert already sent for ${componentId} (${candidate.version}). Skipping duplicate alert.`);
  }

  // Step 2: Acquisition & Multi-Encoding Extraction
  console.log(`📦 Acquiring ${candidate.artifacts.length} target artifacts...`);
  const acquiredArtifacts = [];
  const allExtractedStrings = new Set();
  const allExtractedUrls = new Map();
  const astFindings = [];
  const goFindings = [];
  const macFindings = [];
  const winFindings = [];
  const allUnknownCandidates = [];

  for (const art of candidate.artifacts) {
    try {
      console.log(`   Downloading ${art.target} (${art.format})...`);
      const dl = await downloadArtifact(art);
      dl.sha256 = crypto.createHash('sha256').update(dl.buffer).digest('hex');
      acquiredArtifacts.push(dl);

      console.log(`   Extracting artifacts for ${art.target}...`);
      const { files, status: extractStatus } = extractArtifact(dl.buffer, art.format, art.target, art.url);

      if (extractStatus?.analyzers) {
        if (extractStatus.analyzers.sevenZip === 'completed') analyzerStatus.sevenZip = 'completed';
        else if (extractStatus.analyzers.sevenZip === 'failed') analyzerStatus.sevenZip = 'failed';
        if (extractStatus.analyzers.asar === 'completed') analyzerStatus.asar = 'completed';
        else if (extractStatus.analyzers.asar === 'failed') analyzerStatus.asar = 'failed';
        if (extractStatus.analyzers.tar === 'completed') analyzerStatus.tar = 'completed';
        if (extractStatus.analyzers.zip === 'completed') analyzerStatus.zip = 'completed';
      }

      for (const f of files) {
        // Application URL & endpoint scanner on all valid files
        if (f.buffer) {
          const fileUrls = extractApplicationUrls(f.buffer);
          for (const u of fileUrls) {
            if (!allExtractedUrls.has(u.url)) {
              allExtractedUrls.set(u.url, u);
            }
          }
        }

        // Fast string extraction from text files (priority 1)
        if (f.priority === 1 && f.buffer) {
          if (f.buffer.length <= 10 * 1024 * 1024) {
            const textContent = f.buffer.toString('utf8');
            const lines = textContent.split('\n');

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.length >= 4 && trimmed.length <= 1000) {
                allExtractedStrings.add(trimmed);
              }
            }
          } else {
            const textStrings = extractStrings(f.buffer);
            for (const s of textStrings) {
              if (s.value && s.value.length >= 4 && s.value.length <= 1000) {
                allExtractedStrings.add(s.value);
              }
            }
          }
        }

        // Multi-encoding binary string scan on priority binaries (priority 2 or executables)
        if (f.priority === 2 && f.buffer) {
          const binaryStrings = extractStrings(f.buffer);
          for (const s of binaryStrings) {
            if (s.value && s.value.length >= 4 && s.value.length <= 1000) {
              if (isHumanReadableString(s.value)) {
                allExtractedStrings.add(s.value);
              }
            }
          }
        }

        // JavaScript AST Intelligence Engine (Acorn)
        if (f.buffer && (f.path.endsWith('.js') || f.path.endsWith('.mjs') || f.path.endsWith('.cjs'))) {
          try {
            const jsCode = f.buffer.toString('utf8');
            const extracted = extractSignalsFromAst(jsCode, f.path);
            if (extracted && extracted.length > 0) {
              analyzerStatus.acornAst = 'completed';
              for (const ef of extracted) {
                ef.artifactSha256 = dl.sha256;
                allExtractedStrings.add(ef.value);
                if (ef.category === 'endpoint_domain' && !allExtractedUrls.has(ef.value)) {
                  allExtractedUrls.set(ef.value, {
                    url: ef.value,
                    category: 'internal_api',
                    confidence: 0.9,
                    origin: 'ast',
                  });
                }
                astFindings.push(ef);
              }
            } else if (analyzerStatus.acornAst === 'skipped') {
              analyzerStatus.acornAst = 'completed';
            }

            if (extracted?.unknownCandidates && Array.isArray(extracted.unknownCandidates)) {
              for (const uc of extracted.unknownCandidates) {
                uc.artifactSha256 = dl.sha256;
                allUnknownCandidates.push(uc);
              }
            }
          } catch {
            analyzerStatus.acornAst = 'failed';
          }
        }

        // Source Map Presence & Symbol Name Extraction
        if (f.path.endsWith('.map') || (f.buffer && f.buffer.includes('sourceMappingURL='))) {
          try {
            const smMeta = extractSourceMapMetadata(f.buffer);
            analyzerStatus.sourceMap = 'completed';
            if (Array.isArray(smMeta.names)) {
              for (const sym of smMeta.names) {
                if (sym && sym.length >= 4 && sym.length <= 120) {
                  allExtractedStrings.add(sym);
                }
              }
            }
          } catch {
            analyzerStatus.sourceMap = 'completed';
          }
        }

        // Go Binary Inspection (GoReSym)
        if (f.buffer && isGoBinary(f.buffer)) {
          try {
            const tmpGoPath = path.join(os.tmpdir(), `temp-go-${Date.now()}-${path.basename(f.path) || 'bin'}`);
            fs.writeFileSync(tmpGoPath, f.buffer);
            try {
              const goMeta = extractGoMetadata(tmpGoPath);
              if (goMeta.status === 'completed') {
                analyzerStatus.goReSym = 'completed';
                if (Array.isArray(goMeta.strings)) {
                  for (const s of goMeta.strings) {
                    if (s && s.length >= 4 && s.length <= 1000) {
                      allExtractedStrings.add(s);
                    }
                  }
                }
                const parsedSignals = parseGoSignals(goMeta, f.path);
                for (const sig of parsedSignals) {
                  goFindings.push(sig);
                }
              } else if (goMeta.status === 'failed') {
                analyzerStatus.goReSym = 'failed';
              }
            } finally {
              try { fs.unlinkSync(tmpGoPath); } catch {}
            }
          } catch {
            analyzerStatus.goReSym = 'failed';
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

    // Reject non-human-readable, unprintable, or corrupted binary noise
    if (!isHumanReadableString(str)) continue;

    // Filter through Noise Sieve - strictly drop any noise
    const noise = evaluateNoise(str);
    if (noise.isNoise) continue;
    newCleanStrings.push(str);
  }

  console.log(`   New clean strings in delta: ${newCleanStrings.length}`);

  // URL & Endpoint Delta
  const historicalSeenUrls = new Set(baseline.historicalSeenUrls || []);
  const newCleanUrls = [];
  for (const [url, item] of allExtractedUrls.entries()) {
    if (!historicalSeenUrls.has(url)) {
      newCleanUrls.push({ ...item, isNew: true });
    }
  }
  console.log(`   Application endpoints discovered: ${allExtractedUrls.size} (${newCleanUrls.length} new in this release)`);

  // Step 4: Dynamic Heuristic Leak Detection on newCleanStrings & AST / Go Findings
  const rawFindings = [];
  for (const str of newCleanStrings) {
    const matches = matchSignalsInText(str, '', 'delta');
    for (const m of matches) {
      rawFindings.push(m);
    }
  }

  // Integrate AST and GoReSym findings (preserving file paths and source offsets)
  for (const af of astFindings) {
    if (!historicalSeenHashes.has(af.value)) {
      rawFindings.push(af);
    }
  }
  for (const gf of goFindings) {
    if (!historicalSeenHashes.has(gf.value)) {
      rawFindings.push(gf);
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
    const isNew = isTestRun || diffResults.newFindings.some((nf) => nf.value === f.value);
    const isFirstEver = isTestRun || !historicalSeenHashes.has(f.value);
    return scoreFinding(f, { isNewInDiff: isNew, isFirstEverSeen: isFirstEver });
  });

  const sortedScored = sortFindings(scoredFindings);
  const dedupedFindings = deduplicateFindings(sortedScored);
  const majorSignals = dedupedFindings.filter((f) => f.isMajorEarlySignal);
  const highSignals = dedupedFindings.filter((f) => f.tier === 'HIGH-CONFIDENCE SIGNAL');
  const moreFindings = dedupedFindings.filter((f) => f.tier === 'EARLY SIGNAL');

  // Step 8: Empirical Benchmark & Generate Report Bundle
  const executionTimeMs = Math.round(performance.now() - scanStartTime);
  const heapUsage = process.memoryUsage();
  const peakMemoryMb = Math.round(heapUsage.heapUsed / 1024 / 1024);
  const rssMemoryMb = Math.round(heapUsage.rss / 1024 / 1024);
  const totalExtractedBytes = acquiredArtifacts.reduce((acc, a) => acc + (a.buffer ? a.buffer.length : 0), 0);

  const benchmark = {
    executionTimeMs,
    peakMemoryMb,
    rssMemoryMb,
    totalExtractedBytes,
    totalExtractedStrings,
    newCleanStringsCount: newCleanStrings.length,
    endpointsCount: allExtractedUrls.size,
    timestamp: new Date().toISOString(),
  };

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
    candidates: rawFindings,
    urlsInventory: Array.from(allExtractedUrls.values()),
    newUrls: newCleanUrls,
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
    unknownCandidates: allUnknownCandidates,
    artifactSha256: acquiredArtifacts[0]?.sha256 || null,
    benchmark,
  });

  console.log(`\n📊 Count Check Result:\n${reportBundle.countCheck.text}`);
  console.log(`⏱️ Empirical Benchmark: ${executionTimeMs}ms latency | ${peakMemoryMb}MB heap (${rssMemoryMb}MB RSS) | ${(totalExtractedBytes / (1024 * 1024)).toFixed(2)}MB analyzed | AST: ${analyzerStatus.acornAst}, Go: ${analyzerStatus.goReSym}`);

  // Alert Deduplication Key: SHA256(componentId:version:artifactSha256:findingsDigest)
  const artifactSha256 = crypto
    .createHash('sha256')
    .update(acquiredArtifacts.map((a) => a.hash || a.url || '').sort().join(','))
    .digest('hex');

  const findingsDigest = crypto
    .createHash('sha256')
    .update(sortedScored.map((f) => `${f.category}:${f.value}`).sort().join(';'))
    .digest('hex');

  const alertDeduplicationKey = crypto
    .createHash('sha256')
    .update(`${componentId}:${candidate.version}:${artifactSha256}:${findingsDigest}`)
    .digest('hex');

  const isDuplicateAlert = !isTestRun && Boolean(baseline.lastAlertDigest && baseline.lastAlertDigest === alertDeduplicationKey);

  // Step 9: Send Telegram Completion Message with Attached Files
  if (isDuplicateAlert) {
    console.log(`ℹ️ Duplicate alert digest ${alertDeduplicationKey.slice(0, 12)} already sent. Skipping Telegram completion message.`);
  } else {
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
      urlsCount: allExtractedUrls.size,
      newUrls: newCleanUrls,
      countCheckText: reportBundle.countCheck.text,
      isTestRun,
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

    // Upload the clean report files (leaks.txt, diff.txt, strings.txt, urls.txt)
    for (const file of reportBundle.telegramFiles) {
      try {
        console.log(`   Uploading ${path.basename(file)} to Telegram...`);
        await tg.sendDocument(file, `Scan ${scanId} - ${path.basename(file)}`, { topicId });
        await new Promise((r) => setTimeout(r, 500));
      } catch (docErr) {
        console.warn(`Could not upload ${path.basename(file)} to Telegram: ${docErr.message}`);
      }
    }
  }

  // Step 10: State Integrity — Advance baseline ONLY when coverageState === 'COMPLETE'
  if (coverageState === 'COMPLETE') {
    const identityFingerprint = candidate.identityFingerprint || computeIdentityFingerprint(candidate);
    const updatedSeenHashes = Array.from(
      new Set([...historicalSeenHashes, ...newCleanStrings])
    ).slice(0, 10000); // Retain up to 10,000 clean unique hashes

    const updatedSeenUrls = Array.from(
      new Set([...historicalSeenUrls, ...Array.from(allExtractedUrls.keys())])
    ).slice(0, 5000);

    saveComponentState(STATE_DIR, componentId, {
      version: candidate.version,
      alertedVersion: candidate.version,
      lastTestAlertVersion: candidate.version,
      releaseId: candidate.releaseId,
      channel: candidate.channel,
      identityFingerprint,
      scanId,
      coverageState,
      analyzerStatus,
      lastAlertDigest: alertDeduplicationKey,
      benchmark: { executionTimeMs, peakMemoryMb },
      hotSignals: majorSignals.slice(0, 100),
      recentSignals: sortedScored.slice(0, 2000),
      historicalSeenHashes: updatedSeenHashes,
      historicalSeenUrls: updatedSeenUrls,
    });
    console.log(`✅ Deep scan complete for ${componentId} (${scanId}). Baseline advanced (${coverageState}).`);
  } else {
    console.warn(`⚠️ Scan for ${componentId} achieved ${coverageState} coverage (${coveragePercentage}%). Preserving previous baseline version (${baseline.version || 'none'}).`);
    saveComponentState(STATE_DIR, componentId, {
      ...baseline,
      alertedVersion: candidate.version,
      lastTestAlertVersion: candidate.version,
      scanId,
      coverageState,
      analyzerStatus,
      lastFailureTime: new Date().toISOString(),
      benchmark: { executionTimeMs, peakMemoryMb },
    });
  }

  return { scanId, candidate, diffResults, reportBundle, coverageState, analyzerStatus, executionTimeMs };
}

/**
 * One-time test scan on latest versions for testing Telegram bots and leaks delivery.
 * Executes full deep scan, sends immediate test alert, uploads all report files (leaks.txt, diff.txt, strings.txt, urls.txt),
 * and marks the component as tested and alerted in baseline so it never repeats.
 */
async function handleTestRun(familyId = null, specificCompId = null, options = {}) {
  console.log(`\n🧪 [Test Run] Initiating one-time pipeline test on latest versions (Family: ${familyId || 'ALL'})...`);

  const componentsToTest = specificCompId
    ? [specificCompId]
    : familyId
      ? (FAMILIES[familyId]?.components || [])
      : Object.keys(COMPONENTS);

  console.log(`📋 Components queued for one-time test run (${componentsToTest.length}): ${componentsToTest.join(', ')}`);

  const results = [];
  for (const compId of componentsToTest) {
    try {
      console.log(`\n--- [Test Run] Scanning ${compId} ---`);
      const scanRes = await handleScan(compId, { force: true, isTestRun: true, ...options });
      results.push({ componentId: compId, success: true, scanRes });
    } catch (err) {
      console.error(`✗ [Test Run Error] Failed testing ${compId}: ${err.message}`);
      results.push({ componentId: compId, success: false, error: err.message });
    }
  }

  console.log(`\n🎉 [Test Run] Completed one-time pipeline test for ${familyId || 'ALL'}. Baseline updated.`);
  return results;
}

// CLI Command Parser
const args = process.argv.slice(2);
const command = args[0] || 'detect';

async function main() {
  if (command === 'detect') {
    const familyArg = args.find((a) => a.startsWith('--family='))?.replace(/^--family=/, '') || args[1] || null;
    const changes = await handleDetect(familyArg);
    if (changes.length > 0) {
      console.log(`\nFound ${changes.length} changed component(s).`);
    } else {
      console.log('\nAll components up-to-date.');
    }
  } else if (command === 'scan') {
    const compId = args.find((a) => a.startsWith('--component='))?.replace(/^--component=/, '') || args[1] || 'codex-cli';
    const forceFlag = args.includes('--force') || args.includes('--test-run');
    const bypassDedup = args.includes('--bypass-dedup');
    await handleScan(compId, { force: forceFlag, isTestRun: forceFlag, bypassDedup });
  } else if (command === 'test-run') {
    const familyArg = args.find((a) => a.startsWith('--family='))?.replace(/^--family=/, '') || null;
    const compArg = args.find((a) => a.startsWith('--component='))?.replace(/^--component=/, '') || null;
    const bypassDedup = args.includes('--bypass-dedup');
    await handleTestRun(familyArg, compArg, { bypassDedup });
  } else if (command === 'run') {
    const familyArg = args.find((a) => a.startsWith('--family='))?.replace(/^--family=/, '') || null;
    const isForcedTest = args.includes('--test-run') || args.includes('--force') || process.env.FORCE_TEST_RUN === 'true';

    if (isForcedTest) {
      console.log(`🧪 Detected force test run flag. Executing one-time test scan for family: ${familyArg || 'ALL'}...`);
      await handleTestRun(familyArg);
      return;
    }

    const changes = await handleDetect(familyArg);
    for (const change of changes) {
      try {
        await handleScan(change.componentId, { isTestRun: change.isTestRun, force: Boolean(change.isTestRun) });
      } catch (scanErr) {
        console.error(`✗ Error processing ${change.componentId}: ${scanErr.message}`);
      }
    }
  } else {
    console.log(`Unknown command: ${command}. Usage: node cli.mjs [detect|scan|run|test-run] [--family=<id>] [--component=<id>] [--force]`);
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
