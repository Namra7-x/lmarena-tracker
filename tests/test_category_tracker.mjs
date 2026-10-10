import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCategoryModels, diffCategoryModels } from '../arena_category_tracker.mjs';

test('normalizes stable model identity without storing leaderboard statistics', () => {
  const result = normalizeCategoryModels({
    'contenders/model-agent': {
      id: 'contenders/model-agent',
      displayName: 'Example Model (High)',
      organization: 'Example Lab',
      rank: 4,
      rating: 1512.5,
      votes: 1200,
    },
  });

  assert.deepEqual(result['contenders/model-agent'], {
    modelKey: 'contenders/model-agent',
    displayName: 'Example Model (High)',
    publicName: '',
    organization: 'Example Lab',
    provider: '',
    userSelectable: null,
  });
});

test('new IDs are the only category diff that can trigger a model alert', () => {
  const previous = {
    'known-model': { modelKey: 'known-model', displayName: 'Known Model', rank: 9 },
    'removed-model': { modelKey: 'removed-model', displayName: 'Removed Model' },
  };
  const current = {
    'known-model': { modelKey: 'known-model', displayName: 'Renamed Model', rank: 1, rating: 1600 },
    'new-model': { modelKey: 'new-model', displayName: 'New Candidate' },
  };

  const result = diffCategoryModels(previous, current);
  assert.deepEqual(result.added.map((model) => model.modelKey), ['new-model']);
  assert.deepEqual(Object.keys(result), ['added']);
});
