/**
 * Telegram API Client (Section 8)
 * Handles sending alerts, edits, document uploads, and rate limit backoff (429).
 */

import fs from 'node:fs';
import path from 'node:path';

export class TelegramClient {
  constructor(token = process.env.TELEGRAM_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID) {
    this.token = (token || '').trim();
    this.chatId = (chatId || '').trim();
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
  }

  isConfigured() {
    return Boolean(this.token && this.chatId);
  }

  /**
   * Send a text message with HTML parsing.
   */
  async sendMessage(htmlText, options = {}) {
    if (!this.isConfigured()) {
      console.log('[Telegram Mock] sendMessage:\n', htmlText);
      return { ok: true, result: { message_id: 12345 } };
    }

    const payload = {
      chat_id: this.chatId,
      text: htmlText.slice(0, 4096),
      parse_mode: 'HTML',
      disable_notification: Boolean(options.silent),
      reply_to_message_id: options.replyToMessageId || undefined,
    };

    return await this.requestWithRetry('sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
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

    return await this.requestWithRetry('editMessageText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Send a file document.
   */
  async sendDocument(filePath, caption = '') {
    if (!this.isConfigured()) {
      console.log(`[Telegram Mock] sendDocument: ${filePath} (${caption})`);
      return { ok: true };
    }

    const filename = path.basename(filePath);
    const fileBytes = fs.readFileSync(filePath);

    // Build standard multipart/form-data boundary
    const boundary = '----TelegramClientBoundary' + Math.random().toString(16).slice(2);
    const crlf = '\r\n';

    let body = Buffer.concat([
      Buffer.from(
        `--${boundary}${crlf}Content-Disposition: form-data; name="chat_id"${crlf}${crlf}${this.chatId}${crlf}` +
        `--${boundary}${crlf}Content-Disposition: form-data; name="caption"${crlf}${crlf}${caption.slice(0, 1024)}${crlf}` +
        `--${boundary}${crlf}Content-Disposition: form-data; name="document"; filename="${filename}"${crlf}Content-Type: application/octet-stream${crlf}${crlf}`
      ),
      fileBytes,
      Buffer.from(`${crlf}--${boundary}--${crlf}`),
    ]);

    return await this.requestWithRetry('sendDocument', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
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
