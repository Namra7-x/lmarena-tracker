/**
 * Signal Extraction Rules (Section 4.1)
 * Extracts categorized signals: models, feature flags, hidden commands, endpoints, agents.
 */

export const CATEGORIES = {
  MODEL_ID: 'model_id',
  FEATURE_FLAG: 'feature_flag',
  HIDDEN_COMMAND: 'hidden_command',
  ENDPOINT_DOMAIN: 'endpoint_domain',
  AGENT_MODE: 'agent_mode',
  UI_STRING: 'ui_string',
  ENV_VAR: 'env_var',
  PLATFORM_ENTITLEMENT: 'platform_entitlement',
  DEPENDENCY: 'dependency',
};

export const DORMANT_MARKERS = [
  'internal', 'staff', 'dogfood', 'nightly', 'alpha',
  'experimental', 'preview', 'hidden', 'disabled',
  'unreleased', 'coming soon', 'waitlist', 'canary',
];

// Regex patterns for signal extraction
const MODEL_PATTERNS = [
  /\b(gpt-[4-9](?:\.[0-9]+)?(?:-[a-z0-9_-]+)?)\b/i,
  /\b(o[3-9](?:-mini|-max|-preview)?)\b/i,
  /\b(claude-[3-9](?:-[0-9]+)?(?:-[a-z0-9_-]+)?)\b/i,
  /\b(gemini-[2-9](?:\.[0-9]+)?(?:-[a-z0-9_-]+)?)\b/i,
  /\b(codex-[a-z0-9_-]+)\b/i,
  /\b(sonnet-[3-9](?:-[0-9]+)?)\b/i,
  /\b(opus-[3-9](?:-[0-9]+)?)\b/i,
  /\b(cursor-[a-z0-9_-]+)\b/i,
];

const FLAG_PATTERNS = [
  /\b([a-z0-9_]+_(?:feature_flag|experiment|gate|rollout))\b/i,
  /\b(enable_[a-z0-9_]+)\b/i,
  /\b(FEATURE_[A-Z0-9_]+)\b/,
  /\b(EXPERIMENT_[A-Z0-9_]+)\b/,
  /\b(GATE_[A-Z0-9_]+)\b/,
  /["']([a-zA-Z0-9_.-]+(?:Experiment|FeatureFlag|RolloutGate))["']/,
];

const HIDDEN_COMMAND_PATTERNS = [
  /["']?hidden["']?\s*:\s*(?:true|!0|1)\b[^{}]*?["']?name["']?\s*:\s*["']([^"']+)["']/i,
  /["']?name["']?\s*:\s*["']([^"']+)["'][^{}]*?["']?hidden["']?\s*:\s*(?:true|!0|1)\b/i,
  /\b(?:--internal-[a-z0-9_-]+)\b/i,
  /\b(?:--experimental-[a-z0-9_-]+)\b/i,
];

const ENDPOINT_PATTERNS = [
  /https:\/\/[a-zA-Z0-9_-]+\.(?:openai|anthropic|google|cursor|devin|factory)\.ai\/([a-zA-Z0-9_\-\/]+)/i,
  /["'](\/(?:internal|preview|v1alpha|v2alpha|experiments)\/[a-zA-Z0-9_\-\/]+)["']/i,
];

const AGENT_PATTERNS = [
  /\b(mcp_[a-z0-9_]+)\b/i,
  /\b(agent_[a-z0-9_]+)\b/i,
  /\b(subagent_[a-z0-9_]+)\b/i,
  /["'](?:mcp_servers|mcp_tools|custom_agents)["']\s*:\s*\{([^}]+)\}/i,
];

const ENV_VAR_PATTERNS = [
  /\b([A-Z0-9_]+_(?:EXPERIMENTAL|PREVIEW|INTERNAL|SECRET|KEY|TOKEN))\b/,
  /\b(ENABLE_[A-Z0-9_]+)\b/,
];

/**
 * Scan a text/string line and match potential signals.
 * Returns array of { category, value, context, hasDormantMarker }.
 */
export function matchSignalsInText(text, filePath = '', artifactClass = 'text') {
  const findings = [];
  const lowerText = text.toLowerCase();

  // Check dormant markers
  const matchedMarker = DORMANT_MARKERS.find((m) => lowerText.includes(m)) || null;

  // 1. Models
  for (const pat of MODEL_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.MODEL_ID,
        value: m[1].toLowerCase(),
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        filePath,
        artifactClass,
      });
    }
  }

  // 2. Feature Flags
  for (const pat of FLAG_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.FEATURE_FLAG,
        value: m[1],
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        filePath,
        artifactClass,
      });
    }
  }

  // 3. Hidden Commands
  for (const pat of HIDDEN_COMMAND_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.HIDDEN_COMMAND,
        value: m[1],
        context: text.slice(0, 200),
        hasDormantMarker: true,
        dormantMarker: 'hidden',
        filePath,
        artifactClass,
      });
    }
  }

  // 4. Endpoints / Domains
  for (const pat of ENDPOINT_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.ENDPOINT_DOMAIN,
        value: m[1],
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        filePath,
        artifactClass,
      });
    }
  }

  // 5. Agent / Mode
  for (const pat of AGENT_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.AGENT_MODE,
        value: m[1],
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        filePath,
        artifactClass,
      });
    }
  }

  // 6. Env Vars
  for (const pat of ENV_VAR_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.ENV_VAR,
        value: m[1],
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        filePath,
        artifactClass,
      });
    }
  }

  // 7. UI copy in localization / i18n files
  if (filePath.includes('locale') || filePath.includes('i18n') || filePath.endsWith('.json')) {
    if (matchedMarker && text.length > 10 && text.length < 300) {
      findings.push({
        category: CATEGORIES.UI_STRING,
        value: text.trim(),
        context: text.slice(0, 200),
        hasDormantMarker: true,
        dormantMarker: matchedMarker,
        filePath,
        artifactClass,
      });
    }
  }

  return findings;
}
