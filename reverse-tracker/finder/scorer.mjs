/**
 * Deterministic Scoring Engine & Tier Assignment (Section 4.3 & 4.4)
 */

import { CATEGORIES, isValidModelIdentifier, isValidFeatureFlag, isDarkUiNoise } from './rules.mjs';
import { isThirdPartyPath, evaluateNoise } from './noise.mjs';
import { clusterRelatedFindings } from './similarity.mjs';

const KNOWN_AI_ANCHOR_RE = /^(?:gpt|claude-(?:[0-9]|opus|sonnet|haiku|mythos|fable|instant|donut|onigiri)|gemini|o[1-9]|deepseek|qwen|grok|llama|mistral|kimi|lyria|imagen|chinchilla|palm|titan|flux|sora|veo|whisper|obsidian|swe|orion|mercury|hydrogen|argon|krypton|terra|jupiter)/i;

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
  const isAstStructural = Boolean(
    finding.discoveryMethod &&
    ['ast_array_peer_cluster', 'ast_hyperparam_object', 'ast_property_model', 'ast_property_model_array', 'ast_switch_case_model', 'ast_variable_model', 'ast_variable_array_model', 'ast_pricing_catalog_model'].includes(finding.discoveryMethod)
  );
  // Defense in depth: strictly reject invalid model identifiers, flags, and Dark UI noise
  // (also automatically purges stale polluted entries loaded from legacy state/all baselines).
  if (finding.category === CATEGORIES.MODEL_ID && !isValidModelIdentifier(finding.value, { isStructuralCatalog: isAstStructural })) {
    return {
      ...finding,
      score: 0,
      tier: TIERS.HIDDEN,
      isMajorEarlySignal: false,
      status: 'rejected',
      rejectionReason: 'Rejected: invalid model identifier',
      breakdown: [{ rule: 'Rejected: invalid model identifier', points: 0 }],
    };
  }
  if ((finding.category === CATEGORIES.FEATURE_FLAG || finding.category === CATEGORIES.EXPERIMENT) && !isValidFeatureFlag(finding.value)) {
    return {
      ...finding,
      score: 0,
      tier: TIERS.HIDDEN,
      isMajorEarlySignal: false,
      status: 'rejected',
      rejectionReason: 'Rejected: invalid feature flag',
      breakdown: [{ rule: 'Rejected: invalid feature flag', points: 0 }],
    };
  }
  if (finding.category === CATEGORIES.UI_STRING && isDarkUiNoise(finding.value)) {
    return {
      ...finding,
      score: 0,
      tier: TIERS.HIDDEN,
      isMajorEarlySignal: false,
      status: 'rejected',
      rejectionReason: 'Rejected: dark UI boilerplate/localization noise',
      breakdown: [{ rule: 'Rejected: UI noise', points: 0 }],
    };
  }

  // Reject definite noise (CSS properties, licenses, file assets, bundler boilerplate, generic words, SVG/cloud regions)
  const DEFINITE_NOISE_REASONS = new Set([
    'w3c_css_property',
    'spdx_license',
    'media_or_archive_extension',
    'css_style_or_svg',
    'webpack_boilerplate',
    'standard_generic_word',
    'svg_coordinate',
    'css_component_class',
    'css_tailwind_class_list',
    'date_layout',
    'encoding_standard',
    'cloud_region',
    'data_uri',
  ]);
  const noise = evaluateNoise(finding.value);
  if (noise.isNoise && DEFINITE_NOISE_REASONS.has(noise.reason)) {
    return {
      ...finding,
      score: 0,
      tier: TIERS.HIDDEN,
      isMajorEarlySignal: false,
      status: 'rejected',
      rejectionReason: `Noise rejected: ${noise.reason}`,
      breakdown: [{ rule: `Rejected as noise (${noise.reason})`, points: 0 }],
    };
  }

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
    case CATEGORIES.EXPERIMENT:
      score += 15;
      breakdown.push({ rule: `Category: ${finding.category}`, points: 15 });
      break;
    case CATEGORIES.HIDDEN_COMMAND:
    case CATEGORIES.ENDPOINT_DOMAIN:
      score += 15;
      breakdown.push({ rule: 'Category: hidden command / endpoint', points: 15 });
      break;
    case CATEGORIES.CAPABILITY:
    case CATEGORIES.AGENT_MODE:
      score += 14;
      breakdown.push({ rule: `Category: ${finding.category}`, points: 14 });
      break;
    case CATEGORIES.UI_STRING:
      score += 12;
      breakdown.push({ rule: 'Category: UI feature string', points: 12 });
      break;
    case CATEGORIES.PRICING:
      score += 18;
      breakdown.push({ rule: 'Category: pricing / model catalog table', points: 18 });
      break;
    case CATEGORIES.ENV_VAR:
    case CATEGORIES.PLATFORM_ENTITLEMENT:
    case CATEGORIES.PLAN_ENTITLEMENT:
      score += 12;
      breakdown.push({ rule: 'Category: env var / plan / entitlement', points: 12 });
      break;
    case CATEGORIES.DEPENDENCY:
      score += 5;
      breakdown.push({ rule: 'Category: dependency', points: 5 });
      break;
    default:
      break;
  }

  // Discovery Method Bonuses (structural and semantic AST anchors)
  if (finding.discoveryMethod === 'ast_array_peer_cluster') {
    score += 15;
    breakdown.push({ rule: 'AST Array Peer Cluster with known AI model', points: 15 });
  } else if (finding.discoveryMethod === 'ast_hyperparam_object') {
    score += 20;
    breakdown.push({ rule: 'AST AI Hyperparameter context (tokens/context_window)', points: 20 });
  } else if (finding.discoveryMethod === 'ast_config_object') {
    score += 15;
    breakdown.push({ rule: 'AST Rollout / Experiment configuration object', points: 15 });
  } else if (finding.discoveryMethod === 'ast_switch_case_model') {
    score += 12;
    breakdown.push({ rule: 'AST Switch-case model selection branch', points: 12 });
  } else if (finding.discoveryMethod === 'ast_call_gate') {
    score += 10;
    breakdown.push({ rule: 'AST Feature gate / SDK variation call', points: 10 });
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

  // Evidence gate for unanchored raw model regex hits:
  // If a candidate has NO AST/structural backing, NO known AI family anchor, NO dormant marker,
  // NO source-map agreement, and NO 2+ platform agreement, keep it in WEAK SIGNAL (routed to
  // low-confidence-candidates.txt instead of polluting high-signal leaks.txt / Telegram).
  const hasStrongEvidence = Boolean(
    isAstStructural ||
    finding.discoveryMethod === 'ast_call_gate' ||
    finding.discoveryMethod === 'ast_config_object' ||
    finding.hasDormantMarker ||
    finding.sourceMapAgreement ||
    (Array.isArray(finding.platforms) && finding.platforms.length >= 2) ||
    (Array.isArray(finding.artifactClasses) && finding.artifactClasses.length >= 2) ||
    KNOWN_AI_ANCHOR_RE.test(String(finding.value || ''))
  );
  if (finding.category === CATEGORIES.MODEL_ID && !hasStrongEvidence && score > 34) {
    score = 34;
    breakdown.push({ rule: 'Capped (unanchored raw token -> low-confidence sidecar)', points: 0 });
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
  // HIGH-CONFIDENCE (60+), or MODEL_ID with score >= 50, not in release notes
  const isMajorEarlySignal =
    !context.matchesReleaseNotes &&
    ((tier === TIERS.HIGH_CONFIDENCE &&
      (finding.category === CATEGORIES.MODEL_ID ||
        finding.category === CATEGORIES.HIDDEN_COMMAND ||
        finding.category === CATEGORIES.ENDPOINT_DOMAIN ||
        finding.category === CATEGORIES.AGENT_MODE ||
        finding.category === CATEGORIES.CAPABILITY ||
        finding.category === CATEGORIES.PRICING)) ||
      (finding.category === CATEGORIES.MODEL_ID && score >= 50));

  const activationStatus = finding.activationStatus || 'UNKNOWN';
  const confidenceExplanation = breakdown.map((b) => `${b.rule} (${b.points >= 0 ? '+' : ''}${b.points} pts)`).join('; ');

  return {
    ...finding,
    score,
    tier,
    isMajorEarlySignal,
    activationStatus,
    confidenceExplanation,
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

/**
 * Deduplicate findings by (category, value.toLowerCase()).
 * Merges occurrences, upgrades score & tier, combines platforms, and preserves distinct contexts.
 */
export function deduplicateFindings(findings) {
  const map = new Map();
  for (const f of findings) {
    if (!f || !f.value || f.score <= 0) continue;
    const normVal = (f.value || '').toString().toLowerCase().trim();
    const key = `${f.category || 'other'}:${normVal}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...f,
        occurrences: 1,
        contexts: f.context && f.context !== f.value ? [f.context.trim()] : [],
        locations: f.location ? [f.location] : [],
        platforms: Array.from(new Set(f.platforms || (f.platform ? [f.platform] : ['all']))),
      });
    } else {
      existing.occurrences++;
      // Upgrade score & tier if higher
      if (f.score > existing.score) {
        existing.score = f.score;
        existing.tier = f.tier;
        existing.isMajorEarlySignal = f.isMajorEarlySignal;
      }
      // Upgrade activation status: ENABLED (4) > CONFIGURED (3) > REFERENCED (2) > UNKNOWN (1)
      const statusWeight = { ENABLED: 4, CONFIGURED: 3, REFERENCED: 2, UNKNOWN: 1 };
      if ((statusWeight[f.activationStatus] || 0) > (statusWeight[existing.activationStatus] || 0)) {
        existing.activationStatus = f.activationStatus;
      }
      if (f.context && f.context !== f.value && !existing.contexts.includes(f.context.trim()) && existing.contexts.length < 3) {
        existing.contexts.push(f.context.trim());
      }
      if (f.filePath && !existing.filePath) {
        existing.filePath = f.filePath;
      }
      if (f.related && !existing.related) {
        existing.related = f.related;
      }
      const existingPlats = new Set(existing.platforms);
      for (const p of f.platforms || (f.platform ? [f.platform] : [])) {
        existingPlats.add(p);
      }
      existing.platforms = Array.from(existingPlats);
    }
  }
  return sortFindings(Array.from(map.values()));
}

/**
 * Deduplicate and cluster related findings (e.g. grouping Dark UI echoes under
 * their parent model/feature discovery) for concise, low-noise reports.
 */
export function deduplicateAndClusterFindings(findings) {
  return clusterRelatedFindings(deduplicateFindings(findings));
}
