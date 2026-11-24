/**
 * Multi-Encoding Single-Pass High-Throughput String Scanner (Section 6)
 * Extracts ASCII/UTF-8, UTF-16LE, and UTF-16BE strings across binary & text buffers.
 * Automatically parses Mach-O string/const sections cleanly and unpacks concatenated
 * Rust/Go string literals without chopping normal camelCase or prose.
 */

import { extractMachOStringSlices } from './macho.mjs';

const MIN_STRING_LEN = 4;
const MAX_STRING_LEN = 2048;

// Lowercase glued tier/version boundaries inside packed Rust/Go .rodata literals
// Uses lowercase/digit lookahead so camelCase identifiers (e.g. code-baseComponent) stay intact
const DYNAMIC_TIER_OR_VERSION_SUFFIX = /(?<=-)(?:low|medium|high|xhigh|max|ultra|mini|nano|micro|pro|plus|lite|turbo|fast|small|large|base|instruct|thinking|reasoning|vision|chat|code|agent|canvas|eval|distill|discounted|preview|eap|tts|clip|audio|video|image|music|embed|embedding|multimodal|alpha|beta|luna|terra|sol|nova|astro|stellar|atlas|orion|fable|mythos|v?[0-9]+(?:\.[0-9]+)*(?:-[0-9]+)*)(?=[a-z0-9])/g;

// Glued code prefixes before known AI model anchors (e.g. "availableswe-1-6-fast" -> "available", "swe-1-6-fast")
const GLUED_MODEL_PREFIX = /(?<=[a-zA-Z0-9_])(?=(?:swe|gpt|claude|gemini|o[1-9]|astra|deepseek|llama|qwen|mistral|sonnet|opus|haiku|fable|mythos|obsidian|cactus|silicon|keken|aurora|halo)-[a-zA-Z0-9])/gi;

// Universal feature flag, MCP protocol, and connector boundaries
const DYNAMIC_GATE_PREFIX = /(?<=[a-zA-Z0-9_])(?=(?:can_see_|canUse|is_internal_|enable_|has_feature_|experiment_|feature_|mcp__|mcp_|agent_|subagent_|connector_|tool_)[a-zA-Z0-9])/gi;

// Provider anchor boundaries inside glued strings (splits "_callgemini-..." or "ttslyria-...")
const GLUED_PROVIDER_ANCHOR = /(?<=[a-zA-Z0-9_])(?=(?:gemini|claude|gpt|deepseek|qwen|grok|llama|mistral|kimi|lyria|imagen|chinchilla|devin|cursor|codex|whisper|sora|sonnet|opus|haiku|o[1-9])-[a-zA-Z0-9])/gi;

// 8-digit date/timestamp prefixes attached to letters (e.g. "20250929gemini...")
const GLUED_TIMESTAMP_PREFIX = /(?<=\b\d{8})(?=[a-zA-Z])/g;

// 4-digit year date suffixes attached to identifiers (e.g. "teams2006-01-02" -> "teams", "2006-01-02")
const GLUED_DATE_SUFFIX = /(?<=[a-zA-Z_])(?=(?:19|20)\d{2}[-_]\d{2}[-_]\d{2})/g;

/**
 * Split repeated domain prefixes (like connector_Xconnector_Y or mcp_Xmcp_Y)
 * without shredding ordinary snake_case identifiers.
 */
function splitRepeatedPrefixes(str) {
  const anchorMatch = str.match(/((?:connector_|mcp_|subagent_|agent_|tool_|experiment_|feature_))/);
  if (anchorMatch) {
    const prefix = anchorMatch[1];
    const occurrences = str.split(prefix).length - 1;
    if (occurrences >= 2) {
      return str.replaceAll(prefix, '\n' + prefix).split('\n').filter(Boolean);
    }
  }
  return [str];
}

/**
 * Unpack concatenated string literals lacking null terminators in compiled binaries.
 */
