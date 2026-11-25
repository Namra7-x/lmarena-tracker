/**
 * Report Bundle & File Delivery Generator (Section 8.1)
 * Produces clean, delta-first, zero-truncation reports without redundant repetition:
 *  - leaks.txt (Delta-first ASCII table + tiered full details; compact Section 2 baseline)
 *  - diff.txt (Unified metrics, artifact inventory, structural category delta)
 *  - strings.txt / strings.txt.gz (Grouped & near-duplicate collapsed new strings)
 *  - urls.txt (Uncut categorized endpoint inventory + highlighted new routes)
 *  - models-and-pricing.txt (Uncut model & pricing catalog)
 *  - scan-summary.txt (Delta highlights + coverage + delivery status)
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isHumanReadableString } from '../finder/noise.mjs';
import { deduplicateFindings } from '../finder/scorer.mjs';
import { collapseNearDuplicateStrings } from '../finder/similarity.mjs';

/**
 * Universal ASCII Table Renderer
 * Generates clean, robust, perfectly-aligned Unicode box-drawing tables.
 */
export function renderAsciiTable(headers, rows, maxColWidths = {}) {
  if (!headers || headers.length === 0) return '';
  const colWidths = headers.map((h, i) => {
    const maxValLen = rows.reduce((max, row) => Math.max(max, String(row[i] == null ? '' : row[i]).length), 0);
    const maxAllowed = maxColWidths[i] || (i === headers.length - 1 ? 220 : 80);
    return Math.min(Math.max(h.length, maxValLen), maxAllowed);
  });

  const pad = (val, len) => {
    const s = String(val == null ? '' : val);
    if (s.length > len) {
      return len > 3 ? s.slice(0, len - 1) + '…' : s.slice(0, len);
    }
    return s + ' '.repeat(len - s.length);
  };

  const topBorder = '┌' + colWidths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const midBorder = '├' + colWidths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const botBorder = '└' + colWidths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

  const headerLine = '│ ' + headers.map((h, i) => pad(h, colWidths[i])).join(' │ ') + ' │';

  const rowLines = rows.map((row) => {
    return '│ ' + headers.map((_, i) => pad(row[i], colWidths[i])).join(' │ ') + ' │';
  });

  return [topBorder, headerLine, midBorder, ...rowLines, botBorder].join('\n');
}

/**
 * Universal ASCII Box Renderer
 * Wraps summary text in a clean decorative frame.
 */
export function renderAsciiBox(lines, title = '') {
  const contentWidth = Math.max(
    title ? title.length + 4 : 0,
    ...lines.map((l) => l.length)
  );
  const width = Math.min(Math.max(contentWidth, 68), 110);
  const top = title
    ? `┌─ ${title} ${'─'.repeat(Math.max(0, width - title.length - 4))}┐`
    : `┌${'─'.repeat(width + 2)}┐`;
  const bot = `└${'─'.repeat(width + 2)}┘`;
  const body = lines.map((l) => {
    const truncated = l.length > width ? l.slice(0, width - 1) + '…' : l;
    return `│ ${truncated}${' '.repeat(Math.max(0, width - truncated.length))} │`;
  });
  return [top, ...body, bot].join('\n');
}

function formatLeakDetailBlock(item) {
  const lines = [];
  const badge = item.isMajorEarlySignal ? '🔥 MAJOR EARLY SIGNAL' : (item.tier || 'SIGNAL');
  const plat = (item.platforms || []).join(', ') || 'all';
  const status = item.activationStatus || 'UNKNOWN';
  const diffTag = item.diffStatus ? ` [${item.diffStatus}]` : '';
  const occStr = item.occurrences > 1 ? ` (${item.occurrences}x)` : '';
  lines.push(`• [${badge}] (${item.score || 0} pts) [${item.category}] [Status: ${status}]${diffTag}${occStr}`);
  lines.push(`  Finding:   ${item.value}`);
  if (item.discoveryMethod && item.discoveryMethod !== 'heuristic') {
    lines.push(`  Discovery: ${item.discoveryMethod}`);
  }
  if (item.url) {
    lines.push(`  URL:       ${item.url}`);
  }
  const cleanCtx = item.contexts?.length > 0
    ? item.contexts[0]
    : (item.context && item.context !== item.value ? item.context : '');
  if (cleanCtx) {
    const snippet = cleanCtx.trim().replace(/\r?\n/g, ' ');
    lines.push(`  Context:   ${snippet.length > 260 ? snippet.slice(0, 257) + '...' : snippet}`);
  }
  if (item.relatedSignals && item.relatedSignals.length > 0) {
    lines.push(`  Linked:    ${item.relatedSignals.map((r) => `[${r.category}] ${r.value}`).join(' | ')}`);
  }
  if (item.filePath) {
    lines.push(`  File:      ${item.filePath}`);
  }
  lines.push(`  Platforms: ${plat}`);
  return lines.join('\n') + '\n';
}

