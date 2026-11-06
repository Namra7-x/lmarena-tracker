import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrgIndex, diffOrgState } from '../hf-tracker/detector.mjs';
import { buildEmbed } from '../hf-tracker/discord.mjs';

test('buildOrgIndex indexes models, spaces, and collections', () => {
  const state = {
    models: [
      { id: 'Qwen/Qwen3-Preview', lastModified: '2026-11-01T00:00:00Z', gated: false, pipeline_tag: 'text-generation' }
    ],
    spaces: [
      { id: 'Qwen/Qwen-Demo', lastModified: '2026-11-01T00:00:00Z', sdk: 'gradio' }
    ],
    collections: [
      { slug: 'Qwen/qwen3-collection', title: 'Qwen 3 Suite', lastUpdated: '2026-11-01T00:00:00Z', items: [{}, {}] }
    ]
  };

  const index = buildOrgIndex(state);
  assert.equal(index.models['Qwen/Qwen3-Preview'].gated, false);
  assert.equal(index.models['Qwen/Qwen3-Preview'].pipeline_tag, 'text-generation');
  assert.equal(index.spaces['Qwen/Qwen-Demo'].sdk, 'gradio');
  assert.equal(index.collections['Qwen/qwen3-collection'].itemCount, 2);
});

test('diffOrgState detects NEW_MODEL, NEW_SPACE, and NEW_COLLECTION', () => {
  const previous = {
    models: {
      'deepseek-ai/DeepSeek-V2': { lastModified: '2026-05-01T00:00:00Z', gated: false }
    },
    spaces: {},
    collections: {}
  };

  const current = {
    models: [
      { id: 'deepseek-ai/DeepSeek-V2', lastModified: '2026-05-01T00:00:00Z', gated: false },
      { id: 'deepseek-ai/DeepSeek-R1-Reasoning', lastModified: '2026-11-05T00:00:00Z', gated: false, pipeline_tag: 'text-generation' }
    ],
    spaces: [
      { id: 'deepseek-ai/DeepSeek-R1-Demo', lastModified: '2026-11-05T00:00:00Z', sdk: 'gradio' }
    ],
    collections: [
      { slug: 'deepseek-ai/r1-suite', title: 'DeepSeek R1 Collection', lastUpdated: '2026-11-05T00:00:00Z', items: [{}] }
    ]
  };

  const events = diffOrgState('deepseek-ai', current, previous);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'NEW_MODEL');
  assert.equal(events[0].item.id, 'deepseek-ai/DeepSeek-R1-Reasoning');
  assert.equal(events[1].type, 'NEW_SPACE');
  assert.equal(events[1].item.id, 'deepseek-ai/DeepSeek-R1-Demo');
  assert.equal(events[2].type, 'NEW_COLLECTION');
  assert.equal(events[2].item.title, 'DeepSeek R1 Collection');
});

test('diffOrgState detects GATING_CHANGED and COLLECTION_UPDATED', () => {
  const previous = {
    models: {
      'meta-llama/Llama-4-Preview': { lastModified: '2026-11-01T00:00:00Z', gated: true }
    },
    spaces: {},
    collections: {
      'meta-llama/llama-suite': { title: 'Llama Suite', lastUpdated: '2026-11-01T00:00:00Z', itemCount: 2 }
    }
  };

  const current = {
    models: [
      { id: 'meta-llama/Llama-4-Preview', lastModified: '2026-11-01T00:00:00Z', gated: false }
    ],
    spaces: [],
    collections: [
      { slug: 'meta-llama/llama-suite', title: 'Llama Suite', lastUpdated: '2026-11-05T00:00:00Z', items: [{}, {}, {}] }
    ]
  };

  const events = diffOrgState('meta-llama', current, previous);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'GATING_CHANGED');
  assert.equal(events[1].type, 'COLLECTION_UPDATED');
  assert.equal(events[1].details.summary.includes('expanded from 2 to 3 items'), true);
});

test('buildEmbed generates rich Discord embed with lab avatar, links, and styling', () => {
  const event = {
    type: 'NEW_MODEL',
    org: 'Qwen',
    item: {
      id: 'Qwen/Qwen3-Max-Preview',
      pipeline_tag: 'text-generation',
      gated: false,
      description: 'The next generation frontier reasoning model from Qwen.'
    },
    details: { summary: 'Brand new model Qwen/Qwen3-Max-Preview released.' }
  };

  const embed = buildEmbed(event);
  assert.equal(embed.author.name.includes('Qwen (Alibaba)'), true);
  assert.equal(embed.author.icon_url.includes('cdn-avatars.huggingface.co'), true);
  assert.equal(embed.thumbnail.url.includes('cdn-avatars.huggingface.co'), true);
  assert.equal(embed.title, '🚨 NEW MODEL RELEASE: Qwen/Qwen3-Max-Preview');
  assert.equal(embed.url, 'https://huggingface.co/Qwen/Qwen3-Max-Preview');
  assert.equal(embed.color, 0x10B981); // Emerald Green
  assert.equal(embed.fields.some(f => f.name === '🏷️ Task' && f.value === '`text-generation`'), true);
  assert.equal(embed.fields.some(f => f.name === '🔗 Quick Links'), true);
});

test('diffOrgState ignores ancient models (>72h old) and rejects fake release alerts', () => {
  const previous = {
    models: {},
    spaces: {},
    collections: {}
  };

  const current = {
    models: [
      // Model from 2024 (ancient)
      { id: 'facebook/UMA', createdAt: '2024-10-27T14:58:57.000Z', gated: false },
      // Model from yesterday (genuine new)
      { id: 'facebook/SAM-3-Realtime', createdAt: new Date(Date.now() - 3600000).toISOString(), gated: false, pipeline_tag: 'vision' }
    ],
    spaces: [],
    collections: [
      // Collection from 2025 (ancient)
      { slug: 'facebook/old-suite', title: 'Old Suite', lastUpdated: '2025-01-01T00:00:00Z', items: [] }
    ]
  };

  const events = diffOrgState('facebook', current, previous);
  // Only the genuine 1-hour-old model should be emitted
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'NEW_MODEL');
  assert.equal(events[0].item.id, 'facebook/SAM-3-Realtime');
});

test('buildEmbed formats newly added collection models with exact links', () => {
  const event = {
    type: 'COLLECTION_UPDATED',
    org: 'Qwen',
    item: {
      slug: 'Qwen/qwen38-suite',
      title: 'Qwen 3.8 Suite',
      items: [
        { id: 'Qwen/Qwen3.8-27B' },
        { id: 'Qwen/Qwen3.8-72B' }
      ]
    },
    details: {
      summary: 'Collection **Qwen 3.8 Suite** expanded from 1 to 2 items.',
      addedItems: [
        { id: 'Qwen/Qwen3.8-72B' }
      ]
    }
  };

  const embed = buildEmbed(event);
  assert.equal(embed.title.includes('Qwen 3.8 Suite'), true);
  assert.equal(embed.url, 'https://huggingface.co/collections/Qwen/qwen38-suite');
  assert.equal(embed.fields.some(f => f.name === '➕ Newly Added Models' && f.value.includes('Qwen/Qwen3.8-72B')), true);
});
