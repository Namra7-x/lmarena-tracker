/**
 * Early Signal Radar - Discord Webhook Notifier
 * Sends sleek, rich embed cards formatted with direct links, commit SHAs, model specs, and raw JSON blocks.
 */

import { RADAR_CONFIG } from './config.mjs';

/**
 * Builds a Discord embed for an Artificial Analysis new model release with a formatted JSON block.
 */
export function buildArtificialAnalysisEmbed(model) {
  const modelUrl = model.url || `https://artificialanalysis.ai/models/${model.releaseSlug || model.slug}`;
  const fields = [
    { name: 'Model Name', value: model.name, inline: true },
    { name: 'Slug Identifier', value: `\`${model.slug}\``, inline: true },
  ];

  if (model.creator) {
    fields.push({ name: 'Creator / Lab', value: model.creator, inline: true });
  }

  // Include JSON Code Block of the model's specs
  const rawSpecs = model.rawJson || {
    name: model.name,
    slug: model.slug,
    creator: model.creator || 'Unknown',
    parameters: model.parameters ? `${model.parameters}B` : undefined,
    contextWindow: model.contextWindowTokens ? `${model.contextWindowTokens.toLocaleString()} tokens` : undefined,
    isReasoning: model.isReasoning || undefined,
    pricing: model.price1mInput ? `$${model.price1mInput}/1M in, $${model.price1mOutput}/1M out` : undefined,
    speed: model.outputSpeed ? `${model.outputSpeed} tok/s` : undefined,
    releaseDate: model.releaseDate || undefined,
    weightsUrl: model.weightsUrl || undefined,
    url: modelUrl,
  };

  const jsonStr = JSON.stringify(rawSpecs, null, 2);
  fields.push({
    name: '📦 Model Specs (Raw JSON Block)',
    value: `\`\`\`json\n${jsonStr.slice(0, 950)}\n\`\`\``,
    inline: false,
  });

  fields.push({
    name: '🔗 Quick Links',
    value: `• [View Model Card on Artificial Analysis](${modelUrl})\n• [View Master Model Index](https://artificialanalysis.ai/models)`,
    inline: false,
  });

  return {
    title: `⚡ Artificial Analysis | New Model Indexed`,
    url: modelUrl,
    description: `**[${model.name}](${modelUrl})** has been added to the master index!`,
    color: RADAR_CONFIG.colors.artificialAnalysis,
    fields,
    footer: { text: 'Artificial Analysis Radar • Zero-Spam Tracker' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Builds a Discord embed for an Artificial Analysis new benchmark / evaluation.
 */
export function buildArtificialAnalysisBenchmarkEmbed(benchmark) {
  const benchmarkUrl = benchmark.url || `https://artificialanalysis.ai/evaluations/${benchmark.slug}`;
  const fields = [
    { name: 'Benchmark Name', value: benchmark.name, inline: true },
    { name: 'Slug Identifier', value: `\`${benchmark.slug}\``, inline: true },
    { name: 'Category', value: 'Evaluation / Benchmark', inline: true },
  ];

  const rawSpecs = benchmark.rawJson || {
    name: benchmark.name,
    slug: benchmark.slug,
    category: 'Evaluation Benchmark',
    url: benchmarkUrl,
  };

  const jsonStr = JSON.stringify(rawSpecs, null, 2);
  fields.push({
    name: '📊 Benchmark Specs (Raw JSON Block)',
    value: `\`\`\`json\n${jsonStr.slice(0, 950)}\n\`\`\``,
    inline: false,
  });

  fields.push({
    name: '🔗 Quick Links',
    value: `• [View Benchmark on Artificial Analysis](${benchmarkUrl})\n• [View All Evaluations](https://artificialanalysis.ai/evaluations)`,
    inline: false,
  });

  return {
    title: `📊 Artificial Analysis | New Benchmark Indexed`,
    url: benchmarkUrl,
    description: `**[${benchmark.name}](${benchmarkUrl})** has been added to Artificial Analysis evaluations!`,
    color: RADAR_CONFIG.colors.artificialAnalysis,
    fields,
    footer: { text: 'Artificial Analysis Radar • Benchmark Canary' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Builds a Discord embed for a ChatGPT web app production build deployment.
 */
export function buildChatGPTBuildEmbed(event) {
  const fields = [
    { name: 'Build Manifest Hash', value: `\`${event.manifestHash}\``, inline: true },
    { name: 'Previous Hash', value: `\`${event.prevHash || 'none'}\``, inline: true },
  ];

  if (event.totalChunks) {
    fields.push({ name: 'Dissected Chunks', value: `\`${event.totalChunks} chunks\``, inline: true });
  }

  // 1. HIGHEST PRIORITY: New Models detected in build
  if (event.models && event.models.length > 0) {
    const modelList = event.models.map((m) => `🔥 **\`${m}\`**`).join('\n');
    fields.unshift({ name: '⚡ Discovered Model Slugs', value: modelList, inline: false });
  }

  // 2. Feature Gates
  if (event.featureGates && event.featureGates.length > 0) {
    const preview = event.featureGates.slice(0, 6).map((g) => `\`${g}\``).join(', ');
    fields.push({
      name: `🚩 Feature Gates (${event.featureGates.length})`,
      value: preview,
      inline: false,
    });
  }

  // 3. Agentic Tools & MCP Schemas
  if (event.toolSchemas && event.toolSchemas.length > 0) {
    const preview = event.toolSchemas.slice(0, 6).map((t) => `\`${t}\``).join(', ');
    fields.push({
      name: `🛠️ Agentic Tools / MCP (${event.toolSchemas.length})`,
      value: preview,
      inline: false,
    });
  }

  // 4. Launch Copy
  if (event.launchCopy && event.launchCopy.length > 0) {
    fields.push({
      name: '📢 Launch Copy',
      value: `> "${event.launchCopy[0]}"`,
      inline: false,
    });
  }

  // 5. Quick Links
  const links = [
    `• [Open ChatGPT Web App](https://chatgpt.com/)`,
    `• [Inspect Raw Production Manifest](${event.manifestUrl})`,
  ];
  if (event.reportUrl) {
    links.push(`• [View Full 100% Unabridged Report on GitHub](${event.reportUrl})`);
  }
  fields.push({
    name: '🔗 Quick Links',
    value: links.join('\n'),
    inline: false,
  });

  return {
    title: `⚡ ChatGPT Web App | Production Build Deployed`,
    url: event.manifestUrl,
    description: `OpenAI pushed a new production build to [chatgpt.com](${RADAR_CONFIG.endpoints.chatgpt}).`,
    color: RADAR_CONFIG.colors.chatgpt,
    fields,
    footer: { text: 'ChatGPT Manifest Radar • Build Canary' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Builds a Discord embed for a Claude.ai web app build deployment.
 */
export function buildClaudeBuildEmbed(event) {
  const fields = [
    { name: 'Vite Entry Hash', value: `\`${event.entryHash}\``, inline: true },
    { name: 'Previous Hash', value: `\`${event.prevHash || 'none'}\``, inline: true },
  ];

  if (event.totalChunks) {
    fields.push({ name: 'Dissected Chunks', value: `\`${event.totalChunks} chunks\``, inline: true });
  }

  // 1. HIGHEST PRIORITY: New Models
  if (event.models && event.models.length > 0) {
    const modelList = event.models.map((m) => `🔥 **\`${m}\`**`).join('\n');
    fields.unshift({ name: '⚡ Discovered Model Slugs', value: modelList, inline: false });
  }

  // 2. Feature Gates
  if (event.featureGates && event.featureGates.length > 0) {
    const preview = event.featureGates.slice(0, 6).map((g) => `\`${g}\``).join(', ');
    fields.push({
      name: `🚩 Feature Gates (${event.featureGates.length})`,
      value: preview,
      inline: false,
    });
  }

  // 3. Agentic Tools & MCP Schemas
  if (event.toolSchemas && event.toolSchemas.length > 0) {
    const preview = event.toolSchemas.slice(0, 6).map((t) => `\`${t}\``).join(', ');
    fields.push({
      name: `🛠️ Agentic Tools / MCP (${event.toolSchemas.length})`,
      value: preview,
      inline: false,
    });
  }

  // 4. Quick Links
  const links = [
    `• [Open Claude Web App](https://claude.ai/)`,
    `• [Inspect Vite Entry Bundle](${event.entryUrl})`,
  ];
  if (event.reportUrl) {
    links.push(`• [View Full 100% Unabridged Report on GitHub](${event.reportUrl})`);
  }
  fields.push({
    name: '🔗 Quick Links',
    value: links.join('\n'),
    inline: false,
  });

  return {
    title: `⚡ Claude.ai | Production Build Deployed`,
    url: event.entryUrl,
    description: `Anthropic pushed a new production deployment to [claude.ai](${RADAR_CONFIG.endpoints.claude}).`,
    color: RADAR_CONFIG.colors.claude,
    fields,
    footer: { text: 'Claude Vite Radar • Build Canary' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Builds a Discord embed for an SDK Model Enum commit with direct GitHub links.
 */
export function buildSdkCommitEmbed(event) {
  const isAnthropic = event.repo.includes('anthropic');
  const labName = isAnthropic ? 'Anthropic' : 'OpenAI';
  const color = isAnthropic ? RADAR_CONFIG.colors.claude : RADAR_CONFIG.colors.chatgpt;

  const fileGithubUrl = `https://github.com/${event.repo}/blob/main/${event.filePath}`;
  const rawFileUrl = `https://raw.githubusercontent.com/${event.repo}/main/${event.filePath}`;
  const commitApiUrl = `https://api.github.com/repos/${event.repo}/commits?path=${encodeURIComponent(event.filePath)}&per_page=1`;

  const fields = [
    { name: 'Commit SHA', value: `[\`${event.shortSha}\`](${event.commitUrl})`, inline: true },
    { name: 'Author', value: event.author, inline: true },
    { name: 'File', value: `[\`${event.filePath}\`](${fileGithubUrl})`, inline: false },
    { name: 'Commit Message', value: `> ${event.message}`, inline: false },
  ];

  if (event.additions && event.additions.length > 0) {
    const preview = event.additions.slice(0, 8).map((l) => `🔥 **\`${l}\`**`).join('\n');
    fields.push({ name: '⚡ New Model Enum Additions', value: preview, inline: false });
  }

  // Direct Clickable GitHub Navigation Links
  fields.push({
    name: '🔗 Direct GitHub Links',
    value: [
      `• **[View Commit Diff on GitHub](${event.commitUrl})**`,
      `• **[View Source File on GitHub](${fileGithubUrl})**`,
      `• **[View Raw File](${rawFileUrl})**`,
      `• **[GitHub Commits API Endpoint](${commitApiUrl})**`,
    ].join('\n'),
    inline: false,
  });

  return {
    title: `⚡ ${labName} SDK | Model Enum Commit`,
    url: event.commitUrl,
    description: `A code-gen bot or core engineer committed to the **${labName}** model enum!`,
    color,
    fields,
    footer: { text: `${event.repo} • Ground-Zero Commit Radar` },
    timestamp: event.timestamp || new Date().toISOString(),
  };
}

/**
 * Builds a complete showcase containing 1 sample embed for every single radar category.
 * Features realistic 2026 frontier models with raw JSON blocks and direct GitHub links.
 */
export function buildRadarShowcaseEmbeds() {
  return [
    // 1. Artificial Analysis Model with JSON Block
    buildArtificialAnalysisEmbed({
      name: 'GPT-6 Astra (Max)',
      slug: 'gpt-6-astra',
      url: 'https://artificialanalysis.ai/models/gpt-6-astra',
      creator: 'OpenAI',
      parameters: 1800,
      contextWindowTokens: 2000000,
      isReasoning: true,
      price1mInput: 2.50,
      price1mOutput: 10.00,
      outputSpeed: 142,
      releaseDate: '2026-09-18',
      rawJson: {
        name: 'GPT-6 Astra (Max)',
        slug: 'gpt-6-astra',
        creator: 'OpenAI',
        parameters: '1,800B MoE',
        contextWindow: '2,000,000 tokens',
        isReasoning: true,
        pricing: '$2.50/1M in, $10.00/1M out',
        outputSpeed: '142 tok/s',
        releaseDate: '2026-09-18',
        license: 'Proprietary',
      },
    }),

    // 2. Artificial Analysis Benchmark with JSON Block
    buildArtificialAnalysisBenchmarkEmbed({
      name: 'Artificial Analysis Intelligence Index v5.0',
      slug: 'artificial-analysis-intelligence-index',
      url: 'https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index',
      rawJson: {
        name: 'Artificial Analysis Intelligence Index v5.0',
        slug: 'artificial-analysis-intelligence-index',
        category: 'Evaluation Benchmark',
        url: 'https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index',
      },
    }),

    // 2. ChatGPT Web App Build
    buildChatGPTBuildEmbed({
      manifestHash: 'e48d902a',
      prevHash: '1a91f86c',
      manifestUrl: 'https://chatgpt.com/cdn/assets/manifest-e48d902a.js',
      totalChunks: 6721,
      models: ['gpt-6.1-terra-preview', 'o4-mini-preview'],
      featureGates: ['can_see_autonomous_operator_v2', 'enable_terra_deep_routing', 'search_canvas_v3'],
      launchCopy: ['Introducing GPT-6.1 Terra: Frontier intelligence with native autonomous environment execution.'],
      reportUrl: 'https://github.com/Namra7-x/lmarena-tracker/blob/main/early-radar/reports/BUILD_chatgpt_e48d902a.md',
    }),

    // 3. Claude Web App Build
    buildClaudeBuildEmbed({
      entryHash: 'BlPlYMgx',
      prevHash: 'PYSO3vVA',
      entryUrl: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-BlPlYMgx.js',
      models: ['claude-5-5-opus-preview'],
      featureGates: ['can_see_computer_use_v3', 'enable_dynamic_thinking_budget'],
      reportUrl: 'https://github.com/Namra7-x/lmarena-tracker/blob/main/early-radar/reports/BUILD_claude_BlPlYMgx.md',
    }),

    // 4. OpenAI SDK Commit with Direct GitHub Links
    buildSdkCommitEmbed({
      repo: 'openai/openai-python',
      filePath: 'src/openai/types/shared/chat_model.py',
      sha: '4f82bc19a8234d',
      shortSha: '4f82bc1',
      author: 'Justin Beckwith',
      message: 'feat(models): add gpt-6.1-terra to ChatModel literal enum (#4310)',
      commitUrl: 'https://github.com/openai/openai-python/commit/4f82bc19a8234d',
      additions: ['"gpt-6.1-terra-preview"', '"o4-mini"'],
    }),

    // 5. Anthropic SDK Commit with Direct GitHub Links
    buildSdkCommitEmbed({
      repo: 'anthropics/anthropic-sdk-typescript',
      filePath: 'src/resources/messages/messages.ts',
      sha: '08e2e5ffa7566e',
      shortSha: '08e2e5f',
      author: 'anthropic-sdks-writer[bot]',
      message: 'feat(models): add claude-5-5-opus to Model type enum',
      commitUrl: 'https://github.com/anthropics/anthropic-sdk-typescript/commit/08e2e5ffa7566e',
      additions: ['"claude-5-5-opus-20261105"', '"claude-5-5-opus-latest"'],
    }),
  ];
}

/**
 * Sends embeds to the Discord webhook in batches of up to 10.
 */
export async function sendDiscordEmbeds(webhookUrl, embeds) {
  if (!webhookUrl || embeds.length === 0) return;

  const BATCH_SIZE = 10;
  for (let i = 0; i < embeds.length; i += BATCH_SIZE) {
    const batch = embeds.slice(i, i + BATCH_SIZE);
    const payload = {
      username: 'Early Signal Radar',
      avatar_url: 'https://raw.githubusercontent.com/google/material-design-icons/master/png/action/bolt/materialicons/48dp/2x/baseline_bolt_black_48dp.png',
      embeds: batch,
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`Discord webhook warning: HTTP ${res.status}: ${errText}`);
    } else {
      console.log(`[DISCORD] Successfully delivered ${batch.length} embed cards in 1 message.`);
    }
  }
}
