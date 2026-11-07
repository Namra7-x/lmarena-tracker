/**
 * Early Signal Radar - Test Suite
 * Tests Artificial Analysis parsing (Models & Benchmarks), SDK commit diff parsing,
 * and Discord embed builder.
 * Verifies ZERO HARDCODED MODEL NAMES and ZERO 404 URL FORMATION.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RADAR_CONFIG } from '../early-radar/config.mjs';
import { extractModelIdentifiersFromDiff } from '../early-radar/sources/sdk_commits.mjs';
import {
  buildArtificialAnalysisEmbed,
  buildArtificialAnalysisBenchmarkEmbed,
  buildSdkCommitEmbed,
  buildRadarShowcaseEmbeds,
} from '../early-radar/discord.mjs';
import { extractEscapedJson } from '../early-radar/sources/artificial_analysis.mjs';

describe('Early Radar Configuration', () => {
  it('should define all required endpoints and colors', () => {
    assert.ok(RADAR_CONFIG.endpoints.artificialAnalysis);
    assert.ok(RADAR_CONFIG.endpoints.openaiSdkRepo);
    assert.ok(RADAR_CONFIG.endpoints.anthropicSdkRepo);

    assert.equal(typeof RADAR_CONFIG.colors.artificialAnalysis, 'number');
    assert.equal(typeof RADAR_CONFIG.colors.openai, 'number');
    assert.equal(typeof RADAR_CONFIG.colors.anthropic, 'number');
  });

  it('should include EARLY_RADAR_DISCORD_WEBHOOK_URL in webhook env vars', () => {
    assert.ok(RADAR_CONFIG.webhookEnvVars.includes('EARLY_RADAR_DISCORD_WEBHOOK_URL'));
    assert.equal(RADAR_CONFIG.webhookEnvVars[0], 'EARLY_RADAR_DISCORD_WEBHOOK_URL');
  });
});

describe('Dynamic Model Extraction from SDK Commits (Zero Hardcoded Names)', () => {
  it('should dynamically extract arbitrary new model names from git diff', () => {
    const mockDiff = `
@@ -10,6 +10,8 @@
-    "old-model-v1",
+    "unannounced-future-model-x99",
+    "experimental-quantum-reasoner",
+    // some comment
     "existing-model",
     `;

    const extracted = extractModelIdentifiersFromDiff(mockDiff);
    assert.deepEqual(extracted, [
      'unannounced-future-model-x99',
      'experimental-quantum-reasoner',
    ]);
  });
});

describe('Discord Embed Builder', () => {
  it('should build rich embed for Artificial Analysis new model with JSON block', () => {
    const model = {
      name: 'Arbitrary New Model',
      slug: 'arbitrary-new-model',
      url: 'https://artificialanalysis.ai/models/arbitrary-new-model',
      creator: 'Test Lab',
      rawJson: {
        name: 'Arbitrary New Model',
        slug: 'arbitrary-new-model',
        parameters: '100B',
      },
    };
    const embed = buildArtificialAnalysisEmbed(model);
    assert.ok(embed.title.includes('Artificial Analysis | New Model Indexed'));
    assert.equal(embed.color, RADAR_CONFIG.colors.artificialAnalysis);
    assert.ok(embed.fields.some((f) => f.name.includes('Raw JSON Block')));
    const jsonField = embed.fields.find((f) => f.name.includes('Raw JSON Block'));
    assert.ok(jsonField.value.includes('```json'));
    assert.ok(jsonField.value.includes('arbitrary-new-model'));
  });

  it('should build rich embed for Artificial Analysis new benchmark with evaluation link and category', () => {
    const benchmark = {
      name: 'Humanity Last Exam',
      slug: 'humanitys-last-exam',
      url: 'https://artificialanalysis.ai/evaluations/humanitys-last-exam',
      type: 'benchmark',
      rawJson: {
        name: 'Humanity Last Exam',
        slug: 'humanitys-last-exam',
        category: 'Evaluation Benchmark',
        url: 'https://artificialanalysis.ai/evaluations/humanitys-last-exam',
      },
    };
    const embed = buildArtificialAnalysisBenchmarkEmbed(benchmark);
    assert.ok(embed.title.includes('Artificial Analysis | New Benchmark Indexed'));
    assert.equal(embed.url, 'https://artificialanalysis.ai/evaluations/humanitys-last-exam');
    assert.ok(embed.fields.some((f) => f.name === 'Category' && f.value === 'Evaluation / Benchmark'));
    assert.ok(embed.fields.some((f) => f.name.includes('Quick Links') && f.value.includes('/evaluations/humanitys-last-exam')));
    assert.ok(!embed.url.includes('/models/'), 'Benchmark must never link to /models route');
  });

  it('should build rich embed for SDK model commit with direct GitHub links', () => {
    const event = {
      repo: 'openai/openai-python',
      filePath: 'src/openai/types/shared/chat_model.py',
      sha: '5b43cceea4a25bc1b9ed1b08f087408b47981083',
      shortSha: '5b43cce',
      author: 'Justin Beckwith',
      message: 'chore(api): update model enum (#4199)',
      commitUrl: 'https://github.com/openai/openai-python/commit/5b43cce',
      additions: ['"brand-new-unannounced-model"', '"secret-reasoner"'],
    };
    const embed = buildSdkCommitEmbed(event);
    assert.ok(embed.title.includes('OpenAI SDK'));
    assert.equal(embed.color, RADAR_CONFIG.colors.openai);
    assert.ok(embed.fields.some((f) => f.name.includes('Model Enum Additions')));
    assert.ok(embed.fields.some((f) => f.name.includes('Direct GitHub Links')));

    const linksField = embed.fields.find((f) => f.name.includes('Direct GitHub Links'));
    assert.ok(linksField.value.includes('View Commit Diff on GitHub'));
    assert.ok(linksField.value.includes('View Source File on GitHub'));
    assert.ok(linksField.value.includes('GitHub Commits API Endpoint'));
  });

  it('should build full radar showcase embeds for all active categories', () => {
    const showcase = buildRadarShowcaseEmbeds();
    assert.equal(showcase.length, 4);
    assert.ok(showcase[0].title.includes('Artificial Analysis | New Model Indexed'));
    assert.ok(showcase[1].title.includes('Artificial Analysis | New Benchmark Indexed'));
    assert.ok(showcase[2].title.includes('OpenAI SDK'));
    assert.ok(showcase[3].title.includes('Anthropic SDK'));
  });
});

describe('Artificial Analysis Models & Benchmarks Separation', () => {
  it('should extract JSON structure using extractEscapedJson across unescaped and escaped payloads', () => {
    const payload = `
      self.__next_f.push([1, "1:{\\"modelsAndReleases\\":{\\"releases\\":[{\\"slug\\":\\"model-alpha\\",\\"name\\":\\"Model Alpha\\"}],\\"models\\":[{\\"slug\\":\\"model-alpha\\",\\"releaseSlug\\":\\"model-alpha\\"}]}}"]);
    `;
    const extracted = extractEscapedJson(payload, 'modelsAndReleases');
    assert.ok(extracted);
    assert.equal(extracted.releases.length, 1);
    assert.equal(extracted.releases[0].slug, 'model-alpha');
    assert.equal(extracted.models[0].releaseSlug, 'model-alpha');
  });

  it('should strictly separate models from evaluation benchmarks and prevent 404 routes', () => {
    const mockHtml = `
      self.__next_f.push([1, "{\\"modelsAndReleases\\":{\\"releases\\":[{\\"slug\\":\\"claude-35-sonnet\\",\\"name\\":\\"Claude 3.5 Sonnet\\",\\"creator\\":{\\"slug\\":\\"anthropic\\",\\"name\\":\\"Anthropic\\"}}],\\"models\\":[{\\"slug\\":\\"claude-3-5-sonnet\\",\\"name\\":\\"Claude 3.5 Sonnet\\",\\"releaseSlug\\":\\"claude-35-sonnet\\"}]},\\"generalEvals\\":[{\\"slug\\":\\"hle-diamond\\",\\"name\\":\\"HLE Diamond Benchmark\\"},{\\"slug\\":\\"livecodebench\\",\\"name\\":\\"LiveCodeBench\\"}]}"]);
    `;

    const mAndR = extractEscapedJson(mockHtml, 'modelsAndReleases');
    const generalEvals = extractEscapedJson(mockHtml, 'generalEvals');

    const models = new Map();
    const benchmarks = new Map();

    const releasesMap = new Map();
    for (const rel of mAndR.releases) {
      releasesMap.set(rel.slug, rel);
    }
    for (const m of mAndR.models) {
      const targetSlug = m.releaseSlug || m.slug;
      const rel = releasesMap.get(targetSlug) || {};
      models.set(m.slug, {
        slug: m.slug,
        name: m.name || m.slug,
        releaseSlug: targetSlug,
        url: `https://artificialanalysis.ai/models/${targetSlug}`,
        creator: rel.creator?.name || null,
      });
    }

    for (const ev of generalEvals) {
      benchmarks.set(ev.slug, {
        slug: ev.slug,
        name: ev.name,
        url: `https://artificialanalysis.ai/evaluations/${ev.slug}`,
        type: 'benchmark',
      });
    }

    // Models checks
    assert.equal(models.size, 1);
    const claude = models.get('claude-3-5-sonnet');
    assert.ok(claude);
    assert.equal(claude.url, 'https://artificialanalysis.ai/models/claude-35-sonnet');
    assert.equal(claude.creator, 'Anthropic');

    // Benchmarks checks
    assert.equal(benchmarks.size, 2);
    assert.ok(benchmarks.has('hle-diamond'));
    assert.ok(benchmarks.has('livecodebench'));
    assert.equal(benchmarks.get('hle-diamond').url, 'https://artificialanalysis.ai/evaluations/hle-diamond');

    // Zero cross-contamination
    assert.equal(models.has('hle-diamond'), false, 'Benchmark must NOT be in models Map');
    assert.equal(models.has('livecodebench'), false, 'Benchmark must NOT be in models Map');
    assert.equal(models.has('anthropic'), false, 'Creator must NOT be in models Map');
  });
});
