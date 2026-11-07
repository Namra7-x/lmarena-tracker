import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { validateAsarHeader, isAsar, extractAsar } from '../reverse-tracker/extraction/asar.mjs';
import {
  isGzip,
  isTarGz,
  isZip,
  isPeExecutable,
  isNsisInstaller,
  isMachOBinary,
  isJavaClass,
  MACHO_MAGICS,
} from '../reverse-tracker/extraction/archive.mjs';
import {
  parseJsAst,
  foldBinaryExpression,
  extractSignalsFromAst,
} from '../reverse-tracker/extraction/ast.mjs';
import { isGoBinary, extractGoMetadata, isGoStdLibSymbol, parseGoSignals } from '../reverse-tracker/extraction/go.mjs';
import { extractSourceMapMetadata } from '../reverse-tracker/extraction/sourcemap.mjs';
import { computeExactDiff } from '../reverse-tracker/diff/engine.mjs';

function createMockAsar(filesObj = { 'index.js': { size: 12, offset: '0' } }, payloadStr = 'console.log()') {
  const jsonHeader = JSON.stringify({ files: filesObj });
  const jsonBuf = Buffer.from(jsonHeader, 'utf8');
  const payloadBuf = Buffer.from(payloadStr, 'utf8');

  const jsonLen = jsonBuf.length;
  const pickleObjSize = jsonLen;
  const pickleHeaderSize = pickleObjSize + 4;

  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);                 // Pickle payload size
  header.writeUInt32LE(pickleHeaderSize, 4);  // Pickle header size
  header.writeUInt32LE(pickleObjSize, 8);     // Pickle object size
  header.writeUInt32LE(jsonLen, 12);          // JSON UTF-8 string length

  return Buffer.concat([header, jsonBuf, payloadBuf]);
}

test('ASAR Pickle Header Validation and Integrity', () => {
  // 1. Valid ASAR
  const validAsar = createMockAsar();
  const valRes = validateAsarHeader(validAsar);
  assert.equal(valRes.valid, true);
  assert.equal(isAsar(validAsar), true);

  const files = extractAsar(validAsar);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'index.js');
  assert.equal(files[0].buffer.toString('utf8'), 'console.log(');

  // 2. Corrupt pickle payload magic (byte 0 !== 4)
  const corruptMagic = Buffer.from(validAsar);
  corruptMagic.writeUInt32LE(999, 0);
  assert.equal(validateAsarHeader(corruptMagic).valid, false);
  assert.equal(isAsar(corruptMagic), false);

  // 3. Truncated buffer (< 16 bytes)
  const truncated = validAsar.subarray(0, 10);
  assert.equal(validateAsarHeader(truncated).valid, false);
  assert.equal(isAsar(truncated), false);

  // 4. Header extends beyond buffer
  const outOfBounds = Buffer.from(validAsar);
  outOfBounds.writeUInt32LE(50000, 12); // jsonLen claims 50,000 bytes
  assert.equal(validateAsarHeader(outOfBounds).valid, false);
  assert.equal(isAsar(outOfBounds), false);

  // 5. Non-JSON payload
  const notJson = Buffer.from(validAsar);
  notJson[16] = 0x41; // 'A' instead of '{'
  assert.equal(validateAsarHeader(notJson).valid, false);
});

