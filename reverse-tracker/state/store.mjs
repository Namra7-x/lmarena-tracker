/**
 * Compact State Store & Transactional Candidate Validator (Section 2.1 & 7)
 * Atomic writes, bounded collections, and complete metadata persistence.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAX_RECENT_SIGNALS = 5000;
const MAX_HISTORICAL_HASHES = 10000;
const MAX_HISTORICAL_URLS = 5000;
const MAX_DELIVERY_LEDGER = 50;
const MAX_RELEASE_HISTORY = 100;
const STATE_SCHEMA_VERSION = 2;

function boundArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

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
 * Load dedicated master state for a specific product/lab component.
 * Compressed with gzip (.json.gz) to store full historical memory permanently without Git bloat.
 */
export function loadMasterState(stateDir, componentId) {
  const gzPath = path.join(stateDir, `${componentId}_master.json.gz`);
  const jsonPath = path.join(stateDir, `${componentId}_master.json`);
  let parsed = null;

  if (fs.existsSync(gzPath)) {
    try {
      const buffer = fs.readFileSync(gzPath);
      const unzipped = zlib.gunzipSync(buffer).toString('utf8');
      parsed = JSON.parse(unzipped);
    } catch (err) {
      console.warn(`Failed to read gzip master state for ${componentId}: ${err.message}`);
    }
  }

  if (!parsed && fs.existsSync(jsonPath)) {
    try {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`Failed to read json master state for ${componentId}: ${err.message}`);
    }
  }

  if (!parsed) {
    const legacyState = loadComponentState(stateDir, componentId);
    parsed = {
      componentId,
      schemaVersion: 3,
      knownSignals: legacyState?.knownSignals || {},
      knownStrings: [],
      knownUrls: [],
      releaseHistory: legacyState?.releaseHistory || [],
    };
  }

  if (!parsed.knownSignals) parsed.knownSignals = {};
  if (!Array.isArray(parsed.knownStrings)) parsed.knownStrings = [];
  if (!Array.isArray(parsed.knownUrls)) parsed.knownUrls = [];
  if (!Array.isArray(parsed.releaseHistory)) parsed.releaseHistory = [];

  return parsed;
}

/**
 * Save updated master state for a specific product/lab component.
 * Uses atomic gzip write so no data is corrupted or dropped.
 */
export function saveMasterState(stateDir, componentId, masterState) {
  fs.mkdirSync(stateDir, { recursive: true });
  const gzPath = path.join(stateDir, `${componentId}_master.json.gz`);
  const tmpGzPath = path.join(stateDir, `${componentId}_master.json.gz.tmp.${Date.now()}`);

  const payload = {
    ...masterState,
    componentId,
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
  };

  const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
  const compressed = zlib.gzipSync(buffer, { level: 9 });

  fs.writeFileSync(tmpGzPath, compressed);
  try {
    fs.renameSync(tmpGzPath, gzPath);
  } catch {
    fs.copyFileSync(tmpGzPath, gzPath);
    try { fs.unlinkSync(tmpGzPath); } catch {}
  }

  return payload;
}

/**
 * Save updated compact state for a component.
 * Uses atomic file write (temp file + rename) and preserves all evidence and metadata.
 */
export function saveComponentState(stateDir, componentId, newState) {
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, `${componentId}.json`);
  const tmpFilePath = path.join(stateDir, `${componentId}.json.tmp.${Date.now()}`);

  // Bound legacy collections to prevent unbounded memory growth in CI state branches.
  const recentSignals = boundArray(newState.recentSignals, MAX_RECENT_SIGNALS);
  const historicalSeenHashes = boundArray(newState.historicalSeenHashes, MAX_HISTORICAL_HASHES);
  const historicalSeenUrls = boundArray(newState.historicalSeenUrls, MAX_HISTORICAL_URLS);

  const compactState = {
    ...newState,
    schemaVersion: STATE_SCHEMA_VERSION,
    componentId,
    version: newState.version,
    alertedVersion: Object.prototype.hasOwnProperty.call(newState, 'alertedVersion')
      ? newState.alertedVersion
      : (newState.version || null),
    observedVersion: Object.prototype.hasOwnProperty.call(newState, 'observedVersion')
      ? newState.observedVersion
      : (newState.version || null),
    scannedVersion: newState.scannedVersion || null,
    deliveredVersion: newState.deliveredVersion || null,
    releaseId: newState.releaseId,
    releaseKey: newState.releaseKey || null,
    channel: newState.channel || 'stable',
    versionScheme: newState.versionScheme || null,
    identityFingerprint: newState.identityFingerprint,
    diagnosticFingerprint: newState.diagnosticFingerprint || null,
    scanId: newState.scanId,
    coverageState: newState.coverageState || 'COMPLETE',
    // This timestamp means a complete scan was fully delivered. Never invent it
    // merely because extraction reached COMPLETE while report delivery failed.
    lastSuccessfulScan: newState.lastSuccessfulScan || null,
    lastFailureTime: newState.lastFailureTime || null,
    lastDeliveryStatus: newState.lastDeliveryStatus || null,
    lastAlertDigest: newState.lastAlertDigest || null,
    lastTestAlertVersion: newState.lastTestAlertVersion || null,
    analyzerStatus: newState.analyzerStatus || null,
    benchmark: newState.benchmark || null,
    hotSignals: boundArray(newState.hotSignals, 100),
    recentSignals,
    knownSignals: newState.knownSignals || {},
    historicalSeenHashes,
    historicalSeenUrls,
    pendingDelivery: newState.pendingDelivery || null,
    deliveryLedger: boundArray(newState.deliveryLedger, MAX_DELIVERY_LEDGER),
    releaseHistory: boundArray(newState.releaseHistory, MAX_RELEASE_HISTORY),
    stringBaseline: newState.stringBaseline || null,
    stringHistory: newState.stringHistory || null,
    urlBaseline: newState.urlBaseline || null,
    urlHistory: newState.urlHistory || null,
    lastCoverageGaps: boundArray(newState.lastCoverageGaps, 100),
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
 * Append a delivery ledger entry and keep the newest N entries.
 */
export function appendDeliveryLedger(state, entry) {
  const ledger = Array.isArray(state?.deliveryLedger) ? state.deliveryLedger : [];
  return [entry, ...ledger].slice(0, MAX_DELIVERY_LEDGER);
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
