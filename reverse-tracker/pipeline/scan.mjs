/**
 * Deep scan, exact diff, report generation, and delivery pipeline.
 *
 * Invariants:
 *  - The immediate version-change Telegram message is sent first.
 *  - A delivery ledger/checkpoint is written immediately after that message,
 *    so a killed job resumes instead of sending the same alert again.
 *  - Baseline state only advances after a complete, fully delivered scan.
 *  - Every report is generated and uploaded, including empty reports.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { COMPONENTS, generateScanId } from '../registry/components.mjs';
import { discoverComponent } from '../sources/index.mjs';
import { computeIdentityFingerprint } from '../fingerprint/identity.mjs';
import {
  loadComponentState,
  saveComponentState,
  loadMasterState,
  saveMasterState,
  appendDeliveryLedger,
} from '../state/store.mjs';
import {
  baselineFromState,
  urlBaselineFromState,
  stringHistoryFromState,
  urlHistoryFromState,
  computeReleaseKey,
  diffStringSets,
  encodeStringSet,
  encodeUrlSet,
  mergeStringSets,
} from '../state/baseline.mjs';
import { checkpointState } from '../state/checkpoint.mjs';
import { downloadArtifact } from '../acquisition/downloader.mjs';
import { extractArtifact } from '../extraction/dispatcher.mjs';
import { extractStrings } from '../extraction/strings.mjs';
import { extractApplicationUrls } from '../extraction/urls.mjs';
import { extractSignalsFromAst } from '../extraction/ast.mjs';
import { extractGoMetadata, isGoBinary, parseGoSignals } from '../extraction/go.mjs';
import { extractSourceMapMetadata, extractInlineSourceMaps } from '../extraction/sourcemap.mjs';
import { matchSignalsInText, extractJsonPricingFindings, isValidModelIdentifier, isValidFeatureFlag, isValidAgentTool, isDarkUiNoise, CATEGORIES } from '../finder/rules.mjs';
import { evaluateNoise, isHumanReadableString, isThirdPartyPath } from '../finder/noise.mjs';
import { detectPlatformAsymmetry } from '../finder/asymmetry.mjs';
import { scoreFinding, sortFindings, deduplicateFindings, deduplicateAndClusterFindings } from '../finder/scorer.mjs';
import { computeExactDiff } from '../diff/engine.mjs';
import { generateReportBundle } from '../reports/bundle.mjs';
import { TelegramClient } from '../telegram/client.mjs';
import { formatImmediateAlert, formatCompletionMessage } from '../telegram/formatter.mjs';

const STATE_DIR = process.env.STATE_DIR || path.resolve(process.cwd(), 'state');
const REPORTS_DIR = process.env.REPORTS_DIR || path.resolve(process.cwd(), 'reports');
const DOWNLOAD_TIMEOUT_MS = Number.parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '300000', 10);
const MAX_ARTIFACT_BYTES = Number.parseInt(process.env.MAX_ARTIFACT_BYTES || String(1536 * 1024 * 1024), 10);
const MAX_BINARY_SCAN_BYTES = Number.parseInt(process.env.MAX_BINARY_SCAN_BYTES || String(512 * 1024 * 1024), 10);
const MAX_STRING_LENGTH = 4000;

function sleep(ms) {
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.FAST_TIMERS === 'true' ||
    process.env.DISABLE_STATE_CHECKPOINT === 'true'
  ) {
    return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function platformFromTarget(target) {
  const value = String(target || '').toLowerCase();
  if (value.includes('darwin') || value.includes('mac')) return 'darwin';
  if (value.includes('win32') || value.includes('windows')) return 'win32';
  if (value.includes('linux')) return 'linux';
  return 'all';
}

function artifactFileName(artifact) {
  try {
    return decodeURIComponent(new URL(artifact.url).pathname.split('/').pop() || 'artifact');
  } catch {
    return 'artifact';
  }
}

/**
 * Pick the next scan sequence for today. Two scans of the same component on
 * the same day (for example a retry followed by a new release) must not
 * overwrite each other's report directory.
 */
function nextScanId(componentId, baseline) {
  const now = new Date();
  const datePart = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const used = [
    baseline?.pendingDelivery?.scanId,
    ...(baseline?.releaseHistory || []).map((entry) => entry.scanId),
    ...(baseline?.deliveryLedger || []).map((entry) => entry.scanId),
  ].filter(Boolean);
  let maxSequence = 0;
  for (const scanId of used) {
    const match = String(scanId).match(new RegExp(`-${datePart}-(\\d+)$`));
    if (match) maxSequence = Math.max(maxSequence, Number.parseInt(match[1], 10));
  }
  return generateScanId(componentId, now, maxSequence + 1);
}

/**
 * Select the optimal target artifact to download and scan.
 * macOS-Only Strategy:
 * macOS is the primary target for all AI models, experimental features, and dark UI.
 * Single target selection cuts download bandwidth by 75% and ensures blazing fast execution.
 */
export function selectArtifacts(candidate, component) {
  const artifacts = Array.isArray(candidate.artifacts) ? candidate.artifacts : [];
  if (artifacts.length === 0) return [];

  // 1. Look for darwin-arm64 (Apple Silicon / M-series - primary macOS target)
  const darwinArm = artifacts.find((a) =>
    /darwin.*(?:arm64|aarch64|universal)|mac.*(?:arm64|universal)/i.test(`${a.target || ''} ${a.url || ''}`)
  );
  if (darwinArm) return [darwinArm];

  // 2. Look for general darwin / macOS (e.g. darwin-x64, mac-x64, Codex.dmg)
  const darwin = artifacts.find((a) =>
    /darwin|mac|\.dmg/i.test(`${a.target || ''} ${a.url || ''}`)
  );
  if (darwin) return [darwin];

  // 3. For platform-agnostic npm packages (e.g. codex-cli, claude-code with target: 'all' or .tgz)
  const universal = artifacts.find((a) => a.target === 'all' || /\.(?:tgz|tar\.gz)$/i.test(a.url || ''));
  if (universal) return [universal];

  // 4. Fallback if a component has no macOS build
  return [artifacts[0]];
}

function mergeAnalyzerStatus(target, source) {
  if (!source) return;
  for (const [name, value] of Object.entries(source)) {
    if (!value || value === 'skipped') {
      if (!target[name] || target[name] === 'skipped') target[name] = value || 'skipped';
      continue;
    }
    if (value === 'failed') {
      target[name] = target[name] === 'completed' ? 'completed' : 'failed';
    } else {
      target[name] = 'completed';
    }
  }
}

