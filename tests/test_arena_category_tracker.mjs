import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_SOURCES,
  normalizeCategoryModels,
  diffCategoryModels,
} from '../arena_category_tracker.mjs';

test('tracker covers public Arena leaderboard families and known subcategories', () => {
  const names = new Set(CATEGORY_SOURCES.map((source) => source.name));
  for (const expected of [
    'text', 'vision', 'text_math', 'text_instruction_following', 'text_coding',
    'agent_overall', 'agent_code', 'agent_chat', 'agent_work',
    'code_webdev', 'code_image_to_webdev', 'text_to_image', 'image_edit',
    'text_to_video', 'image_to_video', 'video_edit', 'document', 'search',
  ]) assert.ok(names.has(expected), 'missing source: ' + expected);
  assert.ok(CATEGORY_SOURCES.length >= 20, 'expected broad leaderboard coverage');
});

test('normalization keeps rank, score, vote counts, and public metadata', () => {
  const models = normalizeCategoryModels({
    'test-id': {
      id: 'test-id',
      displayName: 'Test Model',
      modelOrganization: 'Example Lab',
      rank: 4,
      rankUpper: 2,
      rankLower: 9,
      rating: 1423.5,
      votes: 901,
      license: 'Apache 2.0',
      contextLength: 131072,
      inputCapabilities: { text: true, image: true },
      __sourceSchema: 'internal',
    },
  });

  assert.deepEqual(models['test-id'], {
    modelKey: 'test-id',
    displayName: 'Test Model',
    organization: 'Example Lab',
    provider: '',
    rank: 4,
    rankUpper: 2,
    rankLower: 9,
    rating: 1423.5,
    ratingUpper: null,
    ratingLower: null,
    votes: 901,
    rankByModality: {},
    metrics: {},
    metadata: {
      contextLength: 131072,
      inputCapabilities: { image: true, text: true },
      license: 'Apache 2.0',
    },
  });
});

test('diff finds new and removed IDs and changed display-name mappings', () => {
  const previous = {
    old: { modelKey: 'old', displayName: 'Old Name', rank: 10, rating: 1400, votes: 1000, metadata: {} },
    same: { modelKey: 'same', displayName: 'Before', rank: 20, rating: 1300, votes: 900, metadata: {} },
  };
  const current = {
    same: { modelKey: 'same', displayName: 'After', rank: 20, rating: 1300, votes: 900, metadata: {} },
    fresh: { modelKey: 'fresh', displayName: 'Fresh Model', rank: 1, rating: 1500, votes: 5, metadata: {} },
  };
  const diff = diffCategoryModels(previous, current);
  assert.deepEqual(diff.added.map((model) => model.modelKey), ['fresh']);
  assert.deepEqual(diff.removed.map((model) => model.modelKey), ['old']);
  assert.equal(diff.mappingChanged.length, 1);
  assert.equal(diff.mappingChanged[0].after.displayName, 'After');
});

test('diff catches meaningful metadata, rank, and score changes', () => {
  const previous = {
    model: {
      modelKey: 'model', displayName: 'Model', organization: 'Lab A', provider: '',
      rank: 20, rankUpper: 10, rankLower: 30, rating: 1400,
      ratingUpper: null, ratingLower: null, votes: 1000, rankByModality: {},
      metadata: { license: 'MIT', contextLength: 32768 },
    },
  };
  const current = {
    model: {
      modelKey: 'model', displayName: 'Model', organization: 'Lab B', provider: '',
      rank: 15, rankUpper: 5, rankLower: 36, rating: 1404,
      ratingUpper: null, ratingLower: null, votes: 1200, rankByModality: {},
      metadata: { license: 'Apache 2.0', contextLength: 65536 },
    },
  };
  const diff = diffCategoryModels(previous, current);
  assert.equal(diff.metadataChanged.length, 1);
  assert.deepEqual(diff.metadataChanged[0].fields.sort(), ['contextLength', 'license', 'organization']);
  assert.equal(diff.metricChanged.length, 1);
  assert.deepEqual(diff.metricChanged[0].changes.map((change) => change.field), [
    'rank', 'rankUpper', 'rankLower', 'rating',
  ]);
});

test('small rank and score changes do not create noisy alerts', () => {
  const previous = {
    elo: {
      modelKey: 'elo', displayName: 'Elo', rank: 10, rankUpper: 5, rankLower: 15,
      rating: 1400, ratingUpper: null, ratingLower: null, votes: 1000, rankByModality: {}, metadata: {},
    },
    agent: {
      modelKey: 'agent', displayName: 'Agent', rank: 3, rankUpper: 2, rankLower: 5,
      rating: 0.12, ratingUpper: null, ratingLower: null, votes: 1000, rankByModality: {}, metadata: {},
    },
  };
  const current = {
    elo: { ...previous.elo, rank: 11, rating: 1401, votes: 1100 },
    agent: { ...previous.agent, rank: 4, rating: 0.122, votes: 1050 },
  };
  const diff = diffCategoryModels(previous, current);
  assert.equal(diff.metricChanged.length, 0);
});


test('agent metrics are tracked with thresholds instead of noisy exact metadata diffs', () => {
  const previous = {
    agent: {
      modelKey: 'agent', displayName: 'Agent', rank: 1, rating: 0.12, votes: 1000,
      rankByModality: {}, metrics: { netImprovement: 0.12, costPerTaskP50: 1.00 }, metadata: {},
    },
  };
  const current = {
    agent: {
      modelKey: 'agent', displayName: 'Agent', rank: 1, rating: 0.12, votes: 1200,
      rankByModality: {}, metrics: { netImprovement: 0.122, costPerTaskP50: 1.20 }, metadata: {},
    },
  };
  const diff = diffCategoryModels(previous, current);
  assert.equal(diff.metricChanged.length, 1);
  assert.deepEqual(diff.metricChanged[0].changes.map((change) => change.field), ['metrics.costPerTaskP50']);
});

test('existing snapshots migrate without a one-time metadata alert', () => {
  const previous = {
    model: {
      modelKey: 'model', displayName: 'Model', rank: 1, rating: 1500, votes: 10,
      metadata: { license: 'MIT', netImprovement: 0.12, sessions: 1000 },
    },
  };
  const current = {
    model: {
      modelKey: 'model', displayName: 'Model', organization: 'Lab', provider: '',
      rank: 1, rankUpper: null, rankLower: null, rating: 1500, ratingUpper: null,
      ratingLower: null, votes: 10, rankByModality: {}, metadata: { license: 'MIT' },
    },
  };
  const diff = diffCategoryModels(previous, current);
  assert.equal(diff.metadataChanged.length, 0);
  assert.equal(diff.metricChanged.length, 0);
});
