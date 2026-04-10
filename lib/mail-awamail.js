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

const DEFAULT_BASE_URL = 'https://awamail.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

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
  if (Array.isArray(payload?.data?.emails)) {
    return payload.data.emails;
  }
  if (Array.isArray(payload?.emails)) {
    return payload.emails;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function parseSetCookieHeader(value) {
  const header = String(value || '').trim();
  if (!header) {
    return null;
  }

  const firstPart = header.split(';', 1)[0];
  const eqIndex = firstPart.indexOf('=');
  if (eqIndex <= 0) {
    return null;
  }

  return {
    name: firstPart.slice(0, eqIndex).trim(),
    value: firstPart.slice(eqIndex + 1).trim(),
  };
}

class MailAwaMail extends BaseMailProvider {
  constructor(config = {}) {
    super(config);
    const awaMailConfig = config.awamail || {};

    this._baseUrl = normalizeBaseUrl(awaMailConfig.baseUrl || DEFAULT_BASE_URL);
    this._proxy = String(awaMailConfig.proxy || '').trim();
    this._pollIntervalMs = Math.max(1000, Number(this.config.otpPollIntervalSeconds || 5) * 1000);
    this._usedMessageSignatures = new Set();
    this._mailboxes = new Map();
    this._cookieJar = new Map();
    this._proxyAgent = null;

    if (this._proxy) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        this._proxyAgent = new HttpsProxyAgent(this._proxy);
      } catch (error) {
        throw new Error(
          `AWAMAIL_PROXY is configured but https-proxy-agent is unavailable: ${error.message}`,
        );
      }
    }
  }

  async init() {
    this._log(
      `AwaMail API initialized: ${this._baseUrl}${this._proxy ? ` (proxy=${this._proxy})` : ''}`,
    );
  }

  async createAddress() {
    this._log('Creating AwaMail mailbox via API...');

    await this._bootstrapSession(true);
    let payload = await this._requestJson('POST', '/welcome/change_mailbox', {
      headers: this._buildAjaxHeaders(),
    });

    let address = normalizeText(payload?.data?.email_address || payload?.data?.address);
    if (!address) {
      const html = await this._bootstrapSession(false);
      address = this._extractEmailFromHtml(html);
    }

    if (!address) {
      throw new Error(`Unexpected AwaMail address response: ${JSON.stringify(payload)}`);
    }

    this._mailboxes.set(address.toLowerCase(), {
      address,
      createdAt: Date.now(),
    });

    this._log(`Created AwaMail mailbox: ${address}`);
    return {
      address,
      token: this._cookieHeader(),
      provider: 'awamail',
      providerLabel: 'AwaMail',
    };
  }

  async waitForCode(email, timeout = 600, otpSentAt = Date.now()) {
    const mailbox = this._mailboxes.get(String(email || '').trim().toLowerCase());
    if (!mailbox) {
      throw new Error(`No AwaMail session found for ${email}`);
    }

    const deadline = Date.now() + timeout * 1000;
    const baselineMessages = await this._fetchMessages(mailbox);
    const initialMatch = this._pickOtpMessage(baselineMessages, otpSentAt);
    if (initialMatch) {
      this._markMessageUsed(initialMatch);
      this._log(`Found OTP in initial AwaMail snapshot: ${initialMatch.code}`);
      return initialMatch.code;
    }

    this._log(`Initial AwaMail messages: ${baselineMessages.length}`);
    this._logMessageBatch('Initial AwaMail content', baselineMessages);

    while (Date.now() < deadline) {
      await sleep(Math.min(this._pollIntervalMs, Math.max(0, deadline - Date.now())));

      const messages = await this._fetchMessages(mailbox);
      this._log(`Polled AwaMail messages: ${messages.length}`);
      this._logMessageBatch('Polled AwaMail content', messages);

      const nextMatch = this._pickOtpMessage(messages, otpSentAt);
      if (nextMatch) {
        this._markMessageUsed(nextMatch);
        this._log(`Received OTP from AwaMail: ${nextMatch.code}`);
        return nextMatch.code;
      }
    }

    this._log(`OTP wait timed out after ${timeout}s`);
    return null;
  }

  async close() {
    this._mailboxes.clear();
    this._cookieJar.clear();
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
      message?.from_address,
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

  async _fetchMessages(_mailbox) {
    const payload = await this._requestJson('GET', '/welcome/get_emails', {
      headers: this._buildAjaxHeaders(),
    });
    return normalizeMessages(payload);
  }

  async _bootstrapSession(forceNew = false) {
    if (forceNew) {
      this._cookieJar.delete('awamail_session');
    }

    return this._requestText('GET', '/', {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });
  }

  _extractEmailFromHtml(html) {
    const source = String(html || '');
    const match = source.match(/id=["']email-input["'][^>]*value=["']([^"']+)["']/i);
    return normalizeText(match?.[1] || '');
  }

  _buildAjaxHeaders(extraHeaders = {}) {
    return {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Referer: `${this._baseUrl}/`,
      'User-Agent': DEFAULT_USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
      ...extraHeaders,
    };
  }

  _buildUrl(requestPath, query = {}) {
    const targetUrl = String(requestPath || '').startsWith('http')
      ? new URL(String(requestPath))
      : new URL(requestPath, `${this._baseUrl}/`);

    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === null || rawValue === undefined || rawValue === '') {
        continue;
      }
      targetUrl.searchParams.set(key, String(rawValue));
    }
    return targetUrl;
  }

  _storeResponseCookies(setCookieHeaders) {
    const headers = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : (setCookieHeaders ? [setCookieHeaders] : []);

    for (const header of headers) {
      const cookie = parseSetCookieHeader(header);
      if (!cookie || !cookie.name) {
        continue;
      }

      if (!cookie.value || cookie.value.toLowerCase() === 'deleted') {
        this._cookieJar.delete(cookie.name);
        continue;
      }

      this._cookieJar.set(cookie.name, cookie.value);
    }
  }

  _cookieHeader() {
    return Array.from(this._cookieJar.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  async _request(method, requestPath, options = {}, redirectCount = 0) {
    const {
      query = {},
      headers = {},
      body = '',
      timeoutMs = 30000,
    } = options;

    const targetUrl = this._buildUrl(requestPath, query);
    const transport = targetUrl.protocol === 'http:' ? http : https;
    const requestHeaders = { ...headers };
    const cookieHeader = this._cookieHeader();
    if (cookieHeader) {
      requestHeaders.Cookie = cookieHeader;
    }

    if (body && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const requestOptions = {
      method,
      headers: requestHeaders,
      timeout: timeoutMs,
      agent: this._proxyAgent || undefined,
    };

    const response = await new Promise((resolve, reject) => {
      const req = transport.request(targetUrl, requestOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`AwaMail API request timed out after ${timeoutMs}ms`));
      });
      req.on('error', reject);

      if (body) {
        req.write(body);
      }
      req.end();
    });

    this._storeResponseCookies(response.headers['set-cookie']);

    if (
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      response.headers.location &&
      redirectCount < 5
    ) {
      const nextUrl = new URL(response.headers.location, targetUrl);
      const nextMethod = response.statusCode === 307 || response.statusCode === 308 ? method : 'GET';
      return this._request(nextMethod, nextUrl.toString(), {
        headers,
        body: nextMethod === method ? body : '',
        timeoutMs,
      }, redirectCount + 1);
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `AwaMail API request failed: HTTP ${response.statusCode} ${previewText(response.body, 200)}`,
      );
    }

    return response.body;
  }

  async _requestText(method, requestPath, options = {}) {
    return this._request(method, requestPath, options);
  }

  async _requestJson(method, requestPath, options = {}) {
    const rawBody = await this._request(method, requestPath, options);
    try {
      return JSON.parse(rawBody || 'null');
    } catch (error) {
      throw new Error(`AwaMail API JSON parse failed: ${error.message}, body=${previewText(rawBody, 200)}`);
    }
  }
}

module.exports = { MailAwaMail };
