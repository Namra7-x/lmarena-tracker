/**
 * Official SDK Type Extractor
 * Parses TypeScript declaration files (.d.ts) to extract 100% clean, ground-truth:
 * - Model literal type unions (Model, ChatModel, etc.)
 * - Beta header unions (AnthropicBeta, feature flags)
 * - Reasoning effort levels (effort, reasoning_effort)
 * - Tool definitions & parameter schemas
 */

import { extractTar } from '../extraction/archive.mjs';
import { SDK_CONFIG } from './config.mjs';

/**
 * Extracts string literals from a TypeScript type union definition:
 * e.g. "'claude-3-5-sonnet' | 'claude-3-opus' | (string & {})" -> ["claude-3-5-sonnet", "claude-3-opus"]
 */
export function extractUnionLiterals(typeBody) {
  if (!typeBody || typeof typeBody !== 'string') return [];
  const literals = new Set();
  
  // Matches 'some-string' or "some-string"
  const matches = typeBody.matchAll(/['"]([a-zA-Z0-9_\-\.\:\/]+)['"]/g);
  for (const m of matches) {
    const val = m[1].trim();
    if (val && !['string', 'number', 'boolean', 'null', 'undefined'].includes(val)) {
      literals.add(val);
    }
  }

  return Array.from(literals).sort();
}

/**
 * Parses all type declarations from a .d.ts content string:
 * type FooName = ...;
 */
export function parseTypeDeclarations(dtsContent) {
  const declarations = new Map();
  if (!dtsContent) return declarations;

  // Match: (export )?type TypeName = ...;
  const regex = /(?:export\s+)?type\s+([A-Za-z0-9_]+)(?:<[^>]+>)?\s*=\s*([^;]+);/g;
  let match;
  while ((match = regex.exec(dtsContent)) !== null) {
    const name = match[1].trim();
    const body = match[2].trim();
    declarations.set(name, body);
  }

  return declarations;
}

/**
 * Reverses a package tarball buffer and extracts all official SDK ground-truth items.
 */
export function reverseSdkPackage(tarBuffer, packageName) {
  const files = extractTar(tarBuffer);
  const dtsFiles = files.filter((f) => f.path.endsWith('.d.ts'));

  const models = new Set();
  const betaHeaders = new Set();
  const reasoningEfforts = new Set();
  const toolDefinitions = new Set();
  const rawTypes = {};

  for (const file of dtsFiles) {
    const content = file.buffer.toString('utf8');
    const typeDecls = parseTypeDeclarations(content);

    for (const [typeName, typeBody] of typeDecls) {
      // 1. Detect Model Literal Unions
      if (
        typeName === 'Model' ||
        typeName === 'ChatModel' ||
        typeName.endsWith('Model') ||
        typeName.endsWith('Models')
      ) {
        const literals = extractUnionLiterals(typeBody);
        const modelLiterals = literals.filter((l) =>
          /^(?:claude|gpt|o[0-9]|gemini|chatgpt|codex|dall-e|text-|tts-|whisper)/i.test(l)
        );
        if (modelLiterals.length > 0) {
          rawTypes[typeName] = literals;
          modelLiterals.forEach((m) => models.add(m));
        }
      }

      // 2. Detect Beta Header Unions (e.g. AnthropicBeta)
      if (
        typeName.includes('Beta') ||
        typeName.includes('Header') ||
        typeName.includes('Feature')
      ) {
        const literals = extractUnionLiterals(typeBody);
        const betaLiterals = literals.filter((l) =>
          l.includes('-202') || l.includes('prompt-caching') || l.includes('computer-use') || l.includes('mcp')
        );
        if (betaLiterals.length > 0) {
          rawTypes[typeName] = literals;
          betaLiterals.forEach((b) => betaHeaders.add(b));
        }
      }

      // 3. Detect Reasoning Effort Levels
      if (typeName.includes('Effort') || typeName === 'ReasoningEffort') {
        const literals = extractUnionLiterals(typeBody);
        literals.forEach((e) => reasoningEfforts.add(e));
      }

      // 4. Detect Tool Names / Types
      if (typeName.includes('Tool') || typeName.includes('BetaTool') || typeName === 'ToolChoice') {
        const literals = extractUnionLiterals(typeBody);
        const tools = literals.filter((t) =>
          t.includes('tool') || t.includes('computer') || t.includes('bash') || t.includes('editor')
        );
        tools.forEach((t) => toolDefinitions.add(t));
      }
    }

    // Additional targeted inspection for inline model and beta string patterns
    // e.g. for Google GenAI or inline string literals
    const generalMatches = content.matchAll(/['"]((?:claude|gpt|o[1-9]|gemini)-[a-zA-Z0-9_\-\.\:\/]+)['"]/g);
    for (const gm of generalMatches) {
      const val = gm[1].trim();
      if (!val.includes('.d.ts') && !val.includes('/') && val.length > 4 && val.length < 60) {
        models.add(val);
      }
    }

    // Inspect property-level reasoning effort definitions
    // e.g. effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    const effortMatches = content.matchAll(/(?:effort|reasoning_effort|thinking_effort)\s*\??:\s*([^;]+);/g);
    for (const em of effortMatches) {
      const literals = extractUnionLiterals(em[1]);
      for (const lit of literals) {
        if (['low', 'medium', 'high', 'xhigh', 'max', 'budget', 'extended'].includes(lit.toLowerCase())) {
          reasoningEfforts.add(lit);
        }
      }
    }
  }

  return {
    packageName,
    models: Array.from(models).sort(),
    betaHeaders: Array.from(betaHeaders).sort(),
    reasoningEfforts: Array.from(reasoningEfforts).sort(),
    toolDefinitions: Array.from(toolDefinitions).sort(),
    totalDtsFiles: dtsFiles.length,
    rawTypesCount: Object.keys(rawTypes).length,
  };
}

/**
 * Downloads and reverses an SDK package directly from its tarball URL.
 */
export async function downloadAndReverseSdk(tarballUrl, packageName) {
  const res = await fetch(tarballUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AISDKTracker/1.0)',
      Accept: 'application/octet-stream,*/*',
    },
    signal: AbortSignal.timeout(SDK_CONFIG.timeouts.download),
  });

  if (!res.ok) {
    throw new Error(`Failed to download SDK tarball (${res.status}): ${tarballUrl}`);
  }

  const arrayBuf = await res.arrayBuffer();
  const tarBuffer = Buffer.from(arrayBuf);
  return reverseSdkPackage(tarBuffer, packageName);
}
