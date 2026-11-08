import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseModelMarkdown } from '../qwen-tracker/markdown.mjs';
import { diffQwenState, hasEvents } from '../qwen-tracker/diff.mjs';
import {
  buildNewModelEmbed,
  buildPriceChangeEmbed,
  buildContextChangeEmbed,
  buildRemovedModelEmbed,
} from '../qwen-tracker/discord.mjs';

describe('Qwen Cloud Markdown Parser', () => {
  it('should parse pricing and rate limits from standard model markdown', () => {
    const sampleMd = `
# Qwen3.8-Max

## Overview
2.4-trillion-parameter MoE flagship delivering a comprehensive leap.

## Pricing
ModelsBuilt-in Tools
*   Input
    
    $2Per 1M tokens
    
*   Output
    
    $6Per 1M tokens
    
*   Input(Implicit Cache)
    
    $0.25Per 1M tokens

## Rate Limits & Context
*   Max Input
    
    991K
    
*   Max Output
    
    131K
    
*   Context
    
    1M
    
*   Max Reasoning
    
    262K
`;

    const parsed = parseModelMarkdown(sampleMd);
    assert.equal(parsed.pricing['Input'], '$2Per 1M tokens');
    assert.equal(parsed.pricing['Output'], '$6Per 1M tokens');
    assert.equal(parsed.pricing['Input(Implicit Cache)'], '$0.25Per 1M tokens');
    assert.equal(parsed.limits['Context'], '1M');
    assert.equal(parsed.limits['Max Reasoning'], '262K');
    assert.ok(parsed.overview.includes('2.4-trillion-parameter'));
  });

  it('should handle markdown without pricing or limits gracefully', () => {
    const emptyMd = '# Some Model\n\n## Overview\nNo pricing here.';
    const parsed = parseModelMarkdown(emptyMd);
    assert.deepEqual(parsed.pricing, {});
    assert.deepEqual(parsed.limits, {});
    assert.equal(parsed.overview, 'No pricing here.');
  });
});

describe('Qwen Cloud Diff Engine', () => {
  const baseModel = {
    modelId: 'qwen3.8-max',
    name: 'Qwen3.8-Max',
    provider: 'qwen',
    category: 'Flagship',
    updateAt: '2026-08-02T04:16:52.000+00:00',
    modelInfo: {
      contextWindow: 1000000,
      maxInputTokens: 991808,
      maxOutputTokens: 131072,
      maxReasoningTokens: 262144,
    },
    features: ['cache', 'web-search'],
    capabilities: ['Reasoning', 'VU'],
    pricing: {
      Input: '$2Per 1M tokens',
      Output: '$6Per 1M tokens',
    },
  };

  it('should detect newly added models', () => {
    const current = new Map([
      ['qwen3.8-max', baseModel],
      ['qwen3.8-ultra', { ...baseModel, modelId: 'qwen3.8-ultra', name: 'Qwen3.8-Ultra' }],
    ]);

    const prev = {
      models: {
        'qwen3.8-max': baseModel,
      },
    };

    const events = diffQwenState(current, prev);
    assert.ok(hasEvents(events));
    assert.equal(events.added.length, 1);
    assert.equal(events.added[0].modelId, 'qwen3.8-ultra');
  });

  it('should detect pricing changes and new pricing tiers', () => {
    const updatedModel = {
      ...baseModel,
      pricing: {
        Input: '$1.50Per 1M tokens', // Changed
        Output: '$6Per 1M tokens',
        'Batch Input': '$0.75Per 1M tokens', // Added tier
      },
    };

    const current = new Map([['qwen3.8-max', updatedModel]]);
    const prev = { models: { 'qwen3.8-max': baseModel } };

    const events = diffQwenState(current, prev);
    assert.ok(hasEvents(events));
    assert.equal(events.priceChanges.length, 1);
    assert.equal(events.priceChanges[0].diffs.length, 2);
    const changed = events.priceChanges[0].diffs.find((d) => d.key === 'Input');
    assert.equal(changed.type, 'CHANGED');
    assert.equal(changed.oldVal, '$2Per 1M tokens');
    assert.equal(changed.newVal, '$1.50Per 1M tokens');
  });

  it('should detect context window and token limits expansion', () => {
    const updatedModel = {
      ...baseModel,
      modelInfo: {
        ...baseModel.modelInfo,
        contextWindow: 2000000, // 2M expanded
        maxReasoningTokens: 524288,
      },
    };

    const current = new Map([['qwen3.8-max', updatedModel]]);
    const prev = { models: { 'qwen3.8-max': baseModel } };

    const events = diffQwenState(current, prev);
    assert.ok(hasEvents(events));
    assert.equal(events.contextChanges.length, 1);
    const ctxDiff = events.contextChanges[0].diffs.find((d) => d.field === 'contextWindow');
    assert.equal(ctxDiff.oldVal, 1000000);
    assert.equal(ctxDiff.newVal, 2000000);
  });

  it('should detect removed or deprecated models', () => {
    const current = new Map();
    const prev = { models: { 'qwen3.8-max': baseModel } };

    const events = diffQwenState(current, prev);
    assert.ok(hasEvents(events));
    assert.equal(events.removed.length, 1);
    assert.equal(events.removed[0].modelId, 'qwen3.8-max');
  });
});

describe('Qwen Cloud Discord Embed Formatter', () => {
  it('should build rich embed for a new model with all fields intact', () => {
    const model = {
      modelId: 'qwen3.8-max',
      name: 'Qwen3.8-Max',
      provider: 'qwen',
      category: 'Flagship',
      modelPortalUrl: 'https://www.qwencloud.com/models/qwen3.8-max',
      capabilities: ['Reasoning', 'VU', 'TG'],
      inferenceMetadata: {
        requestModality: ['Image', 'Text', 'Video'],
        responseModality: ['Text'],
      },
      modelInfo: {
        contextWindow: 1000000,
        maxInputTokens: 991808,
        maxOutputTokens: 131072,
        maxReasoningTokens: 262144,
      },
      pricing: {
        Input: '$2Per 1M tokens',
        Output: '$6Per 1M tokens',
      },
      features: ['cache', 'web-search'],
    };

    const embed = buildNewModelEmbed(model);
    assert.ok(embed.title.includes('Qwen3.8-Max'));
    assert.equal(embed.url, 'https://www.qwencloud.com/models/qwen3.8-max');
    assert.ok(embed.fields.some((f) => f.name.includes('Modalities')));
    assert.ok(embed.fields.some((f) => f.name.includes('Pricing')));
    assert.ok(embed.fields.some((f) => f.name.includes('Context')));
    assert.ok(embed.thumbnail?.url);
  });

  it('should build clean embed for pricing updates', () => {
    const model = {
      modelId: 'qwen3.8-flash',
      name: 'Qwen3.8-Flash',
      provider: 'qwen',
      modelPortalUrl: 'https://www.qwencloud.com/models/qwen3.8-flash',
    };
    const diffs = [
      { key: 'Input', type: 'CHANGED', oldVal: '$0.20', newVal: '$0.15' },
    ];
    const embed = buildPriceChangeEmbed({ model, diffs });
    assert.ok(embed.title.includes('Pricing Updated'));
    assert.ok(embed.description.includes('~$0.20~ ➔ **`$0.15`**') || embed.description.includes('0.15'));
  });
});
