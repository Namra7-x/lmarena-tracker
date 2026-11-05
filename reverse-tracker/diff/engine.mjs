/**
 * Exact Diff Engine (Section 7)
 * Computes exact new, removed, persistent, and reintroduced items.
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
 * @returns {Object} { newFindings, removedFindings, persistentFindings, reintroducedFindings }
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

  for (const [hash, finding] of candMap.entries()) {
    if (prevMap.has(hash)) {
      persistentFindings.push({ ...finding, diffStatus: 'persistent' });
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

  return {
    newFindings,
    reintroducedFindings,
    persistentFindings,
    removedFindings,
    counts: {
      totalCandidate: candidateFindings.length,
      newCount: newFindings.length,
      reintroducedCount: reintroducedFindings.length,
      persistentCount: persistentFindings.length,
      removedCount: removedFindings.length,
    },
  };
}
