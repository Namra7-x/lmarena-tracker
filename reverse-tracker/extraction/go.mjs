/**
 * GoReSym Go Binary Metadata & Symbol Extractor (Section 6)
 * Executes Mandiant GoReSym to reconstruct Go pclntab, runtime types, package paths,
 * and string internment tables without decompiling machine code.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { CATEGORIES, isValidModelIdentifier, isValidFeatureFlag, isValidAgentTool } from '../finder/rules.mjs';

// Standard library package prefixes to filter out runtime boilerplate
const GO_STDLIB_PREFIXES = new Set([
  'runtime',
  'sync',
  'internal',
  'syscall',
  'reflect',
  'fmt',
  'os',
  'time',
  'math',
  'bytes',
  'strings',
  'sort',
  'path',
  'io',
  'context',
  'crypto',
  'net',
  'encoding',
  'strconv',
  'bufio',
  'errors',
  'unicode',
  'flag',
  'log',
  'testing',
  'compress',
  'container',
  'database',
  'debug',
  'expvar',
  'hash',
  'html',
  'image',
  'index',
  'mime',
  'plugin',
  'regexp',
  'text',
]);

/**
 * Check if a package path or symbol is part of Go standard library.
 */
export function isGoStdLibSymbol(symbolName) {
  if (!symbolName || typeof symbolName !== 'string') return true;
  const clean = symbolName.replace(/^\*/, '').trim();
  const firstSegment = clean.split(/[./\\]/)[0].toLowerCase();
  return GO_STDLIB_PREFIXES.has(firstSegment);
}

/**
 * Check if a buffer appears to be a compiled Go executable.
 * Inspects for Go pclntab magic headers, symbol tables, and runtime markers.
 */
export function isGoBinary(buffer) {
  if (!buffer || buffer.length < 512) return false;

  const sampleLen = Math.min(buffer.length, 4 * 1024 * 1024);
  const sample = buffer.subarray(0, sampleLen).toString('latin1');

  // 1. Text markers
  if (
    sample.includes('.gopclntab') ||
    sample.includes('Go build ID:') ||
    sample.includes('go:buildid') ||
    sample.includes('runtime.g') ||
    sample.includes('runtime.firstmoduledata') ||
    sample.includes('runtime.buildVersion')
  ) {
    return true;
  }

  // 2. Go pclntab magic bytes (LE/BE: 0xfffffff1, 0xfffffff0, 0xfffffffa, 0xfffffffb)
  const pclnMagics = [0xfffffff1, 0xfffffff0, 0xfffffffa, 0xfffffffb];
  for (let i = 0; i < Math.min(buffer.length - 4, 65536); i += 4) {
    const magicLE = buffer.readUInt32LE(i);
    const magicBE = buffer.readUInt32BE(i);
    if (pclnMagics.includes(magicLE) || pclnMagics.includes(magicBE)) {
      return true;
    }
  }

  return false;
}

/**
 * Find the GoReSym binary on PATH or common installation locations.
 */
export function findGoReSymCommand() {
  const candidates = [
    'GoReSym',
    'GoReSym.exe',
    '/usr/local/bin/GoReSym',
    '/usr/bin/GoReSym',
    'go/bin/GoReSym',
    'go/bin/GoReSym.exe',
  ];
  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd, ['-h'], { encoding: 'utf8', timeout: 2000 });
      if (res.status === 0 || res.stdout?.includes('GoReSym') || res.stderr?.includes('GoReSym')) {
        return cmd;
      }
    } catch {
      // not found
    }
  }
  return null;
}

/**
 * Execute GoReSym and parse structured JSON metadata.
 * Uses exact flags: `GoReSym -t -p -strings <binaryPath>`
 *
 * @param {string} binaryPath File path on disk
 * @returns {Object} { status: 'completed' | 'skipped' | 'failed', data }
 */
