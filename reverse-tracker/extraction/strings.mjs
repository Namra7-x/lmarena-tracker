/**
 * Multi-Encoding Single-Pass String Scanner (Section 6)
 * Extracts ASCII/UTF-8, UTF-16LE, and UTF-16BE strings in a single scan.
 */

const MIN_STRING_LEN = 4;
const MAX_STRING_LEN = 2048;

/**
 * Check if a byte is printable ASCII (space 0x20 to tilde 0x7E) or tab/newline
 */
function isPrintableAscii(byte) {
  return (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * Extract all strings from a Buffer across UTF-8, UTF-16LE, and UTF-16BE encodings.
 *
 * @param {Buffer} buffer
 * @param {Object} options { minLength, maxLength }
 * @returns {Array<Object>} [{ value, encoding, offset, length }]
 */
export function extractStrings(buffer, options = {}) {
  const minLen = options.minLength || MIN_STRING_LEN;
  const maxLen = options.maxLength || MAX_STRING_LEN;
  const len = buffer.length;
  const results = [];

  // Pass 1: ASCII & UTF-8 scan
  let start = -1;
  for (let i = 0; i < len; i++) {
    const b = buffer[i];
    if (isPrintableAscii(b)) {
      if (start === -1) start = i;
    } else {
      if (start !== -1) {
        const strLen = i - start;
        if (strLen >= minLen && strLen <= maxLen) {
          const val = buffer.subarray(start, i).toString('utf8');
          results.push({ value: val, encoding: 'utf8', offset: start, length: strLen });
        }
        start = -1;
      }
    }
  }
  if (start !== -1) {
    const strLen = len - start;
    if (strLen >= minLen && strLen <= maxLen) {
      results.push({ value: buffer.subarray(start, len).toString('utf8'), encoding: 'utf8', offset: start, length: strLen });
    }
  }

  // Pass 2: UTF-16LE scan ([char, 0x00, char, 0x00]) - test both byte alignments
  for (const align of [0, 1]) {
    let u16Start = -1;
    for (let i = align; i + 1 < len; i += 2) {
      const b0 = buffer[i];
      const b1 = buffer[i + 1];
      if (b1 === 0x00 && isPrintableAscii(b0)) {
        if (u16Start === -1) u16Start = i;
      } else {
        if (u16Start !== -1) {
          const charCount = (i - u16Start) / 2;
          if (charCount >= minLen && charCount <= maxLen) {
            const val = buffer.subarray(u16Start, i).toString('utf16le');
            results.push({ value: val, encoding: 'utf16le', offset: u16Start, length: charCount });
          }
          u16Start = -1;
        }
      }
    }
    if (u16Start !== -1) {
      const charCount = (len - (len % 2 === align ? 0 : 1) - u16Start) / 2;
      if (charCount >= minLen && charCount <= maxLen) {
        const val = buffer.subarray(u16Start, u16Start + charCount * 2).toString('utf16le');
        results.push({ value: val, encoding: 'utf16le', offset: u16Start, length: charCount });
      }
    }
  }

  // Pass 3: UTF-16BE scan ([0x00, char, 0x00, char]) - test both byte alignments
  for (const align of [0, 1]) {
    let beStart = -1;
    for (let i = align; i + 1 < len; i += 2) {
      const b0 = buffer[i];
      const b1 = buffer[i + 1];
      if (b0 === 0x00 && isPrintableAscii(b1)) {
        if (beStart === -1) beStart = i;
      } else {
        if (beStart !== -1) {
          const charCount = (i - beStart) / 2;
          if (charCount >= minLen && charCount <= maxLen) {
            const slice = Buffer.from(buffer.subarray(beStart, i));
            slice.swap16();
            const val = slice.toString('utf16le');
            results.push({ value: val, encoding: 'utf16be', offset: beStart, length: charCount });
          }
          beStart = -1;
        }
      }
    }
    if (beStart !== -1) {
      const charCount = (len - (len % 2 === align ? 0 : 1) - beStart) / 2;
      if (charCount >= minLen && charCount <= maxLen) {
        const slice = Buffer.from(buffer.subarray(beStart, beStart + charCount * 2));
        slice.swap16();
        const val = slice.toString('utf16le');
        results.push({ value: val, encoding: 'utf16be', offset: beStart, length: charCount });
      }
    }
  }

  return results;
}
