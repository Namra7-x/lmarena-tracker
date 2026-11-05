/**
 * Early Signal Radar - Discord Webhook Notifier
 * Sends sleek, rich embed cards formatted with direct links, commit SHAs, and model specs.
 */

import { RADAR_CONFIG } from './config.mjs';

/**
 * Builds a Discord embed for an Artificial Analysis new model release.
 */
export function buildArtificialAnalysisEmbed(model) {
  return {
    title: `⚡ Artificial Analysis | New Model Indexed`,
    url: model.url,
    description: `**[${model.name}](${model.url})** has been added to the master index!`,
    color: RADAR_CONFIG.colors.artificialAnalysis,
    fields: [
      { name: 'Model Name', value: model.name, inline: true },
      { name: 'Slug Identifier', value: `\`${model.slug}\``, inline: true },
    ],
    footer: { text: 'Artificial Analysis Radar • Zero-Spam Tracker' },
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

  // 3. Launch Copy
  if (event.launchCopy && event.launchCopy.length > 0) {
    fields.push({
      name: '📢 Launch Copy',
      value: `> "${event.launchCopy[0]}"`,
      inline: false,
    });
  }

  // 4. Link to Full Report
  if (event.reportUrl) {
    fields.push({
      name: '📄 Unabridged Full Report',
      value: `[View all extracted signals on GitHub](${event.reportUrl})`,
      inline: false,
    });
  }

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

  // 3. Link to Full Report
  if (event.reportUrl) {
    fields.push({
      name: '📄 Unabridged Full Report',
      value: `[View all extracted signals on GitHub](${event.reportUrl})`,
      inline: false,
    });
  }

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
 * Builds a Discord embed for an SDK Model Enum commit.
 */
export function buildSdkCommitEmbed(event) {
  const isAnthropic = event.repo.includes('anthropic');
  const labName = isAnthropic ? 'Anthropic' : 'OpenAI';
  const color = isAnthropic ? RADAR_CONFIG.colors.claude : RADAR_CONFIG.colors.chatgpt;

  const fields = [
    { name: 'Commit SHA', value: `[\`${event.shortSha}\`](${event.commitUrl})`, inline: true },
    { name: 'Author', value: event.author, inline: true },
    { name: 'File', value: `\`${event.filePath}\``, inline: false },
    { name: 'Message', value: event.message, inline: false },
  ];

  if (event.additions && event.additions.length > 0) {
    const preview = event.additions.slice(0, 8).map((l) => `🔥 **\`${l}\`**`).join('\n');
    fields.push({ name: '⚡ New Model Enum Additions', value: preview, inline: false });
  }

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
 * Delivered together in one single Discord message (all 5 cards in 1 message).
 */
export function buildRadarShowcaseEmbeds() {
  return [
    // 1. Artificial Analysis
    buildArtificialAnalysisEmbed({
      name: 'DeepSeek-V4 Flash',
      slug: 'deepseek-v4-flash',
      url: 'https://artificialanalysis.ai/models/deepseek-v4-flash',
    }),

    // 2. ChatGPT Web App Build
    buildChatGPTBuildEmbed({
      manifestHash: 'e48d902a',
      prevHash: '1a91f86c',
      manifestUrl: 'https://chatgpt.com/cdn/assets/manifest-e48d902a.js',
      totalChunks: 6721,
      models: ['stealth-reasoner-v1', 'gpt-5-preview'],
      featureGates: ['can_see_autonomous_tasks', 'enable_deep_research_v2', 'search_routing_v3'],
      launchCopy: ['Introducing Autonomous Tasks: Execute multi-step agentic workflows directly in ChatGPT.'],
      reportUrl: 'https://github.com/Namra7-x/lmarena-tracker/blob/feat/early-radar/early-radar/reports/BUILD_chatgpt_e48d902a.md',
    }),

    // 3. Claude Web App Build
    buildClaudeBuildEmbed({
      entryHash: 'BlPlYMgx',
      prevHash: 'PYSO3vVA',
      entryUrl: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-BlPlYMgx.js',
      models: ['claude-3-7-sonnet-preview'],
      featureGates: ['can_see_computer_use_v2', 'enable_thinking_budget_slider'],
      reportUrl: 'https://github.com/Namra7-x/lmarena-tracker/blob/feat/early-radar/early-radar/reports/BUILD_claude_BlPlYMgx.md',
    }),

    // 4. OpenAI SDK Commit
    buildSdkCommitEmbed({
      repo: 'openai/openai-python',
      filePath: 'src/openai/types/shared/chat_model.py',
      sha: '4f82bc19a8234d',
      shortSha: '4f82bc1',
      author: 'Justin Beckwith',
      message: 'feat(models): add stealth-reasoner-v1 to ChatModel literal enum (#4250)',
      commitUrl: 'https://github.com/openai/openai-python/commit/4f82bc19a8234d',
      additions: ['"stealth-reasoner-v1"', '"gpt-5-preview"'],
    }),

    // 5. Anthropic SDK Commit
    buildSdkCommitEmbed({
      repo: 'anthropics/anthropic-sdk-typescript',
      filePath: 'src/resources/messages/messages.ts',
      sha: '08e2e5ffa7566e',
      shortSha: '08e2e5f',
      author: 'anthropic-sdks-writer[bot]',
      message: 'feat(models): add claude-3-7-sonnet to Model type enum',
      commitUrl: 'https://github.com/anthropics/anthropic-sdk-typescript/commit/08e2e5ffa7566e',
      additions: ['"claude-3-7-sonnet-20260219"', '"claude-3-7-sonnet-latest"'],
    }),
  ];
}

/**
 * Sends embeds to the Discord webhook in batches of up to 10 (all 5 cards in 1 message).
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
