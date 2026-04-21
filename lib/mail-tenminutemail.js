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

const DEFAULT_BASE_URL = 'https://10minutemail.com';
const DEFAULT_BOOTSTRAP_PATH = '/';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function previewText(value, maxLength = 240) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  return (text || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function normalizeBootstrapPath(value) {
  const text = String(value || '').trim();
  if (!text) return DEFAULT_BOOTSTRAP_PATH;
  return text.startsWith('/') ? text : `/${text}`;
}

function parseTimestampInfo(value) {
  if (value === null || value === undefined || value === '') {
    return { timestamp: 0, precisionMs: 0 };
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { timestamp: 0, precisionMs: 0 };
    if (value >= 1e12) return { timestamp: value, precisionMs: 1 };
    if (value >= 1e9) return { timestamp: value * 1000, precisionMs: 1000 };
    return { timestamp: value, precisionMs: 1 };
  }

  const text = String(value).trim();
  if (!text) return { timestamp: 0, precisionMs: 0 };
  if (/^\d{13}$/.test(text)) return { timestamp: Number.parseInt(text, 10), precisionMs: 1 };
  if (/^\d{10}$/.test(text)) return { timestamp: Number.parseInt(text, 10) * 1000, precisionMs: 1000 };

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return { timestamp: 0, precisionMs: 0 };
  return { timestamp: parsed, precisionMs: 1000 };
}

function htmlToVisibleText(value) {
  let text = String(value || '');
  if (!text) return '';

  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<\/?(br|p|div|tr|td|li|h[1-6])[^>]*>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'');

  return normalizeText(text);
}

function collectMailStrings(value, output = [], seen = new WeakSet()) {
  if (value === null || value === undefined) return output;

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
    if (seen.has(value)) return output;
    seen.add(value);
    for (const item of Object.values(value)) {
      collectMailStrings(item, output, seen);
    }
  }

  return output;
}

function parseSetCookieHeader(value) {
  const header = String(value || '').trim();
  if (!header) return null;

  const firstPart = header.split(';', 1)[0];
  const eqIndex = firstPart.indexOf('=');
  if (eqIndex <= 0) return null;

  return {
    name: firstPart.slice(0, eqIndex).trim(),
    value: firstPart.slice(eqIndex + 1).trim(),
  };
}

