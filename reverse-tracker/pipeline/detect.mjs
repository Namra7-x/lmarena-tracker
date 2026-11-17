/**
 * Change detection stage.
 *
 * Keeps the original workflow behavior (no files unless a real release changed)
 * while fixing three bugs:
 *  1. ETag/header flaps are not releases.
 *  2. A version that was alerted but not delivered is resumed, never skipped.
 *  3. The automatic "one-time test" queue was removed; manual test-run is the
 *     only way to force a test message.
 */

import path from 'node:path';
import { FAMILIES, COMPONENTS, generateScanId } from '../registry/components.mjs';
import { discoverComponent } from '../sources/index.mjs';
import { classifyChange, CHANGE_TYPE } from '../fingerprint/classifier.mjs';
import { computeIdentityFingerprint } from '../fingerprint/identity.mjs';
import { loadComponentState, saveComponentState } from '../state/store.mjs';
import {
  computeReleaseKey,
  encodeStringSet,
  encodeUrlSet,
  decodeStringSet,
} from '../state/baseline.mjs';

const STATE_DIR = process.env.STATE_DIR || path.resolve(process.cwd(), 'state');

function migrateLegacyBaseline(baseline) {
  if (!baseline) return { state: baseline, changed: false };
  let changed = false;
  const next = { ...baseline };

  if (!next.stringBaseline) {
    next.stringBaseline = encodeStringSet(next.historicalSeenHashes || []);
    next.stringHistory = encodeStringSet(next.historicalSeenHashes || []);
    changed = true;
  }
  if (!next.stringHistory) {
    next.stringHistory = encodeStringSet(decodeStringSet(next.stringBaseline, []));
    changed = true;
  }
  if (!next.urlBaseline) {
    next.urlBaseline = encodeUrlSet(next.historicalSeenUrls || []);
    next.urlHistory = encodeUrlSet(next.historicalSeenUrls || []);
    changed = true;
  }
  if (!next.urlHistory) {
    next.urlHistory = encodeUrlSet(next.historicalSeenUrls || []);
    changed = true;
  }
  if (next.schemaVersion !== 2) {
    next.schemaVersion = 2;
    changed = true;
  }
  if (next.deliveredVersion === undefined && next.alertedVersion && next.version === next.alertedVersion) {
    next.deliveredVersion = next.version;
    changed = true;
  }
  return { state: next, changed };
}

function initializeBaseline(componentId, candidate) {
  const identityFingerprint = computeIdentityFingerprint(candidate);
  return {
    schemaVersion: 2,
    componentId,
    version: candidate.version,
    observedVersion: candidate.version,
    scannedVersion: null,
    deliveredVersion: null,
    alertedVersion: null,
    releaseId: candidate.releaseId,
    releaseKey: computeReleaseKey(componentId, candidate),
    channel: candidate.channel || 'stable',
    versionScheme: candidate.versionScheme || null,
    identityFingerprint,
    diagnosticFingerprint: null,
    scanId: generateScanId(componentId),
    coverageState: 'BASELINE_ONLY',
    lastSuccessfulScan: null,
    lastFailureTime: null,
    lastDeliveryStatus: null,
    lastTestAlertVersion: null,
    analyzerStatus: null,
    pendingDelivery: null,
    deliveryLedger: [],
    releaseHistory: [],
    hotSignals: [],
    recentSignals: [],
    historicalSeenHashes: [],
    historicalSeenUrls: [],
    stringBaseline: encodeStringSet([]),
    stringHistory: encodeStringSet([]),
    urlBaseline: encodeUrlSet([]),
    urlHistory: encodeUrlSet([]),
    lastCoverageGaps: [],
  };
}

function silentSyncBaseline(stateDir, componentId, baseline, candidate, classification) {
  return saveComponentState(stateDir, componentId, {
    ...baseline,
    schemaVersion: 2,
    version: candidate.version,
    observedVersion: candidate.version,
    scannedVersion: baseline.scannedVersion || null,
    deliveredVersion: baseline.deliveredVersion || null,
    alertedVersion: baseline.alertedVersion || null,
    releaseId: candidate.releaseId,
    releaseKey: computeReleaseKey(componentId, candidate),
    channel: candidate.channel || baseline.channel || 'stable',
    versionScheme: candidate.versionScheme || baseline.versionScheme || null,
    identityFingerprint: classification.identityFingerprint,
    diagnosticFingerprint: classification.diagnosticFingerprint,
  });
}

