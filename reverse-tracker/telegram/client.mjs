/**
 * Telegram API Client (Section 8)
 * Handles sending alerts, edits, document uploads, and rate limit backoff (429).
 */

import fs from 'node:fs';
import path from 'node:path';

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_SAFE_TEXT_LIMIT = 3900;
const TELEGRAM_DOCUMENT_LIMIT = 50 * 1024 * 1024;

/**
 * Split long HTML text at line boundaries so a large report summary is sent as
 * multiple complete messages instead of being silently cut off at 4096 chars.
 */
function balanceTelegramChunks(rawChunks) {
  const result = [];
  let carry = [];

  for (const rawChunk of rawChunks) {
    const text = `${carry.map((tag) => tag.open).join('')}${rawChunk}`;
    const stack = [...carry];

    // Track simple Telegram HTML tags so a split does not leave an unclosed
    // <b>/<code>/<blockquote> in one message and a stray closer in the next.
    const tagRegex = /<(\/?)([a-z][a-z0-9-]*)([^>]*)>/gi;
    let match;
    while ((match = tagRegex.exec(rawChunk)) !== null) {
      const [, closing, name, attrs] = match;
      const lowerName = name.toLowerCase();
      if (['br', 'hr'].includes(lowerName)) continue;
      if (closing) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === lowerName) {
            stack.splice(i, 1);
            break;
          }
        }
      } else {
        stack.push({ name: lowerName, open: `<${lowerName}${attrs}>` });
      }
    }

    const closers = [...stack].reverse().map((tag) => `</${tag.name}>`).join('');
    result.push(`${text}${closers}`);
    carry = stack;
  }

  return result;
}

function safeLineCut(line, start, limit) {
  let cut = start + limit;
  if (cut >= line.length) return line.length;

  // Do not cut in the middle of an HTML tag or entity. A split there makes
  // Telegram reject the whole message (or display a broken entity/tag).
  const lastOpen = line.lastIndexOf('<', cut - 1);
  const lastClose = line.lastIndexOf('>', cut - 1);
  if (lastOpen > lastClose && cut - lastOpen < 512) cut = lastOpen;
  const lastAmp = line.lastIndexOf('&', cut - 1);
  const lastSemi = line.lastIndexOf(';', cut - 1);
  if (lastAmp > lastSemi && cut - lastAmp <= 12) cut = lastAmp;

  // Prefer a word boundary when one is reasonably close; URLs remain intact
  // because they have no spaces and simply use the tag-safe cut above.
  const space = line.lastIndexOf(' ', cut - 1);
  if (space > start + Math.floor(limit * 0.6)) cut = space + 1;

  return Math.max(start + 1, cut);
}