function makeStringCollector() {
  const allStrings = new Set();
  const stringMeta = new Map();
  const sourceMapStrings = new Set();

  function add(value, platform = 'all', filePath = '', source = 'text', isSourceMap = false) {
    if (typeof value !== 'string') return;
    const clean = value.trim();
    if (clean.length < 4 || clean.length > MAX_STRING_LENGTH) return;
    if (!/[a-zA-Z0-9\p{L}\p{N}]/u.test(clean)) return;

    allStrings.add(clean);
    if (!stringMeta.has(clean)) {
      stringMeta.set(clean, {
        platforms: new Set(),
        filePaths: new Set(),
        source,
      });
    }
    const meta = stringMeta.get(clean);
    if (platform) meta.platforms.add(platform);
    if (filePath) meta.filePaths.add(filePath);
    if (isSourceMap) sourceMapStrings.add(clean);
  }

  return { allStrings, stringMeta, sourceMapStrings, add };
}

function hasOverlongLine(text) {
  return String(text || '').split(/\r?\n/).some((line) => line.length > MAX_STRING_LENGTH);
}

function addTextLines(collector, text, platform, filePath, source = 'text', isSourceMap = false) {
  if (!text) return;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 4 && trimmed.length <= MAX_STRING_LENGTH) {
      collector.add(trimmed, platform, filePath, source, isSourceMap);
    }
  }
}

/**
 * Minified bundles and inline source maps often contain a single line much
 * longer than the readable-string cap. Line scanning alone would silently lose
 * all model IDs, flags, and human copy in that line, so fall back to the
 * multi-encoding string scanner for those files only.
 */
function addStringsFromOverlongText(collector, text, buffer, platform, filePath, source = 'text') {
  if (!text || !hasOverlongLine(text)) return;
  for (const item of extractStrings(buffer, { includeUnicode: true, maxLength: MAX_STRING_LENGTH, unpackGlued: false, machoAware: false })) {
    if (item.value.length >= 4 && item.value.length <= MAX_STRING_LENGTH) {
      collector.add(item.value, platform, filePath, source);
    }
  }
}

function processSourceMapBuffer(collector, buffer, filePath, platform, analyzerStatus) {
  if (!buffer) return;
  try {
    const meta = extractSourceMapMetadata(buffer);
    analyzerStatus.sourceMap = 'completed';
    for (const name of meta.names || []) collector.add(name, platform, filePath, 'sourcemap', true);
    for (const file of meta.files || []) {
      addTextLines(collector, file.content, platform, file.path || filePath, 'sourcemap', true);
      if (file.content) {
        addStringsFromOverlongText(
          collector,
          file.content,
          Buffer.from(file.content, 'utf8'),
          platform,
          file.path || filePath,
          'sourcemap',
        );
      }
    }
    return meta;
  } catch {
    analyzerStatus.sourceMap = 'failed';
    return null;
  }
}

function processInlineSourceMaps(collector, buffer, filePath, platform, analyzerStatus) {
  if (!buffer) return;
  try {
    const files = extractInlineSourceMaps(buffer);
    if (files.length > 0) {
      analyzerStatus.sourceMap = 'completed';
      for (const file of files) {
        addTextLines(collector, file.content, platform, file.path || filePath, 'sourcemap', true);
      }
    }
  } catch {
    analyzerStatus.sourceMap = 'failed';
  }
}

