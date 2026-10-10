import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_SOURCES,
  normalizeCategoryModels,
  diffCategoryModels,
  findFirstSeenModels,
  findSelectorAliasClues,
} from '../arena_category_tracker.mjs';

test('tracker covers public Arena model-discovery surfaces', () => {
  const names = new Set(CATEGORY_SOURCES.map((source) => source.name));
  for (const expected of [
    'text', 'vision', 'text_math', 'text_instruction_following', 'text_coding',
    'agent_overall', 'agent_code', 'agent_chat', 'agent_work', 'agent_pareto',
    'code_pareto', 'code_webdev', 'code_react', 'code_image_to_webdev',
    'text_to_image', 'image_edit', 'text_to_video', 'image_to_video',
    'video_edit', 'document', 'search',
  ]) assert.ok(names.has(expected), 'missing source: ' + expected);
  assert.ok(CATEGORY_SOURCES.length >= 20, 'expected broad discovery coverage');
});

test('normalization retains identity fields only, not leaderboard metrics or arbitrary metadata', () => {
  const models = normalizeCategoryModels({
    'test-id': {
      id: 'test-id',
      displayName: 'Test Model',
      publicName: 'test-public',
      modelOrganization: 'Example Lab',
      provider: 'Example Provider',
      userSelectable: false,
      rank: 4,
      rating: 1423.5,
      votes: 901,
      license: 'Apache 2.0',
    },
  });

  assert.deepEqual(models['test-id'], {
    modelKey: 'test-id',
    displayName: 'Test Model',
    publicName: 'test-public',
    organization: 'Example Lab',
    provider: 'Example Provider',
    userSelectable: false,
  });
});

test('diff detects only new IDs and ignores rank, score, vote, name, metadata, and removal changes', () => {
  const previous = {
    existing: { modelKey: 'existing', displayName: 'Before', rank: 20, rating: 1300, votes: 900 },
    removed: { modelKey: 'removed', displayName: 'Removed Model' },
  };
  const current = {
    existing: { modelKey: 'existing', displayName: 'After', rank: 1, rating: 1500, votes: 1200, license: 'new' },
    fresh: { modelKey: 'fresh', displayName: 'Fresh Model' },
  };

  const diff = diffCategoryModels(previous, current);
  assert.deepEqual(diff.added.map((model) => model.modelKey), ['fresh']);
  assert.deepEqual(Object.keys(diff), ['added']);
});

test('first-seen IDs are deduplicated across sources and excluded when already in overall snapshot', () => {
  const previous = {
    text: {
      known: { modelKey: 'known', displayName: 'Known Model' },
    },
    vision: {
      known: { modelKey: 'known', displayName: 'Known Model' },
    },
  };
  const overview = {
    'already-overall': { id: 'already-overall', displayName: 'Already Listed' },
  };
  const results = [
    {
      source: { name: 'text', url: 'https://arena.ai/leaderboard/chat/text' },
      models: {
        known: { modelKey: 'known', displayName: 'Known Model' },
        'new-id': { modelKey: 'new-id', displayName: 'New Candidate' },
        'already-overall': { modelKey: 'already-overall', displayName: 'Already Listed' },
      },
    },
    {
      source: { name: 'vision', url: 'https://arena.ai/leaderboard/chat/vision' },
      models: {
        known: { modelKey: 'known', displayName: 'Known Model' },
        'new-id': { modelKey: 'new-id', displayName: 'New Candidate' },
      },
    },
  ];

  const found = findFirstSeenModels(results, previous, overview, {});
  assert.equal(found.length, 1);
  assert.equal(found[0].modelKey, 'new-id');
  assert.deepEqual(found[0].sources.map((source) => source.name), ['text', 'vision']);
});

test('newly configured routes baseline quietly rather than alerting every existing ID', () => {
  const results = [{
    source: { name: 'new-route', url: 'https://arena.ai/leaderboard/text/math' },
    models: {
      'existing-id': { modelKey: 'existing-id', displayName: 'Existing Model' },
    },
  }];
  const found = findFirstSeenModels(results, {}, {}, {});
  assert.deepEqual(found, []);
});

test('Direct-selector alias clues are optional context, not the detection identity', () => {
  const selectors = {
    codename: {
      publicName: 'codename',
      displayName: 'Preview Model',
      aliasCandidate: true,
    },
  };
  assert.deepEqual(findSelectorAliasClues('preview model', selectors), [
    { publicName: 'codename', displayName: 'Preview Model' },
  ]);
  assert.deepEqual(findSelectorAliasClues('another model', selectors), []);
});
