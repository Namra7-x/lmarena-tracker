import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSnapshotSchema,
  hasArenaModelPayload,
  parseModelsFromHtml,
  LEADERBOARD_SCHEMA_ID,
  LEGACY_SCHEMA_ID,
} from '../arena_parser.mjs';

function makeRscHtml(data) {
  const chunk = '0:' + JSON.stringify(data);
  return '<script>self.__next_f.push([1,' + JSON.stringify(chunk) + '])</script>';
}

test('extracts current Arena modelKey/modelDisplayName rows from streamed RSC data', () => {
  const html = makeRscHtml({
    agentPareto: {
      costWindowDays: 14,
      entries: [
        {
          rank: 7,
          modelKey: 'contenders/barium-bb-v2-4xts-agent',
          modelDisplayName: 'Gemini 4 Argon (High)',
          rating: 0.092,
          votes: 4000,
        },
        {
          rank: 2,
          modelKey: 'contenders/kivine-wxzc-agent',
          modelDisplayName: 'Kimi K3 (Max)',
          rating: 0.08,
          votes: 2000,
        },
      ],
    },
  });

  assert.equal(hasArenaModelPayload(html), true);
  const models = parseModelsFromHtml(html);
  assert.equal(Object.keys(models).length, 2);
  assert.equal(models['contenders/barium-bb-v2-4xts-agent'].displayName, 'Gemini 4 Argon (High)');
  assert.equal(models['contenders/barium-bb-v2-4xts-agent'].id, 'contenders/barium-bb-v2-4xts-agent');
  assert.equal(models['contenders/barium-bb-v2-4xts-agent'].rank, 7);
  assert.equal(models['contenders/barium-bb-v2-4xts-agent'].userSelectable, null);
  assert.equal(getSnapshotSchema(models), LEADERBOARD_SCHEMA_ID);
});

test('deduplicates a model repeated across leaderboard sections', () => {
  const html = makeRscHtml({
    textArena: {
      entries: [
        {
          rank: 9,
          modelKey: 'contenders/shared-model-agent',
          modelDisplayName: 'Shared Model',
          votes: 100,
        },
      ],
    },
    agentPareto: {
      entries: [
        {
          rank: 3,
          modelKey: 'contenders/shared-model-agent',
          modelDisplayName: 'Shared Model',
          votes: 900,
        },
      ],
    },
  });

  const models = parseModelsFromHtml(html);
  assert.equal(Object.keys(models).length, 1);
  assert.equal(models['contenders/shared-model-agent'].rank, 3);
  assert.equal(models['contenders/shared-model-agent'].votes, 900);
});

test('keeps compatibility with legacy initialModels arrays', () => {
  const html = makeRscHtml({
    initialModels: [
      {
        id: 'legacy-model-id',
        publicName: 'legacy-model',
        displayName: 'Legacy Model',
        organization: 'example-org',
      },
    ],
  });

  const models = parseModelsFromHtml(html);
  assert.equal(models['legacy-model-id'].displayName, 'Legacy Model');
  assert.equal(getSnapshotSchema(models), LEGACY_SCHEMA_ID);
});

test('rejects HTML with no recognizable model records', () => {
  assert.throws(() => parseModelsFromHtml('<html><body>no model data</body></html>'), /No model records found/);
});
