const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { BaseMailProvider } = require('./mail-base');
const {
  OTP_CODE_PATTERN,
  OTP_CODE_SEMANTIC_PATTERN,
  OPENAI_EMAIL_SENDERS,
  OPENAI_VERIFICATION_KEYWORDS,
} = require('./constants');

const DEFAULT_BASE_URL = 'https://temp-mail.app';
const DEFAULT_PART = 'main';
const DEFAULT_EXPIRE_MINUTES = 1440;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function previewText(value, maxLength = 240) {
  const text = normalizeText(value);
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  return (text || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function parseTimestampInfo(value) {
  if (value === null || value === undefined || value === '') {
    return { timestamp: 0, precisionMs: 0 };
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { timestamp: 0, precisionMs: 0 };
    }
    if (value >= 1e12) {
      return { timestamp: value, precisionMs: 1 };
    }
    if (value >= 1e9) {
      return { timestamp: value * 1000, precisionMs: 1000 };
    }
    return { timestamp: value, precisionMs: 1 };
  }

  const text = String(value).trim();
  if (!text) {
    return { timestamp: 0, precisionMs: 0 };
  }
  if (/^\d{13}$/.test(text)) {
    return { timestamp: Number.parseInt(text, 10), precisionMs: 1 };
  }
  if (/^\d{10}$/.test(text)) {
    return { timestamp: Number.parseInt(text, 10) * 1000, precisionMs: 1000 };
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    return { timestamp: 0, precisionMs: 0 };
  }
  return { timestamp: parsed, precisionMs: 1000 };
}

function collectMailStrings(value, output = [], seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return output;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMailStrings(item, output, seen);
    }
    return output;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return output;
    }
    seen.add(value);
    for (const item of Object.values(value)) {
      collectMailStrings(item, output, seen);
    }
  }

  return output;
}

