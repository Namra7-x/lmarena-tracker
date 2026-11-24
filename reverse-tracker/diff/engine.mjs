/**
 * Exact Diff Engine (Section 7)
 * Computes exact added, changed, removed, persistent, and reintroduced items.
 * Normalizes bundler chunk hashes and minified variable churn so unchanged
 * signals never re-trigger MODIFIED alerts across rebuilds.
 */

import { createHash } from 'node:crypto';
import {
  normalizePathForDiff,
  normalizeContextForDiff,
  summarizeContextDelta,
} from '../finder/similarity.mjs';

/**
 * Hash a finding record deterministically (case-normalized on key).
 */
export function hashFindingRecord(record) {
  const cat = String(record?.category || '').trim().toLowerCase();
  const val = String(record?.value || '').trim().toLowerCase();
  return createHash('sha256').update(`${cat}:${val}`, 'utf8').digest('hex');
}

/**
 * Compute exact diff between previous release findings and candidate findings.
 *
 * @param {Array<Object>} previousFindings
 * @param {Array<Object>} candidateFindings
 * @param {Set<string>} historicalSeenHashes - Set of all historically seen finding hashes/keys
 * @param {Object} masterKnownSignals - Dedicated master known signals dictionary for this product
 * @returns {Object} { newFindings, addedFindings, changedFindings, removedFindings, persistentFindings, reintroducedFindings, counts, byCategory }
 */
export function computeExactDiff(
  previousFindings = [],
  candidateFindings = [],
  historicalSeenHashes = new Set(),
  masterKnownSignals = {}
) {
  const prevMap = new Map();
  for (const f of previousFindings) {
    if (!f) continue;
    prevMap.set(hashFindingRecord(f), f);
  }

  const candMap = new Map();
  for (const f of candidateFindings) {
    if (!f) continue;
    const h = hashFindingRecord(f);
    if (!candMap.has(h)) {
      candMap.set(h, f);
    }
  }

  // Case-insensitive historical lookup set
  const historicalLower = new Set();
  for (const entry of historicalSeenHashes || []) {
    if (typeof entry === 'string') historicalLower.add(entry.toLowerCase());
  }

  const newFindings = [];
  const reintroducedFindings = [];
  const persistentFindings = [];
  const removedFindings = [];
  const changedFindings = [];

  for (const [hash, finding] of candMap.entries()) {
    const rawKey = `${finding.category || ''}:${finding.value || ''}`.toLowerCase();
    const valKey = String(finding.value || '').toLowerCase();
    const masterPrev = masterKnownSignals ? (masterKnownSignals[rawKey] || masterKnownSignals[valKey]) : null;
    const prev = prevMap.get(hash) || masterPrev;

    if (prev) {
      const statusChanged = Boolean(
        prev.activationStatus &&
        finding.activationStatus &&
        prev.activationStatus !== finding.activationStatus &&
        prev.activationStatus !== 'UNKNOWN' &&
        finding.activationStatus !== 'UNKNOWN'
      );

      // Compare normalized semantic context so 1-letter minified renames or
      // bundler hashes never trigger false MODIFIED spam.
      const prevNormCtx = normalizeContextForDiff(prev.context);
      const currNormCtx = normalizeContextForDiff(finding.context);
      const contextChanged = Boolean(
        prevNormCtx &&
        currNormCtx &&
        prevNormCtx !== currNormCtx
      );

      // Compare normalized file paths so content-hashed chunk names (app-abc123.js
      // -> app-def456.js) don't cause hundreds of false MODIFIED triggers.
      const prevNormPath = normalizePathForDiff(prev.filePath);
      const currNormPath = normalizePathForDiff(finding.filePath);
      const pathChanged = Boolean(
        prevNormPath &&
        currNormPath &&
        prevNormPath !== currNormPath
      );

      const priceChanged = Boolean(
        finding.category === 'pricing' &&
        ((prev.inputPrice != null && finding.inputPrice != null && prev.inputPrice !== finding.inputPrice) ||
         (prev.outputPrice != null && finding.outputPrice != null && prev.outputPrice !== finding.outputPrice))
      );

      if (statusChanged || contextChanged || pathChanged || priceChanged) {
        const ctxDelta = contextChanged ? summarizeContextDelta(prev.context, finding.context) : null;
        changedFindings.push({
          ...finding,
          diffStatus: 'changed',
          previousContext: prev.context,
          previousStatus: prev.activationStatus,
          previousFilePath: prev.filePath,
          changeReasons: [
            statusChanged ? `status: ${prev.activationStatus} -> ${finding.activationStatus}` : null,
            priceChanged ? 'pricing updated' : null,
            contextChanged ? 'context updated' : null,
            pathChanged ? 'location moved' : null,
          ].filter(Boolean),
          contextDeltaSummary: ctxDelta?.summary || null,
        });
      } else {
        persistentFindings.push({ ...finding, diffStatus: 'persistent' });
      }
    } else {
      const isKnownHistorical = (
        historicalSeenHashes.has(hash) ||
        historicalSeenHashes.has(finding.value) ||
        historicalSeenHashes.has(`${finding.category || ''}:${finding.value || ''}`) ||
        historicalLower.has(rawKey) ||
        historicalLower.has(valKey)
      );

      if (isKnownHistorical) {
        reintroducedFindings.push({ ...finding, diffStatus: 'reintroduced' });
      } else {
        newFindings.push({ ...finding, diffStatus: 'new' });
      }
    }
  }

  for (const [hash, finding] of prevMap.entries()) {
    if (!candMap.has(hash)) {
      removedFindings.push({ ...finding, diffStatus: 'removed' });
    }
  }

  const byCategory = {};
  const ensureCat = (cat) => {
    if (!byCategory[cat]) {
      byCategory[cat] = { total: 0, added: 0, changed: 0, persistent: 0, reintroduced: 0, removed: 0 };
    }
    return byCategory[cat];
  };

  for (const f of candidateFindings) {
    ensureCat(f.category || 'other').total++;
  }
  for (const f of newFindings) ensureCat(f.category || 'other').added++;
  for (const f of changedFindings) ensureCat(f.category || 'other').changed++;
  for (const f of persistentFindings) ensureCat(f.category || 'other').persistent++;
  for (const f of reintroducedFindings) ensureCat(f.category || 'other').reintroduced++;
  for (const f of removedFindings) ensureCat(f.category || 'other').removed++;

  return {
    newFindings,
    addedFindings: newFindings,
    changedFindings,
    reintroducedFindings,
    persistentFindings,
    removedFindings,
    byCategory,
    counts: {
      totalCandidate: candidateFindings.length,
      newCount: newFindings.length,
      addedCount: newFindings.length,
      changedCount: changedFindings.length,
      reintroducedCount: reintroducedFindings.length,
      persistentCount: persistentFindings.length,
      removedCount: removedFindings.length,
    },
  };
}