test('Format Detection: GZIP vs TAR.GZ vs PE vs NSIS vs Mach-O vs Java Class', () => {
  // 1. GZIP vs TAR.GZ
  const plainGzip = zlib.gzipSync(Buffer.from('plain file content'));
  assert.equal(isGzip(plainGzip), true);
  assert.equal(isTarGz(plainGzip), false, 'Plain gzip without ustar is not a tarball');

  // Tar header with 'ustar' at offset 257
  const tarHeader = Buffer.alloc(512);
  tarHeader.write('test.txt', 0, 8, 'ascii');
  tarHeader.write('ustar', 257, 5, 'ascii');
  const tarGz = zlib.gzipSync(Buffer.concat([tarHeader, Buffer.alloc(512)]));
  assert.equal(isGzip(tarGz), true);
  assert.equal(isTarGz(tarGz), true, 'Tar header with ustar identified as tar.gz');

  // 2. Windows PE Executable vs NSIS Installer
  const peExe = Buffer.alloc(2048);
  peExe.write('MZ', 0, 2, 'ascii');
  assert.equal(isPeExecutable(peExe), true);
  assert.equal(isNsisInstaller(peExe), false);

  const nsisExe = Buffer.alloc(4096);
  nsisExe.write('MZ', 0, 2, 'ascii');
  nsisExe.write('NullsoftInst', 200, 12, 'ascii');
  assert.equal(isPeExecutable(nsisExe), true);
  assert.equal(isNsisInstaller(nsisExe), true, 'NSIS marker detected inside PE');

  // 3. Mach-O Universal / Single-arch vs Java Class File
  // Java class file: 0xCAFEBABE with major version 52 (Java 8)
  const javaClass = Buffer.alloc(16);
  javaClass.writeUInt32BE(0xcafebabe, 0);
  javaClass.writeUInt16BE(0, 4);  // minor version
  javaClass.writeUInt16BE(52, 6); // major version 52
  assert.equal(isJavaClass(javaClass), true);
  assert.equal(isMachOBinary(javaClass), false, 'Java class 0xcafebabe must not be identified as Mach-O');

  // Mach-O Fat Universal Binary: 0xCAFEBABE with 2 archs and x86_64 CPU type (0x01000007)
  const machoFat = Buffer.alloc(16);
  machoFat.writeUInt32BE(0xcafebabe, 0);
  machoFat.writeUInt32BE(2, 4);          // nfat_arch = 2
  machoFat.writeUInt32BE(0x01000007, 8); // cputype x86_64
  assert.equal(isJavaClass(machoFat), false);
  assert.equal(isMachOBinary(machoFat), true, 'Mach-O universal binary correctly identified');

  // Mach-O 64-bit LE binary
  const macho64Le = Buffer.alloc(16);
  macho64Le.writeUInt32LE(MACHO_MAGICS.MACHO_64_LE, 0);
  assert.equal(isMachOBinary(macho64Le), true);
});

test('Acorn JavaScript AST Analysis & Constant Expression Folding', () => {
  // 1. Binary Expression Folding
  const ast = parseJsAst('const url = "https://api." + "example.com" + "/v1";');
  assert.ok(ast);
  const declaration = ast.body[0].declarations[0];
  const folded = foldBinaryExpression(declaration.init);
  assert.equal(folded, 'https://api.example.com/v1');

  // 2. CommonJS top-level return support
  const cjsCode = 'return { default_model: "claude-4.0-sonnet-preview" };';
  const cjsFindings = extractSignalsFromAst(cjsCode, 'app/config.cjs');
  assert.ok(cjsFindings.length > 0);
  assert.equal(cjsFindings[0].value, 'claude-4.0-sonnet-preview');
  assert.equal(cjsFindings[0].origin, 'ast');
  assert.ok(cjsFindings[0].offset.line >= 1);

  // 3. Feature Gate / CheckGate call detection
  const gateCode = `
    if (checkGate("canvas_reasoning_mode") && isFeatureEnabled("copilot_next_edit")) {
      console.log("active");
    }
  `;
  const gateFindings = extractSignalsFromAst(gateCode, 'bundle.js');
  const flagValues = gateFindings.filter((f) => f.category === 'feature_flag').map((f) => f.value);
  assert.ok(flagValues.includes('canvas_reasoning_mode'));
  assert.ok(flagValues.includes('copilot_next_edit'));

  // 4. Template literal prefix extraction
  const tplCode = 'const endpoint = `https://internal.google.com/rpc/v2/${modelName}`;';
  const tplFindings = extractSignalsFromAst(tplCode, 'api.js');
  const epValues = tplFindings.filter((f) => f.category === 'endpoint_domain').map((f) => f.value);
  assert.ok(epValues.includes('https://internal.google.com/rpc/v2/'));

  // 5. Graceful fallback on syntax error
  const brokenCode = 'function broken( { ';
  const brokenFindings = extractSignalsFromAst(brokenCode, 'broken.js');
  assert.deepEqual(brokenFindings, []);

  // 6. Model Array and Variable Declarators
  const modelArrayCode = `
    const SUPPORTED_MODELS = [
      "gemini-3.8-flash-tts",
      "claude-4.0-sonnet-preview",
      "o3-high-reasoning"
    ];
    const DEFAULT_MODEL = "gemini-3.5-flash";
  `;
  const arrayFindings = extractSignalsFromAst(modelArrayCode, 'models.js');
  const extractedModels = arrayFindings.filter((f) => f.category === 'model_id').map((f) => f.value);
  assert.ok(extractedModels.includes('gemini-3.8-flash-tts'));
  assert.ok(extractedModels.includes('claude-4.0-sonnet-preview'));
  assert.ok(extractedModels.includes('o3-high-reasoning'));
  assert.ok(extractedModels.includes('gemini-3.5-flash'));

  // 7. Assignment Expression detection
  const assignCode = 'config.defaultModel = "gpt-4.5-preview";';
  const assignFindings = extractSignalsFromAst(assignCode, 'setup.js');
  assert.equal(assignFindings.length, 1);
  assert.equal(assignFindings[0].value, 'gpt-4.5-preview');

  // 8. Fully Folded Template Literals
  const tplFoldCode = 'const url = `https://${"api"}.${"anthropic.com"}/v1/messages`;';
  const tplFoldFindings = extractSignalsFromAst(tplFoldCode, 'client.js');
  assert.equal(tplFoldFindings.length, 1);
  assert.equal(tplFoldFindings[0].value, 'https://api.anthropic.com/v1/messages');

  // 9. Modern JSX Fallback
  const jsxCode = `
    export function Header() {
      const activeModel = "claude-3-7-sonnet";
      return <div className="header">Model: {activeModel}</div>;
    }
  `;
  const jsxFindings = extractSignalsFromAst(jsxCode, 'Header.jsx');
  const jsxModel = jsxFindings.find((f) => f.value === 'claude-3-7-sonnet');
  assert.ok(jsxModel, 'JSX syntax stripped gracefully to recover model constant');
});

