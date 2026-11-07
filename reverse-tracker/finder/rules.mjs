/**
 * Dynamic Signal Extraction Rules
 * Extracts rich, dynamic leaks: models, feature gates, internal RPCs,
 * hidden CLI commands, agent/MCP capabilities, and dark UI strings.
 */

import { unpackGluedTokens } from '../extraction/strings.mjs';
import { evaluateNoise } from './noise.mjs';

export const ACTIVATION_STATUS = {
  REFERENCED: 'REFERENCED',
  CONFIGURED: 'CONFIGURED',
  ENABLED: 'ENABLED',
  UNKNOWN: 'UNKNOWN',
};

export const CATEGORIES = {
  MODEL_ID: 'model_id',
  FEATURE_FLAG: 'feature_flag',
  EXPERIMENT: 'experiment',
  CAPABILITY: 'capability',
  HIDDEN_COMMAND: 'hidden_command',
  ENDPOINT_DOMAIN: 'endpoint_domain',
  AGENT_MODE: 'agent_mode',
  UI_STRING: 'ui_string',
  ENV_VAR: 'env_var',
  INTERNAL_FUNCTION: 'internal_function',
  PLAN_ENTITLEMENT: 'plan_entitlement',
  PLATFORM_ENTITLEMENT: 'platform_entitlement',
};

export const SUBSCRIPTION_PLANS = new Set([
  'free', 'plus', 'pro', 'max', 'ultra', 'team', 'enterprise', 'staff', 'dogfood', 'vip', 'developer', 'unlimited'
]);

export const EFFORT_LEVELS = new Set([
  'low', 'medium', 'high', 'xhigh', 'extra-high', 'max', 'ultra', 'minimal', 'extreme', 'unlimited'
]);

export const DORMANT_MARKERS = [
  'internal', 'staff', 'dogfood', 'nightly', 'alpha',
  'experimental', 'preview', 'hidden', 'disabled',
  'unreleased', 'coming soon', 'waitlist', 'canary',
  'dark_launch', 'confidential', 'nda',
  'research preview', 'early access', 'now available', 'introducing',
];

const CSS_CURSOR_VALUES = new Set([
  'cursor-default', 'cursor-pointer', 'cursor-not-allowed', 'cursor-wait',
  'cursor-text', 'cursor-move', 'cursor-help', 'cursor-none', 'cursor-progress',
  'cursor-cell', 'cursor-crosshair', 'cursor-copy', 'cursor-alias',
  'cursor-col-resize', 'cursor-row-resize', 'cursor-grab', 'cursor-grabbing',
  'cursor-auto'
]);

const NON_MODEL_COMMON_TERMS = new Set([
  'exit-code', 'status-code', 'error-code', 'return-code', 'source-code', 'postal-code', 'zip-code', 'qr-code', 'bar-code', 'op-code',
  'user-agent', 'http-agent', 'proxy-agent', 'caller-agent', 'system-agent', 'multi-agent', 'ssh-agent', 'relay-agent', 'build-agent',
  'ruby-base', 'file-base', 'data-base', 'code-base', 'knowledge-base', 'temp-base', 'home-base', 'path-base',
  'in-pro', 'go-pro', 're-pro', 'error-pro', 'semi-pro', 'non-pro',
  'char-low', 'alphabetic-low', 'numeric-low',
  'upper-case', 'lower-case', 'camel-case', 'kebab-case', 'snake-case',
  'link-preview', 'print-preview', 'web-preview', 'tab-preview',
  'model', 'models', 'default', 'preview', 'fallback', 'primary', 'active', 'selected', 'primary_model', 'default_model',
  'undefined', 'null', 'none', 'true', 'false', 'test', 'example',
]);

/**
 * Validates whether a candidate string is a genuine AI model identifier.
 * Rejects dates, timestamps, SVG coordinates, CSS classes, encodings, AWS regions,
 * and generic programming/system tokens.
 */
