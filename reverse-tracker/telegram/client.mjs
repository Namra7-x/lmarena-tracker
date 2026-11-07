/**
 * Telegram API Client (Section 8)
 * Handles sending alerts, edits, document uploads, and rate limit backoff (429).
 */

import fs from 'node:fs';
import path from 'node:path';

export class TelegramClient {
  constructor(token, chatId, family = null, componentId = null) {
    this.family = family;
    this.componentId = componentId;
    this.token = this.resolveToken(token, family, componentId);
    this.chatId = this.resolveChatId(chatId, family, componentId);
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
  }

  resolveToken(explicitToken, family, componentId = null) {
    if (explicitToken && typeof explicitToken === 'string' && explicitToken.trim()) {
      return explicitToken.trim();
    }
    const candidates = [];

    // Component-level tokens (e.g. OpenCode CLI, Droid CLI)
    if (componentId) {
      const compUpper = componentId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      if (compUpper.includes('OPENCODE')) {
        candidates.push('TELEGRAM_TOKEN_OPENCODE', 'TELEGRAM_BOT_TOKEN_OPENCODE');
      } else if (compUpper.includes('DROID') || compUpper.includes('FACTORY')) {
        candidates.push('TELEGRAM_TOKEN_FACTORY', 'TELEGRAM_BOT_TOKEN_FACTORY', 'TELEGRAM_TOKEN_DROID', 'TELEGRAM_BOT_TOKEN_DROID');
      }
      candidates.push(`TELEGRAM_TOKEN_${compUpper}`, `TELEGRAM_BOT_TOKEN_${compUpper}`);
    }

    if (family) {
      const famUpper = family.toUpperCase();
      candidates.push(
        `TELEGRAM_TOKEN_${famUpper}`,
        `TELEGRAM_BOT_TOKEN_${famUpper}`
      );
      if (famUpper === 'OPENAI') {
        candidates.push('TELEGRAM_TOKEN_CHATGPT', 'TELEGRAM_BOT_TOKEN_CHATGPT');
      } else if (famUpper === 'ANTHROPIC') {
        candidates.push('TELEGRAM_TOKEN_CLAUDE', 'TELEGRAM_BOT_TOKEN_CLAUDE');
      } else if (famUpper === 'GOOGLE') {
        candidates.push('TELEGRAM_TOKEN_GEMINI', 'TELEGRAM_BOT_TOKEN_GEMINI');
      } else if (famUpper === 'OTHER') {
        candidates.push('TELEGRAM_TOKEN_OPENCODE', 'TELEGRAM_BOT_TOKEN_OPENCODE', 'TELEGRAM_TOKEN_FACTORY');
      }
    }

    for (const envKey of candidates) {
      const val = process.env[envKey]?.trim();
      if (val) return val;
    }
    return (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '').trim();
  }

  resolveChatId(explicitChatId, family, componentId = null) {
    if (explicitChatId && typeof explicitChatId === 'string' && explicitChatId.trim()) {
      return explicitChatId.trim();
    }
    const candidates = [];

    if (componentId) {
      const compUpper = componentId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      if (compUpper.includes('OPENCODE')) {
        candidates.push('TELEGRAM_CHAT_ID_OPENCODE');
      } else if (compUpper.includes('DROID') || compUpper.includes('FACTORY')) {
        candidates.push('TELEGRAM_CHAT_ID_FACTORY', 'TELEGRAM_CHAT_ID_DROID');
      }
      candidates.push(`TELEGRAM_CHAT_ID_${compUpper}`);
    }

    if (family) {
      const famUpper = family.toUpperCase();
      candidates.push(
        `TELEGRAM_CHAT_ID_${famUpper}`
      );
      if (famUpper === 'OPENAI') candidates.push('TELEGRAM_CHAT_ID_CHATGPT');
      if (famUpper === 'ANTHROPIC') candidates.push('TELEGRAM_CHAT_ID_CLAUDE');
      if (famUpper === 'GOOGLE') candidates.push('TELEGRAM_CHAT_ID_GEMINI');
      if (famUpper === 'OTHER') candidates.push('TELEGRAM_CHAT_ID_OPENCODE', 'TELEGRAM_CHAT_ID_FACTORY');
    }

    for (const envKey of candidates) {
      const val = process.env[envKey]?.trim();
      if (val) return val;
    }
    return (process.env.TELEGRAM_CHAT_ID || '').trim();
  }

  isConfigured() {
    return Boolean(this.token && this.chatId);
  }