export async function detectChanges(familyId = null, options = {}) {
  const stateDir = options.stateDir || STATE_DIR;
  const fetcher = options.fetcher || discoverComponent;
  const componentsToCheck = options.components || (familyId
    ? FAMILIES[familyId]?.components || []
    : Object.keys(COMPONENTS));

  console.log(`\n🔍 [Detect] Checking components for family: ${familyId || 'ALL'}`);
  const changes = [];
  const firstRuns = [];

  for (const compId of componentsToCheck) {
    try {
      const loaded = loadComponentState(stateDir, compId);
      const migration = migrateLegacyBaseline(loaded);
      let baseline = migration.state;
      if (baseline && migration.changed) {
        saveComponentState(stateDir, compId, baseline);
      }

      const candidate = await fetcher(compId);
      if (!candidate || !candidate.version) {
        throw new Error('Discovery returned no version');
      }

      const classification = classifyChange(baseline, candidate);
      const releaseKey = computeReleaseKey(compId, candidate);
      const pending = baseline?.pendingDelivery;
      const pendingResume = Boolean(
        pending &&
        (pending.releaseKey === releaseKey || pending.version === candidate.version) &&
        pending.status !== 'DELIVERED' &&
        (pending.failedFiles?.length > 0 || !pending.completionSent || pending.status === 'DELIVERY_FAILED' || pending.status === 'COMPLETION_FAILED' || pending.status === 'ALERTED') &&
        pending.alertSent !== false
      );
      const legacyResume = Boolean(
        baseline?.alertedVersion === candidate.version &&
        baseline?.deliveredVersion !== candidate.version
      );
      // Older state files can claim COMPLETE/PARTIAL without a delivery ledger.
      // Recover the missing reports without sending another version alert, but NEVER loop if
      // this version was already scanned or delivered.
      const incompleteSameVersion = Boolean(
        baseline &&
        ['PARTIAL', 'FAILED'].includes(baseline.coverageState) &&
        baseline.version === candidate.version &&
        baseline.scannedVersion !== candidate.version &&
        baseline.deliveredVersion !== candidate.version &&
        !pending
      );

      if (incompleteSameVersion) {
        console.log(`  ↻ ${compId}: Recovering incomplete scan for ${candidate.version} without a duplicate alert.`);
        changes.push({
          componentId: compId,
          family: COMPONENTS[compId].family,
          candidate,
          baseline,
          classification,
          resume: true,
          skipAlert: true,
        });
        continue;
      }

      if (pendingResume || legacyResume) {
        const deliveriesForVersion = (baseline?.deliveryLedger || []).filter(
          (entry) => entry.version === candidate.version && (entry.deliveredFiles?.length || 0) > 0,
        ).length;

        if (deliveriesForVersion >= 2) {
          console.log(`  ✓ ${compId}: Version ${candidate.version} already delivered ${deliveriesForVersion} times. Settling pending delivery.`);
          saveComponentState(stateDir, compId, {
            ...baseline,
            pendingDelivery: null,
            deliveredVersion: candidate.version,
            version: candidate.version,
          });
          continue;
        }

        console.log(`  ↻ ${compId}: Resuming delivery for ${candidate.version} (${pending?.status || 'ALERTED_NOT_DELIVERED'}) without a duplicate alert.`);
        changes.push({
          componentId: compId,
          family: COMPONENTS[compId].family,
          candidate,
          baseline,
          classification,
          resume: true,
          skipAlert: true,
        });
        continue;
      }

      if (classification.changeType === CHANGE_TYPE.FIRST_RUN) {
        console.log(`  🆕 ${compId}: First run detected (${candidate.version}). Initializing baseline silently.`);
        saveComponentState(stateDir, compId, initializeBaseline(compId, candidate));
        firstRuns.push({ componentId: compId, version: candidate.version });
        continue;
      }

      if (classification.changeType === CHANGE_TYPE.NO_CHANGE || classification.changeType === CHANGE_TYPE.DIAGNOSTIC_DRIFT) {
        console.log(`  ✓ ${compId}: Unchanged (${candidate.version})${classification.changeType === CHANGE_TYPE.DIAGNOSTIC_DRIFT ? ` · ${classification.reason}` : ''}`);
        if (baseline) {
          saveComponentState(stateDir, compId, {
            ...baseline,
            diagnosticFingerprint: classification.diagnosticFingerprint,
          });
        }
        continue;
      }

      if (baseline?.alertedVersion === candidate.version) {
        if (
          baseline.deliveredVersion === candidate.version ||
          (baseline.version === candidate.version && !pending)
        ) {
          console.log(`  ℹ️ ${compId}: Version ${candidate.version} already delivered. Syncing identity silently.`);
          silentSyncBaseline(stateDir, compId, baseline, candidate, classification);
        } else {
          console.log(`  ↻ ${compId}: Version ${candidate.version} was alerted but not delivered. Resuming.`);
          changes.push({
            componentId: compId,
            family: COMPONENTS[compId].family,
            candidate,
            baseline,
            classification,
            resume: true,
          });
        }
        continue;
      }

      // A same-version artifact/commit flap is a CDN/replica change, not a new
      // release. Do not alert or rescan; just move the identity forward.
      if (
        classification.changeType === CHANGE_TYPE.BYTE_CHANGE &&
        baseline &&
        baseline.version === candidate.version
      ) {
        console.log(`  🔄 ${compId}: Same version ${candidate.version} with changed artifact identity; syncing silently.`);
        silentSyncBaseline(stateDir, compId, baseline, candidate, classification);
        continue;
      }

      console.log(`  🚨 ${compId}: ${classification.changeType} -> ${classification.reason}`);
      changes.push({
        componentId: compId,
        family: COMPONENTS[compId].family,
        candidate,
        baseline,
        classification,
        resume: false,
      });
    } catch (err) {
      console.error(`  ✗ Error checking ${compId}: ${err.message}`);
    }
  }

  if (firstRuns.length > 0) {
    console.log(`📡 Baseline calibrated silently for ${firstRuns.length} component(s). Zero messages sent.`);
  }

  return changes;
}

export { STATE_DIR };