function groupLeaksByTier(leaks) {
  const groups = {
    'TIER 1: 🤖 UNANNOUNCED MODELS & CODENAMES': leaks.filter((f) => f.category === 'model_id'),
    'TIER 2: 🚩 FEATURE GATES, EXPERIMENTS & ROLLOUTS': leaks.filter((f) => ['feature_flag', 'experiment', 'env_var', 'plan_entitlement', 'platform_entitlement'].includes(f.category)),
    'TIER 3: 🛠️ AGENT CAPABILITIES, MCP TOOLS & DARK UI': leaks.filter((f) => ['agent_mode', 'capability', 'hidden_command', 'ui_string'].includes(f.category)),
    'TIER 4: 🌐 INTERNAL ENDPOINTS & RPC ROUTES': leaks.filter((f) => ['endpoint_domain', 'internal_function'].includes(f.category)),
    'TIER 5: 💵 MODEL & PRICING TABLES': leaks.filter((f) => f.category === 'pricing'),
  };
  const groupedCategories = new Set([
    'model_id', 'feature_flag', 'experiment', 'env_var', 'plan_entitlement',
    'platform_entitlement', 'agent_mode', 'capability', 'hidden_command',
    'ui_string', 'endpoint_domain', 'internal_function', 'pricing',
  ]);
  const otherLeaks = leaks.filter((f) => !groupedCategories.has(f.category));
  if (otherLeaks.length > 0) {
    groups['TIER 6: 📋 OTHER REVERSE-ENGINEERING SIGNALS'] = otherLeaks;
  }
  return groups;
}

function categorizeCleanStrings(groups) {
  const buckets = {
    candidates: [],
    uiCopy: [],
    identifiers: [],
    pathsAndOther: [],
  };

  for (const g of groups) {
    const val = g.primary;
    const suffix = g.variants.length > 0 ? `  (+${g.variants.length} similar)` : '';
    const line = `${val}${suffix}`;

    if (/(?:https?:\/\/|wss?:\/\/|\/v[0-9]|\/api\/|gpt|claude|gemini|o[1-9]-|deepseek|qwen|grok|llama|mistral|mcp_|_flag|enable_|experiment_|rollout)/i.test(val)) {
      buckets.candidates.push(line);
    } else if (val.includes(' ') && val.length >= 16) {
      buckets.uiCopy.push(line);
    } else if (/^[a-zA-Z0-9_.-]{4,80}$/.test(val) && !val.includes('/')) {
      buckets.identifiers.push(line);
    } else {
      buckets.pathsAndOther.push(line);
    }
  }

  return buckets;
}

/**
 * Generate all report files for a scan.
 */
