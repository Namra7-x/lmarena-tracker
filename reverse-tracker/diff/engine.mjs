/**
 * Exact Diff Engine (Section 7)
 * Computes exact new, removed, persistent, and reintroduced items.
 * Includes structural category breakdown and formatted diff summaries.
 */

import { createHash } from 'node:crypto';

/**
 * Hash a finding record deterministically.
 */
export function hashFindingRecord(record) {
  const normalized = `${record.category || ''}:${record.value || ''}`;
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Compute exact diff between previous release findings and candidate findings.
 *
 * @param {Array<Object>} previousFindings
 * @param {Array<Object>} candidateFindings
 * @param {Set<string>} historicalSeenHashes - Set of all historically seen finding hashes
 * @returns {Object} { newFindings, addedFindings, changedFindings, removedFindings, persistentFindings, reintroducedFindings, counts, byCategory }
 */
export function computeExactDiff(previousFindings = [], candidateFindings = [], historicalSeenHashes = new Set()) {
  const prevMap = new Map();
  for (const f of previousFindings) {
    prevMap.set(hashFindingRecord(f), f);
  }

  const candMap = new Map();
  for (const f of candidateFindings) {
    candMap.set(hashFindingRecord(f), f);
  }

  const newFindings = [];
  const reintroducedFindings = [];
  const persistentFindings = [];
  const removedFindings = [];
  const changedFindings = [];

  for (const [hash, finding] of candMap.entries()) {
    if (prevMap.has(hash)) {
      const prev = prevMap.get(hash);
      if (prev.context !== finding.context || prev.filePath !== finding.filePath) {
        changedFindings.push({ ...finding, diffStatus: 'changed', previousContext: prev.context });
      } else {
        persistentFindings.push({ ...finding, diffStatus: 'persistent' });
      }
    } else {
      if (
        historicalSeenHashes.has(hash) ||
        historicalSeenHashes.has(finding.value) ||
        historicalSeenHashes.has(`${finding.category || ''}:${finding.value || ''}`)
      ) {
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

  // Category-specific breakdown
  const byCategory = {};
  for (const f of candidateFindings) {
    const cat = f.category || 'other';
    if (!byCategory[cat]) {
      byCategory[cat] = { total: 0, added: 0, changed: 0, persistent: 0, reintroduced: 0, removed: 0 };
    }
    byCategory[cat].total++;
  }
  for (const f of newFindings) {
    const cat = f.category || 'other';
    if (byCategory[cat]) byCategory[cat].added++;
  }
  for (const f of changedFindings) {
    const cat = f.category || 'other';
    if (byCategory[cat]) byCategory[cat].changed++;
  }
  for (const f of persistentFindings) {
    const cat = f.category || 'other';
    if (byCategory[cat]) byCategory[cat].persistent++;
  }
  for (const f of reintroducedFindings) {
    const cat = f.category || 'other';
    if (byCategory[cat]) byCategory[cat].reintroduced++;
  }
  for (const f of removedFindings) {
    const cat = f.category || 'other';
    if (!byCategory[cat]) {
      byCategory[cat] = { total: 0, added: 0, changed: 0, persistent: 0, reintroduced: 0, removed: 0 };
    }
    byCategory[cat].removed++;
  }

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
 * Format structural diff into human-readable summary text for reports and logging.
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
      lines.push(`  * [${f.category || 'signal'}] ${f.value}`);
      if (f.previousContext) lines.push(`      Old: ${f.previousContext.slice(0, 100)}`);
      if (f.context) lines.push(`      New: ${f.context.slice(0, 100)}`);
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