export function isValidModelIdentifier(val) {
  if (!val || typeof val !== 'string') return false;
  const str = val.trim();
  const len = str.length;

  // 1. Length bounds (e.g. "o1" to "deep-research-pro-preview-12-2025")
  if (len < 2 || len > 70) return false;

  // 2. Must start with an ASCII letter (e.g. 'gemini', 'claude', 'o1')
  // Strictly rejects dates ('01-02', '1970-01-01'), SVG ('1h-9', '43l7-4.4', '58-4.2'),
  // compiler symbols ('_call...'), and encodings starting with digits ('8859-1')
  if (!/^[a-zA-Z]/.test(str)) return false;

  // 3. Must only contain valid identifier characters (supports single spaces for multi-word lab codenames like 'Onion Alpha' or 'Tell Me News')
  if (!/^[a-zA-Z0-9_\-\.\:\/ ]+$/.test(str)) return false;
  if (str.includes('  ')) return false;
  const words = str.split(' ');
  if (words.length > 4) return false;
  for (const w of words) {
    if (!w || !/^[a-zA-Z0-9]/.test(w)) return false;
  }

  // 4. Case-insensitive exact match in non-model common terms
  const lower = str.toLowerCase();
  if (NON_MODEL_COMMON_TERMS.has(lower) || CSS_CURSOR_VALUES.has(lower)) return false;

  // 4b. Reject any noise (W3C CSS properties, SPDX licenses, media/archive extensions)
  const noiseCheck = evaluateNoise(str);
  if (noiseCheck.isNoise && noiseCheck.reason !== 'too_short') return false;

  // 5. Date & Time format layouts (e.g. "02-jan-0", "02-jan-200", "2006-01-02", "jan-2024")
  if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-_]\d+$/i.test(str)) return false;
  if (/^\d{1,2}[-_](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(str)) return false;
  if (/^(?:mon|tue|wed|thu|fri|sat|sun)[-_]/i.test(str)) return false;
  if (/^(?:19|20)\d{2}[-_]\d{1,2}(?:[-_]\d{1,2})?$/.test(str)) return false;

  // 6. SVG / Canvas path coordinates & commands (e.g. "1h-9", "43l7-4.4", "58-4.2", "4v-2")
  if (/[0-9]+[hvlzsqta][0-9.-]/i.test(str)) return false;
  if (/^[a-z]?[0-9]+-[0-9.]+$/i.test(str)) return false;

  // 7. Character encodings, protocols & crypto standards (e.g. "utf-8", "utf-16", "iso-8859-1", "sha-256")
  if (/^(?:utf|ucs|iso|windows|cp|koi8|ascii|ansi|ebcdic|shift[-_]jis|euc)[-_]/i.test(str)) return false;
  if (/^(?:sha|md5|hmac|blake|aes|des|rsa|ecdsa|chacha|tls|ssl|rfc|fips|csa)[-_0-9]/i.test(str)) return false;

  // 8. Cloud regions & network zones (e.g. "ap-southeast-2", "us-west-1", "eu-central-1")
  if (/^(?:us|eu|ap|sa|ca|me|af|cn|gov|asia)-(?:central|east|west|north|south|northeast|northwest|southeast|southwest)-\d+$/i.test(str)) return false;

  // 9. Regex character ranges / tokens (e.g. "za-z0-9", "a-z0-9")
  if (/^[a-z]{1,2}-[a-z0-9]{1,2}(?:-[a-z0-9]{1,2})+$/i.test(str)) return false;

  // 10. CSS / UI classes (e.g. "o2-card", "o2-btn", "o2-border", "o2-ring", "o2-muted")
  if (/^(?:o[1-9]|v[0-9]|col|row|flex|grid|p|m|px|py|bg|text|border|ring|shadow)-[a-z0-9_-]+$/i.test(str)) {
    if (/(?:card|btn|button|input|modal|badge|alert|text|bg|border|ring|muted|container|header|footer|row|col|flex|grid|icon|avatar|tooltip|switch|nav|sidebar|tab|label|select|checkbox|radio|wrapper|item|body|group|content|inner|outer|divider|spacer|overlay|backdrop|popup|dropdown|dialog|panel|list|tile|thumb|track|handle|knob|slot|viewport|pane|window)/i.test(str)) {
      return false;
    }
  }

  // 11. OpenAI Reasoning series constraint (o1, o3, o4...)
  if (/^o[1-9]/i.test(str)) {
    // Only o1 and o3 can be bare 2-character identifiers; o2, o4..o9 MUST have a hyphen and model suffix
    if (/^o[24-9]$/i.test(str)) return false;
    if (!/^o[1-9](?:-(?:mini|preview|pro|plus|low|medium|high|max|turbo|instruct|eval|chat|all|speed|reasoning|\d{4}-\d{2}-\d{2}))*$/i.test(str)) {
      return false;
    }
  }

  // 12. Generic prefix and code token checks
  if (/\.(?:rs|ts|js|jsx|tsx|go|py|c|cpp|h|json|toml|yaml|yml|md|txt|lock)$/i.test(str)) return false;
  if (str.includes('/src/') || str.includes('crates.io') || str.includes('.cargo') || str.includes('node_modules')) return false;

  // Reject non-model software tokens
  if (/-(?:token|session|rs|lib|crate|client|manifest|plugin|header|footer|cache|mutex|lock|protocol|proto|schema)$/i.test(str)) return false;

  // Reject UI preview features
  if (['browser-preview', 'tab-preview', 'window-preview', 'screen-preview', 'page-preview'].includes(lower)) return false;
  if (/browser-preview/i.test(str)) return false;

  // Reject OS architectures, platform build targets, and compiler targets (e.g. "devin-locallinuxx86_64", "x86_64", "aarch64")
  if (/(?:linux|darwin|macos|windows|win32|x86_64|aarch64|arm64|amd64)/i.test(str)) return false;

  // If candidate has slashes (e.g. "cli/current/manifest"), require an AI provider prefix
  if (str.includes('/')) {
    const providerSlashMatch = /^(?:anthropic|openai|google|meta-llama|deepseek|mistral|qwen|cohere|stabilityai)\//i.test(str);
    if (!providerSlashMatch) return false;
  }

  // Generic prefix check: if suffix is one of the generic code words (pro, base, code, agent, low),
  // ensure the prefix is not a 2-letter word or standard programming word
  if (/-(?:pro|base|code|agent|low)$/i.test(str)) {
    const fullStem = str.slice(0, str.lastIndexOf('-')).toLowerCase();
    if (fullStem.length <= 2) return false;
    if (['connect', 'oauth', 'mcp', 'client', 'tool-in', 'cross', 'chisel', 'stream', 'content-type', 'agent-client', 'skippingoauth', 'cessstop', 'event-streamgetmcp', 'exit', 'status', 'error', 'return', 'user', 'http', 'proxy', 'caller', 'system', 'ruby', 'file', 'data', 'temp', 'char', 'line', 'page', 'multi'].some((w) => fullStem.includes(w))) {
      return false;
    }
  }

  // 13. Package semver check: strings formatted like "<name>-<version>" (e.g. "axum-0.8", "hyper-1.8", "box-0.8")
  // are software crate/package dependencies unless they match a known model provider or end with an AI tier suffix.
  if (/^[a-zA-Z][a-zA-Z0-9_]{1,30}-[0-9]+(?:\.[0-9]+)+(?:-[0-9a-zA-Z._-]+)?$/i.test(str)) {
    const isKnownProvider = /^(?:gpt|claude|gemini|o[1-9]|deepseek|llama|qwen|mistral|kimi|lyria|imagen|chinchilla|devin|cursor|codex|whisper|sora|sonnet|opus|haiku|mythos|fable|swe)-/i.test(str);
    const hasTierSuffix = /-(?:turbo|preview|flash|pro|plus|instruct|mini|nano|micro|ultra|lite|base|chat|thinking|reasoning|vision|high|max|fast|low|coder|sonnet|opus|haiku|alpha|beta|eval|distill|eap|tts|clip)$/i.test(str);
    if (!isKnownProvider && !hasTierSuffix) {
      return false;
    }
  }

  return true;
}

