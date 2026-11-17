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

const VOLATILE_VERSION = /^(?:etag-|latest$|unknown$|build-etag-|build-size-|build-latest|build-unknown|0x[0-9a-f]+$)/i;

/**
 * True for ETag-derived / placeholder version labels that must never drive an
 * alert on their own. Real sources should emit semver, a build date, or a
 * content-derived build identifier.
 */
export function isVolatileVersion(value) {
  if (!value || typeof value !== 'string') return true;
  return VOLATILE_VERSION.test(value.trim());
}

/**
 * Parse numeric dotted versions. Returns null for non-numeric schemes.
 */
export function parseNumericVersion(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+){0,3})(?:[-+].*)?$/);
  if (!match) return null;
  return match[1].split('.').map((part) => Number.parseInt(part, 10));
}

/**
 * Parse `build-YYYYMMDD-HHMMSS` labels used by desktop auto-updaters.
 * Returns a sortable number, or null.
 */
export function parseBuildStamp(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.trim().match(/^build-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

/**
 * Compare two desktop build stamps. Same contract as compareVersions.
 */
export function compareBuildVersions(a, b) {
  const pa = parseBuildStamp(a);
  const pb = parseBuildStamp(b);
  if (pa === null || pb === null) return null;
  if (pa > pb) return 1;
  if (pa < pb) return -1;
  return 0;
}

/**
 * Compare two dotted versions. Returns 1 if a > b, -1 if a < b, 0 if equal,
 * and null if either side is not a numeric dotted version.
 */
export function compareVersions(a, b) {
  const pa = parseNumericVersion(a);
  const pb = parseNumericVersion(b);
  if (!pa || !pb) return null;

  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

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

  // Legacy state files predate identityFingerprint but still have a version.
  // Treat those as a real baseline instead of silently resetting and
  // re-alerting the same release.
  if (!baseline || (!baseline.identityFingerprint && !baseline.version)) {
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
  if (baseline.identityFingerprint && baseline.identityFingerprint === candidateIdentity) {
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

  // 2. Same release label, different artifact integrity/URL -> BYTE_CHANGE.
  // Exception: replace a legacy volatile label (latest/etag-...) with a real
  // stable version, which is a release transition, not a byte flap.
  if (baseline.version === candidate.version || baseline.releaseId === candidate.releaseId) {
    const replacingVolatileLabel = isVolatileVersion(baseline.version) && !isVolatileVersion(candidate.version);
    if (!replacingVolatileLabel) {
      return {
        changeType: CHANGE_TYPE.BYTE_CHANGE,
        reason: `Same version (${candidate.version}), but artifact URL or integrity changed.`,
        identityFingerprint: candidateIdentity,
        diagnosticFingerprint: candidateDiagnostic,
        oldVersion: baseline.version,
        newVersion: candidate.version,
      };
    }
  }

  // 3. Reject rollbacks / replica skew / ETag-only labels.
  const ordering = compareVersions(baseline.version, candidate.version)
    ?? compareBuildVersions(baseline.version, candidate.version);
  // A positive ordering means baseline is newer, i.e. the candidate is a
  // rollback/replica skew. This applies to semver and desktop build stamps.
  if (ordering === 1) {
    return {
      changeType: CHANGE_TYPE.DIAGNOSTIC_DRIFT,
      reason: `Candidate version ${candidate.version} is older than baseline ${baseline.version}; treating as replica/rollback drift.`,
      identityFingerprint: candidateIdentity,
      diagnosticFingerprint: candidateDiagnostic,
      oldVersion: baseline.version,
      newVersion: candidate.version,
    };
  }

  if (isVolatileVersion(candidate.version)) {
    return {
      changeType: CHANGE_TYPE.DIAGNOSTIC_DRIFT,
      reason: `Candidate version label '${candidate.version}' is volatile (ETag/placeholder) and cannot identify a release.`,
      identityFingerprint: candidateIdentity,
      diagnosticFingerprint: candidateDiagnostic,
      oldVersion: baseline.version,
      newVersion: candidate.version,
    };
  }

  // 4. Real Version / Release Change
  return {
    changeType: CHANGE_TYPE.VERSION_CHANGE,
    reason: `Version bumped from ${baseline.version} to ${candidate.version}`,
    identityFingerprint: candidateIdentity,
    diagnosticFingerprint: candidateDiagnostic,
    oldVersion: baseline.version,
    newVersion: candidate.version,
  };
}