export function splitTelegramText(text, limit = TELEGRAM_SAFE_TEXT_LIMIT) {
  const value = String(text || '');
  if (value.length <= limit) return [value];

  // balanceTelegramChunks may prepend open tags and append closers to every
  // piece. Reserve room for that framing so a split full of <b>/<code> tags
  // still lands below Telegram's hard 4,096-character limit.
  const workingLimit = Math.max(256, limit - 256);
  const rawChunks = [];
  let current = '';
  for (const line of value.split('\n')) {
    if (line.length > workingLimit) {
      if (current) {
        rawChunks.push(current);
        current = '';
      }
      let offset = 0;
      while (offset < line.length) {
        const end = safeLineCut(line, offset, workingLimit);
        rawChunks.push(line.slice(offset, end));
        offset = end;
      }
      continue;
    }
    if (current && current.length + line.length + 1 > workingLimit) {
      rawChunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) rawChunks.push(current);
  return balanceTelegramChunks(rawChunks.filter((chunk) => chunk.length > 0));
}

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

    // Component-level tokens (e.g. OpenCode CLI, Droid CLI, Cursor Desktop/CLI)
    if (componentId) {
      const compUpper = componentId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      if (compUpper.includes('OPENCODE') || compUpper.includes('CURSOR')) {
        // Cursor shares the OpenCode bot token due to BotFather bot limits
        candidates.push(
          'TELEGRAM_TOKEN_CURSOR',
          'TELEGRAM_BOT_TOKEN_CURSOR',
          'TELEGRAM_TOKEN_OPENCODE',
          'TELEGRAM_BOT_TOKEN_OPENCODE'
        );
      } else if (compUpper.includes('DROID') || compUpper.includes('FACTORY')) {
        candidates.push(
          'TELEGRAM_TOKEN_FACTORY',
          'TELEGRAM_BOT_TOKEN_FACTORY',
          'TELEGRAM_TOKEN_DROID',
          'TELEGRAM_BOT_TOKEN_DROID',
          'TELEGRAM_TOKEN_OPENCODE',
          'TELEGRAM_BOT_TOKEN_OPENCODE'
        );
      }
      candidates.push(`TELEGRAM_TOKEN_${compUpper}`, `TELEGRAM_BOT_TOKEN_${compUpper}`);
    }

    if (family) {
      const famUpper = family.toUpperCase();
      if (famUpper === 'CURSOR') {
        // Cursor shares the OpenCode bot token due to BotFather bot limits
        candidates.push(
          'TELEGRAM_TOKEN_CURSOR',
          'TELEGRAM_BOT_TOKEN_CURSOR',
          'TELEGRAM_TOKEN_OPENCODE',
          'TELEGRAM_BOT_TOKEN_OPENCODE'
        );
      } else if (famUpper === 'OTHER') {
        candidates.push(
          'TELEGRAM_TOKEN_OTHER',
          'TELEGRAM_BOT_TOKEN_OTHER',
          'TELEGRAM_TOKEN_OPENCODE',
          'TELEGRAM_BOT_TOKEN_OPENCODE',
          'TELEGRAM_TOKEN_FACTORY',
          'TELEGRAM_BOT_TOKEN_FACTORY'
        );
      } else {
        candidates.push(
          `TELEGRAM_TOKEN_${famUpper}`,
          `TELEGRAM_BOT_TOKEN_${famUpper}`
        );
      }

      if (famUpper === 'OPENAI') {
        candidates.push('TELEGRAM_TOKEN_CHATGPT', 'TELEGRAM_BOT_TOKEN_CHATGPT');
      } else if (famUpper === 'ANTHROPIC') {
        candidates.push('TELEGRAM_TOKEN_CLAUDE', 'TELEGRAM_BOT_TOKEN_CLAUDE');
      } else if (famUpper === 'GOOGLE') {
        candidates.push('TELEGRAM_TOKEN_GEMINI', 'TELEGRAM_BOT_TOKEN_GEMINI');
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
      if (compUpper.includes('OPENCODE') || compUpper.includes('CURSOR')) {
        candidates.push('TELEGRAM_CHAT_ID_CURSOR', 'TELEGRAM_CHAT_ID_OPENCODE');
      } else if (compUpper.includes('DROID') || compUpper.includes('FACTORY')) {
        candidates.push('TELEGRAM_CHAT_ID_FACTORY', 'TELEGRAM_CHAT_ID_DROID', 'TELEGRAM_CHAT_ID_OPENCODE');
      }
      candidates.push(`TELEGRAM_CHAT_ID_${compUpper}`);
    }

    if (family) {
      const famUpper = family.toUpperCase();
      if (famUpper === 'CURSOR') {
        candidates.push('TELEGRAM_CHAT_ID_CURSOR', 'TELEGRAM_CHAT_ID_OPENCODE');
      } else if (famUpper === 'OTHER') {
        candidates.push('TELEGRAM_CHAT_ID_OTHER', 'TELEGRAM_CHAT_ID_OPENCODE', 'TELEGRAM_CHAT_ID_FACTORY');
      } else {
        candidates.push(`TELEGRAM_CHAT_ID_${famUpper}`);
      }

      if (famUpper === 'OPENAI') candidates.push('TELEGRAM_CHAT_ID_CHATGPT');
      if (famUpper === 'ANTHROPIC') candidates.push('TELEGRAM_CHAT_ID_CLAUDE');
      if (famUpper === 'GOOGLE') candidates.push('TELEGRAM_CHAT_ID_GEMINI');
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
      if (compUpper.includes('OPENCODE') || compUpper.includes('CURSOR')) {
        const topicVal = process.env.TELEGRAM_TOPIC_CURSOR || process.env.TELEGRAM_TOPIC_OPENCODE;
        if (topicVal) {
          const parsed = parseInt(topicVal, 10);
          if (!isNaN(parsed)) return parsed;
        }
      }
    }
    if (family) {
      const envKey = `TELEGRAM_TOPIC_${family.toUpperCase()}`;
      if (envKey && process.env[envKey]) {
        const parsed = parseInt(process.env[envKey], 10);
        if (!isNaN(parsed)) return parsed;
      }
      if ((family.toUpperCase() === 'OTHER' || family.toUpperCase() === 'CURSOR') && process.env.TELEGRAM_TOPIC_OPENCODE) {
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
    const chunks = splitTelegramText(htmlText);
    const results = [];

    for (const chunk of chunks) {
      const payload = {
        chat_id: this.chatId,
        text: chunk,
        parse_mode: 'HTML',
        disable_notification: Boolean(options.silent),
        reply_to_message_id: options.replyToMessageId || undefined,
        message_thread_id: threadId || undefined,
      };

      try {
        results.push(await this.requestWithRetry('sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }));
      } catch (err) {
        // Fallback: if HTML parsing failed (400 Bad Request or parse entities), retry as plain text
        if (err.message && (err.message.includes('400') || err.message.includes('parse entities') || err.message.includes("can't parse"))) {
          console.warn('Telegram HTML parse failed, falling back to plain text...');
          const plainPayload = {
            ...payload,
            parse_mode: undefined,
            text: chunk.replace(/<[^>]+>/g, '').slice(0, TELEGRAM_TEXT_LIMIT),
          };
          try {
            results.push(await this.requestWithRetry('sendMessage', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(plainPayload),
            }));
            continue;
          } catch (plainErr) {
            console.error(`Telegram sendMessage failed in plain text fallback: ${plainErr.message}`);
            return { ok: false, error: plainErr.message };
          }
        }
        console.error(`Telegram sendMessage error: ${err.message}`);
        return { ok: false, error: err.message };
      }
    }

    const last = results[results.length - 1];
    return {
      ok: true,
      result: last?.result,
      messages: results.map((item) => item?.result),
    };
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
      text: newHtmlText.length > TELEGRAM_TEXT_LIMIT
        ? `${newHtmlText.slice(0, TELEGRAM_TEXT_LIMIT - 20)}\n…`
        : newHtmlText,
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
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: `File does not exist: ${filePath}` };
    }
    const stat = fs.statSync(filePath);
    if (stat.size > TELEGRAM_DOCUMENT_LIMIT) {
      return {
        ok: false,
        error: `File ${filename} is ${stat.size} bytes, above Telegram's 50 MB bot upload limit`,
      };
    }
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
          if (attempt >= maxRetries) {
            throw new Error(`Telegram ${endpoint} rate limited after ${maxRetries} attempts`);
          }
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Telegram ${endpoint} failed HTTP ${res.status}: ${errText}`);
        }

        const data = await res.json();
        if (data && data.ok === false) {
          throw new Error(`Telegram ${endpoint} rejected request: ${data.description || 'unknown error'}`);
        }
        return data;
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
}
