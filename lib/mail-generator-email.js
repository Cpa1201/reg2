const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL, URLSearchParams } = require('url');
const { BaseMailProvider } = require('./mail-base');
const {
  OTP_CODE_PATTERN,
  OTP_CODE_SEMANTIC_PATTERN,
  OPENAI_EMAIL_SENDERS,
  OPENAI_VERIFICATION_KEYWORDS,
} = require('./constants');

const DEFAULT_BASE_URL = 'https://generator.email';

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

function normalizeDomain(value) {
  let text = String(value || '').trim().toLowerCase();
  text = text.replace(/[^a-z0-9.-]/g, '').replace(/^\.+|\.+$/g, '');
  text = text.replace(/\.{2,}/g, '.');
  return text;
}

function sanitizeUsername(value) {
  let text = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  text = text.replace(/[._-]{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '');
  if (!text) {
    text = `u${crypto.randomBytes(5).toString('hex')}`;
  }
  return text.slice(0, 32);
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

class MailGeneratorEmail extends BaseMailProvider {
  constructor(config = {}) {
    super(config);
    const generatorConfig = config.generatorEmail || {};

    this._baseUrl = normalizeBaseUrl(generatorConfig.baseUrl || DEFAULT_BASE_URL);
    this._proxy = String(generatorConfig.proxy || '').trim();
    this._pollIntervalMs = Math.max(
      1000,
      Number(generatorConfig.pollIntervalSeconds || this.config.otpPollIntervalSeconds || 5) * 1000,
    );
    this._domainStrategy = String(generatorConfig.domainStrategy || 'random').trim().toLowerCase() === 'round_robin'
      ? 'round_robin'
      : 'random';
    this._configuredDomains = Array.isArray(generatorConfig.domains)
      ? generatorConfig.domains
      : String(generatorConfig.domains || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    this._domainsFile = String(generatorConfig.domainsFile || '').trim();
    this._domainsFromFile = [];
    this._domainsFileLoaded = false;
    this._domainKeywords = Array.isArray(generatorConfig.domainKeywords)
      ? generatorConfig.domainKeywords
      : String(generatorConfig.domainKeywords || 'mail,com,inbox')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    this._domainEnumQueries = Array.isArray(generatorConfig.domainEnumQueries)
      ? generatorConfig.domainEnumQueries
      : String(generatorConfig.domainEnumQueries || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    this._enumerateAllDomains = Boolean(generatorConfig.enumerateAllDomains);
    this._domainEnumSavePath = String(generatorConfig.domainEnumSavePath || '').trim();
    this._maxCreateRetries = Math.max(1, Number(generatorConfig.maxCreateRetries || 12));
    this._cookieJar = new Map();
    this._mailboxes = new Map();
    this._usedMessageSignatures = new Set();
    this._domainCache = [];
    this._rrIndex = 0;
    this._proxyAgent = null;

    if (this._proxy) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        this._proxyAgent = new HttpsProxyAgent(this._proxy);
      } catch (error) {
        throw new Error(
          `GENERATOR_EMAIL_PROXY is configured but https-proxy-agent is unavailable: ${error.message}`,
        );
      }
    }
  }

  async init() {
    if (this._domainsFile) {
      this._loadDomainsFromFile();
    }
    this._log(
      `GeneratorEmail API initialized: ${this._baseUrl}${this._proxy ? ` (proxy=${this._proxy})` : ''}`,
    );
  }

  async createAddress() {
    this._log('Creating GeneratorEmail mailbox via API...');

    try {
      await this._requestText('GET', '/', {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        maxRedirects: 3,
      });
    } catch (error) {
      this._log(`GeneratorEmail bootstrap failed (ignored): ${error.message}`);
    }

    const username = sanitizeUsername(`u${crypto.randomBytes(5).toString('hex')}`);
    const triedDomains = new Set();
    let lastError = null;

    for (let attempt = 1; attempt <= this._maxCreateRetries; attempt += 1) {
      let domain = '';
      try {
        domain = await this._pickDomain(triedDomains);
        triedDomains.add(domain);
        await this._validateMailbox(username, domain);

        const email = `${username}@${domain}`.toLowerCase();
        const token = `ge-${crypto.randomUUID()}`;
        this._mailboxes.set(email, {
          address: email,
          username,
          domain,
          token,
          createdAt: Date.now(),
        });

        this._log(`Created GeneratorEmail mailbox: ${email}`);
        return {
          address: email,
          token,
          provider: 'generator_email',
          providerLabel: 'GeneratorEmail',
          domain,
        };
      } catch (error) {
        lastError = error;
        this._log(`GeneratorEmail create attempt ${attempt}/${this._maxCreateRetries} failed: ${error.message}`);
        await sleep(Math.min(1600, 200 + attempt * 120));
      }
    }

    throw new Error(`GeneratorEmail create mailbox failed: ${lastError?.message || 'unknown error'}`);
  }

  async waitForCode(email, timeout = 600) {
    const mailbox = this._mailboxes.get(String(email || '').trim().toLowerCase());
    if (!mailbox) {
      throw new Error(`No GeneratorEmail session found for ${email}`);
    }

    const deadline = Date.now() + timeout * 1000;
    let baselineHtml = '';
    let baselineMarker = '';
    let baselineCodes = new Set();

    try {
      const baseline = await this._fetchMailboxHtml(mailbox);
      baselineHtml = baseline.html;
      baselineMarker = baseline.marker;
      const baselineExtract = this._extractCodeFromMailboxHtml(baselineHtml);
      baselineCodes = baselineExtract.allCodes;
    } catch (error) {
      this._log(`GeneratorEmail baseline fetch failed: ${error.message}`);
    }

    while (Date.now() < deadline) {
      let html = '';
      let marker = '';
      try {
        const mailboxPage = await this._fetchMailboxHtml(mailbox);
        html = mailboxPage.html;
        marker = mailboxPage.marker;
      } catch (error) {
        this._log(`GeneratorEmail mailbox poll failed: ${error.message}`);
        await sleep(this._pollIntervalMs);
        continue;
      }

      const { code, allCodes } = this._extractCodeFromMailboxHtml(html);
      if (code) {
        const signature = [marker || '-', code, allCodes.size, html.length].join('|');
        if (this._usedMessageSignatures.has(signature) || this._usedCodes.has(code)) {
          await sleep(this._pollIntervalMs);
          continue;
        }
        if (baselineCodes.has(code) && marker === baselineMarker) {
          await sleep(this._pollIntervalMs);
          continue;
        }

        this._usedCodes.add(code);
        this._usedMessageSignatures.add(signature);
        this._log(
          `Received OTP from GeneratorEmail: ${code} (mailbox=${mailbox.address}, marker=${previewText(marker, 24)})`,
        );
        return code;
      }

      await sleep(this._pollIntervalMs);
    }

    this._log(`GeneratorEmail OTP wait timed out after ${timeout}s`);
    return null;
  }

  async close() {
    this._mailboxes.clear();
    this._cookieJar.clear();
  }

  resetOtpTracking() {
    super.resetOtpTracking();
    this._usedMessageSignatures.clear();
  }

  async _pickDomain(excludedDomains = new Set()) {
    if (this._domainsFile && !this._domainsFileLoaded) {
      this._loadDomainsFromFile();
    }

    const excluded = new Set(Array.from(excludedDomains).map((item) => normalizeDomain(item)));
    const configured = [...this._configuredDomains, ...this._domainsFromFile]
      .map((item) => normalizeDomain(item))
      .filter((item) => item && item.includes('.') && !excluded.has(item));
    if (configured.length > 0) {
      return configured[Math.floor(Math.random() * configured.length)];
    }

    if (!Array.isArray(this._domainCache) || this._domainCache.length === 0) {
      this._domainCache = this._enumerateAllDomains
        ? await this._enumerateAvailableDomains()
        : await this._discoverDomains();
    }
    const available = this._domainCache.filter((item) => item && !excluded.has(item));
    const pool = available.length > 0 ? available : this._domainCache;
    if (!Array.isArray(pool) || pool.length === 0) {
      throw new Error('GeneratorEmail no available domains');
    }

    if (this._domainStrategy === 'round_robin') {
      const index = this._rrIndex % pool.length;
      this._rrIndex += 1;
      return pool[index];
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _loadDomainsFromFile() {
    const rawPath = String(this._domainsFile || '').trim();
    if (!rawPath) {
      this._domainsFromFile = [];
      this._domainsFileLoaded = true;
      return;
    }

    const fullPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(process.cwd(), rawPath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`GeneratorEmail domains file not found: ${fullPath}`);
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const domains = content
      .split(/[\r\n,]+/)
      .map((item) => normalizeDomain(item))
      .filter((item) => item && item.includes('.'));

    const uniqueDomains = [...new Set(domains)];
    if (uniqueDomains.length === 0) {
      throw new Error(`GeneratorEmail domains file is empty: ${fullPath}`);
    }

    this._domainsFromFile = uniqueDomains;
    this._domainsFileLoaded = true;
    this._log(`GeneratorEmail loaded domains file: ${fullPath} (${uniqueDomains.length} domains)`);
  }

  async _discoverDomains() {
    const keywords = this._domainKeywords.length > 0 ? this._domainKeywords : ['mail', 'com', 'inbox'];
    const domains = new Set();

    for (const keyword of keywords) {
      try {
        const text = await this._requestText('GET', '/search.php', {
          query: { key: keyword },
          maxRedirects: 2,
        });
        const items = this._extractDomainCandidates(text);
        for (const item of items) {
          domains.add(item);
        }
      } catch (error) {
        this._log(`GeneratorEmail search failed for key=${keyword}: ${error.message}`);
      }
    }

    const ordered = Array.from(domains).filter((item) => item && item.includes('.')).sort();
    if (ordered.length === 0) {
      ordered.push('tritunggalmail.com');
    }
    return ordered;
  }

  async _enumerateAvailableDomains() {
    const defaultQueries = [];
    if (this._domainEnumQueries.length > 0) {
      defaultQueries.push(...this._domainEnumQueries);
    } else {
      defaultQueries.push(...this._domainKeywords);
      for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789') {
        defaultQueries.push(ch);
      }
    }

    const domains = new Set();
    for (const query of defaultQueries) {
      try {
        const text = await this._requestText('GET', '/search.php', {
          query: { key: query },
          maxRedirects: 2,
        });
        for (const item of this._extractDomainCandidates(text)) {
          domains.add(item);
        }
      } catch {}
    }

    const ordered = Array.from(domains).filter((item) => item && item.includes('.')).sort();
    if (this._domainEnumSavePath && ordered.length > 0) {
      try {
        const fs = require('fs');
        const path = require('path');
        const fullPath = path.isAbsolute(this._domainEnumSavePath)
          ? this._domainEnumSavePath
          : path.resolve(process.cwd(), this._domainEnumSavePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, `${ordered.join('\n')}\n`, 'utf8');
        this._log(`GeneratorEmail domain enumeration saved: ${fullPath} (${ordered.length})`);
      } catch (error) {
        this._log(`GeneratorEmail domain enumeration save failed: ${error.message}`);
      }
    }

    return ordered;
  }

  _extractDomainCandidates(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => normalizeDomain(item))
        .filter((item) => item && item.includes('.'));
    } catch {
      return [];
    }
  }

  async _validateMailbox(username, domain) {
    const headers = {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${this._baseUrl}/`,
    };

    try {
      const punycodeDomain = await this._requestText('POST', '/dom_to_punycode.php', {
        data: { dmn: domain },
        headers,
        maxRedirects: 2,
      });
      const normalizedPunycode = normalizeDomain(punycodeDomain);
      if (normalizedPunycode && normalizedPunycode.includes('.')) {
        domain = normalizedPunycode;
      }
    } catch {}

    const validateText = await this._requestText('POST', '/check_adres_validation3.php', {
      data: { usr: username, dmn: domain },
      headers,
      maxRedirects: 2,
    });

    let validateData = null;
    try {
      validateData = JSON.parse(validateText);
    } catch (error) {
      throw new Error(`GeneratorEmail validation JSON parse failed: ${previewText(validateText, 180)}`);
    }

    if (String(validateData?.status || '').toLowerCase() !== 'good') {
      throw new Error(`GeneratorEmail mailbox validation failed: ${JSON.stringify(validateData)}`);
    }

    try {
      await this._requestText('POST', '/check_mail.php', {
        data: { usr: username, dmn: domain },
        headers,
        maxRedirects: 1,
      });
    } catch {}
  }

  async _fetchMailboxHtml(mailbox) {
    const mailboxUrl = `/${mailbox.domain}/${mailbox.username}`;
    const html = await this._requestText('GET', mailboxUrl, {
      maxRedirects: 3,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const markerMatch = html.match(/recieved:\s*"([^"]+)"/i) || html.match(/received:\s*"([^"]+)"/i);
    const marker = markerMatch ? normalizeText(markerMatch[1]) : '';
    return { html, marker };
  }

  _extractCodeFromMailboxHtml(html) {
    const visibleText = htmlToVisibleText(html);
    if (!visibleText) {
      return { code: null, allCodes: new Set() };
    }

    const allCodes = new Set();
    const genericPattern = new RegExp(OTP_CODE_PATTERN.source, 'g');
    let match = genericPattern.exec(visibleText);
    while (match) {
      allCodes.add(match[1]);
      match = genericPattern.exec(visibleText);
    }

    const lowerText = visibleText.toLowerCase();
    const keywords = [
      ...OPENAI_EMAIL_SENDERS,
      ...OPENAI_VERIFICATION_KEYWORDS,
      'openai',
      'chatgpt',
      'verification code',
    ]
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean);

    for (const keyword of keywords) {
      let start = 0;
      while (start < lowerText.length) {
        const index = lowerText.indexOf(keyword, start);
        if (index < 0) break;
        const window = visibleText.slice(Math.max(0, index - 260), Math.min(visibleText.length, index + 260));
        const code = this._extractCodeFromText(window);
        if (code) {
          return { code, allCodes };
        }
        start = index + keyword.length;
      }
    }

    const semanticMatch = visibleText.match(OTP_CODE_SEMANTIC_PATTERN);
    if (semanticMatch) {
      return { code: semanticMatch[1], allCodes };
    }

    if (allCodes.size === 1 && visibleText.length < 200000) {
      return { code: Array.from(allCodes)[0], allCodes };
    }

    return { code: null, allCodes };
  }

  _extractCodeFromText(text) {
    const source = normalizeText(text);
    if (!source) return null;

    const semanticMatch = source.match(OTP_CODE_SEMANTIC_PATTERN);
    if (semanticMatch) return semanticMatch[1];

    const semanticFallbackMatch = source.match(
      /(?:code\s+is|verification code|验证码[是为]?\s*[:：]?\s*)(\d{6})/i,
    );
    if (semanticFallbackMatch) return semanticFallbackMatch[1];

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
      data = null,
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
    if (cookieHeader) requestHeaders.Cookie = cookieHeader;

    let requestBody = body || '';
    if (!requestBody && data && typeof data === 'object') {
      requestBody = new URLSearchParams(
        Object.entries(data).map(([key, value]) => [key, String(value ?? '')]),
      ).toString();
      if (!requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      }
    } else if (requestBody && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'text/plain; charset=UTF-8';
    }

    if (requestBody) {
      requestHeaders['Content-Length'] = Buffer.byteLength(requestBody);
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
        req.destroy(new Error(`GeneratorEmail request timed out after ${timeoutMs}ms`));
      });
      req.on('error', reject);

      if (requestBody) req.write(requestBody);
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
        data: nextMethod === method ? data : null,
        body: nextMethod === method ? requestBody : '',
        timeoutMs,
        maxRedirects,
      }, redirectCount + 1);
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `GeneratorEmail request failed: HTTP ${response.statusCode} ${previewText(response.body, 220)}`,
      );
    }

    return response.body;
  }

  async _requestText(method, requestPath, options = {}) {
    return this._request(method, requestPath, options);
  }
}

module.exports = { MailGeneratorEmail };
