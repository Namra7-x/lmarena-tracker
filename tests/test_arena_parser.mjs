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


test('does not mistake a later unrelated array for initialModels when it is undefined', () => {
  const html = makeRscHtml({
    initialModels: '$undefined',
    unrelated: [{ id: 'not-a-model-registry', publicName: 'Fake component item' }],
    agentPareto: {
      entries: [{
        modelKey: 'stealth-codename-example',
        modelDisplayName: 'Stealth Candidate',
        rank: 1,
        votes: 12,
      }],
    },
  });

  const models = parseModelsFromHtml(html);
  assert.deepEqual(Object.keys(models), ['stealth-codename-example']);
  assert.equal(models['stealth-codename-example'].displayName, 'Stealth Candidate');
  assert.equal(getSnapshotSchema(models), LEADERBOARD_SCHEMA_ID);
});


test('extracts Agent leaderboard contenderName/model rows and preserves agent metrics', () => {
  const html = makeRscHtml({
    agentRanking: {
      modelCount: 2,
      rows: [
        {
          rank: 1,
          contenderName: 'contenders/claude-opus-5.5-high-vertex-agent',
          model: 'Claude Opus 5.5 (High)',
          modelOrganization: 'Anthropic',
          license: 'Proprietary',
          netImprovement: 0.1433,
          confirmedSuccess: 0.1393,
          sessions: 6103,
          costPerTaskP50: 1.79,
          outputTokensPerTaskP50: 29200,
        },
        {
          rank: 2,
          contenderName: 'contenders/gpt-6-astra-max-agent',
          model: 'GPT 6 Astra (Max)',
          modelOrganization: 'OpenAI',
          netImprovement: 0.1309,
          sessions: 12029,
        },
      ],
    },
    initialModels: '$undefined',
  });

  const models = parseModelsFromHtml(html);
  const agent = models['contenders/claude-opus-5.5-high-vertex-agent'];
  assert.ok(agent);
  assert.equal(agent.displayName, 'Claude Opus 5.5 (High)');
  assert.equal(agent.organization, 'Anthropic');
  assert.equal(agent.rank, 1);
  assert.equal(agent.rating, 0.1433);
  assert.equal(agent.votes, 6103);
  assert.equal(agent.netImprovement, 0.1433);
  assert.equal(agent.costPerTaskP50, 1.79);
  assert.equal(Object.keys(models).length, 2);
});

test('rejects HTML with no recognizable model records', () => {
  assert.throws(() => parseModelsFromHtml('<html><body>no model data</body></html>'), /No model records found/);
});
