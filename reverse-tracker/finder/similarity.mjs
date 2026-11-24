/**
 * Text Normalization, Semantic Diffing & Near-Duplicate Clustering Engine
 *
 * Solves two core sources of reverse-engineering noise:
 * 1. Minified bundler churn (chunk hashes, 1-2 char variable renames, whitespace)
 *    falsely triggering MODIFIED alerts on unchanged models/flags across builds.
 * 2. Near-duplicate words, repeated phrases, and numeric/hash variants flooding
 *    reports (`strings.txt`, `leaks.txt`).
 */

/**
 * Normalize an extracted file path so bundler content hashes and temporary
 * archive unpack directories do not cause false pathChanged transitions.
 */
export function normalizePathForDiff(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  return filePath
    .replace(/\\/g, '/')
    .replace(/(?:extracted_disk_[^/]+|7z-extract-[^/]+|tar-extract-[^/]+)\//g, '')
    .replace(/([._-])[0-9a-f]{6,32}(?=\.(?:js|mjs|cjs|ts|css|map|wasm|json|bin)\b)/gi, '$1[hash]')
    .replace(/([._-])[A-Za-z0-9_-]{8,16}(?=\.(?:chunk|bundle)\.(?:js|mjs|css))/gi, '$1[hash]')
    .replace(/\/\d+\.\d+\.\d+(?:-[0-9a-zA-Z._-]+)?\//g, '/[ver]/')
    .trim()
    .toLowerCase();
}

/**
 * Normalize code/text context for semantic diff comparison (never used to cut
 * or alter stored display strings — only used to check whether content truly changed).
 */
export function normalizeContextForDiff(context) {
  if (!context || typeof context !== 'string') return '';
  return context
    .replace(/\r?\n/g, ' ')
    // Normalize minified local variable bindings like `const e=` or `,t={`
    .replace(/\b(?:var|let|const)\s+[a-zA-Z_$]{1,2}\s*=/g, 'var _=')
    // Normalize minified object member prefixes like `e.defaultModel` or `t.models`
    .replace(/(?<=[(,;={:\s])[a-zA-Z_$]{1,2}\.(?=[a-zA-Z_]{3,})/g, '_.')
    // Normalize bundler chunk hashes and cache-bust query params
    .replace(/([._-])[0-9a-f]{6,32}(\.(?:js|mjs|cjs|css|map|wasm))/gi, '$1[hash]$2')
    .replace(/\?(?:v|t|hash|cb)=[a-zA-Z0-9_-]+/g, '?v=[hash]')
    // Collapse whitespace runs
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute a structural signature for grouping near-duplicate strings.
 * Strings differing only by build hashes, hex IDs, or sequence numbers share a signature.
 */
export function normalizeStringSignature(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,64}\b/gi, '<hex>')
    .replace(/([._-])[0-9a-f]{6,16}(?=\.(?:js|mjs|cjs|css|map))/gi, '$1<hash>')
    .replace(/\b\d+(?:\.\d+){1,3}\b/g, '<ver>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ');
}

/**
 * Character 3-gram Dice similarity in [0, 1]. Zero dependencies, O(n).
 */
export function trigramSimilarity(a, b) {
  const s1 = String(a || '').toLowerCase().trim();
  const s2 = String(b || '').toLowerCase().trim();
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 3 || s2.length < 3) return s1 === s2 ? 1 : 0;

  const grams1 = new Map();
  for (let i = 0; i <= s1.length - 3; i++) {
    const g = s1.slice(i, i + 3);
    grams1.set(g, (grams1.get(g) || 0) + 1);
  }

  let intersection = 0;
  const total2 = s2.length - 2;
  for (let i = 0; i <= s2.length - 3; i++) {
    const g = s2.slice(i, i + 3);
    const count = grams1.get(g) || 0;
    if (count > 0) {
      grams1.set(g, count - 1);
      intersection++;
    }
  }

  return (2 * intersection) / (s1.length - 2 + total2);
}

/**
 * Collapse near-duplicate strings into grouped entries while keeping exact text intact.
 * Preserves high-signal items individually and aggregates repetitive variants.
 */
export function collapseNearDuplicateStrings(strings = [], options = {}) {
  const threshold = options.similarityThreshold ?? 0.88;
  const groups = [];
  const signatureMap = new Map();
  const prefixBuckets = new Map();

  for (const raw of strings) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;

    const sig = normalizeStringSignature(value);
    const existingBySig = signatureMap.get(sig);
    if (existingBySig) {
      if (value !== existingBySig.primary && !existingBySig.variants.includes(value)) {
        existingBySig.variants.push(value);
      }
      continue;
    }

    // Only attempt fuzzy merge for longer prose/repetitive lines (>= 28 chars) so short
    // distinct model IDs / flags like gpt-5-low vs gpt-5-high are NEVER collapsed together.
    let matchedGroup = null;
    if (value.length >= 28) {
      const bucketKey = `${sig.slice(0, 12)}:${Math.floor(value.length / 20)}`;
      const candidates = prefixBuckets.get(bucketKey) || [];
      for (const candidate of candidates) {
        if (Math.abs(candidate.primary.length - value.length) <= 18 && trigramSimilarity(candidate.primary, value) >= threshold) {
          matchedGroup = candidate;
          break;
        }
      }
      if (!matchedGroup) {
        const group = { primary: value, signature: sig, variants: [] };
        groups.push(group);
        signatureMap.set(sig, group);
        candidates.push(group);
        prefixBuckets.set(bucketKey, candidates);
      } else if (value !== matchedGroup.primary && !matchedGroup.variants.includes(value)) {
        matchedGroup.variants.push(value);
      }
    } else {
      const group = { primary: value, signature: sig, variants: [] };
      groups.push(group);
      signatureMap.set(sig, group);
    }
  }

  return groups;
}

/**
 * Extract canonical stem from a finding value so related signals
 * (e.g. model_id `claude-4-sonnet`, flag `enable_claude_4_sonnet`, UI copy `Introducing Claude 4 Sonnet`)
 * can be linked cleanly without dropping anything.
 */
export function extractCanonicalStem(value) {
  if (!value || typeof value !== 'string') return '';
  let norm = value.toLowerCase().trim();
  // Strip common announcements / flag verb prefixes
  norm = norm
    .replace(/^(?:introducing|announcing|welcome to|try the new|powered by|built on|enable|enabled|feature|experiment|rollout|gate|toggle|canary|dogfood|use|show|allow|should)[ _:-]+/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return norm;
}

/**
 * Group related findings under canonical parent discoveries (keeps higher-scored
 * model_id/flag/pricing as primary and attaches related variants in `.relatedSignals`).
 * Never discards findings across distinct categories unless they are pure UI chatter
 * echoing an already-captured primary finding.
 */
export function clusterRelatedFindings(findings = []) {
  if (!Array.isArray(findings) || findings.length <= 1) return findings;

  const categoryPriority = {
    model_id: 1,
    pricing: 2,
    hidden_command: 3,
    endpoint_domain: 4,
    agent_mode: 5,
    capability: 6,
    experiment: 7,
    feature_flag: 8,
    plan_entitlement: 9,
    platform_entitlement: 10,
    env_var: 11,
    ui_string: 12,
  };

  // Sort deterministically by score desc, then category specificity
  const ordered = [...findings].sort((a, b) => {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return (categoryPriority[a.category] || 99) - (categoryPriority[b.category] || 99);
  });

  const stemIndex = new Map();
  const result = [];

  for (const item of ordered) {
    const stem = extractCanonicalStem(item.value);
    // Attach echo UI copy that repeats an already-captured primary model/capability
    if (stem.length >= 6 && item.category === 'ui_string') {
      const parent = Array.from(stemIndex.entries()).find(([parentStem]) =>
        parentStem.length >= 5 && (stem === parentStem || stem.includes(parentStem))
      )?.[1];
      if (parent && parent.diffStatus === item.diffStatus) {
        parent.relatedSignals = parent.relatedSignals || [];
        if (!parent.relatedSignals.some((r) => r.value === item.value)) {
          parent.relatedSignals.push({ category: item.category, value: item.value });
        }
        continue;
      }
    }

    const cloned = { ...item };
    result.push(cloned);
    if (stem.length >= 5 && !stemIndex.has(stem)) {
      stemIndex.set(stem, cloned);
    }
  }

  return result;
}

/**
 * Produce a compact token/word-level diff line showing what changed between
 * oldContext and newContext without cutting URLs or identifiers.
 */
export function summarizeContextDelta(oldContext, newContext) {
  const prev = String(oldContext || '').replace(/\r?\n/g, ' ').trim();
  const curr = String(newContext || '').replace(/\r?\n/g, ' ').trim();
  if (!prev) return { summary: curr, changedTokens: [] };
  if (!curr) return { summary: prev, changedTokens: [] };
  if (prev === curr) return { summary: 'unchanged', changedTokens: [] };

  const tokenize = (s) => s.split(/(\s+|[{}()[\],;])/).map((t) => t.trim()).filter(Boolean);
  const oldTokens = tokenize(prev);
  const newTokens = tokenize(curr);

  const oldSet = new Set(oldTokens);
  const newSet = new Set(newTokens);
  const removed = oldTokens.filter((t) => !newSet.has(t)).slice(0, 12);
  const added = newTokens.filter((t) => !oldSet.has(t)).slice(0, 12);

  const parts = [];
  if (removed.length > 0) parts.push(`- [${removed.join(' ')}]`);
  if (added.length > 0) parts.push(`+ [${added.join(' ')}]`);

  return {
    summary: parts.length > 0 ? parts.join('  ➔  ') : `${prev}  ➔  ${curr}`,
    addedTokens: added,
    removedTokens: removed,
  };
}
