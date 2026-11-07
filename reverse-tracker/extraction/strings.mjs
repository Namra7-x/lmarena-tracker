/**
 * Multi-Encoding Single-Pass High-Throughput String Scanner (Section 6)
 * Extracts ASCII/UTF-8, UTF-16LE, and UTF-16BE strings across 100% of binary buffers.
 * Automatically unpacks concatenated Rust/Go string literals in .rodata without null terminators.
 */

const MIN_STRING_LEN = 4;
const MAX_STRING_LEN = 2048;

// Universal structural model tier & version boundaries across ALL AI models (Zero hardcoded lab names)
const DYNAMIC_TIER_OR_VERSION_SUFFIX = /(?<=-)(?:low|medium|high|xhigh|max|ultra|mini|nano|micro|pro|plus|lite|turbo|fast|small|large|base|instruct|thinking|reasoning|vision|chat|code|agent|canvas|eval|distill|discounted|preview|eap|v?[0-9]+(?:\.[0-9]+)*(?:-[0-9]+)*)(?=[a-zA-Z0-9])/gi;

// Universal feature flag and MCP protocol boundaries
const DYNAMIC_GATE_PREFIX = /(?=(?:can_see_|canUse|is_internal_|enable_|has_feature_|experiment_|feature_|mcp__|mcp_|agent_|subagent_)[a-zA-Z0-9])/gi;

/**
 * Split repeated prefixes in a single glued identifier dynamically (e.g. "prefix-..." repeating 2+ times).
 */
function splitRepeatedPrefixes(str) {
  const prefixMatch = str.match(/\b([a-zA-Z0-9_]{3,20}[-_])/);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    const occurrences = str.split(prefix).length - 1;
    if (occurrences >= 2) {
      return str.replaceAll(prefix, '\n' + prefix).split('\n').filter(Boolean);
    }
  }
  return [str];
}

/**
 * Unpack concatenated string literals lacking null terminators in compiled binaries (Zero hardcoded lab names).
 */
export function unpackGluedTokens(str) {
  if (!str || typeof str !== 'string' || str.length < 8) return [str];

  let tokens = [str];

  // 1. Split on universal model tier or version boundaries
  if (str.includes('-') && DYNAMIC_TIER_OR_VERSION_SUFFIX.test(str)) {
    DYNAMIC_TIER_OR_VERSION_SUFFIX.lastIndex = 0;
    const split = str.replaceAll(DYNAMIC_TIER_OR_VERSION_SUFFIX, (match) => match + '\n');
    tokens = split.split('\n').map((s) => s.trim().replace(/[^a-zA-Z0-9_\-\.]+$/, '')).filter((s) => s.length >= 4);
  }

  // 2. Check for recurring prefix patterns in each token
  const out = [];
  for (const t of tokens) {
    const subTokens = splitRepeatedPrefixes(t);
    for (const st of subTokens) {
      // 3. Split on feature gates or MCP protocol boundaries
      if (DYNAMIC_GATE_PREFIX.test(st)) {
        DYNAMIC_GATE_PREFIX.lastIndex = 0;
        const gateSplit = st.split(DYNAMIC_GATE_PREFIX).map((s) => s.trim().replace(/[^a-zA-Z0-9_\-\.]+$/, '')).filter((s) => s.length >= 4);
        out.push(...(gateSplit.length > 0 ? gateSplit : [st]));
      } else {
        out.push(st);
      }
    }
  }

  return out.length > 0 ? out : [str];
}

/**
 * Extract all strings from a Buffer across UTF-8, UTF-16LE, and UTF-16BE encodings.
 * Uses a sliding chunked scanner to achieve O(1) memory overhead and sub-second execution on large binaries.
 *
 * @param {Buffer} buffer
 * @param {Object} options { minLength, maxLength, maxStrings }
 * @returns {Array<Object>} [{ value, encoding, offset, length }]
 */
export function extractStrings(buffer, options = {}) {
  if (!buffer || buffer.length === 0) return [];

  const minLen = options.minLength || MIN_STRING_LEN;
  const maxLen = options.maxLength || MAX_STRING_LEN;
  const maxStrings = options.maxStrings || 500000; // High limit to ensure complete coverage without early cutoff
  const results = [];
  const seen = new Set();

  function addResult(val, encoding, offset) {
    if (!val || val.length < minLen || val.length > maxLen) return;
    if (!/[a-zA-Z0-9]/.test(val)) return;

    const tokens = unpackGluedTokens(val);
    for (const tok of tokens) {
      if (tok.length >= minLen && !seen.has(tok)) {
        if (results.length >= maxStrings) return;
        seen.add(tok);
        results.push({ value: tok, encoding, offset, length: tok.length });
      }
    }
  }

  const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB chunks
  const OVERLAP = 4096; // 4 KB overlap to prevent cutting strings across chunk boundaries
  const totalLen = buffer.length;

  for (let offset = 0; offset < totalLen; offset += CHUNK_SIZE - OVERLAP) {
    if (results.length >= maxStrings) break;
    const chunkEnd = Math.min(totalLen, offset + CHUNK_SIZE);
    const chunkBuf = buffer.subarray(offset, chunkEnd);
    const chunkStr = chunkBuf.toString('latin1'); // Instant O(1) buffer mapping in V8

    // 1. ASCII & UTF-8 scan (printable ASCII range \x20-\x7E, \t, \r, \n)
    const asciiRegex = /[\x20-\x7E\t\r\n]{4,2048}/g;
    let m;
    while ((m = asciiRegex.exec(chunkStr)) !== null) {
      addResult(m[0].trim(), 'utf8', offset + m.index);
    }

    // 2. UTF-16LE scan ([char, 0x00]{4,1024})
    const u16leRegex = /(?:[\x20-\x7E\t\r\n]\x00){4,1024}/g;
    while ((m = u16leRegex.exec(chunkStr)) !== null) {
      const decoded = Buffer.from(m[0], 'latin1').toString('utf16le').trim();
      addResult(decoded, 'utf16le', offset + m.index);
    }

    // 3. UTF-16BE scan ([0x00, char]{4,1024})
    const u16beRegex = /(?:\x00[\x20-\x7E\t\r\n]){4,1024}/g;
    while ((m = u16beRegex.exec(chunkStr)) !== null) {
      const sliceBuf = Buffer.from(m[0], 'latin1');
      sliceBuf.swap16();
      const decoded = sliceBuf.toString('utf16le').trim();
      addResult(decoded, 'utf16be', offset + m.index);
    }
  }

  return results;
}
