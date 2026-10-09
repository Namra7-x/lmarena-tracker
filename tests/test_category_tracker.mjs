import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCategoryModels, diffCategoryModels } from '../arena_category_tracker.mjs';

test('normalizes category records around stable modelKey IDs', () => {
  const result = normalizeCategoryModels({
    'contenders/model-agent': {
      id: 'contenders/model-agent',
      displayName: 'Example Model (High)',
      rank: 4,
      rating: 1512.5,
      votes: 1200,
    },
  });

  assert.equal(result['contenders/model-agent'].modelKey, 'contenders/model-agent');
  assert.equal(result['contenders/model-agent'].displayName, 'Example Model (High)');
  assert.equal(result['contenders/model-agent'].rank, 4);
});

test('reports category-only new IDs while suppressing IDs already present in overview', () => {
  const previous = {
    'known-model': { modelKey: 'known-model', displayName: 'Known Model' },
  };
  const current = {
    'known-model': { modelKey: 'known-model', displayName: 'Known Model' },
    'overview-model': { modelKey: 'overview-model', displayName: 'Overview Model' },
    'category-only-model': { modelKey: 'category-only-model', displayName: 'Category Only Model' },
  };

  const result = diffCategoryModels(previous, current, new Set(['overview-model']));
  assert.deepEqual(result.added.map((model) => model.modelKey), ['category-only-model']);
  assert.equal(result.mappingChanged.length, 0);
});

test('detects display-name changes for an existing stable model key', () => {
  const previous = {
    'codename-123': { modelKey: 'codename-123', displayName: 'Anonymous Model' },
  };
  const current = {
    'codename-123': { modelKey: 'codename-123', displayName: 'Revealed Model' },
  };

  const result = diffCategoryModels(previous, current);
  assert.equal(result.mappingChanged.length, 1);
  assert.equal(result.mappingChanged[0].after.displayName, 'Revealed Model');
});