export function extractGoMetadata(binaryPath) {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return { status: 'skipped', reason: 'Binary file does not exist' };
  }

  const cmd = findGoReSymCommand();
  if (!cmd) {
    return { status: 'skipped', reason: 'GoReSym not found on PATH (will use native string scanner)' };
  }

  try {
    const res = spawnSync(cmd, ['-t', '-p', '-strings', binaryPath], {
      timeout: 30000,
      maxBuffer: 100 * 1024 * 1024,
      encoding: 'utf8',
    });

    if (res.status !== 0 || !res.stdout) {
      return { status: 'failed', reason: res.stderr || `GoReSym exited with code ${res.status}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (parseErr) {
      return { status: 'failed', reason: `Failed to parse GoReSym JSON stdout: ${parseErr.message}` };
    }

    return {
      status: 'completed',
      version: parsed.Version || parsed.BuildInfo?.GoVersion || null,
      buildId: parsed.BuildId || null,
      userFunctions: Array.isArray(parsed.UserFunctions) ? parsed.UserFunctions : [],
      types: Array.isArray(parsed.Types) ? parsed.Types : [],
      files: Array.isArray(parsed.Files) ? parsed.Files : (Array.isArray(parsed.FilePaths) ? parsed.FilePaths : []),
      strings: Array.isArray(parsed.Strings) ? parsed.Strings : [],
      interfaces: Array.isArray(parsed.Interfaces) ? parsed.Interfaces : [],
    };
  } catch (err) {
    return { status: 'failed', reason: err.message };
  }
}

/**
 * Parse structured signals (functions, types, fields, repo paths) from GoReSym metadata.
 * Filters out runtime boilerplate and returns clean finding records.
 *
 * @param {Object} metadata Output from extractGoMetadata
 * @param {string} filePath Executable file path
 * @returns {Array<Object>} Structured findings
 */
export function parseGoSignals(metadata, filePath = '') {
  if (!metadata || metadata.status !== 'completed') return [];

  const findings = [];
  const seen = new Set();

  function addFinding(category, value, context, rawExpression = '') {
    if (!value || typeof value !== 'string') return;
    const clean = value.trim();
    if (clean.length < 3 || clean.length > 250) return;

    const key = `${category}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);

    findings.push({
      category,
      value: clean,
      filePath,
      origin: 'go_symbol',
      offset: { line: 0, column: 0 },
      context: context || clean,
      rawExpression: rawExpression || clean,
      status: 'accepted',
    });
  }

  // 1. User Functions (exclude standard library)
  for (const fn of metadata.userFunctions || []) {
    const fnName = typeof fn === 'string' ? fn : (fn.FullName || fn.Name || fn.name);
    if (!fnName || isGoStdLibSymbol(fnName)) continue;

    const lower = fnName.toLowerCase();
    if (lower.includes('model') || lower.includes('agent') || lower.includes('client') || lower.includes('stream')) {
      addFinding(CATEGORIES.AGENT_MODE, fnName, `Go user function: ${fnName}`, 'UserFunction');
    } else {
      addFinding('go_function', fnName, `Go user function: ${fnName}`, 'UserFunction');
    }
  }

  // 2. Struct Types & Fields (exclude standard library)
  for (const typ of metadata.types || []) {
    const typeName = typeof typ === 'string' ? typ : (typ.Name || typ.name);
    if (!typeName || isGoStdLibSymbol(typeName)) continue;

    addFinding('go_type', typeName, `Go struct type: ${typeName}`, 'Type');

    // Inspect struct fields if available
    if (typ && Array.isArray(typ.Fields)) {
      for (const field of typ.Fields) {
        const fieldName = typeof field === 'string' ? field : field.Name;
        if (!fieldName) continue;
        const lowerField = fieldName.toLowerCase();
        if (/model|engine|endpoint|flag|gate|token|prompt|agent/i.test(lowerField)) {
          addFinding('go_field', `${typeName}.${fieldName}`, `Go field: ${typeName}.${fieldName}`, 'Field');
        }
      }
    }
  }

  // 3. Source Files (identify first-party packages and internal repos)
  for (const f of metadata.files || []) {
    if (typeof f !== 'string') continue;
    if (f.startsWith('/usr/local/go') || f.includes('/go/src/runtime')) continue;
    if (f.includes('github.com/') || f.includes('gitlab.com/') || f.includes('/internal/') || f.includes('/agent/')) {
      addFinding('go_source_file', f, `Go source path: ${f}`, 'FilePath');
    }
  }

  return findings;
}
