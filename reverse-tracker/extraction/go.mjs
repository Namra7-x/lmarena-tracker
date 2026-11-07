/**
 * GoReSym Go Binary Metadata & Symbol Extractor (Section 6)
 * Executes Mandiant GoReSym to reconstruct Go pclntab, runtime types, package paths,
 * and string internment tables without decompiling machine code.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Check if a buffer appears to be a compiled Go executable.
 * Looks for Go runtime indicators: '.gopclntab', 'go.buildid', or Go symbol markers.
 */
export function isGoBinary(buffer) {
  if (!buffer || buffer.length < 512) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024 * 1024)).toString('latin1');
  return sample.includes('.gopclntab') || sample.includes('Go build ID') || sample.includes('runtime.g');
}

/**
 * Find the GoReSym binary on PATH or common installation locations.
 */
export function findGoReSymCommand() {
  const candidates = ['GoReSym', 'GoReSym.exe', 'go/bin/GoReSym', 'go/bin/GoReSym.exe'];
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
      timeout: 25000,
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