test('Go Binary Detection and GoReSym Fallback', () => {
  // Go runtime signatures (buffer >= 512 bytes)
  const goMock = Buffer.concat([
    Buffer.from('MZ\x90\x00'),
    Buffer.alloc(500),
    Buffer.from('.gopclntab\x00runtime.g\x00'),
  ]);
  assert.equal(isGoBinary(goMock), true);

  const nonGo = Buffer.from('console.log("hello world");');
  assert.equal(isGoBinary(nonGo), false);

  // Fallback when binary does not exist
  const resNonExistent = extractGoMetadata('/tmp/non-existent-binary-12345');
  assert.equal(resNonExistent.status, 'skipped');

  // Go Standard Library filter check
  assert.equal(isGoStdLibSymbol('runtime.newobject'), true);
  assert.equal(isGoStdLibSymbol('fmt.Printf'), true);
  assert.equal(isGoStdLibSymbol('sync/atomic.LoadInt64'), true);
  assert.equal(isGoStdLibSymbol('github.com/google/jetski/agent.Run'), false);
  assert.equal(isGoStdLibSymbol('main.initSession'), false);

  // parseGoSignals with mock GoReSym JSON output
  const mockGoMetadata = {
    status: 'completed',
    version: 'go1.23.2',
    userFunctions: [
      { FullName: 'runtime.gcWork' }, // should be filtered out (stdlib)
      { FullName: 'github.com/google/jetski/agent.StartAgentSession' }, // user function
      { FullName: 'main.InitModelRouter' }, // user function
    ],
    types: [
      { Name: 'runtime.g', Fields: [] }, // should be filtered out (stdlib)
      {
        Name: 'github.com/google/jetski/config.AgentConfig',
        Fields: [{ Name: 'DefaultModel' }, { Name: 'TimeoutSeconds' }],
      },
    ],
    files: [
      '/usr/local/go/src/runtime/panic.go', // should be filtered out
      'github.com/google/jetski/agent/session.go', // repo file
    ],
  };

  const signals = parseGoSignals(mockGoMetadata, 'bin/antigravity-cli');
  const signalValues = signals.map((s) => s.value);

  // Check user functions extracted and stdlib filtered
  assert.ok(signalValues.includes('github.com/google/jetski/agent.StartAgentSession'));
  assert.ok(signalValues.includes('main.InitModelRouter'));
  assert.ok(!signalValues.includes('runtime.gcWork'), 'Standard library function filtered');

  // Check types and fields extracted
  assert.ok(signalValues.includes('github.com/google/jetski/config.AgentConfig'));
  assert.ok(signalValues.includes('github.com/google/jetski/config.AgentConfig.DefaultModel'));
  assert.ok(!signalValues.includes('runtime.g'), 'Standard library type filtered');

  // Check repo source file extracted
  assert.ok(signalValues.includes('github.com/google/jetski/agent/session.go'));
});

