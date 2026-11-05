import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStrings } from '../reverse-tracker/extraction/strings.mjs';

test('extractStrings finds UTF-8, UTF-16LE, and UTF-16BE strings in single pass', () => {
  const utf8Part = Buffer.from('unreleased_model_gemini_3', 'utf8');
  const utf16lePart = Buffer.from('internal_secret_endpoint', 'utf16le');

  const beChars = Buffer.from('dogfood_hidden_flag', 'utf16le');
  beChars.swap16(); // Turn into UTF-16BE
  const utf16bePart = beChars;

  const binaryChunk = Buffer.concat([
    Buffer.from([0x00, 0x01, 0x02, 0xff]),
    utf8Part,
    Buffer.from([0x00, 0x00, 0x00]),
    utf16lePart,
    Buffer.from([0x00, 0x00, 0x00]),
    utf16bePart,
    Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  ]);

  const extracted = extractStrings(binaryChunk);
  const values = extracted.map((e) => e.value);

  assert.ok(values.includes('unreleased_model_gemini_3'), 'Must find UTF-8 string');
  assert.ok(values.includes('internal_secret_endpoint'), 'Must find UTF-16LE string');
  assert.ok(values.includes('dogfood_hidden_flag'), 'Must find UTF-16BE string');
});