/**
 * Validates whether a candidate string is a plausible feature flag name.
 */
export function isValidFeatureFlag(val) {
  if (!val || typeof val !== 'string') return false;
  const str = val.trim();
  const len = str.length;
  if (len < 4 || len > 100) return false;
  if (!/^[a-zA-Z_]/.test(str)) return false;
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(str)) return false;
  const lower = str.toLowerCase();
  if (NON_MODEL_COMMON_TERMS.has(lower) || CSS_CURSOR_VALUES.has(lower)) return false;
  if (evaluateNoise(str).isNoise) return false;
  // Reject UI DOM properties mistaken as feature flags
  if (/^preview_(?:id|width|height|style|dom|element|view|node|ptr|item|modal|close|closed)/i.test(str)) return false;
  return true;
}

const AGENT_CODE_NOUNS = new Set([
  'impl', 'ext', 'builder', 'setup', 'init', 'state', 'context', 'session',
  'handler', 'handlers', 'error', 'errors', 'runner', 'dispatcher', 'manager',
  'panel', 'view', 'views', 'controller', 'component', 'props', 'schema',
  'result', 'results', 'content', 'contents', 'footer', 'header', 'body',
  'id', 'ids', 'type', 'types', 'val', 'key', 'keys', 'arg', 'args', 'param', 'params',
  'data', 'info', 'cache', 'mutex', 'lock', 'arc', 'rc', 'ptr', 'ref',
  'call', 'calls', 'event', 'events', 'msg', 'message', 'messages',
  'iterationcore', 'idsubagent', 'profilesassertion'
]);

