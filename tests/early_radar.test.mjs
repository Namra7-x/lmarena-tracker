/**
 * Early Signal Radar - Test Suite
 * Tests Artificial Analysis parsing, ChatGPT & Claude manifest extraction,
 * SDK commit diff parsing, deep build analyzer, and Discord embed builder.
 * Verifies ZERO HARDCODED MODEL NAMES.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { RADAR_CONFIG } from '../early-radar/config.mjs';
import { extractModelIdentifiersFromDiff } from '../early-radar/sources/sdk_commits.mjs';
import { extractDynamicModelIdentifiers } from '../early-radar/sources/chatgpt_manifest.mjs';
import { extractDynamicClaudeIdentifiers } from '../early-radar/sources/claude_manifest.mjs';
import { analyzeChunkContent, writeBuildReport } from '../early-radar/analyzer.mjs';
import {
  buildArtificialAnalysisEmbed,
  buildArtificialAnalysisBenchmarkEmbed,
  buildChatGPTBuildEmbed,
  buildClaudeBuildEmbed,
  buildSdkCommitEmbed,
} from '../early-radar/discord.mjs';
import { extractEscapedJson } from '../early-radar/sources/artificial_analysis.mjs';

describe('Early Radar Configuration', () => {
  it('should define all required endpoints and colors', () => {
    assert.ok(RADAR_CONFIG.endpoints.artificialAnalysis);
    assert.ok(RADAR_CONFIG.endpoints.chatgpt);
    assert.ok(RADAR_CONFIG.endpoints.claude);
    assert.ok(RADAR_CONFIG.endpoints.openaiSdkRepo);
    assert.ok(RADAR_CONFIG.endpoints.anthropicSdkRepo);

    assert.equal(typeof RADAR_CONFIG.colors.artificialAnalysis, 'number');
    assert.equal(typeof RADAR_CONFIG.colors.chatgpt, 'number');
    assert.equal(typeof RADAR_CONFIG.colors.claude, 'number');
  });

  it('should include EARLY_RADAR_DISCORD_WEBHOOK_URL in webhook env vars', () => {
    assert.ok(RADAR_CONFIG.webhookEnvVars.includes('EARLY_RADAR_DISCORD_WEBHOOK_URL'));
    assert.equal(RADAR_CONFIG.webhookEnvVars[0], 'EARLY_RADAR_DISCORD_WEBHOOK_URL');
  });
});

describe('Dynamic Model Extraction (Zero Hardcoded Names)', () => {
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

  it('should dynamically extract arbitrary model slugs from ChatGPT chunk JS', () => {
    const mockJs = `
      const config = {
        model_slug: "stealth-frontier-preview",
        default_model: "autonomous-coder-v1",
        timeout: 30000
      };
    `;

    const extracted = extractDynamicModelIdentifiers(mockJs);
    assert.ok(extracted.includes('stealth-frontier-preview'));
    assert.ok(extracted.includes('autonomous-coder-v1'));
    assert.equal(extracted.length, 2);
  });

  it('should dynamically extract arbitrary model IDs from Claude chunk JS', () => {
    const mockJs = `
      function getModel() {
        return { modelId: "secret-hybrid-agent-77", isDefault: true };
      }
    `;

    const extracted = extractDynamicClaudeIdentifiers(mockJs);
    assert.deepEqual(extracted, ['secret-hybrid-agent-77']);
  });
});

describe('Deep Build Analyzer & Reports', () => {
  it('should extract feature gates, tools, launch copy, and models from chunk text', () => {
    const mockChunk = `
      const gates = ["can_see_autonomous_tasks", "enable_deep_reasoning_v2"];
      const tool = { name: "terminal_sandbox_action" };
      const banner = "Introducing Project Titan: A new paradigm in reasoning";
      const settings = { model_slug: "titan-preview" };
    `;

    const analysis = analyzeChunkContent(mockChunk);
    assert.ok(analysis.models.includes('titan-preview'));
    assert.ok(analysis.featureGates.includes('can_see_autonomous_tasks'));
    assert.ok(analysis.featureGates.includes('enable_deep_reasoning_v2'));
    assert.ok(analysis.toolSchemas.includes('terminal_sandbox_action'));
    assert.ok(analysis.launchCopy.some((c) => c.includes('Introducing Project Titan')));
  });

  it('should generate a permanent markdown report file without errors', () => {
    const analysis = {
      models: ['titan-preview'],
      featureGates: ['can_see_autonomous_tasks'],
      toolSchemas: ['terminal_sandbox_action'],
      launchCopy: ['Introducing Project Titan'],
    };

    const url = writeBuildReport('ChatGPT', 'test1234', analysis);
    assert.ok(url.includes('BUILD_chatgpt_test1234.md'));

    // Clean up test report file
    const testReportPath = path.join(__dirname, '../early-radar/reports/BUILD_chatgpt_test1234.md');
    if (fs.existsSync(testReportPath)) {
      fs.unlinkSync(testReportPath);
    }
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
    assert.ok(embed.title.includes('Artificial Analysis'));
    assert.equal(embed.color, RADAR_CONFIG.colors.artificialAnalysis);
    assert.ok(embed.fields.some((f) => f.name.includes('Raw JSON Block')));
    const jsonField = embed.fields.find((f) => f.name.includes('Raw JSON Block'));
    assert.ok(jsonField.value.includes('```json'));
    assert.ok(jsonField.value.includes('arbitrary-new-model'));
  });

  it('should build rich embed for ChatGPT web app build deployment with detected models', () => {
    const event = {
      manifestHash: '1a91f86c',
      prevHash: 'old99999',
      manifestUrl: 'https://chatgpt.com/cdn/assets/manifest-1a91f86c.js',
      totalChunks: 6721,
      models: ['titan-preview'],
      featureGates: ['can_see_autonomous_tasks'],
      launchCopy: ['Introducing Project Titan'],
      reportUrl: 'https://github.com/Namra7-x/lmarena-tracker/blob/main/early-radar/reports/BUILD_chatgpt_1a91f86c.md',
    };
    const embed = buildChatGPTBuildEmbed(event);
    assert.ok(embed.title.includes('ChatGPT Web App'));
    assert.equal(embed.color, RADAR_CONFIG.colors.chatgpt);
    assert.ok(embed.fields.some((f) => f.name.includes('Discovered Model Slugs')));
    assert.ok(embed.fields.some((f) => f.name.includes('Feature Gates')));
    assert.ok(embed.fields.some((f) => f.name.includes('Quick Links') && f.value.includes('Unabridged Report')));
  });

  it('should build rich embed for Claude web app build deployment', () => {
    const event = {
      entryHash: 'PYSO3vVA',
      prevHash: 'OLDHASH1',
      entryUrl: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-PYSO3vVA.js',
      models: ['claude-4-preview'],
      featureGates: ['can_see_computer_use_v2'],
    };
    const embed = buildClaudeBuildEmbed(event);
    assert.ok(embed.title.includes('Claude.ai'));
    assert.equal(embed.color, RADAR_CONFIG.colors.claude);
    assert.ok(embed.fields.some((f) => f.name.includes('Discovered Model Slugs')));
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
    assert.equal(embed.color, RADAR_CONFIG.colors.chatgpt);
    assert.ok(embed.fields.some((f) => f.name.includes('Model Enum Additions')));
    assert.ok(embed.fields.some((f) => f.name.includes('Direct GitHub Links')));

    const linksField = embed.fields.find((f) => f.name.includes('Direct GitHub Links'));
    assert.ok(linksField.value.includes('View Commit Diff on GitHub'));
    assert.ok(linksField.value.includes('View Source File on GitHub'));
    assert.ok(linksField.value.includes('GitHub Commits API Endpoint'));
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