export function generateReportBundle(outputDir, scanData) {
  fs.mkdirSync(outputDir, { recursive: true });

  const {
    scanId,
    componentId,
    version,
    oldVersion = 'unknown',
    family = '',
    diffResults = {},
    stringDiff = null,
    scoredFindings = [],
    platformAsymmetry = {},
    coverage = {},
    totalExtractedStrings = 0,
    artifactInventory = [],
    unknownCandidates = [],
    artifactSha256 = null,
    analyzerStatus = null,
    delivery = null,
    versionScheme = null,
    isTestRun = false,
  } = scanData;

  const {
    newFindings = [],
    changedFindings = [],
    persistentFindings = [],
    removedFindings = [],
    reintroducedFindings = [],
  } = diffResults;

  const generatedAt = new Date().toISOString();
  const validLeaks = deduplicateFindings(scoredFindings).filter((f) => f.status !== 'rejected' && (f.score == null || f.score > 0));

  const leaksByCategory = {};
  for (const leak of validLeaks) {
    const cat = leak.category || 'other';
    if (!leaksByCategory[cat]) leaksByCategory[cat] = [];
    leaksByCategory[cat].push(leak);
  }

  // Strictly NEW leaks only (zero old/persistent/historical baseline bloat).
  // Supports unit-test fixtures that pass scoredFindings without diffStatus.
  const rawNewOrUnscored = validLeaks.filter((f) => f.diffStatus === 'NEW' || !f.diffStatus);
  const testRunPool = isTestRun && rawNewOrUnscored.length === 0 ? validLeaks : rawNewOrUnscored;
  const highSignalNewLeaks = testRunPool.filter(
    (f) => f.category !== 'model_id' || f.score == null || f.score >= 35,
  );
  const weakCandidateLeaks = testRunPool.filter(
    (f) => f.category === 'model_id' && f.score != null && f.score > 0 && f.score < 35,
  );

  // -------------------------------------------------------------
  // 1. `leaks.txt`: Ultra-clean NEW leaks only (no old/persistent dump)
  // -------------------------------------------------------------
  let leaksContent = renderAsciiBox([
    `Component: ${componentId} (${family || 'unknown'})`,
    `Version:   ${oldVersion} ➔ ${version}`,
    `Scan ID:   ${scanId}`,
    `Timestamp: ${generatedAt}`,
    `Total Leaks Found: ${highSignalNewLeaks.length} (New Verified Only · Low-Conf Sidecar: ${weakCandidateLeaks.length})`,
  ], '🚨 NEW LEAKS REPORT (ZERO NOISE · DELTA ONLY)') + '\n\n';

  leaksContent += `🔥 [NEW VERIFIED LEAKS IN THIS RELEASE] (${highSignalNewLeaks.length})\n`;
  if (highSignalNewLeaks.length > 0) {
    const newHeaders = ['CATEGORY', 'IDENTIFIER', 'SCORE', 'ACTIVATION', 'EVIDENCE / LOCATION'];
    const newRows = highSignalNewLeaks.map((item) => [
      item.category,
      item.value,
      `${item.score || 0} pts`,
      item.activationStatus || 'UNKNOWN',
      item.filePath || (item.context ? item.context.replace(/\r?\n/g, ' ').slice(0, 120) : 'delta'),
    ]);
    leaksContent += renderAsciiTable(newHeaders, newRows, { 0: 20, 1: 44, 2: 10, 3: 14, 4: 120 }) + '\n\n';

    const deltaGroups = groupLeaksByTier(highSignalNewLeaks);
    for (const [tierTitle, list] of Object.entries(deltaGroups)) {
      if (list.length === 0) continue;
      leaksContent += `[${tierTitle}] (${list.length})\n`;
      leaksContent += `----------------------------------------------------------------------\n`;
      for (const item of list) {
        leaksContent += formatLeakDetailBlock(item) + '\n';
      }
    }
  } else {
    leaksContent += `No high-confidence new leaks were introduced in this release.\n`;
  }

  const leaksFilePath = path.join(outputDir, 'leaks.txt');
  fs.writeFileSync(leaksFilePath, leaksContent, 'utf8');

  // Sidecar preservation for weak/unanchored raw matches so zero discoveries vanish quietly
  const lowConfLines = weakCandidateLeaks.map((f) => formatLeakDetailBlock(f)).join('\n');
  fs.writeFileSync(
    path.join(outputDir, 'low-confidence-candidates.txt'),
    lowConfLines || 'No low-confidence unanchored candidates in this delta.\n',
    'utf8',
  );

  // -------------------------------------------------------------
  // 2. `diff.txt`: Version delta, artifact checksums, structural metrics
  // -------------------------------------------------------------
  const stringCounts = stringDiff?.counts || null;
  const totalCleanStr = stringCounts ? stringCounts.current : totalExtractedStrings;
  const newCleanStr = stringCounts ? stringCounts.added : newFindings.length;
  const remCleanStr = stringCounts ? stringCounts.removed : removedFindings.length;
  const perCleanStr = stringCounts ? stringCounts.persistent : persistentFindings.length;
  const reiCleanStr = stringCounts ? stringCounts.reintroduced : reintroducedFindings.length;

  let diffContent = renderAsciiBox([
    `Component: ${componentId} (${family || 'unknown'})`,
    `Release:   ${oldVersion} -> ${version}`,
    `Scan ID:   ${scanId}`,
    `Timestamp: ${generatedAt}`,
    `Delta: +${newCleanStr} new strings | -${remCleanStr} removed | +${highSignalNewLeaks.length} new leaks`,
  ], '📊 VERSION DELTA & STRUCTURAL DIFF') + '\n\n';

  diffContent += `VERSION DELTA & STRUCTURAL DIFF\n`;

  if (artifactInventory.length > 0) {
    diffContent += `📦 ARTIFACT INVENTORY:\n`;
    const artHeaders = ['TARGET', 'FORMAT', 'SIZE', 'SHA256 CHECKSUM'];
    const artRows = artifactInventory.map((art) => [
      art.target || 'target',
      art.format || 'bin',
      art.size ? (art.size / (1024 * 1024)).toFixed(2) + ' MB' : 'unknown',
      art.sha256 || 'unknown',
    ]);
    diffContent += renderAsciiTable(artHeaders, artRows, { 0: 20, 1: 10, 2: 14, 3: 68 }) + '\n\n';
  }

  diffContent += `📊 STRING DELTA METRICS:\n`;
  const metricHeaders = ['METRIC DESCRIPTION', 'COUNT'];
  const metricRows = [
    ['Total Clean Strings Analyzed', String(totalCleanStr)],
    ['Newly Introduced Strings (Delta)', `+${newCleanStr}`],
    ['Deprecated / Removed Strings', `-${remCleanStr}`],
    ['Persistent Unchanged Strings', String(perCleanStr)],
    ['Reintroduced Historical Strings', String(reiCleanStr)],
    ['Signal Ratio (New / Changed / Persistent / Removed)', `${newFindings.length} / ${changedFindings.length} / ${persistentFindings.length} / ${removedFindings.length}`],
  ];
  diffContent += renderAsciiTable(metricHeaders, metricRows, { 0: 52, 1: 24 }) + '\n\n';

  const macOnly = platformAsymmetry.macOnly || [];
  const winOnly = platformAsymmetry.winOnly || [];
  const expectedPlatforms = Array.isArray(coverage.expectedPlatforms) ? coverage.expectedPlatforms : [];
  const isSingleMacScan = expectedPlatforms.includes('darwin') && !expectedPlatforms.includes('win32');
  diffContent += `🎯 PLATFORM ASYMMETRY:\n`;
  if (isSingleMacScan) {
    diffContent += `  • Target Mode:                   macOS-only fast scan\n`;
  } else {
    diffContent += `  • macOS Only Features:           ${macOnly.length}\n`;
    diffContent += `  • Windows Only Features:         ${winOnly.length}\n`;
  }
  diffContent += '\n';

  if (changedFindings.length > 0) {
    diffContent += `🔄 CONTEXT / STATUS CHANGES (${changedFindings.length}):\n`;
    for (const ch of changedFindings) {
      const reasons = ch.changeReasons?.length ? ` (${ch.changeReasons.join(', ')})` : '';
      diffContent += `  * [${ch.category}] ${ch.value}${reasons}\n`;
      if (ch.contextDeltaSummary) diffContent += `      Delta: ${ch.contextDeltaSummary}\n`;
    }
    diffContent += '\n';
  }

  if (diffResults.byCategory && Object.keys(diffResults.byCategory).length > 0) {
    diffContent += `🔬 STRUCTURAL SIGNAL CATEGORIES BREAKDOWN:\n`;
    for (const [cat, stats] of Object.entries(diffResults.byCategory)) {
      diffContent += `  • ${cat}: +${stats.added} added, *${stats.changed} changed, -${stats.removed} removed (total: ${stats.total})\n`;
    }
    diffContent += '\n';
  }

  if (scanData.benchmark) {
    diffContent += `⏱️ EMPIRICAL RUNTIME BENCHMARK:\n`;
    diffContent += `  • Execution Latency:  ${scanData.benchmark.executionTimeMs || 0} ms\n`;
    diffContent += `  • Peak Memory (Heap): ${scanData.benchmark.peakMemoryMb || 0} MB\n`;
    if (scanData.benchmark.totalExtractedBytes) {
      diffContent += `  • Bytes Analyzed:     ${(scanData.benchmark.totalExtractedBytes / (1024 * 1024)).toFixed(2)} MB\n`;
    }
  }

  const diffFilePath = path.join(outputDir, 'diff.txt');
  fs.writeFileSync(diffFilePath, diffContent, 'utf8');

  // -------------------------------------------------------------
  // 3. `strings.txt`: Categorized & near-duplicate collapsed new strings
  // -------------------------------------------------------------
  const stringSource = Array.isArray(stringDiff?.added)
    ? stringDiff.added
    : newFindings.map((f) => (typeof f === 'string' ? f : f.value)).filter(Boolean);
  const uniqueCleanNewStrings = Array.from(
    new Set(stringSource.filter(isHumanReadableString))
  ).sort();

  const collapsedGroups = collapseNearDuplicateStrings(uniqueCleanNewStrings);
  const groupedBuckets = categorizeCleanStrings(collapsedGroups);

  let stringsContent = `# Newly Introduced Strings in ${componentId} (${version})\n`;
  stringsContent += `# Generated: ${generatedAt}\n`;
  stringsContent += `# Total Count: ${uniqueCleanNewStrings.length} (Grouped into ${collapsedGroups.length} entries)\n`;
  if (stringCounts) {
    stringsContent += `# Removed: ${stringCounts.removed} · Persistent: ${stringCounts.persistent} · Reintroduced: ${stringCounts.reintroduced}\n`;
  }
  stringsContent += '\n';

  if (uniqueCleanNewStrings.length === 0) {
    stringsContent += 'No new human-readable strings were introduced in this release.\n';
  } else {
    const appendBucket = (title, lines) => {
      if (lines.length === 0) return;
      stringsContent += `=== ${title} (${lines.length}) ===\n`;
      stringsContent += lines.join('\n') + '\n\n';
    };
    appendBucket('1. AI / MODEL / FEATURE / ENDPOINT CANDIDATES', groupedBuckets.candidates);
    appendBucket('2. USER-FACING UI COPY & PHRASES', groupedBuckets.uiCopy);
    appendBucket('3. IDENTIFIERS, CONFIG KEYS & FLAGS', groupedBuckets.identifiers);
    appendBucket('4. PATHS & OTHER CLEAN STRINGS', groupedBuckets.pathsAndOther);
  }

  const stringsFilePath = path.join(outputDir, 'strings.txt');
  fs.writeFileSync(stringsFilePath, stringsContent, 'utf8');

  const stringsGzPath = path.join(outputDir, 'strings.txt.gz');
  fs.writeFileSync(stringsGzPath, zlib.gzipSync(Buffer.from(stringsContent, 'utf8')));

  // -------------------------------------------------------------
  // Backward-compatible evidence files (preserve full test contract)
  // -------------------------------------------------------------
  const majorAndHigh = scoredFindings.filter(
    (f) => f.isMajorEarlySignal || f.tier === 'HIGH-CONFIDENCE SIGNAL'
  );
  const file1Content = majorAndHigh.map((f) => {
    return `[${f.isMajorEarlySignal ? '🔥 MAJOR EARLY SIGNAL' : '⭐ HIGH'}] (${f.score} pts) [${f.category}]\nValue: ${f.value}\nContext: ${f.context}\nLocation: ${f.filePath} (${f.platforms?.join(', ') || 'all'})\n---`;
  }).join('\n\n');
  fs.writeFileSync(path.join(outputDir, '1-major-and-high.txt'), file1Content || 'No major or high-confidence signals found.', 'utf8');

  const earlyAndWeak = scoredFindings.filter(
    (f) => f.tier === 'EARLY SIGNAL' || f.tier === 'WEAK SIGNAL'
  );
  const file2Content = earlyAndWeak.map((f) => {
    return `[${f.tier}] (${f.score} pts) [${f.category}]\nValue: ${f.value}\nContext: ${f.context}\nLocation: ${f.filePath}\n---`;
  }).join('\n\n');
  fs.writeFileSync(path.join(outputDir, '2-early-and-weak.txt'), file2Content || 'No early or weak signals found.', 'utf8');

  const file3Content = Object.entries(leaksByCategory).map(([cat, list]) => {
    const items = list.map((item) => `  • [${item.tier}] (${item.score} pts) ${item.value}`).join('\n');
    return `=== CATEGORY: ${cat} (${list.length}) ===\n${items}`;
  }).join('\n\n');
  fs.writeFileSync(path.join(outputDir, '3-by-category.txt'), file3Content || 'No categorized findings.', 'utf8');

  const newStringLines = Array.isArray(stringDiff?.added)
    ? stringDiff.added.map((value) => `raw\t${value}\t`)
    : newFindings.map((f) => `${f.category || 'raw'}\t${f.value}\t${f.filePath || ''}`);
  fs.writeFileSync(path.join(outputDir, '4-all-new-strings.txt.gz'), zlib.gzipSync(Buffer.from(newStringLines.join('\n'), 'utf8')));

  const file5Content = [
    `=== macOS ONLY (${macOnly.length}) ===`,
    ...macOnly.map((f) => `• [${f.category}] ${f.value} (${f.filePath || ''})`),
    '',
    `=== Windows ONLY (${winOnly.length}) ===`,
    ...winOnly.map((f) => `• [${f.category}] ${f.value} (${f.filePath || ''})`),
  ].join('\n');
  fs.writeFileSync(path.join(outputDir, '5-platform-only.txt'), file5Content, 'utf8');

  const removedLines = Array.isArray(stringDiff?.removed)
    ? stringDiff.removed.map((value) => `raw\t${value}\t`)
    : removedFindings.map((f) => `${f.category || 'raw'}\t${f.value}\t${f.filePath || ''}`);
  fs.writeFileSync(path.join(outputDir, '6-removed.txt.gz'), zlib.gzipSync(Buffer.from(removedLines.join('\n'), 'utf8')));

  // Manifest metadata
  const manifestData = {
    scanId,
    componentId,
    version,
    artifactSha256,
    generatedAt,
    leakCount: highSignalNewLeaks.length,
    deltaLeakCount: highSignalNewLeaks.length,
    newStringCount: uniqueCleanNewStrings.length,
    unknownCandidatesCount: unknownCandidates.length,
    activationStatusSummary: {
      enabled: validLeaks.filter((l) => l.activationStatus === 'ENABLED').length,
      configured: validLeaks.filter((l) => l.activationStatus === 'CONFIGURED').length,
      referenced: validLeaks.filter((l) => l.activationStatus === 'REFERENCED').length,
      unknown: validLeaks.filter((l) => l.activationStatus === 'UNKNOWN' || !l.activationStatus).length,
    },
    benchmark: scanData.benchmark || null,
  };
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifestData, null, 2), 'utf8');

  // Evidence Preservation: candidate signals with offsets, context, and raw expressions
  const candidateRecords = (scanData.candidates || scoredFindings).map((f) => ({
    category: f.category,
    value: f.value,
    activationStatus: f.activationStatus || 'UNKNOWN',
    discoveryMethod: f.discoveryMethod || f.origin || 'heuristic',
    filePath: f.filePath || '',
    offset: f.offset || { line: 0, column: 0 },
    context: f.context || '',
    rawExpression: f.rawExpression || f.value,
    related: f.related || null,
    origin: f.origin || 'heuristic',
    status: f.status || 'accepted',
    rejectionReason: f.rejectionReason || null,
    score: f.score || 0,
    tier: f.tier || 'UNSCORED',
    confidenceExplanation: f.confidenceExplanation || '',
  }));
  fs.writeFileSync(
    path.join(outputDir, 'candidates.json'),
    JSON.stringify(
      {
        scanId,
        componentId,
        version,
        artifactSha256,
        totalCandidates: candidateRecords.length,
        candidates: candidateRecords,
      },
      null,
      2
    ),
    'utf8'
  );

  // Preserve Uncertain / Unknown candidates without silently dropping them
  const unknownRecords = unknownCandidates.map((u) => ({
    value: u.value,
    filePath: u.filePath || '',
    offset: u.offset || { line: 0, column: 0 },
    context: u.context || '',
    reason: u.reason || 'unfamiliar_identifier',
    contextHint: u.contextHint || '',
    activationStatus: u.activationStatus || 'UNKNOWN',
  }));
  fs.writeFileSync(
    path.join(outputDir, 'unknown_candidates.json'),
    JSON.stringify(
      {
        scanId,
        componentId,
        version,
        artifactSha256,
        totalUnknownCandidates: unknownRecords.length,
        candidates: unknownRecords,
      },
      null,
      2
    ),
    'utf8'
  );

  // Mandatory Count Check verification (Section 8.1)
  const checkTotal = stringCounts ? stringCounts.current : totalExtractedStrings;
  const checkNew = stringCounts ? stringCounts.added : newFindings.length;
  const checkPersistent = stringCounts ? stringCounts.persistent : persistentFindings.length;
  const countCheckPassed = (
    checkTotal >= (checkNew + checkPersistent) &&
    validLeaks.length <= scoredFindings.length
  );

  const platformStatus = expectedPlatforms.includes('all')
    ? 'all platforms'
    : expectedPlatforms.length > 0
      ? [
          expectedPlatforms.includes('darwin') ? `macOS ${coverage.macOk !== false ? '✓' : '✗'}` : null,
          expectedPlatforms.includes('win32') ? `Windows ${coverage.winOk !== false ? '✓' : '✗'}` : null,
          expectedPlatforms.includes('linux') ? `Linux ${coverage.linuxOk !== false ? '✓' : '✗'}` : null,
        ].filter(Boolean).join(' · ')
      : `macOS ${coverage.macOk !== false ? '✓' : '✗'} Windows ${coverage.winOk !== false ? '✓' : '✗'}`;
  const checkReintroduced = stringCounts ? stringCounts.reintroduced : reintroducedFindings.length;
  const listedLeaks = validLeaks.length;
  const listedOk = listedLeaks <= scoredFindings.length;
  const countCheckText = [
    `Extracted ${checkTotal} = New ${checkNew} + Persistent ${checkPersistent} + Reintroduced ${checkReintroduced}`,
    `Listed in files ${listedLeaks} / ${scoredFindings.length}${listedOk ? ' ✓' : ' ⚠️'}`,
    `Coverage ${coverage.percentage ?? 100}% (${platformStatus})`,
    `Signals: +${newFindings.length} / *${persistentFindings.length} / -${removedFindings.length} / ~${reintroducedFindings.length}`,
    `Artifacts: ${coverage.downloadedArtifacts ?? '?'}/${coverage.expectedArtifacts ?? '?'} · Analyzer: ${coverage.coverageState || 'UNKNOWN'}`,
  ].join('\n');

  // -------------------------------------------------------------
  // 4. `urls.txt`: Uncut categorized endpoints & highlighted new URLs
  // -------------------------------------------------------------
  const { urlsInventory = [], newUrls = [] } = scanData;
  const newUrlSet = new Set(newUrls.map((u) => (typeof u === 'string' ? u : u.url)));

  const categoryNames = {
    CATALOG_AND_UPDATES: '📦 CATALOG & AUTO-UPDATE FEEDS',
    MODEL_AND_AI_APIS: '🤖 MODEL & INFERENCE APIS',
    INTERNAL_AND_STAGING: '🚩 INTERNAL & STAGING ROUTES',
    REMOTE_CONFIG_AND_FLAGS: '⚙️ REMOTE CONFIG & FEATURE GATES',
    STORAGE_AND_CDN: '🗄️ STORAGE & CDN BUCKETS',
    SERVICE_AND_RPCS: '🌐 BACKEND SERVICE RPCS',
  };

  const urlsByCategory = {};
  for (const item of urlsInventory) {
    const cat = item.category || 'SERVICE_AND_RPCS';
    if (!urlsByCategory[cat]) urlsByCategory[cat] = [];
    urlsByCategory[cat].push(item);
  }

  let urlsContent = renderAsciiBox([
    `Component: ${componentId}`,
    `Version:   ${version}`,
    `Scan ID:   ${scanId}`,
    `Timestamp: ${generatedAt}`,
    `Total Endpoints Discovered: ${urlsInventory.length}  |  New Endpoints: ${newUrls.length}`,
  ], '🌐 APPLICATION ENDPOINTS & ROUTES INVENTORY') + '\n\n';

  if (newUrls.length > 0) {
    urlsContent += `🔥 [NEWLY INTRODUCED ENDPOINTS IN THIS RELEASE] (${newUrls.length})\n`;
    const newEpHeaders = ['STATUS', 'CATEGORY', 'ENDPOINT URL'];
    const newEpRows = newUrls.map((nu) => [
      '🔥 NEW',
      typeof nu === 'string' ? 'NEW' : (nu.category || 'NEW'),
      typeof nu === 'string' ? nu : nu.url,
    ]);
    urlsContent += renderAsciiTable(newEpHeaders, newEpRows, { 0: 10, 1: 28, 2: 240 }) + '\n\n';
  }

  urlsContent += `📦 [ACTIVE ENDPOINTS BY OPERATIONAL CATEGORY]\n`;
  urlsContent += `----------------------------------------------------------------------\n`;
  for (const [cat, list] of Object.entries(urlsByCategory)) {
    const title = categoryNames[cat] || cat;
    urlsContent += `\n[${title}] (${list.length})\n`;
    for (const item of list) {
      const isNewBadge = newUrlSet.has(item.url) ? '🔥 NEW' : '✓';
      urlsContent += `  ${isNewBadge} ${item.url}\n`;
    }
  }

  const urlsFilePath = path.join(outputDir, 'urls.txt');
  fs.writeFileSync(urlsFilePath, urlsContent, 'utf8');

  // -------------------------------------------------------------
  // 5. `models-and-pricing.txt`: clean NEW-only model & pricing delta (no old baseline bloat)
  // -------------------------------------------------------------
  const modelFindings = testRunPool.filter((f) => f.category === 'model_id');
  const pricingFindings = testRunPool.filter((f) => f.category === 'pricing');

  let modelsContent = renderAsciiBox([
    `Component: ${componentId}`,
    `Version:   ${version}`,
    `Scan ID:   ${scanId}`,
    `Timestamp: ${generatedAt}`,
    `New Models: ${modelFindings.length}  |  New Pricing Tables: ${pricingFindings.length}`,
  ], '🤖 NEW MODELS & PRICING TABLE (DELTA ONLY)') + '\n\n';

  if (modelFindings.length > 0) {
    modelsContent += `🤖 [MODEL CATALOG TABLE] (${modelFindings.length})\n`;
    const modelHeaders = ['MODEL IDENTIFIER', 'STATUS', 'SCORE', 'TIER', 'ACTIVATION', 'ORIGIN'];
    const modelRows = modelFindings.map((m) => [
      m.value,
      m.diffStatus === 'NEW' ? '🔥 NEW' : m.diffStatus === 'CHANGED' ? '🔄 MODIFIED' : (m.diffStatus || 'ACTIVE'),
      `${m.score || 0} pts`,
      m.tier || 'SIGNAL',
      m.activationStatus || 'UNKNOWN',
      m.discoveryMethod || m.origin || 'ast',
    ]);
    modelsContent += renderAsciiTable(modelHeaders, modelRows, { 0: 44, 1: 14, 2: 10, 3: 24, 4: 14, 5: 26 }) + '\n\n';
  }

  if (pricingFindings.length > 0) {
    modelsContent += `💵 [PRICING RATES TABLE] (${pricingFindings.length})\n`;
    const priceHeaders = ['MODEL / TIER', 'INPUT PRICE/1M', 'OUTPUT PRICE/1M', 'STATUS', 'SOURCE VALUE'];
    const priceRows = pricingFindings.map((p) => [
      p.model || p.value.split('|')[0].trim(),
      p.inputPrice != null ? `$${p.inputPrice}` : (p.related?.inputPrice != null ? `$${p.related.inputPrice}` : '?'),
      p.outputPrice != null ? `$${p.outputPrice}` : (p.related?.outputPrice != null ? `$${p.related.outputPrice}` : '?'),
      p.diffStatus === 'NEW' ? '🔥 NEW' : mStatus(p.diffStatus),
      p.value,
    ]);
    modelsContent += renderAsciiTable(priceHeaders, priceRows, { 0: 32, 1: 15, 2: 15, 3: 14, 4: 80 }) + '\n\n';
  }

  modelsContent += `🤖 [MODELS & CODENAMES DETAILS] (${modelFindings.length})\n`;
  modelsContent += `----------------------------------------------------------------------\n`;
  if (modelFindings.length === 0) {
    modelsContent += `No model identifiers were extracted in this release.\n`;
  } else {
    for (const item of modelFindings) {
      modelsContent += `• ${item.value} [${item.diffStatus || 'ACTIVE'}] [${item.tier || 'UNSCORED'}] (${item.score || 0} pts) ${item.activationStatus || ''}\n`;
      if (item.filePath) modelsContent += `  File: ${item.filePath}\n`;
      if (item.context) modelsContent += `  Context: ${String(item.context).replace(/\r?\n/g, ' ')}\n`;
    }
  }

  modelsContent += `\n💵 [PRICING TABLES & RATES DETAILS] (${pricingFindings.length})\n`;
  modelsContent += `----------------------------------------------------------------------\n`;
  if (pricingFindings.length === 0) {
    modelsContent += `No pricing or model-catalog table entries were extracted in this release.\n`;
  } else {
    for (const item of pricingFindings) {
      modelsContent += `• ${item.value} [${item.diffStatus || 'ACTIVE'}]\n`;
      if (item.filePath) modelsContent += `  File: ${item.filePath}\n`;
      if (item.context) modelsContent += `  Context: ${String(item.context).replace(/\r?\n/g, ' ')}\n`;
    }
  }
  const modelsFilePath = path.join(outputDir, 'models-and-pricing.txt');
  fs.writeFileSync(modelsFilePath, modelsContent, 'utf8');

  // -------------------------------------------------------------
  // 6. `scan-summary.txt`: Delta-first executive summary
  // -------------------------------------------------------------
  const coverageState = coverage.coverageState || 'UNKNOWN';
  const analyzerLines = analyzerStatus && typeof analyzerStatus === 'object'
    ? Object.entries(analyzerStatus).map(([name, value]) => `  • ${name}: ${value}`).join('\n')
    : '  • no analyzer status recorded';
  const artifactLines = artifactInventory.length > 0
    ? artifactInventory.map((art) => {
        const sizeMb = art.size ? `${(art.size / (1024 * 1024)).toFixed(2)} MB` : 'unknown size';
        const sha = art.sha256 ? ` · sha256 ${art.sha256}` : '';
        return `  • ${art.target || 'target'} (${art.format || 'bin'}) · ${sizeMb}${sha}`;
      }).join('\n')
    : '  • no artifacts recorded';
  const deliveryStatusText = delivery
    ? `${delivery.status || 'UNKNOWN'} · ${delivery.deliveredFiles?.length || 0} delivered · ${delivery.failedFiles?.length || 0} failed`
    : 'not attempted yet';

  let summaryContent = `======================================================================\n`;
  summaryContent += `SCAN SUMMARY\n`;
  summaryContent += `Component: ${componentId}\n`;
  summaryContent += `Family:    ${family || 'unknown'}\n`;
  summaryContent += `Version:   ${oldVersion} -> ${version}\n`;
  summaryContent += `Scheme:    ${versionScheme || 'unknown'}\n`;
  summaryContent += `Scan ID:   ${scanId}\n`;
  summaryContent += `Timestamp: ${generatedAt}\n`;
  summaryContent += `======================================================================\n\n`;
  summaryContent += `🔥 NEW LEAKS HIGHLIGHT (${highSignalNewLeaks.length})\n`;
  if (highSignalNewLeaks.length === 0) {
    summaryContent += `  • No high-confidence new leaks detected in this release delta.\n\n`;
  } else {
    for (const item of highSignalNewLeaks.slice(0, 40)) {
      summaryContent += `  • [${item.category}] ${item.value} (${item.score || 0} pts)\n`;
    }
    if (highSignalNewLeaks.length > 40) {
      summaryContent += `  • ...plus ${highSignalNewLeaks.length - 40} more in leaks.txt\n`;
    }
    summaryContent += '\n';
  }
  summaryContent += `🧭 COVERAGE\n`;
  summaryContent += `  • State: ${coverageState}\n`;
  summaryContent += `  • Artifacts: ${coverage.downloadedArtifacts ?? '?'} downloaded / ${coverage.expectedArtifacts ?? '?'} expected\n`;
  summaryContent += `  • Files analyzed: ${coverage.analyzedFiles ?? '?'}\n`;
  summaryContent += `  • Coverage percentage: ${coverage.percentage ?? '?'}%\n`;
  const platformSummary = expectedPlatforms.includes('all')
    ? 'all platforms'
    : expectedPlatforms.length > 0
      ? [
          expectedPlatforms.includes('darwin') ? `macOS: ${coverage.macOk === false ? 'missing' : 'ok'}` : null,
          expectedPlatforms.includes('win32') ? `Windows: ${coverage.winOk === false ? 'missing' : 'ok'}` : null,
          expectedPlatforms.includes('linux') ? `Linux: ${coverage.linuxOk === false ? 'missing' : 'ok'}` : null,
        ].filter(Boolean).join(' · ')
      : `macOS: ${coverage.macOk === false ? 'missing' : 'ok'} · Windows: ${coverage.winOk === false ? 'missing' : 'ok'}`;
  summaryContent += `  • Platforms: ${platformSummary}\n\n`;
  summaryContent += `🧪 ANALYZERS\n${analyzerLines}\n\n`;
  summaryContent += `📦 ARTIFACTS\n${artifactLines}\n\n`;
  summaryContent += `📊 COUNTS\n`;
  summaryContent += `  • Total clean strings: ${stringCounts ? stringCounts.current : totalExtractedStrings}\n`;
  summaryContent += `  • New strings: ${stringCounts ? stringCounts.added : uniqueCleanNewStrings.length}\n`;
  summaryContent += `  • Removed strings: ${stringCounts ? stringCounts.removed : removedFindings.length}\n`;
  summaryContent += `  • Reintroduced strings: ${stringCounts ? stringCounts.reintroduced : reintroducedFindings.length}\n`;
  summaryContent += `  • New leaks: ${highSignalNewLeaks.length} (Low-conf sidecar: ${weakCandidateLeaks.length})\n`;
  summaryContent += `  • Endpoints: ${urlsInventory.length} (new: ${newUrls.length})\n\n`;
  summaryContent += `🚚 DELIVERY\n  • ${deliveryStatusText}\n`;
  if (highSignalNewLeaks.length > 0) {
    summaryContent += `\n🔥 TOP NEW SIGNALS\n`;
    for (const item of highSignalNewLeaks.slice(0, 20)) {
      summaryContent += `  • [${item.category}] ${item.value} (${item.score || 0} pts)\n`;
    }
  }
  const summaryFilePath = path.join(outputDir, 'scan-summary.txt');
  fs.writeFileSync(summaryFilePath, summaryContent, 'utf8');

  // Telegram attachments: always the complete, fixed six-file bundle.
  const telegramFiles = [];
  if (fs.existsSync(leaksFilePath)) telegramFiles.push(leaksFilePath);
  if (fs.existsSync(diffFilePath)) telegramFiles.push(diffFilePath);
  if (fs.existsSync(stringsFilePath)) {
    const stringSize = fs.statSync(stringsFilePath).size;
    if (stringSize > 1024 * 1024 && fs.existsSync(stringsGzPath)) {
      telegramFiles.push(stringsGzPath);
    } else {
      telegramFiles.push(stringsFilePath);
    }
  }
  if (fs.existsSync(urlsFilePath)) telegramFiles.push(urlsFilePath);
  if (fs.existsSync(modelsFilePath)) telegramFiles.push(modelsFilePath);
  if (fs.existsSync(summaryFilePath)) telegramFiles.push(summaryFilePath);

  return {
    files: [
      path.join(outputDir, '1-major-and-high.txt'),
      path.join(outputDir, '2-early-and-weak.txt'),
      path.join(outputDir, '3-by-category.txt'),
      path.join(outputDir, '4-all-new-strings.txt.gz'),
      path.join(outputDir, '5-platform-only.txt'),
      path.join(outputDir, '6-removed.txt.gz'),
      leaksFilePath,
      diffFilePath,
      stringsFilePath,
      urlsFilePath,
      modelsFilePath,
      summaryFilePath,
    ],
    telegramFiles,
    countCheck: {
      passed: countCheckPassed,
      text: countCheckText,
    },
    leaksCount: validLeaks.length,
    newStringsCount: uniqueCleanNewStrings.length,
    urlsCount: urlsInventory.length,
    newUrlsCount: newUrls.length,
    modelCount: modelFindings.length,
    pricingCount: pricingFindings.length,
  };
}

function mStatus(status) {
  if (status === 'CHANGED') return '🔄 MODIFIED';
  return status || 'ACTIVE';
}
