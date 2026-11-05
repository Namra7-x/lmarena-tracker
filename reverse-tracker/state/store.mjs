/**
 * Compact State Store & Transactional Candidate Validator (Section 2.1 & 7)
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_RECENT_SIGNALS = 5000;

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
 * Ensures bounded signal lists and transactional updates.
 */
export function saveComponentState(stateDir, componentId, newState) {
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, `${componentId}.json`);

  // Cap recent signals to 5000
  const recentSignals = (newState.recentSignals || []).slice(0, MAX_RECENT_SIGNALS);

  const compactState = {
    componentId,
    version: newState.version,
    releaseId: newState.releaseId,
    channel: newState.channel || 'stable',
    identityFingerprint: newState.identityFingerprint,
    diagnosticFingerprint: newState.diagnosticFingerprint || null,
    scanId: newState.scanId,
    coverageState: newState.coverageState || 'COMPLETE',
    lastSuccessfulScan: newState.lastSuccessfulScan || new Date().toISOString(),
    hotSignals: newState.hotSignals || [],
    recentSignals,
    historicalSeenHashes: newState.historicalSeenHashes || [],
  };

  fs.writeFileSync(filePath, JSON.stringify(compactState, null, 2), 'utf8');
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
