/**
 * Official SDK Type & Client Extractor
 * Parses TypeScript declaration files (.d.ts) and JS bundles to extract 100% clean, ground-truth:
 * - Model literal type unions (text, vision, audio, video: veo-, sora-, imagen-, lyria-, etc.)
 * - Beta header unions (AnthropicBeta, feature flags)
 * - Reasoning effort levels (effort, reasoning_effort)
 * - Service tiers (flex, priority, auto, scale)
 * - Tool definitions & top-level request parameters
 * - API endpoint routes (/v1/responses, /v1/videos, /v1/messages/batches, etc.)
 */

import { extractTar } from '../extraction/archive.mjs';
import { SDK_CONFIG } from './config.mjs';

const MODEL_LITERAL_PREFIX_REGEX = /^(?:claude|gpt|o[0-9]|gemini|chatgpt|codex|dall-e|sora|veo|imagen|lyria|computer-use|text-|tts-|whisper|omni-moderation)/i;
const INLINE_MODEL_LITERAL_REGEX = /['"]((?:claude|gpt|o[1-9]|gemini|sora|veo|imagen|lyria)-[a-zA-Z0-9_\-\.\:\/]+)['"]/g;
const ENDPOINT_ROUTE_REGEX = /['"`](\/(?:v[0-9]+(?:alpha|beta)?\/[a-zA-Z0-9_./{}-]{2,80}|(?:messages|responses|chat\/completions|completions|batches|files|models|videos|audio|images|containers|evals|realtime|assistants|threads|vector_stores)(?:\/[a-zA-Z0-9_./{}-]{1,60})?))['"`]/g;

/**
 * Extracts string literals from a TypeScript type union definition:
 * e.g. "'claude-3-5-sonnet' | 'claude-3-opus' | (string & {})" -> ["claude-3-5-sonnet", "claude-3-opus"]
 */
export function extractUnionLiterals(typeBody) {
  if (!typeBody || typeof typeBody !== 'string') return [];
  const literals = new Set();

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
 * Extracts top-level parameter property names from request interfaces like
 * `interface MessageCreateParams`, `interface ResponseCreateParams`, `interface GenerateContentConfig`.
 */
export function extractRequestParameters(dtsContent) {
  const params = new Set();
  if (!dtsContent) return params;

  const ifaceRegex = /(?:export\s+)?interface\s+([A-Za-z0-9_]*(?:CreateParams|UpdateParams|RequestParams|GenerateContentConfig|GenerateContentParameters|ChatCompletionCreateParams|ResponseCreateParams)[A-Za-z0-9_]*)[^{]*\{([\s\S]*?)\n\}/g;
  let ifaceMatch;
  while ((ifaceMatch = ifaceRegex.exec(dtsContent)) !== null) {
    const body = ifaceMatch[2];
    const propMatches = body.matchAll(/^\s*(?:readonly\s+)?([a-zA-Z_][a-zA-Z0-9_]{1,50})\??\s*:/gm);
    for (const pm of propMatches) {
      const prop = pm[1].trim();
      if (!['model', 'messages', 'contents', 'stream', 'headers', 'body', 'query', 'signal', 'timeout'].includes(prop)) {
        params.add(prop);
      }
    }
  }
  return params;
}

/**
 * Extracts clean API routes from SDK client JS/d.ts files.
 */
export function extractApiEndpoints(content) {
  const routes = new Set();
  if (!content || typeof content !== 'string') return routes;

  ENDPOINT_ROUTE_REGEX.lastIndex = 0;
  let match;
  while ((match = ENDPOINT_ROUTE_REGEX.exec(content)) !== null) {
    const route = match[1].trim();
    if (
      route.length >= 4 &&
      route.length <= 90 &&
      !route.includes('..') &&
      !route.includes('.js') &&
      !route.includes('.ts') &&
      !route.includes('.json')
    ) {
      routes.add(route);
    }
  }
  return routes;
}

/**
 * Reverses a package tarball buffer and extracts all official SDK ground-truth items.
 */
export function reverseSdkPackage(tarBuffer, packageName) {
  const files = extractTar(tarBuffer);
  const dtsFiles = files.filter((f) => f.path.endsWith('.d.ts'));
  const codeFiles = files.filter((f) => /\.(?:js|mjs|cjs|d\.ts)$/i.test(f.path));

  const models = new Set();
  const betaHeaders = new Set();
  const reasoningEfforts = new Set();
  const serviceTiers = new Set();
  const toolDefinitions = new Set();
  const requestParams = new Set();
  const apiEndpoints = new Set();
  const rawTypes = {};

  for (const file of dtsFiles) {
    const content = file.buffer.toString('utf8');
    const typeDecls = parseTypeDeclarations(content);

    for (const [typeName, typeBody] of typeDecls) {
      // 1. Detect Model & Modality Literal Unions (Text, Image, Video, Audio)
      if (
        typeName === 'Model' ||
        typeName === 'ChatModel' ||
        typeName === 'VideoModel' ||
        typeName === 'ImageModel' ||
        typeName === 'AudioModel' ||
        typeName === 'SpeechModel' ||
        typeName === 'TranscriptionModel' ||
        typeName === 'EmbeddingModel' ||
        typeName === 'Modality' ||
        typeName.endsWith('Model') ||
        typeName.endsWith('Models')
      ) {
        const literals = extractUnionLiterals(typeBody);
        const modelLiterals = literals.filter((l) =>
          MODEL_LITERAL_PREFIX_REGEX.test(l) ||
          (typeName === 'Model' && !l.includes('/') && l.length >= 3 && l.length <= 60)
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
          l.includes('-202') || l.includes('prompt-caching') || l.includes('computer-use') || l.includes('mcp') || l.includes('context-')
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

      // 4. Detect Service Tiers
      if (typeName.includes('ServiceTier') || typeName === 'Tier') {
        const literals = extractUnionLiterals(typeBody);
        literals.forEach((t) => serviceTiers.add(t));
      }

      // 5. Detect Tool Names / Types
      if (typeName.includes('Tool') || typeName.includes('BetaTool') || typeName === 'ToolChoice') {
        const literals = extractUnionLiterals(typeBody);
        const tools = literals.filter((t) =>
          t.includes('tool') || t.includes('computer') || t.includes('bash') || t.includes('editor') || t.includes('web_search') || t.includes('code_execution')
        );
        tools.forEach((t) => toolDefinitions.add(t));
      }
    }

    // Inline model literals (supports sora-, veo-, imagen-, lyria-, claude-, gpt-, gemini-)
    INLINE_MODEL_LITERAL_REGEX.lastIndex = 0;
    let gm;
    while ((gm = INLINE_MODEL_LITERAL_REGEX.exec(content)) !== null) {
      const val = gm[1].trim();
      if (!val.includes('.d.ts') && !val.includes('/') && val.length > 4 && val.length < 60) {
        models.add(val);
      }
    }

    // Inline reasoning effort definitions
    const effortMatches = content.matchAll(/(?:effort|reasoning_effort|thinking_effort)\s*\??:\s*([^;]+);/g);
    for (const em of effortMatches) {
      const literals = extractUnionLiterals(em[1]);
      for (const lit of literals) {
        if (['low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'budget', 'extended'].includes(lit.toLowerCase())) {
          reasoningEfforts.add(lit);
        }
      }
    }

    // Inline service_tier definitions
    const tierMatches = content.matchAll(/service_tier\s*\??:\s*([^;]+);/g);
    for (const tm of tierMatches) {
      for (const lit of extractUnionLiterals(tm[1])) {
        serviceTiers.add(lit);
      }
    }

    // Top-level Request Parameters
    for (const p of extractRequestParameters(content)) {
      requestParams.add(p);
    }
  }

  // Scan JS/d.ts client code for API routes
  for (const file of codeFiles) {
    const text = file.buffer.toString('utf8');
    for (const route of extractApiEndpoints(text)) {
      apiEndpoints.add(route);
    }
  }

  return {
    packageName,
    models: Array.from(models).sort(),
    betaHeaders: Array.from(betaHeaders).sort(),
    reasoningEfforts: Array.from(reasoningEfforts).sort(),
    serviceTiers: Array.from(serviceTiers).sort(),
    toolDefinitions: Array.from(toolDefinitions).sort(),
    requestParams: Array.from(requestParams).sort(),
    apiEndpoints: Array.from(apiEndpoints).sort(),
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