/**
 * Validates whether a candidate string is an agent capability, tool schema, or MCP identifier.
 */
export function isValidAgentTool(val) {
  if (!val || typeof val !== 'string') return false;
  const str = val.trim();
  if (str.length < 4 || str.length > 80) return false;
  if (!/^[a-zA-Z_]/.test(str)) return false;
  const lower = str.toLowerCase();
  // Filter out internal code nouns
  for (const noun of AGENT_CODE_NOUNS) {
    if (lower === `agent_${noun}` || lower === `tool_${noun}` || lower === `mcp_${noun}` || lower.endsWith(`_${noun}`)) {
      return false;
    }
  }
  return /^(?:mcp__|mcp_|agent_|subagent_|connector_|tool_|computer_control|browser_use|terminal_exec|voice_canvas|canvas_reasoning|deep_research)/i.test(str);
}

/**
 * Validates whether a candidate string is a plausible Go symbol, package path, or type identifier.
 */
export function isValidGoSymbol(val) {
  if (!val || typeof val !== 'string') return false;
  const str = val.trim();
  if (str.length < 3 || str.length > 250) return false;
  if (!/^[a-zA-Z0-9_\.\/\*\[\]\(\)\-\:]+$/.test(str)) return false;
  if (/[\x00-\x1F\x7F-\x9F\uFFFD]/.test(str)) return false;
  return true;
}

