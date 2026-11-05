/**
 * Deterministic Scoring Engine & Tier Assignment (Section 4.3 & 4.4)
 */

import { CATEGORIES } from './rules.mjs';
import { isThirdPartyPath, evaluateNoise } from './noise.mjs';

export const TIERS = {
  CONFIRMED: 'CONFIRMED',
  HIGH_CONFIDENCE: 'HIGH-CONFIDENCE SIGNAL',
  EARLY_SIGNAL: 'EARLY SIGNAL',
  WEAK_SIGNAL: 'WEAK SIGNAL',
  HIDDEN: 'HIDDEN',
};

/**
 * Score an extracted finding deterministically according to Section 4.4 table.
 *
 * @param {Object} finding
 * @param {Object} context { isNewInDiff, isFirstEverSeen, matchesReleaseNotes, historicalFp }
 * @returns {Object} scored finding with score, tier, isMajorEarlySignal, breakdown
 */
export function scoreFinding(finding, context = {}) {
  let score = 0;
  const breakdown = [];

  // 1. Exact diff & history
  if (context.isNewInDiff) {
    score += 10;
    breakdown.push({ rule: 'New in exact diff', points: 10 });
  }
  if (context.isFirstEverSeen) {
    score += 15;
    breakdown.push({ rule: 'First-ever appearance in history', points: 15 });
  }

  // 2. Category weights
  switch (finding.category) {
    case CATEGORIES.MODEL_ID:
      score += 25;
      breakdown.push({ rule: 'Category: model id', points: 25 });
      break;
    case CATEGORIES.FEATURE_FLAG:
      score += 15;
      breakdown.push({ rule: 'Category: feature/rollout flag', points: 15 });
      break;
    case CATEGORIES.HIDDEN_COMMAND:
    case CATEGORIES.ENDPOINT_DOMAIN:
      score += 15;
      breakdown.push({ rule: 'Category: hidden command / endpoint', points: 15 });
      break;
    case CATEGORIES.AGENT_MODE:
      score += 12;
      breakdown.push({ rule: 'Category: agent/skill/MCP/plugin', points: 12 });
      break;
    case CATEGORIES.UI_STRING:
      score += 12;
      breakdown.push({ rule: 'Category: UI feature string', points: 12 });
      break;
    case CATEGORIES.ENV_VAR:
    case CATEGORIES.PLATFORM_ENTITLEMENT:
      score += 10;
      breakdown.push({ rule: 'Category: env var / config / entitlement', points: 10 });
      break;
    case CATEGORIES.DEPENDENCY:
      score += 5;
      breakdown.push({ rule: 'Category: dependency', points: 5 });
      break;
    default:
      break;
  }

  // 3. Dormant marker context
  if (finding.hasDormantMarker) {
    score += 15;
    breakdown.push({ rule: `Dormant marker (${finding.dormantMarker}) in context`, points: 15 });
  }

  // 4. Agreement bonuses
  if (finding.artifactClasses && finding.artifactClasses.length >= 2) {
    score += 10;
    breakdown.push({ rule: '2+ artifact classes agree (JS + binary)', points: 10 });
  }
  if (finding.platforms && finding.platforms.length >= 2) {
    score += 8;
    breakdown.push({ rule: 'Present on both macOS and Windows', points: 8 });
  }
  if (finding.sourceMapAgreement) {
    score += 10;
    breakdown.push({ rule: 'Source-map + binary agreement', points: 10 });
  }
  if (finding.platformOnly) {
    score += 6;
    breakdown.push({ rule: `PLATFORM_ONLY (${finding.platformOnly})`, points: 6 });
  }

  // 5. Penalties
  if (isThirdPartyPath(finding.filePath)) {
    score -= 20;
    breakdown.push({ rule: 'Attributed to third-party dependency', points: -20 });
  }

  const noise = evaluateNoise(finding.value);
  if (noise.isNoise) {
    if (noise.isMinified || noise.isHashOrUuid) {
      score -= 15;
      breakdown.push({ rule: `Looks minified/hash/uuid (${noise.reason})`, points: -15 });
    }
  }

  if (context.historicalFp) {
    score -= 10;
    breakdown.push({ rule: 'High historical false-positive rate', points: -10 });
  }

  // 6. Tier assignment
  let tier;
  if (context.matchesReleaseNotes) {
    tier = TIERS.CONFIRMED;
  } else if (score >= 60) {
    tier = TIERS.HIGH_CONFIDENCE;
  } else if (score >= 35) {
    tier = TIERS.EARLY_SIGNAL;
  } else if (score >= 15) {
    tier = TIERS.WEAK_SIGNAL;
  } else {
    tier = TIERS.HIDDEN;
  }

  // 7. MAJOR EARLY SIGNAL qualification:
  // HIGH-CONFIDENCE (60+), not in release notes, and category is model, command, endpoint, or agent
  const isMajorEarlySignal =
    tier === TIERS.HIGH_CONFIDENCE &&
    !context.matchesReleaseNotes &&
    (finding.category === CATEGORIES.MODEL_ID ||
      finding.category === CATEGORIES.HIDDEN_COMMAND ||
      finding.category === CATEGORIES.ENDPOINT_DOMAIN ||
      finding.category === CATEGORIES.AGENT_MODE);

  return {
    ...finding,
    score,
    tier,
    isMajorEarlySignal,
    breakdown,
  };
}

/**
 * Deterministically sort findings: score desc, category, value.
 */
export function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.value.localeCompare(b.value);
  });
}