function normalizeMessages(payload) {
  if (Array.isArray(payload?.message)) {
    return payload.message;
  }
  if (Array.isArray(payload?.messages)) {
    return payload.messages;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function createVisitorId() {
  if (typeof crypto.randomUUID === 'function') {
    return `reg2-${crypto.randomUUID()}`;
  }
  return `reg2-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

class MailTempMail extends BaseMailProvider {
  constructor(config = {}) {
    super(config);
    const tempmailConfig = config.tempmail || {};

    this._baseUrl = normalizeBaseUrl(tempmailConfig.baseUrl || DEFAULT_BASE_URL);
    this._proxy = String(tempmailConfig.proxy || '').trim();
    this._part = String(tempmailConfig.part || DEFAULT_PART).trim() || DEFAULT_PART;
    this._expireMinutes = Math.max(
      1,
      Number.parseInt(String(tempmailConfig.expireMinutes || DEFAULT_EXPIRE_MINUTES), 10) || DEFAULT_EXPIRE_MINUTES,
    );
    this._pollIntervalMs = Math.max(1000, Number(this.config.otpPollIntervalSeconds || 5) * 1000);
    this._usedMessageSignatures = new Set();
    this._mailboxes = new Map();
    this._proxyAgent = null;

    if (this._proxy) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        this._proxyAgent = new HttpsProxyAgent(this._proxy);
      } catch (error) {
        throw new Error(
          `TEMPMAIL_PROXY is configured but https-proxy-agent is unavailable: ${error.message}`,
        );
      }
    }
  }

  async init() {
    this._log(
      `Temp Mail API initialized: ${this._baseUrl} (part=${this._part}, expire=${this._expireMinutes}m${this._proxy ? `, proxy=${this._proxy}` : ''})`,
    );
  }

  async createAddress() {
    this._log('Creating Temp Mail mailbox via API...');

    const visitorId = createVisitorId();
    const payload = await this._requestJson('GET', '/api/mail/address', {
      headers: { 'visitor-id': visitorId },
      query: {
        refresh: 'false',
        expire: this._expireMinutes,
        part: this._part,
      },
    });

    const address = normalizeText(payload?.address);
    if (!address) {
      throw new Error(`Unexpected Temp Mail address response: ${JSON.stringify(payload)}`);
    }

    this._mailboxes.set(address.toLowerCase(), {
      address,
      visitorId,
      createdAt: Date.now(),
    });

    this._log(`Created Temp Mail mailbox: ${address}`);
    return {
      address,
      token: visitorId,
      visitorId,
    };
  }

  async waitForCode(email, timeout = 600, otpSentAt = Date.now()) {
    const mailbox = this._mailboxes.get(String(email || '').trim().toLowerCase());
    if (!mailbox) {
      throw new Error(`No Temp Mail session found for ${email}`);
    }

    const deadline = Date.now() + timeout * 1000;
    const baselineMessages = await this._fetchMessages(mailbox);
    const initialMatch = this._pickOtpMessage(baselineMessages, otpSentAt);
    if (initialMatch) {
      this._markMessageUsed(initialMatch);
      this._log(`Found OTP in initial Temp Mail snapshot: ${initialMatch.code}`);
      return initialMatch.code;
    }

    this._log(`Initial Temp Mail messages: ${baselineMessages.length}`);
    this._logMessageBatch('Initial Temp Mail content', baselineMessages);

    while (Date.now() < deadline) {
      await sleep(Math.min(this._pollIntervalMs, Math.max(0, deadline - Date.now())));

      const messages = await this._fetchMessages(mailbox);
      this._log(`Polled Temp Mail messages: ${messages.length}`);
      this._logMessageBatch('Polled Temp Mail content', messages);

      const nextMatch = this._pickOtpMessage(messages, otpSentAt);
      if (nextMatch) {
        this._markMessageUsed(nextMatch);
        this._log(`Received OTP from Temp Mail: ${nextMatch.code}`);
        return nextMatch.code;
      }
    }

    this._log(`OTP wait timed out after ${timeout}s`);
    return null;
  }

  async close() {
    this._mailboxes.clear();
  }

  _pickOtpMessage(messages, otpSentAt) {
    const preferred = [];
    const fallback = [];

    for (const message of messages) {
      const signature = this._messageSignature(message);
      const code = this._extractCodeFromMessage(message);
      if (!code) {
        continue;
      }
      if (this._usedMessageSignatures.has(signature) || this._usedCodes.has(code)) {
        continue;
      }
      if (!this._isMessageFresh(message, otpSentAt)) {
        continue;
      }

      const candidate = { message, signature, code };
      if (this._looksLikeOpenAIMail(message)) {
        preferred.push(candidate);
      } else {
        fallback.push(candidate);
      }
    }

    return preferred[0] || fallback[0] || null;
  }

  _markMessageUsed(candidate) {
    this._usedCodes.add(candidate.code);
    this._usedMessageSignatures.add(candidate.signature);
  }

  _looksLikeOpenAIMail(message) {
    const summary = this._summarizeMessage(message);
    const sender = summary.from.toLowerCase();
    const text = `${summary.subject} ${summary.fullText}`.toLowerCase();

    const senderMatch = OPENAI_EMAIL_SENDERS.some((keyword) => {
      const normalized = String(keyword || '').trim().toLowerCase();
      return normalized && sender.includes(normalized);
    });

    if (senderMatch) {
      return true;
    }

    return OPENAI_VERIFICATION_KEYWORDS.some((keyword) => {
      const normalized = String(keyword || '').trim().toLowerCase();
      return normalized && text.includes(normalized);
    });
  }

  _extractCodeFromMessage(message) {
    const summary = this._summarizeMessage(message);
    const source = `${summary.subject}\n${summary.fullText}`;

    const semanticMatch = source.match(OTP_CODE_SEMANTIC_PATTERN);
    if (semanticMatch) {
      return semanticMatch[1];
    }

    const subjectTail = summary.subject.split(/\s+/).pop() || '';
    if (/^\d{6}$/.test(subjectTail)) {
      return subjectTail;
    }

    const genericMatch = source.match(OTP_CODE_PATTERN);
    return genericMatch ? genericMatch[1] : null;
  }

  _messageSignature(message) {
    const summary = this._summarizeMessage(message);
    const rawTime =
      message?.date ||
      message?.receivedAt ||
      message?.received_at ||
      message?.createdAt ||
      message?.created_at ||
      message?.timestamp ||
      '';

    return [
      message?.id || message?._id || message?.uid || message?.messageId || '',
      summary.from,
      summary.subject,
      rawTime,
      summary.fullText.slice(0, 500),
    ].join('|');
  }

  _isMessageFresh(message, otpSentAt) {
    if (!otpSentAt || otpSentAt <= 0) {
      return true;
    }

    const rawTime =
      message?.date ||
      message?.receivedAt ||
      message?.received_at ||
      message?.createdAt ||
      message?.created_at ||
      message?.timestamp;

    const { timestamp, precisionMs } = parseTimestampInfo(rawTime);
    if (!timestamp) {
      return true;
    }

    const slackMs = Math.max(precisionMs, 60000);
    const fresh = timestamp + slackMs >= otpSentAt;
    if (!fresh) {
      this._log(
        `Message treated as old: messageTime=${timestamp} rawTime="${rawTime}" otpSentAt=${otpSentAt} slackMs=${slackMs}`,
      );
    }
    return fresh;
  }

  _summarizeMessage(message) {
    const from = normalizeText([
      message?.from,
      message?.sender,
      message?.fromName,
      message?.from_email,
      message?.mailFrom,
    ].filter(Boolean).join(' '));

    const subject = normalizeText([
      message?.subject,
      message?.title,
      message?.mailSubject,
      message?.mail_subject,
    ].filter(Boolean).join(' '));

    const fullText = normalizeText(collectMailStrings(message).join(' '));
    return { from, subject, fullText };
  }

  _logMessageBatch(label, messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    const limit = Math.min(messages.length, 3);
    for (let index = 0; index < limit; index += 1) {
      const message = messages[index];
      const summary = this._summarizeMessage(message);
      const extractedCode = this._extractCodeFromMessage(message);
      const createdAt =
        message?.date ||
        message?.receivedAt ||
        message?.received_at ||
        message?.createdAt ||
        message?.created_at ||
        message?.timestamp ||
        '';

      this._log(
        `${label} [${index + 1}/${messages.length}] from="${previewText(summary.from || '(unknown)', 120)}" subject="${previewText(summary.subject || '(no subject)', 180)}" time="${createdAt}" extractedCode=${extractedCode || '-'} preview="${previewText(summary.fullText, 280) || '(empty)'}"`,
      );
    }
  }

  async _fetchMessages(mailbox) {
    const payload = await this._requestJson('GET', '/api/mail/list', {
      headers: { 'visitor-id': mailbox.visitorId },
      query: { part: this._part },
    });
    return normalizeMessages(payload);
  }

  _buildUrl(requestPath, query = {}) {
    const url = new URL(requestPath, `${this._baseUrl}/`);
    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === null || rawValue === undefined || rawValue === '') {
        continue;
      }
      url.searchParams.set(key, String(rawValue));
    }
    return url;
  }

  async _requestJson(method, requestPath, options = {}) {
    const {
      query = {},
      headers = {},
      body = '',
      timeoutMs = 30000,
    } = options;

    const targetUrl = this._buildUrl(requestPath, query);
    const transport = targetUrl.protocol === 'http:' ? http : https;

    const requestHeaders = {
      Accept: 'application/json',
      ...headers,
    };
    if (body && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const requestOptions = {
      method,
      headers: requestHeaders,
      timeout: timeoutMs,
      agent: this._proxyAgent || undefined,
    };

    const rawBody = await new Promise((resolve, reject) => {
      const req = transport.request(targetUrl, requestOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const payload = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode || 0;

          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `Temp Mail API request failed: HTTP ${statusCode} ${previewText(payload, 200)}`,
              ),
            );
            return;
          }

          resolve(payload);
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Temp Mail API request timed out after ${timeoutMs}ms`));
      });
      req.on('error', reject);

      if (body) {
        req.write(body);
      }
      req.end();
    });

    try {
      return JSON.parse(rawBody || 'null');
    } catch (error) {
      throw new Error(`Temp Mail API JSON parse failed: ${error.message}, body=${previewText(rawBody, 200)}`);
    }
  }
}

module.exports = { MailTempMail };