test('Source Map Metadata Parsing (names and sources without sourcesContent)', () => {
  // Production source map where sourcesContent is omitted
  const prodMap = JSON.stringify({
    version: 3,
    sources: ['webpack:///src/agent/modelRouter.ts', 'webpack:///node_modules/lodash/index.js'],
    names: ['activeModel', 'gemini38FlashTts', 'useFeatureGate', 'launchDarklyFlag'],
    mappings: 'AAAA,SAAS...',
  });

  const parsed = extractSourceMapMetadata(prodMap);
  assert.equal(parsed.hasSourcesContent, false);
  assert.equal(parsed.files.length, 0, 'No empty files created when sourcesContent is stripped');
  assert.deepEqual(parsed.sources, ['src/agent/modelRouter.ts'], 'First party source retained, node_modules filtered');
  assert.ok(parsed.names.includes('gemini38FlashTts'));
  assert.ok(parsed.names.includes('useFeatureGate'));
});

test('3-Way Structural Diffing (Added, Changed, Removed, Persistent, Reintroduced)', () => {
  const previous = [
    { category: 'model_id', value: 'gpt-4o', context: 'version 1', filePath: 'a.js' },
    { category: 'feature_flag', value: 'old_flag', context: 'flag 1', filePath: 'b.js' },
    { category: 'endpoint_domain', value: 'https://api.openai.com/v1', context: 'unchanged', filePath: 'c.js' },
  ];

  const candidate = [
    // persistent unchanged
    { category: 'endpoint_domain', value: 'https://api.openai.com/v1', context: 'unchanged', filePath: 'c.js' },
    // changed context
    { category: 'model_id', value: 'gpt-4o', context: 'version 2 updated', filePath: 'a.js' },
    // newly added
    { category: 'model_id', value: 'gemini-3.5-pro', context: 'new model', filePath: 'd.js' },
    // reintroduced from historical seen hashes
    { category: 'feature_flag', value: 'dormant_revived', context: 'revived', filePath: 'e.js' },
  ];

  const historicalHashes = new Set(['dormant_revived']);

  const diff = computeExactDiff(previous, candidate, historicalHashes);

  // Check diff counts and categories
  assert.equal(diff.counts.removedCount, 1, 'old_flag was removed');
  assert.equal(diff.removedFindings[0].value, 'old_flag');

  assert.equal(diff.counts.changedCount, 1, 'gpt-4o context changed');
  assert.equal(diff.changedFindings[0].value, 'gpt-4o');

  assert.equal(diff.counts.persistentCount, 1, 'api endpoint is persistent');
  assert.equal(diff.persistentFindings[0].value, 'https://api.openai.com/v1');

  assert.equal(diff.counts.newCount, 1, 'gemini-3.5-pro is new');
  assert.equal(diff.newFindings[0].value, 'gemini-3.5-pro');

  assert.equal(diff.counts.reintroducedCount, 1, 'dormant_revived was reintroduced');
  assert.equal(diff.reintroducedFindings[0].value, 'dormant_revived');
});

test('Alert Deduplication Key Digest Consistency', () => {
  const componentId = 'antigravity-cli';
  const version = '1.5.4';
  const artifacts = [
    { hash: 'sha256:aaaa', url: 'https://example.com/bin-mac' },
    { hash: 'sha256:bbbb', url: 'https://example.com/bin-win' },
  ];
  const findings = [
    { category: 'model_id', value: 'gemini-3.5-flash' },
    { category: 'feature_flag', value: 'smart_edit_v2' },
  ];

  function computeDigest(comp, ver, arts, finds) {
    const artSha = crypto.createHash('sha256').update(arts.map((a) => a.hash || a.url).sort().join(',')).digest('hex');
    const findDigest = crypto.createHash('sha256').update(finds.map((f) => `${f.category}:${f.value}`).sort().join(';')).digest('hex');
    return crypto.createHash('sha256').update(`${comp}:${ver}:${artSha}:${findDigest}`).digest('hex');
  }

  const digest1 = computeDigest(componentId, version, artifacts, findings);
  const digest2 = computeDigest(componentId, version, artifacts, findings);
  assert.equal(digest1, digest2, 'Digest must be deterministic and identical for same inputs');

  // If a new finding is discovered, digest must change
  const newFindings = [...findings, { category: 'model_id', value: 'gemini-3.5-ultra' }];
  const digest3 = computeDigest(componentId, version, artifacts, newFindings);
  assert.notEqual(digest1, digest3, 'New finding must produce distinct deduplication digest');
});
