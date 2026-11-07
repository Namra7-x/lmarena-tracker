/**
 * Compact State Store & Transactional Candidate Validator (Section 2.1 & 7)
 * Atomic writes, bounded collections, and complete metadata persistence.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_RECENT_SIGNALS = 5000;
const MAX_HISTORICAL_HASHES = 10000;
const MAX_HISTORICAL_URLS = 5000;

/**
 * Load compact state for a component.
 */
export function loadComponentState(stateDir, componentId) {
  const filePath = path.join(stateDir, `${componentId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Failed to read state for ${componentId}: ${err.message}`);
    return null;
  }
}

/**
 * Save updated compact state for a component.
 * Uses atomic file write (temp file + rename) and preserves all evidence and metadata.
 */
export function saveComponentState(stateDir, componentId, newState) {
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, `${componentId}.json`);
  const tmpFilePath = path.join(stateDir, `${componentId}.json.tmp.${Date.now()}`);

  // Bound collections to prevent unbounded memory growth in CI state branches
  const recentSignals = (newState.recentSignals || []).slice(0, MAX_RECENT_SIGNALS);
  const historicalSeenHashes = (newState.historicalSeenHashes || []).slice(0, MAX_HISTORICAL_HASHES);
  const historicalSeenUrls = (newState.historicalSeenUrls || []).slice(0, MAX_HISTORICAL_URLS);

  const compactState = {
    componentId,
    version: newState.version,
    alertedVersion: newState.alertedVersion || newState.version || null,
    releaseId: newState.releaseId,
    channel: newState.channel || 'stable',
    identityFingerprint: newState.identityFingerprint,
    diagnosticFingerprint: newState.diagnosticFingerprint || null,
    scanId: newState.scanId,
    coverageState: newState.coverageState || 'COMPLETE',
    lastSuccessfulScan: newState.coverageState === 'COMPLETE' ? (newState.lastSuccessfulScan || new Date().toISOString()) : undefined,
    lastFailureTime: newState.lastFailureTime || null,
    lastAlertDigest: newState.lastAlertDigest || null,
    analyzerStatus: newState.analyzerStatus || null,
    benchmark: newState.benchmark || null,
    hotSignals: newState.hotSignals || [],
    recentSignals,
    historicalSeenHashes,
    historicalSeenUrls,
  };

  // Atomic write: write to unique temporary file then atomically replace target
  fs.writeFileSync(tmpFilePath, JSON.stringify(compactState, null, 2), 'utf8');
  try {
    fs.renameSync(tmpFilePath, filePath);
  } catch {
    // Fallback if cross-device or permission lock on Windows
    fs.copyFileSync(tmpFilePath, filePath);
    try { fs.unlinkSync(tmpFilePath); } catch {}
  }

  return compactState;
}

/**
 * Transactional validation:
 * Never advance baseline if scan was partial, failed, or base fingerprint changed.
 */
export function validateStateAdvancement(baseline, candidate) {
  if (candidate.coverageState === 'FAILED' || candidate.coverageState === 'PARTIAL') {
    return {
      canAdvance: false,
      reason: `Cannot advance baseline: coverage state is ${candidate.coverageState}`,
    };
  }

  if (baseline && candidate.basedOnFingerprint) {
    if (baseline.identityFingerprint !== candidate.basedOnFingerprint) {
      return {
        canAdvance: false,
        reason: 'Baseline was updated concurrently; candidate basedOnFingerprint is stale.',
      };
    }
  }

  return { canAdvance: true };
}