function dedupeRawFindings(findings) {
  const map = new Map();
  for (const finding of findings || []) {
    if (!finding || !finding.category || !finding.value) continue;
    const value = String(finding.value).trim();
    if (!value) continue;
    const key = `${finding.category}:${value.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...finding,
        value,
        platforms: Array.from(new Set(finding.platforms || [])),
        contexts: finding.context ? [finding.context] : [],
      });
      continue;
    }
    existing.platforms = Array.from(new Set([...(existing.platforms || []), ...(finding.platforms || [])]));
    if (finding.context && !existing.contexts.includes(finding.context)) {
      existing.contexts.push(finding.context);
      existing.contexts = existing.contexts.slice(0, 5);
    }
    if (!existing.filePath && finding.filePath) existing.filePath = finding.filePath;
    if (finding.sourceMapAgreement) existing.sourceMapAgreement = true;
    if (finding.related) existing.related = { ...(existing.related || {}), ...finding.related };
  }
  return Array.from(map.values());
}

function buildCoverage({ selectedArtifacts, acquired, extractionGaps, platformsWithFiles, analyzedFileCount, stringCount, analyzerStatus }) {
  const expectedArtifacts = selectedArtifacts.length;
  const downloadedArtifacts = acquired.length;
  const expectedPlatforms = new Set(selectedArtifacts.map((artifact) => platformFromTarget(artifact.target)));
  const macOk = !expectedPlatforms.has('darwin') || platformsWithFiles.has('darwin');
  const winOk = !expectedPlatforms.has('win32') || platformsWithFiles.has('win32');
  const linuxOk = !expectedPlatforms.has('linux') || platformsWithFiles.has('linux');

  let coverageState;
  if (downloadedArtifacts === 0) {
    coverageState = 'FAILED';
  } else if (
    downloadedArtifacts < expectedArtifacts ||
    extractionGaps.length > 0 ||
    analyzedFileCount === 0 ||
    analyzerStatus.sevenZip === 'failed'
  ) {
    coverageState = 'PARTIAL';
  } else {
    coverageState = 'COMPLETE';
  }

  const percentage = expectedArtifacts > 0
    ? Math.round((downloadedArtifacts / expectedArtifacts) * 100)
    : 0;

  return {
    coverageState,
    state: coverageState,
    percentage,
    expectedArtifacts,
    downloadedArtifacts,
    failedArtifacts: expectedArtifacts - downloadedArtifacts,
    analyzedFiles: analyzedFileCount,
    expectedPlatforms: Array.from(expectedPlatforms),
    macOk,
    winOk,
    linuxOk,
    extractionGaps,
  };
}

async function sendReportFile({ tg, file, scanId, componentName = '', version = '', topicId, delivery }) {
  const name = path.basename(file);
  const label = componentName ? `${componentName} ${version} · ` : '';
  let sent = false;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await tg.sendDocument(file, `Scan ${scanId} · ${label}${name}`, { topicId });
      if (res?.ok === true) {
        sent = true;
        break;
      }
      lastError = res?.error || 'Telegram rejected document';
    } catch (err) {
      lastError = err.message;
    }
    await sleep(500 * attempt);
  }

  if (sent) {
    delivery.deliveredFiles.push({ name, path: file });
    console.log(`   ✓ Uploaded ${name}`);
  } else {
    delivery.failedFiles.push({ name, path: file, error: lastError });
    console.warn(`   ✗ Upload failed for ${name}: ${lastError}`);
  }
  await sleep(350);
}

async function deliverReports({ tg, files, scanId, componentName, version, topicId, delivery, summaryPath }) {
  const allFiles = files.filter(Boolean);
  const reportFiles = allFiles.filter((file) => path.basename(file) !== 'scan-summary.txt');

  for (const file of reportFiles) {
    await sendReportFile({ tg, file, scanId, componentName, version, topicId, delivery });
  }

  // Rewrite the summary with the actual delivery outcome, then upload it last.
  if (summaryPath && fs.existsSync(summaryPath)) {
    try {
      let content = fs.readFileSync(summaryPath, 'utf8');
      const delivered = delivery.deliveredFiles.map((item) => item.name).join(', ') || 'none';
      const failed = delivery.failedFiles.map((item) => item.name).join(', ') || 'none';
      content = content.replace(
        /🚚 DELIVERY\n  • [^\n]*/,
        `🚚 DELIVERY\n  • ${delivery.failedFiles.length === 0 ? 'DELIVERED' : 'PARTIAL'} · delivered: ${delivered} · failed: ${failed}`,
      );
      fs.writeFileSync(summaryPath, content, 'utf8');
    } catch {
      // Summary rewrite is best-effort; the report set is still valid.
    }
    await sendReportFile({ tg, file: summaryPath, scanId, componentName, version, topicId, delivery });
  }
}

/**
 * Perform a full scan for one component. This function is safe to call for a
 * real version change, a resume, or a manual test run.
 */
export async function performScan(componentId, options = {}) {
  const comp = COMPONENTS[componentId];
  if (!comp) throw new Error(`Unknown component ${componentId}`);

  const isTestRun = Boolean(options.isTestRun || options.force);
  const stateDir = options.stateDir || STATE_DIR;
  const reportsDir = options.reportsDir || REPORTS_DIR;
  const scanStartTime = performance.now();
  const download = options.downloadArtifact || downloadArtifact;
  const extract = options.extractArtifact || extractArtifact;

  let baseline = loadComponentState(stateDir, componentId) || {};
  const candidate = options.candidate || await discoverComponent(componentId);
  if (!candidate?.version) throw new Error(`No version discovered for ${componentId}`);
  if (!Array.isArray(candidate.artifacts) || candidate.artifacts.length === 0) {
    throw new Error(`No downloadable artifacts discovered for ${componentId} ${candidate.version}`);
  }

  const releaseKey = computeReleaseKey(componentId, candidate);
  const pending = baseline.pendingDelivery;
  const samePending = Boolean(
    pending &&
    (pending.releaseKey === releaseKey || pending.version === candidate.version) &&
    pending.status !== 'DELIVERED' &&
    pending.alertSent !== false
  );
  const scanId = samePending && pending.scanId ? pending.scanId : nextScanId(componentId, baseline);
  const alreadyAlerted =
    baseline.alertedVersion === candidate.version ||
    baseline.version === candidate.version ||
    baseline.deliveredVersion === candidate.version ||
    samePending;

  if (
    isTestRun &&
    baseline.lastTestAlertVersion === candidate.version &&
    !samePending &&
    !options.bypassDedup
  ) {
    console.log(`ℹ️ [Test Run] ${componentId} already tested on ${candidate.version}. Skipping duplicate test.`);
    return { scanId: baseline.scanId, skipped: true, reason: 'ALREADY_TESTED' };
  }

  const tg = options.telegramClient || new TelegramClient(null, null, comp.family, componentId);
  const topicId = typeof tg.getTopicId === 'function' ? tg.getTopicId(comp.family, componentId) : undefined;

  const skipAlert = Boolean(options.skipAlert);
  const shouldAlert = skipAlert
    ? false
    : isTestRun
      ? (baseline.lastTestAlertVersion !== candidate.version || options.bypassDedup)
      : !alreadyAlerted;

  let alertSent = false;
  let alertMessageId = samePending ? pending.alertMessageId || null : null;

  // STEP 1: immediate alert, always before downloading.
  if (shouldAlert) {
    console.log(`📡 Sending immediate alert for ${componentId} ${baseline.version || 'none'} -> ${candidate.version}...`);
    const alertText = formatImmediateAlert({
      componentName: comp.name,
      family: comp.family,
      oldVersion: baseline.version || 'none',
      newVersion: candidate.version,
      scanId,
      targets: (candidate.artifacts || []).map((artifact) => artifact.target),
      releaseUrl: candidate.artifacts?.[0]?.url,
      isTestRun,
    });

    const alertRes = await tg.sendMessage(alertText, { topicId });
    if (alertRes?.ok === true) {
      alertSent = true;
      alertMessageId = alertRes.result?.message_id || null;
      console.log(`   ✓ Immediate alert sent (message ${alertMessageId || 'unknown'}).`);
    } else {
      console.error(`   ✗ Immediate alert failed: ${alertRes?.error || 'unknown Telegram error'}`);
    }

    // Checkpoint immediately. This is the line that prevents duplicate alerts
    // when the job dies during a large download or extraction.
    const alertCheckpoint = {
      ...baseline,
      schemaVersion: 2,
      observedVersion: candidate.version,
      coverageState: baseline.coverageState || 'BASELINE_ONLY',
      alertedVersion: alertSent ? candidate.version : baseline.alertedVersion || null,
      lastTestAlertVersion: isTestRun && alertSent ? candidate.version : baseline.lastTestAlertVersion || null,
      pendingDelivery: {
        scanId,
        version: candidate.version,
        releaseKey,
        status: 'ALERTED',
        alertSent,
        alertMessageId,
        expectedFiles: [],
        deliveredFiles: [],
        failedFiles: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      lastDeliveryStatus: alertSent ? 'ALERT_SENT' : 'ALERT_FAILED',
    };
    saveComponentState(stateDir, componentId, alertCheckpoint);
    checkpointState(stateDir, comp.family, `Alert sent for ${componentId} ${candidate.version}`);
    baseline = alertCheckpoint;
  } else {
    console.log(`ℹ️ No new alert for ${componentId} (${candidate.version}); resuming report delivery.`);
  }

  // STEP 2: acquisition and extraction.
  const selectedArtifacts = selectArtifacts(candidate, comp);
  console.log(`📦 Acquiring ${selectedArtifacts.length}/${candidate.artifacts?.length || 0} target artifacts...`);

  const collector = makeStringCollector();
  const allExtractedUrls = new Map();
  const directFindings = [];
  const unknownCandidates = [];
  const acquired = [];
  const extractionGaps = [];
  const platformsWithFiles = new Set();
  let analyzedFileCount = 0;
  const analyzerStatus = {
    acornAst: 'skipped',
    goReSym: 'skipped',
    sourceMap: 'skipped',
    sevenZip: 'skipped',
    asar: 'skipped',
    tar: 'skipped',
    zip: 'skipped',
    multiEncodingScanner: 'skipped',
  };
  let binaryFilesScanned = 0;
  const analyzedFileDigests = new Set();

  for (const artifact of selectedArtifacts) {
    let extractCleanup = null;
    try {
      console.log(`   Downloading ${artifact.target} (${artifact.format})...`);
      const dl = await download(artifact, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxSizeBytes: MAX_ARTIFACT_BYTES,
        maxRetries: 3,
      });
      dl.sha256 = dl.sha256 || crypto.createHash('sha256').update(dl.buffer).digest('hex');
      acquired.push({
        target: dl.target,
        format: dl.format,
        size: dl.size ?? dl.buffer?.length,
        sha256: dl.sha256,
        url: dl.url,
      });

      console.log(`   Extracting ${artifact.target}...`);
      const extractResult = extract(dl.buffer, artifact.format, artifact.target, artifact.url, { streamFromDisk: true });
      const { files, status: extractStatus } = extractResult;
      extractCleanup = typeof extractResult.cleanup === 'function' ? extractResult.cleanup : null;
      dl.buffer = null; // Release downloaded compressed artifact buffer immediately to avoid runner OOM
      if (extractStatus?.analyzers) mergeAnalyzerStatus(analyzerStatus, extractStatus.analyzers);
      if (extractStatus?.coverageState === 'PARTIAL') {
        extractionGaps.push(`${artifact.target}: extraction partial${extractStatus.error ? ` (${extractStatus.error})` : ''}`);
      }
      if (!files || files.length === 0) {
        extractionGaps.push(`${artifact.target}: no analyzable files extracted`);
      }

      const platform = platformFromTarget(artifact.target);

      for (const file of files || []) {
        let fileBuf = file?.buffer || null;
        if (!fileBuf && file?.fullPath && fs.existsSync(file.fullPath)) {
          try {
            fileBuf = fs.readFileSync(file.fullPath);
          } catch {
            continue;
          }
        }
        if (!fileBuf || fileBuf.length === 0) continue;

        platformsWithFiles.add(platform);
        analyzedFileCount++;

        // Deduplicate identical file contents within a scan so duplicate copies aren't analyzed twice
        const fileDigest = crypto.createHash('sha256').update(fileBuf).digest('hex');
        if (analyzedFileDigests.has(fileDigest)) {
          fileBuf = null;
          continue;
        }
        analyzedFileDigests.add(fileDigest);

        const lowerPath = String(file.path || '').toLowerCase();
        const isChromiumFrameworkBin = (
          lowerPath.includes('_codesignature/') ||
          /\.(?:css|scss|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|car|icns)$/i.test(lowerPath) ||
          lowerPath.includes('electron framework.framework') ||
          lowerPath.includes('squirrel.framework') ||
          lowerPath.includes('mantle.framework') ||
          lowerPath.includes('reactiveobjc.framework') ||
          lowerPath.includes('libffmpeg') ||
          lowerPath.includes('libglesv2') ||
          lowerPath.includes('vk_swiftshader') ||
          lowerPath.endsWith('icudtl.dat') ||
          lowerPath.endsWith('v8_context_snapshot.bin')
        );
        if (isChromiumFrameworkBin) {
          fileBuf = null;
          continue;
        }

        // URL / endpoint scanner works on text and binary buffers.
        try {
          const fileUrls = extractApplicationUrls(fileBuf);
          for (const item of fileUrls) {
            if (!item?.url) continue;
            const existing = allExtractedUrls.get(item.url);
            if (!existing) {
              allExtractedUrls.set(item.url, { ...item, platforms: [platform] });
            } else {
              existing.platforms = Array.from(new Set([...(existing.platforms || []), platform]));
            }
          }
        } catch {
          // URL extraction is best-effort per file.
        }

        // Text/config files: keep every line, including minified JSON tables.
        if (file.priority === 1) {
          const text = fileBuf.toString('utf8');
          addTextLines(collector, text, platform, file.path, 'text');
          addStringsFromOverlongText(collector, text, fileBuf, platform, file.path, 'text');
          if (/\.json$/i.test(file.path)) {
            for (const finding of extractJsonPricingFindings(text, file.path, 'json')) {
              finding.platforms = [platform];
              finding.artifactSha256 = dl.sha256;
              directFindings.push(finding);
              collector.add(finding.value, platform, file.path, 'ast');
            }
          }
        }

        // Binary / executable files: Mach-O section-aware multi-encoding string scanner.
        if (file.priority === 2) {
          binaryFilesScanned++;
          for (const s of extractStrings(fileBuf, { includeUnicode: true, maxLength: MAX_STRING_LENGTH })) {
            if (isHumanReadableString(s.value)) {
              collector.add(s.value, platform, file.path, 'binary');
            }
          }
        }

        // Source maps: sourcesContent is high-value reverse-engineering input
        if (file.path.endsWith('.map')) {
          processSourceMapBuffer(collector, fileBuf, file.path, platform, analyzerStatus);
        } else if (fileBuf.includes('sourceMappingURL=')) {
          processInlineSourceMaps(collector, fileBuf, file.path, platform, analyzerStatus);
        }

        // JavaScript AST (skip third-party node_modules AST churn for speed & precision; text strings are still collected)
        if (/\.(?:js|mjs|cjs)$/i.test(file.path) && !isThirdPartyPath(file.path)) {
          try {
            const jsCode = fileBuf.toString('utf8');
            const extracted = extractSignalsFromAst(jsCode, file.path);
            analyzerStatus.acornAst = 'completed';
            for (const finding of extracted || []) {
              finding.platforms = Array.from(new Set([...(finding.platforms || []), platform]));
              finding.filePath = finding.filePath || file.path;
              finding.artifactSha256 = dl.sha256;
              directFindings.push(finding);
              collector.add(finding.value, platform, file.path, 'ast');
            }
            for (const unknown of extracted?.unknownCandidates || []) {
              unknown.platforms = Array.from(new Set([...(unknown.platforms || []), platform]));
              unknown.artifactSha256 = dl.sha256;
              unknownCandidates.push(unknown);
            }
          } catch {
            analyzerStatus.acornAst = 'failed';
          }
        }

        // Go binaries (strictly gated behind binary priority to avoid testing text/JS files)
        if (file.priority === 2 && isGoBinary(fileBuf)) {
          let tmpGoPath = null;
          try {
            tmpGoPath = path.join(os.tmpdir(), `temp-go-${Date.now()}-${path.basename(file.path) || 'bin'}`);
            fs.writeFileSync(tmpGoPath, fileBuf);
            const goMeta = extractGoMetadata(tmpGoPath);
            if (goMeta.status === 'completed') {
              analyzerStatus.goReSym = 'completed';
              for (const value of goMeta.strings || []) {
                if (value && value.length >= 4 && value.length <= MAX_STRING_LENGTH) {
                  collector.add(value, platform, file.path, 'goresym');
                }
              }
              for (const finding of parseGoSignals(goMeta, file.path)) {
                finding.platforms = Array.from(new Set([...(finding.platforms || []), platform]));
                finding.filePath = finding.filePath || file.path;
                finding.artifactSha256 = dl.sha256;
                directFindings.push(finding);
              }
            } else if (goMeta.status === 'failed') {
              analyzerStatus.goReSym = 'failed';
            }
          } catch {
            analyzerStatus.goReSym = 'failed';
          } finally {
            if (tmpGoPath) {
              try { fs.unlinkSync(tmpGoPath); } catch {}
            }
          }
        }

        // Release per-file buffer immediately after scanning
        fileBuf = null;
        if (file.lazyDisk) file.buffer = null;
      }
    } catch (err) {
      extractionGaps.push(`${artifact.target}: ${err.message}`);
      console.error(`   ✗ Target ${artifact.target} failed: ${err.message}`);
    } finally {
      if (extractCleanup) extractCleanup();
    }
  }

  const allExtractedStringCount = collector.allStrings.size;
  console.log(`   Total distinct strings extracted: ${allExtractedStringCount}`);

  // STEP 3: clean current set. Noise filtering happens before diff/reporting so
  // the baseline stays compact and the strings report is genuinely readable.
  const currentCleanStrings = [];
  for (const value of collector.allStrings) {
    if (!isHumanReadableString(value)) continue;
    if (evaluateNoise(value).isNoise) continue;
    currentCleanStrings.push(value);
  }
  currentCleanStrings.sort();

  // Load dedicated product master state (.json.gz) BEFORE string/URL diff so it acts as resilient fallback
  const masterState = loadMasterState(stateDir, componentId);
  const rawMasterSignals = masterState?.knownSignals || {};
  // Purge stale polluted findings stored in legacy state/all baselines before diffing.
  const isPlausibleStoredSignal = (f) => {
    if (!f || !f.value || !f.category) return false;
    if (String(f.filePath || '').toLowerCase().includes('_codesignature/')) return false;
    if (evaluateNoise(f.value).isNoise) return false;
    if (f.category === CATEGORIES.MODEL_ID && !isValidModelIdentifier(f.value, { isStructuralCatalog: Boolean(f.discoveryMethod && f.discoveryMethod.startsWith('ast_')) })) {
      return false;
    }
    if ((f.category === CATEGORIES.FEATURE_FLAG || f.category === CATEGORIES.EXPERIMENT) && !isValidFeatureFlag(f.value)) {
      return false;
    }
    if (f.category === CATEGORIES.AGENT_MODE && !isValidAgentTool(f.value)) {
      return false;
    }
    if (f.category === CATEGORIES.HIDDEN_COMMAND && (!/^[a-z0-9_-]{2,55}$/i.test(f.value.trim()) || /^[A-Z0-9_]+$/.test(f.value.trim()))) {
      return false;
    }
    if (f.category === CATEGORIES.UI_STRING && isDarkUiNoise(f.value)) {
      return false;
    }
    return true;
  };
  const masterSignals = {};
  for (const [k, v] of Object.entries(rawMasterSignals)) {
    if (isPlausibleStoredSignal(v)) masterSignals[k] = v;
  }

  const baselineStrings = baselineFromState(baseline);
  const previousStrings = baselineStrings.length > 0
    ? baselineStrings
    : (Array.isArray(masterState.lastVersionStrings) && masterState.lastVersionStrings.length > 0
        ? masterState.lastVersionStrings
        : (masterState.knownStrings || []));
  const stringHistory = mergeStringSets(
    stringHistoryFromState(baseline, baseline.historicalSeenHashes || []),
    masterState.knownStrings || [],
  );
  const stringDiff = diffStringSets(previousStrings, currentCleanStrings, stringHistory);
  console.log(`   Clean strings: ${stringDiff.counts.current} (${stringDiff.counts.added} new, ${stringDiff.counts.removed} removed, ${stringDiff.counts.reintroduced} reintroduced)`);

  // URL delta.
  const currentUrls = Array.from(allExtractedUrls.values());
  const currentUrlValues = currentUrls.map((item) => item.url);
  const baselineUrls = urlBaselineFromState(baseline);
  const previousUrls = baselineUrls.length > 0
    ? baselineUrls
    : (Array.isArray(masterState.lastVersionUrls) && masterState.lastVersionUrls.length > 0
        ? masterState.lastVersionUrls
        : (masterState.knownUrls || []));
  const urlHistory = mergeStringSets(
    urlHistoryFromState(baseline, previousUrls),
    masterState.knownUrls || [],
  );
  const urlDiff = diffStringSets(previousUrls, currentUrlValues, urlHistory);
  const addedUrlSet = new Set(urlDiff.added);
  const newUrls = currentUrls.filter((item) => addedUrlSet.has(item.url));
  console.log(`   Endpoints discovered: ${currentUrls.length} (${newUrls.length} new)`);

  // STEP 4: Delta-First signal matching.
  const isFirstBaselineRun = previousStrings.length === 0;
  const stringsToScan = (isFirstBaselineRun || (isTestRun && stringDiff.added.length === 0) || options.fullScan)
    ? currentCleanStrings
    : [...stringDiff.added, ...stringDiff.reintroduced];

  const textFindings = [];
  for (const value of stringsToScan) {
    if (value.length > MAX_STRING_LENGTH) continue;
    const meta = collector.stringMeta.get(value);
    const platform = meta?.platforms?.values().next().value || 'all';
    const filePath = meta?.filePaths?.values().next().value || '';
    const matches = matchSignalsInText(value, filePath, 'string');
    for (const match of matches) {
      match.platforms = Array.from(meta?.platforms || [platform]);
      if (collector.sourceMapStrings.has(value)) match.sourceMapAgreement = true;
      textFindings.push(match);
    }
  }

  // Load and re-validate previous baseline signals (automatically strips historical noise)
  const previousFindings = dedupeRawFindings([
    ...(baseline.recentSignals || []),
    ...(baseline.hotSignals || []),
    ...(baseline.knownSignals ? Object.values(baseline.knownSignals) : []),
    ...Object.values(masterSignals),
  ]).filter(isPlausibleStoredSignal);

  // Track historical finding keys (normalized lowercase)
  const historicalFindingValues = new Set([
    ...stringHistory,
    ...(masterState.knownStrings || []),
    ...(baseline.historicalSeenHashes || []),
    ...previousFindings.map((f) => `${String(f.category || '').toLowerCase()}:${String(f.value || '').toLowerCase()}`),
    ...previousFindings.map((f) => String(f.value || '').toLowerCase()),
  ]);

  // Identify previously known signals that remain genuinely active in the current release
  const currentStringLookup = new Set(currentCleanStrings);
  const currentLowerLookup = new Set(currentCleanStrings.map((s) => s.toLowerCase()));
  const directKeyLookup = new Set(
    [...textFindings, ...directFindings].map((f) => `${String(f.category || '').toLowerCase()}:${String(f.value || '').toLowerCase()}`)
  );
  const removedLowerSet = new Set((stringDiff.removed || []).map((s) => s.toLowerCase()));
  const activePreviousFindings = [];
  for (const prev of previousFindings) {
    const prevKey = `${String(prev.category || '').toLowerCase()}:${String(prev.value || '').toLowerCase()}`;
    const prevValLower = String(prev.value || '').toLowerCase();
    const isStillActive = (
      directKeyLookup.has(prevKey) ||
      currentStringLookup.has(prev.value) ||
      currentLowerLookup.has(prevValLower) ||
      (prev.context && (currentStringLookup.has(prev.context) || currentLowerLookup.has(String(prev.context).toLowerCase()))) ||
      (prev.origin === 'ast' && !removedLowerSet.has(prevValLower) && !stringDiff.removed.includes(prev.value))
    );
    if (isStillActive) {
      activePreviousFindings.push({ ...prev, diffStatus: 'persistent' });
    }
  }

  const allCandidateFindings = dedupeRawFindings([...textFindings, ...directFindings, ...activePreviousFindings]);
  const diffResults = computeExactDiff(previousFindings, allCandidateFindings, historicalFindingValues, masterSignals);
  const allFindings = allCandidateFindings;

  // STEP 5: score, rank, deduplicate, and cluster related findings.
  const keyOf = (finding) => `${String(finding.category || '').toLowerCase()}:${String(finding.value || '').toLowerCase()}`;
  const newKeySet = new Set(diffResults.newFindings.map(keyOf));
  const changedKeySet = new Set(diffResults.changedFindings.map(keyOf));
  const persistentKeySet = new Set(diffResults.persistentFindings.map(keyOf));
  const reintroducedKeySet = new Set(diffResults.reintroducedFindings.map(keyOf));

  const scoredFindings = allFindings.map((finding) => {
    const key = keyOf(finding);
    const valLower = String(finding.value || '').toLowerCase();
    const isMasterKnown = Boolean(masterSignals[key] || masterSignals[valLower]);
    const diffStatus = newKeySet.has(key)
      ? 'NEW'
      : changedKeySet.has(key)
        ? 'CHANGED'
        : persistentKeySet.has(key)
          ? 'PERSISTENT'
          : reintroducedKeySet.has(key)
            ? 'REINTRODUCED'
            : isMasterKnown
              ? 'PERSISTENT'
              : 'NEW';
    return {
      ...scoreFinding(finding, {
        isNewInDiff: diffStatus === 'NEW' || diffStatus === 'CHANGED',
        isFirstEverSeen: !historicalFindingValues.has(valLower) && !historicalFindingValues.has(key) && !isMasterKnown,
      }),
      diffStatus,
    };
  });
  const sortedScored = sortFindings(scoredFindings);
  const dedupedFindings = deduplicateAndClusterFindings(sortedScored);

  // Strictly NEW-only filtering: alerts and leaks.txt show genuinely NEW clean discoveries only
  // (excluding persistent baseline noise and chunk/context MODIFIED chatter).
  const displayFindings = isTestRun
    ? dedupedFindings.filter((finding) => finding.score >= 35 || finding.diffStatus === 'NEW')
    : dedupedFindings.filter((finding) => finding.diffStatus === 'NEW' && finding.score >= 35);
  const majorSignals = displayFindings.filter((finding) => finding.isMajorEarlySignal);
  const highSignals = displayFindings.filter(
    (finding) => finding.tier === 'HIGH-CONFIDENCE SIGNAL' && !finding.isMajorEarlySignal,
  );
  const changedSignals = [];
  const moreFindings = displayFindings.filter(
    (finding) => finding.tier === 'EARLY SIGNAL' && !finding.isMajorEarlySignal,
  );
  const pricingSignals = displayFindings.filter((finding) => finding.category === 'pricing');
  const modelCount = displayFindings.filter((finding) => finding.category === 'model_id').length;

  // Platform asymmetry from the actual per-platform findings.
  const macFindings = allFindings.filter((finding) => (finding.platforms || []).includes('darwin'));
  const winFindings = allFindings.filter((finding) => (finding.platforms || []).includes('win32'));
  const platformAsymmetry = detectPlatformAsymmetry(macFindings, winFindings);

  // STEP 6: coverage. A successful HTTP download is not complete coverage.
  analyzerStatus.multiEncodingScanner = binaryFilesScanned > 0 ? 'completed' : 'skipped';
  const coverage = buildCoverage({
    selectedArtifacts,
    acquired,
    extractionGaps,
    platformsWithFiles,
    analyzedFileCount,
    stringCount: currentCleanStrings.length,
    analyzerStatus,
  });

  // STEP 7: reports.
  const executionTimeMs = Math.round(performance.now() - scanStartTime);
  const heapUsage = process.memoryUsage();
  const totalExtractedBytes = acquired.reduce((sum, artifact) => sum + (artifact.size || 0), 0);
  const artifactSha256 = acquired.length > 0
    ? crypto.createHash('sha256').update(acquired.map((artifact) => artifact.sha256).sort().join(',')).digest('hex')
    : null;
  const benchmark = {
    executionTimeMs,
    peakMemoryMb: Math.round(heapUsage.heapUsed / 1024 / 1024),
    rssMemoryMb: Math.round(heapUsage.rss / 1024 / 1024),
    totalExtractedBytes,
    totalExtractedStrings: allExtractedStringCount,
    newCleanStringsCount: stringDiff.counts.added,
    endpointsCount: currentUrls.length,
    timestamp: new Date().toISOString(),
  };

  const scanReportsDir = path.join(reportsDir, scanId);
  const reportBundle = generateReportBundle(scanReportsDir, {
    scanId,
    componentId,
    family: comp.family,
    version: candidate.version,
    oldVersion: baseline.version || 'unknown',
    versionScheme: candidate.versionScheme || null,
    isTestRun,
    diffResults,
    stringDiff,
    scoredFindings: dedupedFindings,
    candidates: allFindings,
    urlsInventory: currentUrls,
    newUrls,
    platformAsymmetry,
    coverage,
    totalExtractedStrings: allExtractedStringCount,
    artifactInventory: acquired.map((artifact) => ({
      target: artifact.target,
      format: artifact.format || '',
      size: artifact.size,
      sha256: artifact.sha256,
      url: artifact.url,
    })),
    unknownCandidates,
    artifactSha256,
    analyzerStatus,
    delivery: {
      status: 'PENDING',
      deliveredFiles: [],
      failedFiles: [],
    },
    benchmark,
  });

  console.log(`\n📊 Count Check Result:\n${reportBundle.countCheck.text}`);

  // STEP 8: upload reports ONLY if at least 1 artifact was actually acquired & scanned.
  // When download fails completely (e.g. transient npm CDN 404), hold pendingDelivery
  // quietly for the next tick instead of spamming 6 empty placeholder files to Telegram.
  const delivery = {
    status: 'PENDING',
    deliveredFiles: [],
    failedFiles: [],
    completionSent: false,
    completionError: null,
  };
  if (coverage.coverageState === 'FAILED' || acquired.length === 0) {
    delivery.status = 'DOWNLOAD_FAILED';
    console.warn(`⚠️ Skipping Telegram delivery for ${componentId} (${candidate.version}): 0 artifacts acquired (will retry next run).`);
  } else {
    await deliverReports({
      tg,
      files: reportBundle.telegramFiles,
      scanId,
      componentName: comp.name,
      version: candidate.version,
      topicId,
      delivery,
      summaryPath: reportBundle.telegramFiles.find((file) => path.basename(file) === 'scan-summary.txt'),
    });

    delivery.status = delivery.failedFiles.length === 0 ? 'DELIVERED' : 'PARTIAL';
    const attachedFileNames = delivery.deliveredFiles.map((item) => item.name);
    const completionText = formatCompletionMessage({
      componentName: comp.name,
      family: comp.family,
      oldVersion: baseline.version || 'none',
      newVersion: candidate.version,
      scanId,
      majorSignals,
      highSignals,
      changedSignals,
      moreFindings,
      coverage,
      leakCount: reportBundle.leaksCount,
      newStringsCount: stringDiff.counts.added,
      urlsCount: currentUrls.length,
      newUrls,
      attachedFiles: attachedFileNames,
      deliveryStatus: delivery,
      analyzerStatus,
      pricingSignals,
      modelCount,
      pricingCount: pricingSignals.length,
      countCheckText: reportBundle.countCheck.text,
      isTestRun,
    });

    let completionError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const completionRes = alertMessageId
          ? await tg.sendMessage(completionText, { replyToMessageId: alertMessageId, topicId })
          : await tg.sendMessage(completionText, { topicId });
        if (completionRes?.ok === true) {
          delivery.completionSent = true;
          break;
        }
        completionError = completionRes?.error || 'Telegram rejected completion message';
      } catch (err) {
        completionError = err.message;
      }
      await sleep(750 * attempt);
    }
    delivery.completionError = completionError;
    if (!delivery.completionSent) console.warn(`Could not send completion message: ${completionError}`);
  }

  // STEP 9: state transaction. Advance only when the scan was complete and
  // every report was actually delivered.
  const allFilesDelivered = delivery.failedFiles.length === 0;
  const canAdvance = (
    coverage.coverageState === 'COMPLETE' &&
    allFilesDelivered &&
    delivery.completionSent &&
    (alertSent || alreadyAlerted || skipAlert)
  );

  const scannedAt = new Date().toISOString();
  const pendingDelivery = canAdvance ? null : {
    scanId,
    version: candidate.version,
    releaseKey,
    status: coverage.coverageState !== 'COMPLETE'
      ? 'PARTIAL'
      : (!delivery.completionSent ? 'COMPLETION_FAILED' : 'DELIVERY_FAILED'),
    alertSent: alertSent || alreadyAlerted || skipAlert,
    alertMessageId,
    expectedFiles: reportBundle.telegramFiles.map((file) => path.basename(file)),
    deliveredFiles: delivery.deliveredFiles.map((item) => item.name),
    failedFiles: delivery.failedFiles.map((item) => item.name),
    coverageState: coverage.coverageState,
    createdAt: pending?.createdAt || scannedAt,
    updatedAt: scannedAt,
  };

  const updatedHistoricalStrings = mergeStringSets(
    baseline.historicalSeenHashes || [],
    currentCleanStrings,
  );
  const updatedHistoricalUrls = mergeStringSets(
    baseline.historicalSeenUrls || [],
    currentUrlValues,
  );

  // Rebuild cleaned knownSignals (automatically strips poisoned historical junk)
  const updatedKnownSignals = { ...masterSignals };
  for (const f of dedupedFindings) {
    if (f.category && f.value && f.score > 0 && f.status !== 'rejected') {
      const k = `${f.category}:${f.value.toLowerCase()}`;
      updatedKnownSignals[k] = {
        category: f.category,
        value: f.value,
        score: f.score,
        tier: f.tier,
        activationStatus: f.activationStatus,
        filePath: f.filePath,
        context: typeof f.context === 'string' ? f.context.slice(0, 300) : '',
        url: f.url || null,
        discoveryMethod: f.discoveryMethod || null,
        firstSeenVersion: updatedKnownSignals[k]?.firstSeenVersion || candidate.version,
        lastSeenVersion: candidate.version,
        modifiedAt: scannedAt,
      };
    }
  }

  const releaseHistory = canAdvance
    ? [{
        version: candidate.version,
        releaseKey,
        scanId,
        scannedAt,
        deliveredAt: scannedAt,
        artifactSha256,
        stringCount: stringDiff.counts.current,
        urlCount: currentUrls.length,
      }, ...(baseline.releaseHistory || [])].slice(0, 100)
    : (baseline.releaseHistory || []);

  // Store lightweight compact entries in <componentId>.json (<100 KB total) while keeping
  // complete string baselines, URL history, and signal archive inside gzipped _master.json.gz.
  const shrinkForState = (sig) => ({
    category: sig.category,
    value: sig.value,
    score: sig.score,
    tier: sig.tier,
    activationStatus: sig.activationStatus,
    diffStatus: sig.diffStatus,
    filePath: sig.filePath || '',
    discoveryMethod: sig.discoveryMethod || null,
    isMajorEarlySignal: Boolean(sig.isMajorEarlySignal),
    platforms: sig.platforms || [],
  });
  const compactRecentSignals = dedupedFindings
    .filter((f) => f.score > 0 && f.status !== 'rejected')
    .slice(0, 500)
    .map(shrinkForState);
  const compactHotSignals = majorSignals.slice(0, 100).map(shrinkForState);

  const nextState = {
    ...baseline,
    schemaVersion: 2,
    componentId,
    version: canAdvance ? candidate.version : (baseline.version || candidate.version),
    observedVersion: candidate.version,
    scannedVersion: candidate.version,
    deliveredVersion: canAdvance ? candidate.version : (baseline.deliveredVersion || null),
    alertedVersion: (alertSent || alreadyAlerted) ? candidate.version : (baseline.alertedVersion || null),
    releaseId: canAdvance ? candidate.releaseId : (baseline.releaseId || candidate.releaseId),
    releaseKey: canAdvance ? releaseKey : (baseline.releaseKey || releaseKey),
    channel: candidate.channel || baseline.channel || 'stable',
    versionScheme: candidate.versionScheme || baseline.versionScheme || null,
    identityFingerprint: canAdvance
      ? (candidate.identityFingerprint || computeIdentityFingerprint(candidate))
      : (baseline.identityFingerprint || computeIdentityFingerprint(candidate)),
    diagnosticFingerprint: null,
    scanId,
    coverageState: coverage.coverageState,
    analyzerStatus,
    lastSuccessfulScan: canAdvance ? scannedAt : (baseline.lastSuccessfulScan || null),
    lastFailureTime: canAdvance ? null : scannedAt,
    lastDeliveryStatus: canAdvance ? 'DELIVERED' : pendingDelivery?.status || 'FAILED',
    lastTestAlertVersion: isTestRun && (alertSent || alreadyAlerted)
      ? candidate.version
      : (baseline.lastTestAlertVersion || null),
    pendingDelivery,
    deliveryLedger: appendDeliveryLedger(baseline, {
      scanId,
      version: candidate.version,
      status: pendingDelivery?.status || 'DELIVERED',
      coverageState: coverage.coverageState,
      deliveredFiles: pendingDelivery?.deliveredFiles || reportBundle.telegramFiles.map((file) => path.basename(file)),
      failedFiles: pendingDelivery?.failedFiles || [],
      at: scannedAt,
    }),
    releaseHistory,
    hotSignals: canAdvance ? compactHotSignals : (baseline.hotSignals || []).filter(isPlausibleStoredSignal).slice(0, 100).map(shrinkForState),
    recentSignals: canAdvance ? compactRecentSignals : (baseline.recentSignals || []).filter(isPlausibleStoredSignal).slice(0, 500).map(shrinkForState),
    knownSignals: {},
    historicalSeenHashes: [],
    historicalSeenUrls: [],
    stringBaseline: null,
    stringHistory: null,
    urlBaseline: null,
    urlHistory: null,
    lastCoverageGaps: coverage.extractionGaps,
    benchmark: { executionTimeMs, peakMemoryMb: benchmark.peakMemoryMb },
  };

  saveComponentState(stateDir, componentId, nextState);
  if (canAdvance) {
    masterState.knownSignals = updatedKnownSignals;
    masterState.lastVersionStrings = currentCleanStrings;
    masterState.knownStrings = mergeStringSets(masterState.knownStrings || [], currentCleanStrings);
    masterState.lastVersionUrls = currentUrlValues;
    masterState.knownUrls = mergeStringSets(masterState.knownUrls || [], currentUrlValues);
    masterState.releaseHistory = [
      {
        version: candidate.version,
        releaseKey,
        scanId,
        scannedAt,
        newCount: diffResults.newFindings.length,
        changedCount: diffResults.changedFindings.length,
      },
      ...(masterState.releaseHistory || []),
    ].slice(0, 100);
    saveMasterState(stateDir, componentId, masterState);
  }
  checkpointState(stateDir, comp.family, `Scan ${scanId} ${canAdvance ? 'delivered' : 'pending'}`);

  if (canAdvance) {
    console.log(`✅ Deep scan complete for ${componentId} (${scanId}). Baseline advanced (COMPLETE).`);
  } else {
    console.warn(`⚠️ Scan for ${componentId} did not advance baseline: coverage=${coverage.coverageState}, filesFailed=${delivery.failedFiles.length}, completion=${delivery.completionSent}.`);
  }

  return {
    scanId,
    candidate,
    diffResults,
    stringDiff,
    reportBundle,
    coverage,
    coverageState: coverage.coverageState,
    analyzerStatus,
    delivery,
    pendingDelivery,
    executionTimeMs,
  };
}

export { STATE_DIR, REPORTS_DIR };