export function unpackGluedTokens(str) {
  if (!str || typeof str !== 'string' || str.length < 6) return [str];

  // GUARD 1: Preserve human prose / multi-word sentences intact
  if (str.includes(' ')) {
    return [str];
  }

  // GUARD 2: Keep intact URLs and API routes 100% complete
  if (/^(?:https?|wss?):\/\//i.test(str) || /^\/(?:api|v[0-9]|models|model-catalogue)/i.test(str) || str.includes('://')) {
    return [str];
  }

  // GUARD 3: Keep complete file paths and npm package paths intact
  if (str.includes('/') && (
    str.startsWith('Contents/') ||
    str.startsWith('out/') ||
    str.startsWith('lib/') ||
    str.startsWith('src/') ||
    str.startsWith('dist/') ||
    str.startsWith('build/') ||
    str.startsWith('resources/') ||
    str.startsWith('node_modules/') ||
    str.startsWith('@')
  )) {
    return [str];
  }

  let tokens = [str];

  // 0. Split 8-digit timestamp prefixes (e.g. "20250929gemini...")
  if (GLUED_TIMESTAMP_PREFIX.test(str)) {
    GLUED_TIMESTAMP_PREFIX.lastIndex = 0;
    tokens = str.replace(GLUED_TIMESTAMP_PREFIX, '\n').split('\n').filter(Boolean);
  }

  // 0b. Split date suffixes (e.g. "teams2006-01-02")
  const dateSplit = [];
  for (const t of tokens) {
    if (GLUED_DATE_SUFFIX.test(t)) {
      GLUED_DATE_SUFFIX.lastIndex = 0;
      dateSplit.push(...t.replace(GLUED_DATE_SUFFIX, '\n').split('\n').filter(Boolean));
    } else {
      dateSplit.push(t);
    }
  }
  tokens = dateSplit;

  // 1. Split on provider anchors
  const providerSplit = [];
  for (const t of tokens) {
    if (GLUED_PROVIDER_ANCHOR.test(t)) {
      GLUED_PROVIDER_ANCHOR.lastIndex = 0;
      providerSplit.push(...t.replace(GLUED_PROVIDER_ANCHOR, '\n').split('\n').filter(Boolean));
    } else {
      providerSplit.push(t);
    }
  }
  tokens = providerSplit;

  // 1b. Split on glued model prefixes
  const modelPrefixSplit = [];
  for (const t of tokens) {
    if (GLUED_MODEL_PREFIX.test(t)) {
      GLUED_MODEL_PREFIX.lastIndex = 0;
      modelPrefixSplit.push(...t.replace(GLUED_MODEL_PREFIX, '\n').split('\n').filter(Boolean));
    } else {
      modelPrefixSplit.push(t);
    }
  }
  tokens = modelPrefixSplit;

  // 2. Split on lowercase model tier or version boundaries
  const tierSplit = [];
  for (const t of tokens) {
    if (t.includes('-') && DYNAMIC_TIER_OR_VERSION_SUFFIX.test(t)) {
      DYNAMIC_TIER_OR_VERSION_SUFFIX.lastIndex = 0;
      const split = t.replaceAll(DYNAMIC_TIER_OR_VERSION_SUFFIX, (match) => match + '\n');
      tierSplit.push(...split.split('\n').map((s) => s.trim().replace(/[^a-zA-Z0-9_\-\.]+$/, '')).filter((s) => s.length >= 2));
    } else {
      tierSplit.push(t);
    }
  }
  tokens = tierSplit;

  // 3. Split recurring protocol/connector prefixes
  const out = [];
  for (const t of tokens) {
    const subTokens = splitRepeatedPrefixes(t);
    for (const st of subTokens) {
      if (DYNAMIC_GATE_PREFIX.test(st)) {
        DYNAMIC_GATE_PREFIX.lastIndex = 0;
        const gateSplit = st.split(DYNAMIC_GATE_PREFIX).map((s) => s.trim().replace(/[^a-zA-Z0-9_\-\.]+$/, '')).filter((s) => s.length >= 2);
        out.push(...(gateSplit.length > 0 ? gateSplit : [st]));
      } else {
        out.push(st);
      }
    }
  }

  return out.length > 0 ? out : [str];
}

