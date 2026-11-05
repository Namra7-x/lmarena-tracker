import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { extractTar, extractZip, isSafeRelativePath } from '../reverse-tracker/extraction/archive.mjs';
import { extractAsar, isAsar } from '../reverse-tracker/extraction/asar.mjs';
import { extractSourceMap } from '../reverse-tracker/extraction/sourcemap.mjs';

test('isSafeRelativePath prevents path traversal (zip-slip)', () => {
  assert.equal(isSafeRelativePath('package.json'), true);
  assert.equal(isSafeRelativePath('dist/index.js'), true);
  assert.equal(isSafeRelativePath('../evil.js'), false);
  assert.equal(isSafeRelativePath('foo/../../evil.js'), false);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('C:\\Windows\\System32'), false);
});

test('extractTar unpacks a valid tar.gz buffer safely', () => {
  // Construct a minimal in-memory TAR header (512 bytes) + 512 bytes data + 1024 zero bytes
  const tarBuf = Buffer.alloc(2048, 0);

  // Filename at 0..100
  tarBuf.write('test-file.txt', 0, 'utf8');
  // File size at 124..136 (octal string: 11 bytes = "00000000013 ")
  tarBuf.write('00000000013 ', 124, 'ascii');
  // Type flag at 156 ('0' for regular file)
  tarBuf.write('0', 156, 'ascii');

  // File content at 512..523
  tarBuf.write('Hello World', 512, 'utf8');

  // Gzip the tar buffer
  const gzipped = zlib.gzipSync(tarBuf);

  const files = extractTar(gzipped);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'test-file.txt');
  assert.equal(files[0].buffer.toString('utf8'), 'Hello World');
});

test('extractAsar parses Electron ASAR header and extracts file contents', () => {
  const file1Content = Buffer.from('console.log("hello asar");', 'utf8');

  // Create ASAR header JSON
  const headerJson = JSON.stringify({
    files: {
      'index.js': {
        size: file1Content.length,
        offset: '0',
      },
    },
  });
  const headerJsonBuf = Buffer.from(headerJson, 'utf8');

  // ASAR Header: 16 bytes prefix
  const asarBuf = Buffer.alloc(16 + headerJsonBuf.length + file1Content.length);
  asarBuf.writeUInt32LE(4, 0);
  asarBuf.writeUInt32LE(headerJsonBuf.length + 8, 4);
  asarBuf.writeUInt32LE(headerJsonBuf.length + 4, 8);
  asarBuf.writeUInt32LE(headerJsonBuf.length, 12);

  headerJsonBuf.copy(asarBuf, 16);
  file1Content.copy(asarBuf, 16 + headerJsonBuf.length);

  assert.equal(isAsar(asarBuf), true);

  const extracted = extractAsar(asarBuf);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].path, 'index.js');
  assert.equal(extracted[0].buffer.toString('utf8'), 'console.log("hello asar");');
});

test('extractSourceMap parses sourcesContent and filters third party paths', () => {
  const mapJson = JSON.stringify({
    version: 3,
    sources: [
      'webpack:///src/features/super-agent.ts',
      'webpack:///node_modules/lodash/lodash.js',
    ],
    sourcesContent: [
      'export const superAgent = "active";',
      'function lodash() {}',
    ],
  });

  const sources = extractSourceMap(mapJson);
  assert.equal(sources.length, 2);

  const firstParty = sources.find((s) => s.path.includes('super-agent'));
  assert.ok(firstParty);
  assert.equal(firstParty.isFirstParty, true);
  assert.equal(firstParty.content, 'export const superAgent = "active";');

  const thirdParty = sources.find((s) => s.path.includes('lodash'));
  assert.ok(thirdParty);
  assert.equal(thirdParty.isFirstParty, false);
});
