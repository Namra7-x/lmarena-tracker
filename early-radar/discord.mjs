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
 * Sends embeds to the Discord webhook in batches of up to 10.
 */
export async function sendDiscordEmbeds(webhookUrl, embeds) {
  if (!webhookUrl || embeds.length === 0) return;

  const BATCH_SIZE = 10;
  for (let i = 0; i < BATCH_SIZE && i < embeds.length; i += BATCH_SIZE) {
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
    }
  }
}
