/**
 * Fingerprint Calculation (Section 3)
 * Identity fingerprint vs Diagnostic fingerprint
 */

import { createHash } from 'node:crypto';

/**
 * Compute the authoritative Identity Fingerprint.
 * ONLY includes identity-defining fields:
 * - componentId
 * - channel
 * - normalized version
 * - releaseId
 * - sorted list of official target artifacts (target, url, checksum)
 *
 * Explicitly EXCLUDES: page HTML, changelog text, ETag, Last-Modified, Content-Length, timestamps.
 */
export function computeIdentityFingerprint(candidate) {
  if (!candidate) return null;

  const normalizedArtifacts = (candidate.artifacts || []).map((a) => ({
    target: a.target || 'all',
    url: a.url || '',
    checksum: a.checksum || null,
  })).sort((a, b) => (a.target + a.url).localeCompare(b.target + b.url));

  const identityPayload = {
    componentId: candidate.componentId,
    channel: candidate.channel || 'stable',
    version: String(candidate.version || '').trim(),
    releaseId: String(candidate.releaseId || '').trim(),
    artifacts: normalizedArtifacts,
  };

  const jsonString = JSON.stringify(identityPayload);
  return createHash('sha256').update(jsonString, 'utf8').digest('hex');
}

/**
 * Compute Diagnostic Fingerprint for volatile observations (ETags, timestamps, headers).
 */
export function computeDiagnosticFingerprint(candidate) {
  if (!candidate) return null;

  const payload = {
    metadata: candidate.metadata || {},
    artifactSizes: (candidate.artifacts || []).map((a) => ({
      target: a.target,
      contentLength: a.contentLength || null,
    })),
  };

  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}