// 1. Dynamic Models & AI Engines (Zero Hardcoded Model Names)
const MODEL_PATTERNS = [
  // A. Structural Model Slots in Code & Config (captures ANY model assigned to a property)
  /(?:model|model_slug|model_id|model_name|default_model|defaultModel|fallbackModel|reasoningModel|evalModel|chat_model|active_model|primary_model|subagent_model|selected_model)\s*[:=]\s*["']([a-zA-Z0-9_\-\.\:\/]{2,60})["']/i,

  // B. Structural Tiered & Capability Model Identifiers (e.g. banana-pro-preview, quantum-max, supernova-preview, silicon-low)
  /\b([a-zA-Z][a-zA-Z0-9_]{2,30}(?:-[a-zA-Z0-9_]{1,30})*-(?:ultra|mini|nano|micro|pro|plus|lite|turbo|instruct|thinking|reasoning|vision|eval|distill|preview|eap|tts|clip|flash|max|low|high)(?:-[0-9]{2,4}(?:-[0-9]{2,4})*)?)\b/i,

  // C. Structural Versioned Model Identifiers (e.g. swe-1-6-fast, swe-2-high, mythos-5.1, fable-5.1, hyper-v3-coder)
  /\b([a-zA-Z][a-zA-Z0-9_]{2,25}-(?:v?[0-9]+(?:\.[0-9]+)*(?:-[0-9]+)*-(?:turbo|preview|flash|pro|plus|instruct|mini|nano|micro|ultra|lite|base|chat|thinking|reasoning|vision|high|max|fast|low|coder|sonnet|opus|haiku|alpha|beta|eval|distill|eap|tts|clip)[a-zA-Z0-9._-]*))\b/i,

  // D. Provider Anchor Wildcards (provider-(ANYTHING))
  /\b((?:claude|gpt|gemini|devin|cursor|codex|droid|deepseek|qwen|grok|llama|mistral|kimi|lyria|imagen|chinchilla|palm|titan|flux|sora|whisper)-[a-zA-Z0-9_\-\.]+)\b/i,

  // E. OpenAI Reasoning Series (o1-mini, o3-mini, o4-preview... then standalone o1, o3)
  /\b(o[1-9]-(?:mini|preview|pro|plus|low|medium|high|max|turbo|instruct|eval|chat|all|speed|reasoning|\d{4}-\d{2}-\d{2})|o1|o3)\b/i,

  // F. Anthropic Tier Wildcards
  /\b((?:sonnet|opus|haiku|mythos|fable)-[a-zA-Z0-9_\-\.]+)\b/i,
];

// 2. Dynamic Feature Gates & Experiments (LaunchDarkly, Statsig, PostHog, custom SDKs)
const FLAG_PATTERNS = [
  // SDK invocation patterns: variation("..."), checkGate("..."), isFeatureEnabled("...")
  /(?:variation|checkGate|getExperiment|isFeatureEnabled|useFeatureFlag|useExperiment|isEnabled)\s*\(\s*["']([a-zA-Z0-9_.-]{3,60})["']/i,
  // Snake_case with explicit gate prefixes
  /\b((?:enable|canary|dogfood|dark|gate|exp|experiment|rollout|feature_gate|feature_flag|beta)_[a-z0-9_]{3,50})\b/i,
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
  /\b(connector_[a-z0-9_]{3,50})\b/i,
  /\b(tool_[a-z0-9_]{3,50})\b/i,
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

// 7. Dark UI Copy & Natural Language Announcements (models, capabilities, and preview banners)
const DARK_UI_PATTERNS = [
  // A. Product/Model Introductions (e.g. "Introducing Claude 3.7 Sonnet", "Announcing GPT-5", "Welcome to Canvas")
  /["']?\b((?:Introducing|Announcing|Welcome to|Try the new|Experience)\s+[A-Z0-9][a-zA-Z0-9_\-\.\s]{3,80})\b/i,

  // B. Preview & Availability Status (e.g. "Now in research preview", "Now available in early access", "Now generally available")
  /["']?\b((?:Now in|Now available in|Available in|In)\s+(?:research preview|preview|preview mode|early access|public beta|private beta|canary|dogfood)[a-zA-Z0-9_\-\.\s,]{0,80})\b/i,

  // C. General Availability & Launch Statements (e.g. "Now available to all users", "Now live for subscribers")
  /["']?\b((?:Now available|Now live|Generally available)\s+(?:to all users|for pro|for plus|for enterprise|globally|in your region)[a-zA-Z0-9_\-\.\s,]{0,80})\b/i,

  // D. Engine Attribution (e.g. "Powered by Claude 3.5 Sonnet", "Powered by Gemini 2.0 Flash")
  /["']?\b((?:Powered by|Built on|Backed by)\s+[A-Z0-9][a-zA-Z0-9_\-\.\s]{3,60})\b/i,

  // E. Pre-launch Callouts (coming soon, waitlist, early access, preview only)
  /["']?([A-Z][a-zA-Z0-9\s,\.'"-]{10,120}?(?:coming soon|waitlist|internal dogfood|preview only|early access|research preview|waitlist only))["']?/i,

  // F. Major Dark Capabilities UI Copy
  /["']?((?:Generate full application|Autonomous computer use|Deep research mode|Run full terminal commands autonomously|Connect external tools via MCP)[a-zA-Z0-9\s,\.'"-]{0,80})["']?/i,
];

// 8. Search & Grounding Capabilities (web search, live browsing, grounding)
const SEARCH_PATTERNS = [
  /\b((?:enable_|use_|supports_)?[a-zA-Z0-9_]*(?:web_search|search_web|google_search|bing_search|live_search|search_grounding|grounding_search|tavily_search|brave_search|deep_research|web_retrieval)[a-zA-Z0-9_]*)\b/i,
  /["']((?:googleSearch|webSearch|searchGrounding|web_search_tool))["']/i,
];

// 9. Plan & Subscription Entitlements (pro, plus, max, ultra, team, enterprise)
const PLAN_PATTERNS = [
  /(?:available_to|availableTo|required_plan|requiredPlan|min_plan|minPlan|subscription_tier|required_tier|plan_tier)\s*[:=]\s*["']([a-zA-Z0-9_\-\.\:\/]+)["']/i,
  /\b((?:is_?|has_?)(?:pro|plus|max|ultra|enterprise|team|staff)_?(?:user|subscriber|access|entitled|tier)?)\b/i,
  /["']?\b((?:Available|Unlock|Exclusive|Reserved)\s+(?:only\s+)?(?:to|for)\s+(?:pro|plus|max|ultra|team|enterprise|subscribers)[a-zA-Z0-9_\-\.\s,]{0,80})\b/i,
];

/**
 * Scan a text/string line and match potential signals.
 * Returns array of { category, value, context, hasDormantMarker, dormantMarker }.
 */
export function matchSignalsInText(text, filePath = '', artifactClass = 'text') {
  if (!text || typeof text !== 'string') return [];

  const findings = [];
  const lowerText = text.toLowerCase();

  // Check dormant markers with strict word boundaries to prevent 'boundary' or 'secondary' matching 'nda'
  const matchedMarker = DORMANT_MARKERS.find((m) => {
    const escaped = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i');
    return regex.test(lowerText);
  }) || null;
  const defaultActivation = matchedMarker ? ACTIVATION_STATUS.CONFIGURED : ACTIVATION_STATUS.REFERENCED;

  // Unpack glued binary string tokens if present (e.g. "_callgemini-3.8-flash-ttslyria-3-clip-preview")
  const textCandidates = unpackGluedTokens(text);
  if (!textCandidates.includes(text)) {
    textCandidates.push(text);
  }

  // 1. Models
  for (const candidate of textCandidates) {
    for (const pat of MODEL_PATTERNS) {
      const globalPat = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
      let m;
      while ((m = globalPat.exec(candidate)) !== null) {
        if (m && m[1]) {
          const val = m[1].toLowerCase().trim();
          if (isValidModelIdentifier(val)) {
            findings.push({
              category: CATEGORIES.MODEL_ID,
              value: val,
              context: text.slice(0, 200),
              hasDormantMarker: Boolean(matchedMarker),
              dormantMarker: matchedMarker,
              activationStatus: defaultActivation,
              filePath,
              artifactClass,
              status: 'accepted',
              rejectionReason: null,
            });
          }
        }
      }
    }
  }

  // 2. Feature Flags & Experiments
  for (const pat of FLAG_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      const val = m[1].trim();
      if (isValidFeatureFlag(val)) {
        const isExp = /^(?:exp_|experiment_)/i.test(val) || /(?:variation|getExperiment|useExperiment)\s*\(/i.test(text);
        findings.push({
          category: isExp ? CATEGORIES.EXPERIMENT : CATEGORIES.FEATURE_FLAG,
          value: val,
          context: text.slice(0, 200),
          hasDormantMarker: Boolean(matchedMarker),
          dormantMarker: matchedMarker,
          activationStatus: defaultActivation,
          filePath,
          artifactClass,
          status: 'accepted',
          rejectionReason: null,
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
        activationStatus: ACTIVATION_STATUS.CONFIGURED,
        filePath,
        artifactClass,
        status: 'accepted',
        rejectionReason: null,
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
        activationStatus: defaultActivation,
        filePath,
        artifactClass,
        status: 'accepted',
        rejectionReason: null,
      });
    }
  }

  // 5. Agent Mode / Tools
  for (const pat of AGENT_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      const val = m[1].trim();
      if (isValidAgentTool(val)) {
        findings.push({
          category: CATEGORIES.AGENT_MODE,
          value: val,
          context: text.slice(0, 200),
          hasDormantMarker: Boolean(matchedMarker),
          dormantMarker: matchedMarker,
          activationStatus: defaultActivation,
          filePath,
          artifactClass,
          status: 'accepted',
          rejectionReason: null,
        });
      }
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
        activationStatus: defaultActivation,
        filePath,
        artifactClass,
        status: 'accepted',
        rejectionReason: null,
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
        activationStatus: ACTIVATION_STATUS.CONFIGURED,
        filePath,
        artifactClass,
        status: 'accepted',
        rejectionReason: null,
      });
    }
  }

  // 8. Search & Grounding Capabilities (web search, live browsing, grounding)
  for (const pat of SEARCH_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      const val = m[1].trim();
      findings.push({
        category: CATEGORIES.CAPABILITY,
        value: val,
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        activationStatus: defaultActivation,
        filePath,
        artifactClass,
        status: 'accepted',
        rejectionReason: null,
      });
    }
  }

  // 9. Plan & Subscription Entitlements (pro, plus, max, ultra, team, enterprise)
  for (const pat of PLAN_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      const val = m[1].trim();
      findings.push({
        category: CATEGORIES.PLAN_ENTITLEMENT,
        value: val,
        context: text.slice(0, 200),
        hasDormantMarker: Boolean(matchedMarker),
        dormantMarker: matchedMarker,
        activationStatus: ACTIVATION_STATUS.CONFIGURED,
        filePath,
        artifactClass,
        status: 'accepted',
        rejectionReason: null,
      });
    }
  }

  // Filter out strict sub-segments when a longer parent model identifier is present
  const modelValues = new Set(findings.filter((f) => f.category === CATEGORIES.MODEL_ID).map((f) => f.value));
  const filteredFindings = findings.filter((f) => {
    if (f.category !== CATEGORIES.MODEL_ID) return true;
    for (const other of modelValues) {
      if (other !== f.value && other.includes(f.value)) {
        return false; // Suppress sub-segment
      }
    }
    return true;
  });

  // Deduplicate findings by category + value
  const seenFindings = new Set();
  const uniqueFindings = [];
  for (const f of filteredFindings) {
    const key = `${f.category}:${f.value}`;
    if (!seenFindings.has(key)) {
      seenFindings.add(key);
      uniqueFindings.push(f);
    }
  }

  return uniqueFindings;
}
