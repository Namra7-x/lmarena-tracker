/**
 * Multi-Encoding Single-Pass High-Throughput String Scanner (Section 6)
 * Extracts ASCII/UTF-8, UTF-16LE, and UTF-16BE strings across 100% of binary buffers.
 * Automatically unpacks concatenated Rust/Go string literals in .rodata without null terminators.
 */

const MIN_STRING_LEN = 4;
const MAX_STRING_LEN = 2048;

// Regular expressions to split concatenated/glued string literals in Rust/Go binaries
const GLUED_MODEL_REGEX = /(?=(?:(?<!claude-)(?:sonnet|opus|haiku)|claude|silicon|obsidian|cactus|kraken|hyperion|swe|penguin|pigeon|kimi|deepseek|grok|llama|qwen|mistral|codex|devin|gpt|gemini|o[1-9])-(?:[a-zA-Z0-9]))/gi;
const GLUED_FLAG_REGEX = /(?=(?:enable|canary|dogfood|dark|gate|exp|experiment|feature)_[a-zA-Z0-9])/gi;
const GLUED_MCP_REGEX = /(?=(?:mcp__|mcp_|agent_|subagent_)[a-zA-Z0-9])/gi;

/**
 * Unpack concatenated string literals that lack null terminators in compiled binaries.
 */
export function unpackGluedTokens(str) {
  if (!str || typeof str !== 'string' || str.length < 8) return [str];
  let tokens = [str];

  if (GLUED_MODEL_REGEX.test(str)) {
    GLUED_MODEL_REGEX.lastIndex = 0;
    const split = str.split(GLUED_MODEL_REGEX);
    if (split.length > 1) {
      tokens = split.map((s) => s.trim().replace(/[^a-zA-Z0-9_\-\.]+$/, '')).filter((s) => s.length >= 4);
    }
  }

  const out = [];
  for (const t of tokens) {
    if (t.length >= 12 && GLUED_FLAG_REGEX.test(t)) {
      GLUED_FLAG_REGEX.lastIndex = 0;
      const split = t.split(GLUED_FLAG_REGEX);
      if (split.length > 1) {
        for (const s of split) {
          const clean = s.trim().replace(/[^a-zA-Z0-9_\-\.]+$/, '');
          if (clean.length >= 4) out.push(clean);
        }
        continue;
      }
    }
    if (t.length >= 10 && GLUED_MCP_REGEX.test(t)) {
      GLUED_MCP_REGEX.lastIndex = 0;
      const split = t.split(GLUED_MCP_REGEX);
      if (split.length > 1) {
        for (const s of split) {
          const clean = s.trim().replace(/[^a-zA-Z0-9_\-\.]+$/, '');
          if (clean.length >= 4) out.push(clean);
        }
        continue;
      }
    }
    out.push(t);
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
