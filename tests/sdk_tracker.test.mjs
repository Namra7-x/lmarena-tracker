import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractUnionLiterals,
  parseTypeDeclarations,
  reverseSdkPackage,
} from '../reverse-tracker/sdk/extractor.mjs';
import {
  computeSdkDiff,
  formatSdkTelegramSummary,
  formatSdkDiffDocument,
} from '../reverse-tracker/sdk/diff.mjs';

describe('Official SDK Type Extractor', () => {
  it('should cleanly extract string union literals without noise', () => {
    const unionBody = `'claude-3-5-sonnet' | 'claude-opus-5' | (string & {}) | null`;
    const literals = extractUnionLiterals(unionBody);
    assert.deepEqual(literals, ['claude-3-5-sonnet', 'claude-opus-5']);
  });

  it('should parse export type declarations from .d.ts string', () => {
    const dtsContent = `
export type Model = 'gpt-5' | 'gpt-5.5' | 'o4-mini';
export type ReasoningEffort = 'low' | 'medium' | 'high';
type InternalConfig = 'foo' | 'bar';
`;
    const decls = parseTypeDeclarations(dtsContent);
    assert.equal(decls.size, 3);
    assert.ok(decls.has('Model'));
    assert.ok(decls.has('ReasoningEffort'));
    assert.ok(decls.has('InternalConfig'));
  });
});

describe('Official SDK Diff & Report Formatter', () => {
  const prevSnapshot = {
    version: '1.5.0',
    models: ['claude-3-5-sonnet', 'claude-3-opus'],
    betaHeaders: ['prompt-caching-2024-07-31'],
    reasoningEfforts: ['low', 'medium', 'high'],
    toolDefinitions: ['computer_20241022'],
  };

  const newReversed = {
    models: ['claude-3-5-sonnet', 'claude-3-opus', 'claude-opus-5-5'], // 1 added
    betaHeaders: ['prompt-caching-2024-07-31', 'computer-use-2025-01-24'], // 1 added
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], // 1 added
    toolDefinitions: ['computer_20241022', 'mcp_client_2025'], // 1 added
  };

  it('should accurately calculate version bumps, added models, and beta headers', () => {
    const diff = computeSdkDiff('@anthropic-ai/sdk', '1.6.0', newReversed, prevSnapshot);
    assert.equal(diff.oldVersion, '1.5.0');
    assert.equal(diff.newVersion, '1.6.0');
    assert.ok(diff.hasChanges);
    assert.deepEqual(diff.addedModels, ['claude-opus-5-5']);
    assert.deepEqual(diff.addedBetaHeaders, ['computer-use-2025-01-24']);
    assert.deepEqual(diff.addedEfforts, ['xhigh']);
    assert.deepEqual(diff.addedTools, ['mcp_client_2025']);
  });

  it('should format clean executive summary message under 4,096 chars', () => {
    const diff = computeSdkDiff('@anthropic-ai/sdk', '1.6.0', newReversed, prevSnapshot);
    const summary = formatSdkTelegramSummary(diff, 'Anthropic (Claude)');
    assert.ok(summary.length < 3500);
    assert.ok(summary.includes('claude-opus-5-5'));
    assert.ok(summary.includes('computer-use-2025-01-24'));
    assert.ok(summary.includes('@anthropic-ai/sdk'));
  });

  it('should format full technical diff document content', () => {
    const diff = computeSdkDiff('@anthropic-ai/sdk', '1.6.0', newReversed, prevSnapshot);
    const doc = formatSdkDiffDocument(diff);
    assert.ok(doc.includes('OFFICIAL SDK DEEP REVERSE DIFF REPORT'));
    assert.ok(doc.includes('+ claude-opus-5-5'));
    assert.ok(doc.includes('+ computer-use-2025-01-24'));
  });
});
