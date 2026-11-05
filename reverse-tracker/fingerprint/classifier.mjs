/**
 * Change Classifier (Section 3)
 * Deterministically classifies identity transitions between baseline and candidate.
 */

import { computeIdentityFingerprint, computeDiagnosticFingerprint } from './identity.mjs';

export const CHANGE_TYPE = {
  FIRST_RUN: 'FIRST_RUN',
  NO_CHANGE: 'NO_CHANGE',
  VERSION_CHANGE: 'VERSION_CHANGE',
  BYTE_CHANGE: 'BYTE_CHANGE',
  DIAGNOSTIC_DRIFT: 'DIAGNOSTIC_DRIFT',
};

/**
 * Classify changes between baseline state and discovered candidate.
 *
 * @param {Object|null} baseline - Saved state from state branch
 * @param {Object} candidate - Newly discovered release information
 * @returns {Object} { changeType, reason, identityFingerprint, oldVersion, newVersion }
 */
export function classifyChange(baseline, candidate) {
  const candidateIdentity = computeIdentityFingerprint(candidate);
  const candidateDiagnostic = computeDiagnosticFingerprint(candidate);

  if (!baseline || !baseline.identityFingerprint) {
    return {
      changeType: CHANGE_TYPE.FIRST_RUN,
      reason: 'No previous baseline found for component.',
      identityFingerprint: candidateIdentity,
      diagnosticFingerprint: candidateDiagnostic,
      oldVersion: null,
      newVersion: candidate.version,
    };
  }

  // 1. Identical identity fingerprint -> NO_CHANGE
  if (baseline.identityFingerprint === candidateIdentity) {
    // Check if volatile diagnostic drifted (informational only)
    if (baseline.diagnosticFingerprint && baseline.diagnosticFingerprint !== candidateDiagnostic) {
      return {
        changeType: CHANGE_TYPE.DIAGNOSTIC_DRIFT,
        reason: 'Metadata or headers drifted, but binary identity is unchanged.',
        identityFingerprint: candidateIdentity,
        diagnosticFingerprint: candidateDiagnostic,
        oldVersion: baseline.version,
        newVersion: candidate.version,
      };
    }
    return {
      changeType: CHANGE_TYPE.NO_CHANGE,
      reason: 'Candidate matches existing baseline identity.',
      identityFingerprint: candidateIdentity,
      diagnosticFingerprint: candidateDiagnostic,
      oldVersion: baseline.version,
      newVersion: candidate.version,
    };
  }

  // 2. Real Version / Release Change
  if (baseline.version !== candidate.version || baseline.releaseId !== candidate.releaseId) {
    return {
      changeType: CHANGE_TYPE.VERSION_CHANGE,
      reason: `Version bumped from ${baseline.version} to ${candidate.version}`,
      identityFingerprint: candidateIdentity,
      diagnosticFingerprint: candidateDiagnostic,
      oldVersion: baseline.version,
      newVersion: candidate.version,
    };
  }

  // 3. Same version, but different URL or Checksum -> BYTE_CHANGE
  return {
    changeType: CHANGE_TYPE.BYTE_CHANGE,
    reason: `Same version (${candidate.version}), but artifact URL or integrity changed.`,
    identityFingerprint: candidateIdentity,
    diagnosticFingerprint: candidateDiagnostic,
    oldVersion: baseline.version,
    newVersion: candidate.version,
  };
}