function normalizeMessages(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

class MailTenMinuteMail extends BaseMailProvider {
  constructor(config = {}) {
    super(config);
    const tenMinuteConfig = config.tenMinuteMail || {};

    this._baseUrl = normalizeBaseUrl(tenMinuteConfig.baseUrl || DEFAULT_BASE_URL);
    this._bootstrapPath = normalizeBootstrapPath(tenMinuteConfig.bootstrapPath || DEFAULT_BOOTSTRAP_PATH);
    this._proxy = String(tenMinuteConfig.proxy || '').trim();
    this._pollIntervalMs = Math.max(
      1000,
      Number(tenMinuteConfig.pollIntervalSeconds || this.config.otpPollIntervalSeconds || 5) * 1000,
    );
    this._usedMessageSignatures = new Set();
    this._mailboxes = new Map();
    this._cookieJar = new Map();
    this._browser = config.browser || null;
    this._browserContext = null;
    this._browserPage = null;
    this._useBrowserApi = false;
    this._proxyAgent = null;

    if (this._proxy) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        this._proxyAgent = new HttpsProxyAgent(this._proxy);
      } catch (error) {
        throw new Error(
          `TENMINUTEMAIL_PROXY is configured but https-proxy-agent is unavailable: ${error.message}`,
        );
      }
    }
  }

  async init() {
    this._log(
      `10MinuteMail API initialized: ${this._baseUrl} (bootstrap=${this._bootstrapPath}${this._proxy ? `, proxy=${this._proxy}` : ''})`,
    );
  }

  async createAddress() {
    this._log('Creating 10MinuteMail mailbox via API...');

    try {
      await this._requestText('GET', this._bootstrapPath, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    } catch (error) {
      this._log(`10MinuteMail bootstrap failed (ignored): ${error.message}`);
    }

    let payload = null;
    try {
      payload = await this._requestJson('GET', '/session/address');
    } catch (error) {
      const isCfBlocked = /HTTP 403/i.test(String(error?.message || ''));
      if (!isCfBlocked || !this._browser) {
        throw error;
      }
      this._log('10MinuteMail Node 请求命中 403，切换浏览器会话 API 模式...');
      this._useBrowserApi = true;
      payload = await this._browserRequestJson('GET', '/session/address');
    }

    const address = normalizeText(payload?.address);
    if (!address || !address.includes('@')) {
      throw new Error(`Unexpected 10MinuteMail address response: ${JSON.stringify(payload)}`);
    }

    const token = `10mm-${crypto.randomUUID()}`;
    this._mailboxes.set(address.toLowerCase(), {
      address,
      token,
      createdAt: Date.now(),
    });

    this._log(`Created 10MinuteMail mailbox: ${address}`);
    return {
      address,
      token,
      provider: 'tenminutemail',
      providerLabel: '10MinuteMail',
    };
  }

  async waitForCode(email, timeout = 600, otpSentAt = Date.now()) {
    const mailbox = this._mailboxes.get(String(email || '').trim().toLowerCase());
    if (!mailbox) {
      throw new Error(`No 10MinuteMail session found for ${email}`);
    }

    const deadline = Date.now() + timeout * 1000;
    let baselineMessages = [];
    try {
      baselineMessages = await this._fetchMessages(0);
    } catch (error) {
      this._log(`Initial 10MinuteMail fetch failed: ${error.message}`);
    }
    const baselineIds = new Set(baselineMessages.map((message) => this._messageId(message)));

    const initialMatch = this._pickOtpMessage(baselineMessages, otpSentAt, {
      baselineIds,
      allowBaseline: false,
    });
    if (initialMatch) {
      this._markMessageUsed(initialMatch);
      this._log(`Found OTP in initial 10MinuteMail snapshot: ${initialMatch.code}`);
      return initialMatch.code;
    }

    this._log(`Initial 10MinuteMail messages: ${baselineMessages.length}`);
    this._logMessageBatch('Initial 10MinuteMail content', baselineMessages);

    while (Date.now() < deadline) {
      await sleep(Math.min(this._pollIntervalMs, Math.max(0, deadline - Date.now())));

      try {
        const count = await this._fetchMessageCount();
        if (count <= 0) {
          this._log('10MinuteMail message count = 0, continue polling...');
          continue;
        }
      } catch (error) {
        this._log(`10MinuteMail messageCount failed: ${error.message}`);
      }

      let messages = [];
      try {
        messages = await this._fetchMessages(0);
      } catch (error) {
        this._log(`Polled 10MinuteMail fetch failed: ${error.message}`);
        continue;
      }

      this._log(`Polled 10MinuteMail messages: ${messages.length}`);
      this._logMessageBatch('Polled 10MinuteMail content', messages);

      const nextMatch = this._pickOtpMessage(messages, otpSentAt, {
        baselineIds,
      });
      if (nextMatch) {
        this._markMessageUsed(nextMatch);
        this._log(`Received OTP from 10MinuteMail: ${nextMatch.code}`);
        return nextMatch.code;
      }
    }

    this._log(`OTP wait timed out after ${timeout}s`);
    return null;
  }

  async close() {
    this._mailboxes.clear();
    this._cookieJar.clear();
    if (this._browserContext) {
      await this._browserContext.close().catch(() => {});
    }
    this._browserContext = null;
    this._browserPage = null;
    this._useBrowserApi = false;
  }

  resetOtpTracking() {
    super.resetOtpTracking();
    this._usedMessageSignatures.clear();
  }

  _pickOtpMessage(messages, otpSentAt, options = {}) {
    const {
      baselineIds = null,
      allowBaseline = true,
    } = options;

    const preferred = [];
    const fallback = [];

    for (const message of messages) {
      const messageId = this._messageId(message);
      const signature = this._messageSignature(message);
      const code = this._extractCodeFromMessage(message);
      if (!code) continue;

      if (this._usedMessageSignatures.has(signature) || this._usedCodes.has(code)) continue;

      const isBaseline = baselineIds instanceof Set && baselineIds.has(messageId);
      if (isBaseline && !allowBaseline) continue;

      if (!this._isMessageFresh(message, otpSentAt)) continue;

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
    if (senderMatch) return true;

    return OPENAI_VERIFICATION_KEYWORDS.some((keyword) => {
      const normalized = String(keyword || '').trim().toLowerCase();
      return normalized && text.includes(normalized);
    });
  }

  _extractCodeFromMessage(message) {
    const summary = this._summarizeMessage(message);
    const source = `${summary.subject}\n${summary.contentText}`;

    const semanticMatch = source.match(OTP_CODE_SEMANTIC_PATTERN);
    if (semanticMatch) return semanticMatch[1];

    const semanticFallbackMatch = source.match(
      /(?:code\s+is|verification code|验证码[是为]?\s*[:：]?\s*)(\d{6})/i,
    );
    if (semanticFallbackMatch) return semanticFallbackMatch[1];

    const subjectTail = summary.subject.split(/\s+/).pop() || '';
    if (/^\d{6}$/.test(subjectTail)) return subjectTail;

    const genericPattern = new RegExp(OTP_CODE_PATTERN.source, 'g');
    let genericMatch = genericPattern.exec(source);
    while (genericMatch) {
      const code = genericMatch[1];
      const start = genericMatch.index;
      const end = start + code.length;
      const prevChar = start > 0 ? source[start - 1] : '';
      const nextChar = end < source.length ? source[end] : '';
      const context = source.slice(Math.max(0, start - 24), Math.min(source.length, end + 24)).toLowerCase();

      if (prevChar === '#') {
        genericMatch = genericPattern.exec(source);
        continue;
      }
      if (context.includes('color') && (context.includes(`#${code}`) || context.includes(`:${code}`))) {
        genericMatch = genericPattern.exec(source);
        continue;
      }
      if (/[a-f]/i.test(prevChar) || /[a-f]/i.test(nextChar)) {
        genericMatch = genericPattern.exec(source);
        continue;
      }
      return code;
    }

    return null;
  }

  _messageId(message) {
    for (const key of ['id', 'messageId', 'uid', '_id']) {
      const value = message?.[key];
      if (value !== null && value !== undefined && String(value).trim()) {
        return String(value).trim();
      }
    }

    const summary = this._summarizeMessage(message);
    return [
      summary.from,
      summary.subject,
      summary.rawTime,
      summary.contentText.slice(0, 240),
    ].join('|');
  }

  _messageSignature(message) {
    const summary = this._summarizeMessage(message);
    return [
      this._messageId(message),
      summary.from,
      summary.subject,
      summary.rawTime,
      summary.contentText.slice(0, 500),
    ].join('|');
  }

  _isMessageFresh(message, otpSentAt) {
    if (!otpSentAt || otpSentAt <= 0) return true;

    const rawTime =
      message?.sentDate ||
      message?.sentDateFormatted ||
      message?.receivedAt ||
      message?.createdAt ||
      '';

    const { timestamp, precisionMs } = parseTimestampInfo(rawTime);
    if (!timestamp) return true;

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
    const senderValue = message?.sender;
    const from = typeof senderValue === 'object' && senderValue !== null
      ? normalizeText(
        `${senderValue.name || ''} ${senderValue.address || ''} ${senderValue.email || ''}`,
      )
      : normalizeText(senderValue || message?.from || '');

    const subject = normalizeText(
      message?.subject ||
      message?.title ||
      '',
    );

    const bodyPlainText = normalizeText(message?.bodyPlainText || message?.body_text || '');
    const bodyHtmlText = htmlToVisibleText(message?.bodyHtml || message?.body_html || '');
    const fullText = normalizeText(
      `${bodyPlainText} ${bodyHtmlText} ${collectMailStrings(message).join(' ')}`,
    );
    const contentText = normalizeText(`${bodyPlainText} ${bodyHtmlText}`) || fullText;

    const rawTime = normalizeText(
      message?.sentDate ||
      message?.sentDateFormatted ||
      message?.receivedAt ||
      message?.createdAt ||
      '',
    );

    return {
      from,
      subject,
      fullText,
      contentText,
      rawTime,
    };
  }

  _logMessageBatch(label, messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;

    const limit = Math.min(messages.length, 3);
    for (let index = 0; index < limit; index += 1) {
      const message = messages[index];
      const summary = this._summarizeMessage(message);
      const extractedCode = this._extractCodeFromMessage(message);

      this._log(
        `${label} [${index + 1}/${messages.length}] from="${previewText(summary.from || '(unknown)', 120)}" subject="${previewText(summary.subject || '(no subject)', 180)}" time="${summary.rawTime}" extractedCode=${extractedCode || '-'} preview="${previewText(summary.contentText, 280) || '(empty)'}"`,
      );
    }
  }

  async _fetchMessageCount() {
    if (this._useBrowserApi) {
      const browserPayload = await this._browserRequestJson('GET', '/messages/messageCount');
      const parsed = Number.parseInt(String(browserPayload?.messageCount || 0), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    const payload = await this._requestJson('GET', '/messages/messageCount', { maxRedirects: 4 });
    if (typeof payload?.messageCount !== 'undefined') {
      const parsed = Number.parseInt(String(payload.messageCount), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  async _fetchMessages(index = 0) {
    if (this._useBrowserApi) {
      const browserPayload = await this._browserRequestJson(
        'GET',
        `/messages/messagesAfter/${Math.max(0, Number(index) || 0)}`,
      );
      return normalizeMessages(browserPayload);
    }

    const payload = await this._requestJson('GET', `/messages/messagesAfter/${Math.max(0, Number(index) || 0)}`, {
      maxRedirects: 4,
    });
    return normalizeMessages(payload);
  }

  async _ensureBrowserApiPage() {
    if (!this._browser) {
      throw new Error('10MinuteMail browser API is unavailable: browser instance missing');
    }

    if (!this._browserContext) {
      this._browserContext = await this._browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      });
      this._browserPage = await this._browserContext.newPage();
      await this._browserPage.goto(`${this._baseUrl}${this._bootstrapPath}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    }

    return this._browserPage;
  }

  async _browserRequestJson(method, path) {
    const page = await this._ensureBrowserApiPage();
    const url = this._buildUrl(path).toString();
    const response = await page.evaluate(async ({ url, method }) => {
      const result = {
        ok: false,
        status: 0,
        text: '',
      };
      try {
        const resp = await fetch(url, {
          method,
          credentials: 'include',
        });
        result.status = resp.status;
        result.text = await resp.text();
        result.ok = resp.ok;
      } catch (error) {
        result.text = String(error?.message || error);
      }
      return result;
    }, { url, method });

    if (!response?.ok) {
      throw new Error(`10MinuteMail browser API failed: HTTP ${response?.status || 0} ${previewText(response?.text, 220)}`);
    }

    try {
      return JSON.parse(response.text || 'null');
    } catch (error) {
      throw new Error(`10MinuteMail browser API JSON parse failed: ${error.message}, body=${previewText(response.text, 220)}`);
    }
  }

  _buildUrl(requestPath, query = {}) {
    const targetUrl = String(requestPath || '').startsWith('http')
      ? new URL(String(requestPath))
      : new URL(requestPath, `${this._baseUrl}/`);
    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === null || rawValue === undefined || rawValue === '') continue;
      targetUrl.searchParams.set(key, String(rawValue));
    }
    return targetUrl;
  }

  _cookieHeader() {
    return Array.from(this._cookieJar.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  _storeResponseCookies(setCookieHeaders) {
    const headers = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : (setCookieHeaders ? [setCookieHeaders] : []);

    for (const header of headers) {
      const cookie = parseSetCookieHeader(header);
      if (!cookie || !cookie.name) continue;

      if (!cookie.value || cookie.value.toLowerCase() === 'deleted') {
        this._cookieJar.delete(cookie.name);
        continue;
      }
      this._cookieJar.set(cookie.name, cookie.value);
    }
  }

  async _request(method, requestPath, options = {}, redirectCount = 0) {
    const {
      query = {},
      headers = {},
      body = '',
      timeoutMs = 30000,
      maxRedirects = 5,
    } = options;

    const targetUrl = this._buildUrl(requestPath, query);
    const transport = targetUrl.protocol === 'http:' ? http : https;
    const requestHeaders = {
      ...headers,
    };
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
            url: targetUrl.toString(),
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`10MinuteMail request timed out after ${timeoutMs}ms`));
      });
      req.on('error', reject);

      if (body) req.write(body);
      req.end();
    });

    this._storeResponseCookies(response.headers['set-cookie']);

    if (
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      response.headers.location &&
      redirectCount < maxRedirects
    ) {
      const nextUrl = new URL(response.headers.location, targetUrl);
      const nextMethod = response.statusCode === 307 || response.statusCode === 308 ? method : 'GET';
      return this._request(nextMethod, nextUrl.toString(), {
        headers,
        body: nextMethod === method ? body : '',
        timeoutMs,
        maxRedirects,
      }, redirectCount + 1);
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `10MinuteMail API request failed: HTTP ${response.statusCode} ${previewText(response.body, 220)}`,
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
      throw new Error(
        `10MinuteMail API JSON parse failed: ${error.message}, body=${previewText(rawBody, 220)}`,
      );
    }
  }
}

module.exports = { MailTenMinuteMail };