function scanSingleBuffer(buffer, options, results, seen, baseOffset = 0) {
  const minLen = options.minLength || MIN_STRING_LEN;
  const maxLen = options.maxLength || MAX_STRING_LEN;
  const maxStrings = options.maxStrings ?? Infinity;

  function addResult(val, encoding, offset) {
    if (!val || val.length < minLen || val.length > maxLen) return;
    if (!/[a-zA-Z0-9\p{L}\p{N}]/u.test(val)) return;
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFD]/.test(val)) return;

    const lines = val.split(/[\r\n]+/);
    for (const line of lines) {
      const clean = line.trim();
      if (clean.length < minLen || clean.length > maxLen) continue;
      if (!/[a-zA-Z0-9\p{L}\p{N}]/u.test(clean)) continue;

      const tokens = options.unpackGlued === false ? [clean] : unpackGluedTokens(clean);
      for (const tok of tokens) {
        if (tok.length >= minLen && !seen.has(tok)) {
          if (Number.isFinite(maxStrings) && results.length >= maxStrings) return;
          seen.add(tok);
          results.push({ value: tok, encoding, offset, length: tok.length });
        }
      }
    }
  }

  const CHUNK_SIZE = 16 * 1024 * 1024;
  const OVERLAP = 4096;
  const totalLen = buffer.length;
  const scanMax = Math.min(Math.max(maxLen, 4), 65536);
  const utf16ScanMax = Math.min(scanMax * 2, 131072);
  const asciiRegex = new RegExp(`[\\x20-\\x7E\\t\\r\\n]{4,${scanMax}}`, 'g');
  const utf8Regex = new RegExp(`(?:[\\x20-\\x7E\\t\\r\\n]|[\\xC2-\\xF4][\\x80-\\xBF]{1,3}){4,${scanMax}}`, 'g');
  const u16leRegex = new RegExp(`(?:[\\x20-\\x7E\\t\\r\\n]\\x00){4,${utf16ScanMax}}`, 'g');
  const u16beRegex = new RegExp(`(?:\\x00[\\x20-\\x7E\\t\\r\\n]){4,${utf16ScanMax}}`, 'g');

  for (let offset = 0; offset < totalLen; offset += CHUNK_SIZE - OVERLAP) {
    if (Number.isFinite(maxStrings) && results.length >= maxStrings) break;
    const chunkEnd = Math.min(totalLen, offset + CHUNK_SIZE);
    const chunkBuf = buffer.subarray(offset, chunkEnd);
    const chunkStr = chunkBuf.toString('latin1');

    let m;
    while ((m = asciiRegex.exec(chunkStr)) !== null) {
      addResult(m[0].trim(), 'utf8', baseOffset + offset + m.index);
    }

    if (options.includeUnicode !== false) {
      while ((m = utf8Regex.exec(chunkStr)) !== null) {
        if (!/[\x80-\xFF]/.test(m[0])) continue;
        const decoded = Buffer.from(m[0], 'latin1').toString('utf8').trim();
        addResult(decoded, 'utf8-multibyte', baseOffset + offset + m.index);
      }
    }

    while ((m = u16leRegex.exec(chunkStr)) !== null) {
      const decoded = Buffer.from(m[0], 'latin1').toString('utf16le').trim();
      addResult(decoded, 'utf16le', baseOffset + offset + m.index);
    }

    while ((m = u16beRegex.exec(chunkStr)) !== null) {
      const sliceBuf = Buffer.from(m[0], 'latin1');
      sliceBuf.swap16();
      const decoded = sliceBuf.toString('utf16le').trim();
      addResult(decoded, 'utf16be', baseOffset + offset + m.index);
    }
  }
}

/**
 * Extract all strings from a Buffer across UTF-8, UTF-16LE, and UTF-16BE encodings.
 * Uses Mach-O section slicing when scanning Apple binaries to avoid machine-code opcode noise.
 */
export function extractStrings(buffer, options = {}) {
  if (!buffer || buffer.length === 0) return [];

  const results = [];
  const seen = new Set();

  if (options.machoAware !== false) {
    const machoSlices = extractMachOStringSlices(buffer);
    if (machoSlices.length > 0) {
      for (const slice of machoSlices) {
        scanSingleBuffer(slice.buffer, options, results, seen, slice.offset);
      }
      return results;
    }
  }

  scanSingleBuffer(buffer, options, results, seen, 0);
  return results;
}