/**
 * Format structural diff into clean, uncut human-readable summary text.
 */
export function formatStructuralDiffReport(diffResults) {
  const lines = [];
  lines.push(`======================================================================`);
  lines.push(`STRUCTURAL DELTA DIFF REPORT`);
  lines.push(`Total Candidates: ${diffResults.counts.totalCandidate}`);
  lines.push(`Added: ${diffResults.counts.addedCount} | Changed: ${diffResults.counts.changedCount} | Removed: ${diffResults.counts.removedCount} | Reintroduced: ${diffResults.counts.reintroducedCount}`);
  lines.push(`======================================================================`);

  if (diffResults.byCategory && Object.keys(diffResults.byCategory).length > 0) {
    lines.push(`\n[CATEGORIES BREAKDOWN]`);
    for (const [cat, stats] of Object.entries(diffResults.byCategory)) {
      lines.push(`  • ${cat}: +${stats.added} added, *${stats.changed} changed, -${stats.removed} removed (total: ${stats.total})`);
    }
  }

  if (diffResults.newFindings.length > 0) {
    lines.push(`\n[+] NEW SIGNALS ADDED (${diffResults.newFindings.length}):`);
    for (const f of diffResults.newFindings) {
      lines.push(`  + [${f.category || 'signal'}] ${f.value} (${f.filePath || 'delta'})`);
    }
  }

  if (diffResults.changedFindings.length > 0) {
    lines.push(`\n[*] DRIFTED / CHANGED SIGNALS (${diffResults.changedFindings.length}):`);
    for (const f of diffResults.changedFindings) {
      const reasonStr = f.changeReasons?.length ? ` (${f.changeReasons.join(', ')})` : '';
      lines.push(`  * [${f.category || 'signal'}] ${f.value}${reasonStr}`);
      if (f.contextDeltaSummary) {
        lines.push(`      Delta: ${f.contextDeltaSummary}`);
      } else {
        if (f.previousContext) lines.push(`      Old: ${f.previousContext}`);
        if (f.context) lines.push(`      New: ${f.context}`);
      }
    }
  }

  if (diffResults.removedFindings.length > 0) {
    lines.push(`\n[-] DEPRECATED / REMOVED SIGNALS (${diffResults.removedFindings.length}):`);
    for (const f of diffResults.removedFindings) {
      lines.push(`  - [${f.category || 'signal'}] ${f.value}`);
    }
  }

  if (diffResults.reintroducedFindings.length > 0) {
    lines.push(`\n[~] REINTRODUCED HISTORICAL SIGNALS (${diffResults.reintroducedFindings.length}):`);
    for (const f of diffResults.reintroducedFindings) {
      lines.push(`  ~ [${f.category || 'signal'}] ${f.value}`);
    }
  }

  return lines.join('\n');
}
