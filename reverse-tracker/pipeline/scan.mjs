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
import { loadComponentState, saveComponentState, appendDeliveryLedger } from '../state/store.mjs';
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
import { matchSignalsInText, extractJsonPricingFindings } from '../finder/rules.mjs';
import { evaluateNoise, isHumanReadableString } from '../finder/noise.mjs';
import { detectPlatformAsymmetry } from '../finder/asymmetry.mjs';
import { scoreFinding, sortFindings, deduplicateFindings } from '../finder/scorer.mjs';
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
  for (const item of extractStrings(buffer, { includeUnicode: true, maxLength: MAX_STRING_LENGTH })) {
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

async function sendReportFile({ tg, file, scanId, topicId, delivery }) {
  const name = path.basename(file);
  let sent = false;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await tg.sendDocument(file, `Scan ${scanId} - ${name}`, { topicId });
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

async function deliverReports({ tg, files, scanId, topicId, delivery, summaryPath }) {
  const allFiles = files.filter(Boolean);
  const reportFiles = allFiles.filter((file) => path.basename(file) !== 'scan-summary.txt');

  for (const file of reportFiles) {
    await sendReportFile({ tg, file, scanId, topicId, delivery });
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
    await sendReportFile({ tg, file: summaryPath, scanId, topicId, delivery });
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
  const alreadyAlerted = baseline.alertedVersion === candidate.version || samePending;

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

  for (const artifact of selectedArtifacts) {
    try {
      console.log(`   Downloading ${artifact.target} (${artifact.format})...`);
      const dl = await download(artifact, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxSizeBytes: MAX_ARTIFACT_BYTES,
      });
      dl.sha256 = dl.sha256 || crypto.createHash('sha256').update(dl.buffer).digest('hex');
      // Keep only metadata here. Retaining every multi-hundred-MB compressed
      // artifact buffer for the whole scan is a major runner OOM risk.
      acquired.push({
        target: dl.target,
        format: dl.format,
        size: dl.size ?? dl.buffer?.length,
        sha256: dl.sha256,
        url: dl.url,
      });

      console.log(`   Extracting ${artifact.target}...`);
      const { files, status: extractStatus } = extract(dl.buffer, artifact.format, artifact.target, artifact.url);
      if (extractStatus?.analyzers) mergeAnalyzerStatus(analyzerStatus, extractStatus.analyzers);
      if (extractStatus?.coverageState === 'PARTIAL') {
        extractionGaps.push(`${artifact.target}: extraction partial${extractStatus.error ? ` (${extractStatus.error})` : ''}`);
      }
      if (!files || files.length === 0) {
        extractionGaps.push(`${artifact.target}: no analyzable files extracted`);
      }

      const platform = platformFromTarget(artifact.target);

      for (const file of files || []) {
        if (!file?.buffer || file.buffer.length === 0) continue;
        platformsWithFiles.add(platform);
        analyzedFileCount++;

        // URL / endpoint scanner works on text and binary buffers.
        try {
          const fileUrls = extractApplicationUrls(file.buffer);
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
          const text = file.buffer.toString('utf8');
          addTextLines(collector, text, platform, file.path, 'text');
          addStringsFromOverlongText(collector, text, file.buffer, platform, file.path, 'text');
          if (/\.json$/i.test(file.path)) {
            for (const finding of extractJsonPricingFindings(text, file.path, 'json')) {
              finding.platforms = [platform];
              finding.artifactSha256 = dl.sha256;
              directFindings.push(finding);
              collector.add(finding.value, platform, file.path, 'ast');
            }
          }
        }

        // Binary / executable files: multi-encoding string scanner.
        if (file.priority === 2) {
          binaryFilesScanned++;
          for (const s of extractStrings(file.buffer, { includeUnicode: true, maxLength: MAX_STRING_LENGTH })) {
            if (isHumanReadableString(s.value)) {
              collector.add(s.value, platform, file.path, 'binary');
            }
          }
        }

        // Source maps: sourcesContent is the highest-value reverse-engineering
        // input, but the old pipeline only used `names`.
        if (file.path.endsWith('.map')) {
          processSourceMapBuffer(collector, file.buffer, file.path, platform, analyzerStatus);
        } else if (file.buffer.includes('sourceMappingURL=')) {
          processInlineSourceMaps(collector, file.buffer, file.path, platform, analyzerStatus);
        }

        // JavaScript AST.
        if (/\.(?:js|mjs|cjs)$/i.test(file.path)) {
          try {
            const jsCode = file.buffer.toString('utf8');
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

        // Go binaries.
        if (isGoBinary(file.buffer)) {
          let tmpGoPath = null;
          try {
            tmpGoPath = path.join(os.tmpdir(), `temp-go-${Date.now()}-${path.basename(file.path) || 'bin'}`);
            fs.writeFileSync(tmpGoPath, file.buffer);
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
      }
    } catch (err) {
      extractionGaps.push(`${artifact.target}: ${err.message}`);
      console.error(`   ✗ Target ${artifact.target} failed: ${err.message}`);
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

  const previousStrings = baselineFromState(baseline);
  const stringHistory = stringHistoryFromState(baseline, baseline.historicalSeenHashes || []);
  const stringDiff = diffStringSets(previousStrings, currentCleanStrings, stringHistory);
  console.log(`   Clean strings: ${stringDiff.counts.current} (${stringDiff.counts.added} new, ${stringDiff.counts.removed} removed, ${stringDiff.counts.reintroduced} reintroduced)`);

  // URL delta.
  const currentUrls = Array.from(allExtractedUrls.values());
  const currentUrlValues = currentUrls.map((item) => item.url);
  const previousUrls = urlBaselineFromState(baseline);
  const urlHistory = urlHistoryFromState(baseline, previousUrls);
  const urlDiff = diffStringSets(previousUrls, currentUrlValues, urlHistory);
  const addedUrlSet = new Set(urlDiff.added);
  const newUrls = currentUrls.filter((item) => addedUrlSet.has(item.url));
  console.log(`   Endpoints discovered: ${currentUrls.length} (${newUrls.length} new)`);

  // STEP 4: Delta-First signal matching.
  // We scan raw text patterns ONLY on newly introduced or reintroduced strings (or all strings on first run / fullScan).
  // Unchanged persistent strings do not need to be re-scanned for raw text patterns;
  // their signals are preserved from the baseline without noise or re-alert spam.
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

  // Load previous baseline signals
  const previousFindings = dedupeRawFindings([
    ...(baseline.recentSignals || []),
    ...(baseline.hotSignals || []),
    ...(baseline.knownSignals ? Object.values(baseline.knownSignals) : []),
  ]);

  // Track historical finding keys
  const historicalFindingValues = new Set([
    ...stringHistory,
    ...(baseline.historicalSeenHashes || []),
    ...previousFindings.map((f) => `${f.category || ''}:${f.value || ''}`),
    ...previousFindings.map((f) => f.value),
  ]);

  // Identify previously known signals that remain active in the release
  const currentStringLookup = new Set(currentCleanStrings);
  const activePreviousFindings = [];
  for (const prev of previousFindings) {
    const isStillActive = currentStringLookup.has(prev.value) ||
      (prev.context && currentStringLookup.has(prev.context)) ||
      (prev.origin === 'ast' && !stringDiff.removed.includes(prev.value)) ||
      prev.category === 'model_id' || prev.category === 'pricing';
    if (isStillActive) {
      activePreviousFindings.push({ ...prev, diffStatus: 'persistent' });
    }
  }

  const allCandidateFindings = dedupeRawFindings([...textFindings, ...directFindings, ...activePreviousFindings]);
  const diffResults = computeExactDiff(previousFindings, allCandidateFindings, historicalFindingValues);
  const allFindings = allCandidateFindings;

  // STEP 5: score and rank.
  const keyOf = (finding) => `${finding.category}:${finding.value}`;
  const newKeySet = new Set(diffResults.newFindings.map(keyOf));
  const reintroducedKeySet = new Set(diffResults.reintroducedFindings.map(keyOf));
  const persistentKeySet = new Set(diffResults.persistentFindings.map(keyOf));
  const changedKeySet = new Set(diffResults.changedFindings.map(keyOf));
  const scoredFindings = allFindings.map((finding) => {
    const key = keyOf(finding);
    const diffStatus = newKeySet.has(key)
      ? 'NEW'
      : reintroducedKeySet.has(key)
        ? 'REINTRODUCED'
        : persistentKeySet.has(key)
          ? 'PERSISTENT'
          : changedKeySet.has(key)
            ? 'CHANGED'
            : 'NEW';
    return {
      ...scoreFinding(finding, {
        isNewInDiff: diffStatus === 'NEW' || diffStatus === 'REINTRODUCED',
        isFirstEverSeen: !historicalFindingValues.has(finding.value) && !historicalFindingValues.has(key),
      }),
      diffStatus,
    };
  });
  const sortedScored = sortFindings(scoredFindings);
  const dedupedFindings = deduplicateFindings(sortedScored);
  // The completion message is an alert, not a full inventory. Persistent
  // signals are available in leaks.txt/models-and-pricing.txt but must not be
  // re-alerted every release.
  const displayFindings = isTestRun
    ? dedupedFindings
    : dedupedFindings.filter((finding) => !['PERSISTENT', 'CHANGED'].includes(finding.diffStatus));
  const majorSignals = displayFindings.filter((finding) => finding.isMajorEarlySignal);
  const highSignals = displayFindings.filter(
    (finding) => finding.tier === 'HIGH-CONFIDENCE SIGNAL' && !finding.isMajorEarlySignal,
  );
  const moreFindings = displayFindings.filter(
    (finding) => finding.tier === 'EARLY SIGNAL' && !finding.isMajorEarlySignal,
  );
  const pricingSignals = displayFindings.filter((finding) => finding.category === 'pricing');
  const modelCount = dedupedFindings.filter((finding) => finding.category === 'model_id').length;

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

  // STEP 8: upload every file, then send the completion message. The old
  // pipeline sent completion first and ignored {ok:false}, which is why files
  // could vanish while the message claimed success.
  const delivery = {
    status: 'PENDING',
    deliveredFiles: [],
    failedFiles: [],
    completionSent: false,
    completionError: null,
  };
  await deliverReports({
    tg,
    files: reportBundle.telegramFiles,
    scanId,
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

  const updatedKnownSignals = { ...(baseline.knownSignals || {}) };
  for (const f of dedupedFindings) {
    if (f.category && f.value) {
      const k = `${f.category}:${f.value.toLowerCase()}`;
      updatedKnownSignals[k] = {
        category: f.category,
        value: f.value,
        score: f.score,
        tier: f.tier,
        activationStatus: f.activationStatus,
        filePath: f.filePath,
        context: f.context ? f.context.slice(0, 200) : '',
        firstSeenVersion: updatedKnownSignals[k]?.firstSeenVersion || candidate.version,
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
    hotSignals: canAdvance ? majorSignals : (baseline.hotSignals || []),
    recentSignals: canAdvance ? dedupedFindings : (baseline.recentSignals || []),
    knownSignals: canAdvance ? updatedKnownSignals : (baseline.knownSignals || {}),
    historicalSeenHashes: canAdvance ? updatedHistoricalStrings : (baseline.historicalSeenHashes || []),
    historicalSeenUrls: canAdvance ? updatedHistoricalUrls : (baseline.historicalSeenUrls || []),
    stringBaseline: canAdvance ? encodeStringSet(currentCleanStrings) : baseline.stringBaseline || encodeStringSet(previousStrings),
    stringHistory: canAdvance
      ? encodeStringSet(mergeStringSets(stringHistory, currentCleanStrings))
      : baseline.stringHistory || encodeStringSet(stringHistory),
    urlBaseline: canAdvance ? encodeUrlSet(currentUrlValues) : baseline.urlBaseline || encodeUrlSet(previousUrls),
    urlHistory: canAdvance
      ? encodeUrlSet(mergeStringSets(urlHistory, currentUrlValues))
      : baseline.urlHistory || encodeUrlSet(urlHistory),
    lastCoverageGaps: coverage.extractionGaps,
    benchmark: { executionTimeMs, peakMemoryMb: benchmark.peakMemoryMb },
  };

  saveComponentState(stateDir, componentId, nextState);
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
