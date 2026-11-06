/**
 * Discord Webhook Client with Rich Embed Formatter
 * Formats Hugging Face release events into clean, high-signal Discord cards.
 */

import { LABS } from './config.mjs';

const HF_LOGO = 'https://huggingface.co/front/assets/huggingface_logo-noborder.png';

const EVENT_STYLES = {
  NEW_MODEL: {
    label: '🚨 NEW MODEL RELEASE',
    color: 0x10B981, // Emerald Green
    badge: '📦 Model'
  },
  NEW_SPACE: {
    label: '🎮 NEW SPACE / LIVE DEMO',
    color: 0x8B5CF6, // Purple
    badge: '🚀 Space'
  },
  NEW_COLLECTION: {
    label: '📁 NEW COLLECTION CREATED',
    color: 0x3B82F6, // Blue
    badge: '📚 Collection'
  },
  COLLECTION_UPDATED: {
    label: '✨ COLLECTION EXPANDED',
    color: 0x6366F1, // Indigo
    badge: '📚 Collection Update'
  },
  WEIGHTS_UPDATED: {
    label: '⚡ WEIGHTS / COMMITS UPDATED',
    color: 0xF59E0B, // Amber
    badge: '🔄 Update'
  },
  GATING_CHANGED: {
    label: '🔓 ACCESS STATUS CHANGED',
    color: 0x14B8A6, // Teal
    badge: '🔑 Gating'
  }
};

/**
 * Builds a single Discord embed object for an event
 */
export function buildEmbed(event) {
  const { type, org, item, details } = event;
  const lab = LABS[org] || { name: org, avatar: HF_LOGO, category: 'AI Lab' };
  const style = EVENT_STYLES[type] || {
    label: '📢 HUGGING FACE UPDATE',
    color: lab.color || 0x5865F2,
    badge: 'Release'
  };

  const isCollection = type === 'NEW_COLLECTION' || type === 'COLLECTION_UPDATED';
  const isSpace = type === 'NEW_SPACE';
  
  const title = isCollection
    ? `${item.title || item.slug}`
    : `${item.id}`;

  const targetUrl = isCollection
    ? `https://huggingface.co/collections/${item.slug}`
    : (isSpace
      ? `https://huggingface.co/spaces/${item.id}`
      : `https://huggingface.co/${item.id}`);

  const fields = [];

  // Resource / Type Field
  fields.push({
    name: '📂 Resource Type',
    value: `\`${style.badge}\``,
    inline: true
  });

  // Task / Pipeline or SDK Field
  if (item.pipeline_tag) {
    fields.push({
      name: '🏷️ Task',
      value: `\`${item.pipeline_tag}\``,
      inline: true
    });
  } else if (item.sdk) {
    fields.push({
      name: '⚙️ App SDK',
      value: `\`${item.sdk}\``,
      inline: true
    });
  }

  // Access status
  if (type === 'GATING_CHANGED') {
    fields.push({
      name: '🔓 Access Change',
      value: details?.change || (item.gated ? '🔒 Gated' : '🌐 Public / Open Weights'),
      inline: true
    });
  } else if (item.gated !== undefined) {
    fields.push({
      name: '🔒 Access',
      value: item.gated ? '🔒 Gated Form' : '🌐 Open Weights',
      inline: true
    });
  }

  // Collection Items count
  if (isCollection && item.items) {
    fields.push({
      name: '📚 Items Count',
      value: `${item.items.length} models/papers`,
      inline: true
    });
  }

  // Exact list of newly added items for collection updates
  if (type === 'COLLECTION_UPDATED' && details?.addedItems && details.addedItems.length > 0) {
    const addedList = details.addedItems
      .slice(0, 5)
      .map((i) => `• [${i.id}](https://huggingface.co/${i.id})`)
      .join('\n');
    fields.push({
      name: '➕ Newly Added Models',
      value: addedList + (details.addedItems.length > 5 ? `\n...and ${details.addedItems.length - 5} more` : ''),
      inline: false
    });
  } else if (type === 'NEW_COLLECTION' && details?.items && details.items.length > 0) {
    const includedList = details.items
      .slice(0, 5)
      .map((i) => `• [${i.id}](https://huggingface.co/${i.id})`)
      .join('\n');
    fields.push({
      name: '📦 Included Models',
      value: includedList + (details.items.length > 5 ? `\n...and ${details.items.length - 5} more` : ''),
      inline: false
    });
  }

  // Quick Action Links
  const quickLinks = [];
  if (isCollection) {
    quickLinks.push(`[Open Collection](${targetUrl})`);
    quickLinks.push(`[All ${lab.name} Collections](https://huggingface.co/collections/${org})`);
  } else if (isSpace) {
    quickLinks.push(`[Open Space Demo](${targetUrl})`);
    quickLinks.push(`[View Code](${targetUrl}/tree/main)`);
  } else {
    quickLinks.push(`[Model Card](${targetUrl})`);
    quickLinks.push(`[Files & Weights](${targetUrl}/tree/main)`);
    quickLinks.push(`[Config JSON](${targetUrl}/raw/main/config.json)`);
  }

  fields.push({
    name: '🔗 Quick Links',
    value: quickLinks.join(' • '),
    inline: false
  });

  // Description
  let description = `**${lab.name}** published a new ${style.badge.toLowerCase()} to Hugging Face.`;
  if (details?.summary) {
    description = details.summary;
  } else if (item.description) {
    description = item.description.length > 250
      ? item.description.slice(0, 247) + '...'
      : item.description;
  }

  return {
    author: {
      name: `${lab.name} • ${lab.category}`,
      url: `https://huggingface.co/${org}`,
      icon_url: lab.avatar || HF_LOGO
    },
    title: `${style.label}: ${title}`,
    url: targetUrl,
    description,
    color: style.color,
    fields,
    thumbnail: {
      url: lab.avatar || HF_LOGO
    },
    footer: {
      text: `Hugging Face Signal Tracker • Org: ${org}`,
      icon_url: HF_LOGO
    },
    timestamp: new Date().toISOString()
  };
}

/**
 * Sends a list of embeds to the Discord Webhook URL.
 * Bundles up to 10 embeds per message to maintain Discord rate limits.
 */
export async function sendDiscordAlerts(
  events,
  webhookUrl = (process.env.HF_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL)
) {
  if (!webhookUrl) {
    console.warn('[HF Tracker] No DISCORD_WEBHOOK_URL configured. Skipping Discord alert dispatch.');
    return { sent: 0, skipped: events.length };
  }

  if (!events || events.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  const embeds = events.map(buildEmbed);
  const CHUNK_SIZE = 10;
  let sentCount = 0;

  for (let i = 0; i < embeds.length; i += CHUNK_SIZE) {
    const chunk = embeds.slice(i, i + CHUNK_SIZE);
    const payload = {
      username: 'Hugging Face Radar',
      avatar_url: HF_LOGO,
      embeds: chunk
    };

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[HF Tracker] Discord webhook failed (${res.status}): ${errText}`);
      } else {
        sentCount += chunk.length;
      }
    } catch (err) {
      console.error(`[HF Tracker] Failed to send Discord webhook:`, err.message);
    }

    // Gentle delay between chunks to respect Discord rate limits
    if (i + CHUNK_SIZE < embeds.length) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  return { sent: sentCount, total: events.length };
}
