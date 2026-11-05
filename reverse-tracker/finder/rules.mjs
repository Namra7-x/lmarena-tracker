/**
 * Dynamic Signal Extraction Rules
 * Extracts rich, dynamic leaks: models, feature gates, internal RPCs,
 * hidden CLI commands, agent/MCP capabilities, and dark UI strings.
 */

export const CATEGORIES = {
  MODEL_ID: 'model_id',
  FEATURE_FLAG: 'feature_flag',
  HIDDEN_COMMAND: 'hidden_command',
  ENDPOINT_DOMAIN: 'endpoint_domain',
  AGENT_MODE: 'agent_mode',
  UI_STRING: 'ui_string',
  ENV_VAR: 'env_var',
};

export const DORMANT_MARKERS = [
  'internal', 'staff', 'dogfood', 'nightly', 'alpha',
  'experimental', 'preview', 'hidden', 'disabled',
  'unreleased', 'coming soon', 'waitlist', 'canary',
  'dark_launch', 'confidential', 'nda',
];

// 1. Dynamic Models & AI Engines
const MODEL_PATTERNS = [
  /\b(gpt-[4-9](?:\.[0-9]+)?(?:-[a-z0-9_-]+)?)\b/i,
  /\b(o[2-9](?:-mini|-max|-preview|-thinking|-pro)?)\b/i,
  /\b(claude-[3-9](?:-[0-9]+)?(?:-[a-z0-9_-]+)?)\b/i,
  /\b(gemini-[2-9](?:\.[0-9]+)?(?:-[a-z0-9_-]+)?)\b/i,
  /\b(sonnet-[3-9](?:-[a-z0-9_-]+)?)\b/i,
  /\b(opus-[3-9](?:-[a-z0-9_-]+)?)\b/i,
  /\b(haiku-[3-9](?:-[a-z0-9_-]+)?)\b/i,
  /\b((?:codex|cursor|devin|droid|deepseek|qwen|grok|llama)-[a-z0-9_-]+)\b/i,
  /\b([a-z0-9_]+-(?:instruct|reasoning|thinking|canvas|vision)-preview)\b/i,
  // Parameter definitions (e.g. model: "...", defaultModel: "...")
  /["']?(?:model|defaultModel|reasoningModel|evalModel|fallbackModel)["']?\s*[:=]\s*["']([a-zA-Z0-9_\-\.]{4,40})["']/i,
];

// 2. Dynamic Feature Gates & Experiments (LaunchDarkly, Statsig, PostHog, custom SDKs)
const FLAG_PATTERNS = [
  // SDK invocation patterns: variation("..."), checkGate("..."), isFeatureEnabled("...")
  /(?:variation|checkGate|getExperiment|isFeatureEnabled|useFeatureFlag|useExperiment|isEnabled)\s*\(\s*["']([a-zA-Z0-9_.-]{3,60})["']/i,
  // Snake_case with explicit gate prefixes
  /\b((?:enable|canary|dogfood|dark|gate|exp|experiment|rollout|feature|preview|beta)_[a-z0-9_]{3,50})\b/i,
  // Flag configuration dictionaries
  /["']([a-zA-Z0-9_.-]+(?:Experiment|FeatureFlag|RolloutGate|FeatureGate))["']/,
  // CamelCase boolean toggles
  /\b(is[A-Z][a-zA-Z0-9]{3,40}(?:Enabled|Allowed|Active|Supported))\b/,
];

// 3. Hidden CLI Commands & Switches
const HIDDEN_COMMAND_PATTERNS = [
  /["']?hidden["']?\s*:\s*(?:true|!0|1)\b[^{}]*?["']?name["']?\s*:\s*["']([^"']+)["']/i,
  /["']?name["']?\s*:\s*["']([^"']+)["'][^{}]*?["']?hidden["']?\s*:\s*(?:true|!0|1)\b/i,
  /\b(--(?:internal|experimental|debug|canary|dogfood|staff|admin|developer)-[a-z0-9_-]{3,40})\b/i,
  /\b(--enable-[a-z0-9_-]{3,40})\b/i,
];

// 4. Dark Endpoints & Internal RPCs
const ENDPOINT_PATTERNS = [
  /(https:\/\/(?:[a-zA-Z0-9_-]+\.)?(?:internal|staging|dev|dogfood|canary|preview)\.[a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\/]+)/i,
  /https:\/\/[a-zA-Z0-9_-]+\.(?:openai|anthropic|google|cursor|devin|factory)\.ai\/([a-zA-Z0-9_\-\/]+)/i,
  /["'](\/(?:api\/)?(?:internal|preview|v1alpha|v2alpha|v1beta|v2beta|experiments|dogfood)\/[a-zA-Z0-9_\-\/]+)["']/i,
  // gRPC internal services
  /\b([a-zA-Z0-9_]+\.internal\.v[0-9]+(?:\.[a-zA-Z0-9_]+)*)\b/,
];

// 5. Agent Capabilities & Tool Schemas
const AGENT_PATTERNS = [
  /\b(mcp__[a-z0-9_]{3,40})\b/i,
  /\b(mcp_[a-z0-9_]{3,40})\b/i,
  /\b(agent_[a-z0-9_]{3,40})\b/i,
  /\b(subagent_[a-z0-9_]{3,40})\b/i,
  /["'](?:mcp_servers|mcp_tools|custom_agents|agent_capabilities)["']\s*:\s*\{([^}]+)\}/i,
  /\b((?:computer_control|browser_use|terminal_exec|voice_canvas|canvas_reasoning|deep_research))\b/i,
];

// 6. Config & Environment Variables
const ENV_VAR_PATTERNS = [
  /\b([A-Z0-9_]{3,40}_(?:EXPERIMENTAL|PREVIEW|INTERNAL|SECRET|KEY|TOKEN))\b/,
  /\b(ENABLE_[A-Z0-9_]{3,40})\b/,
  /\b(FEATURE_[A-Z0-9_]{3,40})\b/,
  /\b(EXPERIMENT_[A-Z0-9_]{3,40})\b/,
];

// 7. Dark UI Copy (natural language announcing upcoming capabilities)
const DARK_UI_PATTERNS = [
  /["']([A-Z][a-zA-Z0-9\s,\.'"-]{20,120}(?:coming soon|waitlist|internal dogfood|preview only|early access))["']/i,
  /["']((?:Generate full application|Autonomous computer use|Deep research mode|Run full terminal commands autonomously|Connect external tools via MCP)[a-zA-Z0-9\s,\.'"-]{0,80})["']/i,
];

/**
 * Scan a text/string line and match potential signals.
 * Returns array of { category, value, context, hasDormantMarker, dormantMarker }.
 */
export function matchSignalsInText(text, filePath = '', artifactClass = 'text') {
  if (!text || typeof text !== 'string') return [];

  const findings = [];
  const lowerText = text.toLowerCase();

  // Check dormant markers
  const matchedMarker = DORMANT_MARKERS.find((m) => lowerText.includes(m)) || null;

  // 1. Models
  for (const pat of MODEL_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      const val = m[1].toLowerCase().trim();
      // Guard against false positives like common words
      if (val.length >= 3 && !['model', 'models', 'default', 'preview'].includes(val)) {
        findings.push({
          category: CATEGORIES.MODEL_ID,
          value: val,
          context: text.slice(0, 200),
          hasDormantMarker: Boolean(matchedMarker),
          dormantMarker: matchedMarker,
          filePath,
          artifactClass,
        });
      }
    }
  }

  // 2. Feature Flags
  for (const pat of FLAG_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      const val = m[1].trim();
      if (val.length >= 5) {
        findings.push({
          category: CATEGORIES.FEATURE_FLAG,
          value: val,
          context: text.slice(0, 200),
          hasDormantMarker: Boolean(matchedMarker),
          dormantMarker: matchedMarker,
          filePath,
          artifactClass,
        });
      }
    }
  }

  // 3. Hidden Commands
  for (const pat of HIDDEN_COMMAND_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.HIDDEN_COMMAND,
        value: m[1].trim(),
        context: text.slice(0, 200),
        hasDormantMarker: true,
        dormantMarker: matchedMarker || 'hidden_command',
        filePath,
        artifactClass,
      });
    }
  }

  // 4. Endpoints
  for (const pat of ENDPOINT_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.ENDPOINT_DOMAIN,
        value: m[1].trim(),
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        filePath,
        artifactClass,
      });
    }
  }

  // 5. Agent Mode / Tools
  for (const pat of AGENT_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.AGENT_MODE,
        value: m[1].trim(),
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        filePath,
        artifactClass,
      });
    }
  }

  // 6. Environment Variables
  for (const pat of ENV_VAR_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.ENV_VAR,
        value: m[1].trim(),
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        filePath,
        artifactClass,
      });
    }
  }

  // 7. Dark UI Copy
  for (const pat of DARK_UI_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      findings.push({
        category: CATEGORIES.UI_STRING,
        value: m[1].trim(),
        context: text.slice(0, 200),
        hasDormantMarker: true,
        dormantMarker: 'dark_ui_copy',
        filePath,
        artifactClass,
      });
    }
  }

  return findings;
}