  /**
   * Get topic thread ID for a given family or component from environment variables if configured.
   */
  getTopicId(family, componentId = null) {
    if (componentId) {
      const compUpper = componentId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      if (compUpper.includes('OPENCODE') && process.env.TELEGRAM_TOPIC_OPENCODE) {
        const parsed = parseInt(process.env.TELEGRAM_TOPIC_OPENCODE, 10);
        if (!isNaN(parsed)) return parsed;
      }
    }
    if (family) {
      const envKey = `TELEGRAM_TOPIC_${family.toUpperCase()}`;
      if (process.env[envKey]) {
        const parsed = parseInt(process.env[envKey], 10);
        if (!isNaN(parsed)) return parsed;
      }
      if (family.toUpperCase() === 'OTHER' && process.env.TELEGRAM_TOPIC_OPENCODE) {
        const parsed = parseInt(process.env.TELEGRAM_TOPIC_OPENCODE, 10);
        if (!isNaN(parsed)) return parsed;
      }
    }
    if (process.env.TELEGRAM_TOPIC_MAP) {
      try {
        const map = JSON.parse(process.env.TELEGRAM_TOPIC_MAP);
        if (componentId && map[componentId]) return map[componentId];
        if (family && map[family]) return map[family];
      } catch {}
    }
    return undefined;
  }

  /**
   * Send a text message with HTML parsing.
   */
  async sendMessage(htmlText, options = {}) {
    if (!this.isConfigured()) {
      console.log('[Telegram Mock] sendMessage:\n', htmlText);
      return { ok: true, result: { message_id: 12345 } };
    }

    const threadId = options.topicId || options.message_thread_id;

    const payload = {
      chat_id: this.chatId,
      text: htmlText.slice(0, 4096),
      parse_mode: 'HTML',
      disable_notification: Boolean(options.silent),
      reply_to_message_id: options.replyToMessageId || undefined,
      message_thread_id: threadId || undefined,
    };

    try {
      return await this.requestWithRetry('sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Fallback: if HTML parsing failed (400 Bad Request or parse entities), retry as plain text
      if (err.message && (err.message.includes('400') || err.message.includes('parse entities') || err.message.includes("can't parse"))) {
        console.warn('Telegram HTML parse failed, falling back to plain text...');
        const plainPayload = {
          ...payload,
          parse_mode: undefined,
          text: htmlText.replace(/<[^>]+>/g, '').slice(0, 4096),
        };
        try {
          return await this.requestWithRetry('sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(plainPayload),
          });
        } catch (plainErr) {
          console.error(`Telegram sendMessage failed in plain text fallback: ${plainErr.message}`);
          return { ok: false, error: plainErr.message };
        }
      }
      console.error(`Telegram sendMessage error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Edit existing message text.
   */
  async editMessageText(messageId, newHtmlText) {
    if (!this.isConfigured()) {
      console.log(`[Telegram Mock] editMessageText (${messageId}):\n`, newHtmlText);
      return { ok: true };
    }

    const payload = {
      chat_id: this.chatId,
      message_id: messageId,
      text: newHtmlText.slice(0, 4096),
      parse_mode: 'HTML',
    };

    try {
      return await this.requestWithRetry('editMessageText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn(`Telegram editMessageText failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Send a file document.
   */
  async sendDocument(filePath, caption = '', options = {}) {
    if (!this.isConfigured()) {
      console.log(`[Telegram Mock] sendDocument: ${filePath} (${caption})`);
      return { ok: true };
    }

    const filename = path.basename(filePath);
    const fileBytes = fs.readFileSync(filePath);
    const threadId = options.topicId || options.message_thread_id;

    // Build standard multipart/form-data boundary
    const boundary = '----TelegramClientBoundary' + Math.random().toString(16).slice(2);
    const crlf = '\r\n';

    let parts = [
      `--${boundary}${crlf}Content-Disposition: form-data; name="chat_id"${crlf}${crlf}${this.chatId}${crlf}`,
      `--${boundary}${crlf}Content-Disposition: form-data; name="caption"${crlf}${crlf}${caption.slice(0, 1024)}${crlf}`,
    ];

    if (threadId) {
      parts.push(`--${boundary}${crlf}Content-Disposition: form-data; name="message_thread_id"${crlf}${crlf}${threadId}${crlf}`);
    }

    parts.push(
      `--${boundary}${crlf}Content-Disposition: form-data; name="document"; filename="${filename}"${crlf}Content-Type: application/octet-stream${crlf}${crlf}`
    );

    let body = Buffer.concat([
      Buffer.from(parts.join('')),
      fileBytes,
      Buffer.from(`${crlf}--${boundary}--${crlf}`),
    ]);

    try {
      return await this.requestWithRetry('sendDocument', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      });
    } catch (err) {
      console.warn(`Telegram sendDocument failed for ${filename}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Low-level fetch with retry logic on 429 rate limits.
   */
  async requestWithRetry(endpoint, fetchOptions, maxRetries = 3) {
    const url = `${this.apiBase}/${endpoint}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, fetchOptions);

        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          const retryAfter = (data.parameters?.retry_after || 5) * 1000;
          console.warn(`Telegram 429 rate limited. Retrying after ${retryAfter}ms...`);
          await new Promise((r) => setTimeout(r, retryAfter));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Telegram ${endpoint} failed HTTP ${res.status}: ${errText}`);
        }

        return await res.json();
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
}
