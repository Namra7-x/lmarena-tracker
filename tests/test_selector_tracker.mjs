import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSelectorModels, diffSelectorModels } from '../selector_tracker.mjs';

test('normalizes selector entries using publicName as the stable key', () => {
  const result = normalizeSelectorModels({
    uuid1: {
      id: 'uuid1',
      publicName: 'kiteki',
      displayName: 'qwen3.5-max-preview',
      organization: 'alibaba',
      userSelectable: true,
    },
    uuid2: {
      id: 'uuid2',
      publicName: 'gpt-5.5',
      displayName: 'gpt-5.5',
      organization: 'openai',
      userSelectable: true,
    },
  });

  assert.equal(Object.keys(result).length, 2);
  assert.equal(result.kiteki.aliasCandidate, true);
  assert.equal(result.kiteki.displayName, 'qwen3.5-max-preview');
  assert.equal(result['gpt-5.5'].aliasCandidate, false);
});

test('detects new aliases and mapping changes without false alerts from UUID rotation', () => {
  const previous = {
    kiteki: {
      id: 'uuid-old',
      publicName: 'kiteki',
      displayName: 'qwen3.5-max-preview',
      organization: 'alibaba',
      userSelectable: true,
      aliasCandidate: true,
    },
  };
  const current = {
    kiteki: {
      id: 'uuid-rotated',
      publicName: 'kiteki',
      displayName: 'qwen3.5-max',
      organization: 'alibaba',
      userSelectable: true,
      aliasCandidate: true,
    },
    'new-otter': {
      id: 'uuid-new',
      publicName: 'new-otter',
      displayName: 'gemma-next-preview',
      organization: 'google',
      userSelectable: true,
      aliasCandidate: true,
    },
  };

  const diff = diffSelectorModels(previous, current);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].publicName, 'new-otter');
  assert.equal(diff.mappingChanged.length, 1);
  assert.equal(diff.mappingChanged[0].after.publicName, 'kiteki');
  assert.equal(diff.selectableChanged.length, 0);
});

test('detects selectable-state changes for existing entries', () => {
  const previous = {
    'test-model': {
      id: 'id',
      publicName: 'test-model',
      displayName: 'test-model',
      userSelectable: true,
    },
  };
  const current = {
    'test-model': {
      id: 'id',
      publicName: 'test-model',
      displayName: 'test-model',
      userSelectable: false,
    },
  };

  const diff = diffSelectorModels(previous, current);
  assert.equal(diff.selectableChanged.length, 1);
  assert.equal(diff.selectableChanged[0].after.userSelectable, false);
});
