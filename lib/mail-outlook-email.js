const fs = require('fs');
const path = require('path');
const { BaseMailProvider } = require('./mail-base');
const { OTP_CODE_PATTERN, OPENAI_VERIFICATION_KEYWORDS } = require('./constants');

const claimedAddresses = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function previewText(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  return text.replace(/\/+$/, '');
}

function normalizeFilePath(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return path.isAbsolute(text) ? text : path.resolve(process.cwd(), text);
}

function normalizeAddressMode(value) {
  const mode = String(value || 'aliases-first').trim().toLowerCase();
  if (['aliases-first', 'primary-first', 'aliases-only', 'primary-only'].includes(mode)) {
    return mode;
  }
  throw new Error(`Unsupported OUTLOOK_EMAIL_ADDRESS_MODE: ${value}`);
}

function splitAddressPool(value) {
  return String(value || '')
    .split(/[,\r\n]+/)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function buildCookieHeader(setCookies) {
  if (!Array.isArray(setCookies) || setCookies.length === 0) {
    return '';
  }

  return setCookies
    .map((cookie) => String(cookie || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function readJsonSafely(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeAccounts(payload) {
  if (Array.isArray(payload?.accounts)) {
    return payload.accounts;
  }
  if (Array.isArray(payload?.data?.accounts)) {
    return payload.data.accounts;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function normalizeMessages(payload) {
  if (Array.isArray(payload?.emails)) {
    return payload.emails;
  }
  if (Array.isArray(payload?.messages)) {
    return payload.messages;
  }
  if (Array.isArray(payload?.data?.emails)) {
    return payload.data.emails;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function loadUsedAddressMap(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return new Map();
  }

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload)
        ? payload
        : [];
    const map = new Map();

    for (const item of entries) {
      const address = String(item?.address || '').trim().toLowerCase();
      if (!address) {
        continue;
      }
      map.set(address, {
        address: String(item.address || '').trim(),
        accountId: item?.accountId ?? null,
        disabledAt: item?.disabledAt || '',
        source: item?.source || 'local',
      });
    }

    return map;
  } catch {
    return new Map();
  }
}

function saveUsedAddressMap(filePath, usedMap) {
  if (!filePath) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const items = Array.from(usedMap.values())
    .sort((left, right) => String(left.address || '').localeCompare(String(right.address || '')));
  fs.writeFileSync(filePath, JSON.stringify({ items }, null, 2));
}

class MailOutlookEmail extends BaseMailProvider {
  constructor(config = {}) {
    super(config);
    const outlookConfig = config.outlookEmail || {};

    this._baseUrl = normalizeBaseUrl(outlookConfig.baseUrl || '');
    this._authMode = String(outlookConfig.authMode || 'auto').trim().toLowerCase();
    this._apiKey = String(outlookConfig.apiKey || '').trim();
    this._loginPassword = String(outlookConfig.loginPassword || '').trim();
    this._groupId = outlookConfig.groupId ?? null;
    this._addressMode = normalizeAddressMode(outlookConfig.addressMode || 'aliases-first');
    this._addressPool = splitAddressPool(outlookConfig.addressPool || '');
    this._folder = String(outlookConfig.folder || 'all').trim().toLowerCase() || 'all';
    this._fetchTop = Math.max(1, Math.min(50, Number.parseInt(String(outlookConfig.fetchTop || '10'), 10) || 10));
    this._disableUsedAccounts = outlookConfig.disableUsedAccounts !== false;
    this._disableUsedStatus = String(outlookConfig.disableUsedStatus || 'inactive').trim() || 'inactive';
    this._usedAddressesPath = normalizeFilePath(outlookConfig.usedAddressesPath || '');
    this._pollIntervalMs = Math.max(1000, Number(this.config.otpPollIntervalSeconds || 5) * 1000);
    this._internalCookie = '';
    this._resolvedMode = '';
    this._usedMessageSignatures = new Set();
    this._usedAddressMap = loadUsedAddressMap(this._usedAddressesPath);
    this._currentReservation = null;
  }

  async init() {
    if (!this._baseUrl) {
      throw new Error('OUTLOOK_EMAIL_BASE_URL is required when MAIL_PROVIDER=outlookapi');
    }

    if (!['auto', 'external', 'internal'].includes(this._authMode)) {
      throw new Error(`Unsupported OUTLOOK_EMAIL_AUTH_MODE: ${this._authMode}`);
    }

    if (this._authMode === 'external' && !this._apiKey) {
      throw new Error('OUTLOOK_EMAIL_API_KEY is required when OUTLOOK_EMAIL_AUTH_MODE=external');
    }

    if (this._authMode === 'internal' && !this._loginPassword) {
      throw new Error('OUTLOOK_EMAIL_LOGIN_PASSWORD is required when OUTLOOK_EMAIL_AUTH_MODE=internal');
    }

    if (this._authMode === 'internal') {
      await this._ensureInternalSession();
    }
  }

  async createAddress() {
    const candidates = this._addressPool.length > 0
      ? this._addressPool.map((address) => ({
          address,
          resolvedEmail: address,
          kind: 'pool',
        }))
      : await this._fetchAddressCandidates();

    if (candidates.length === 0) {
      throw new Error('No available email addresses were returned by the Outlook Email API');
    }

    const selected = candidates.find((candidate) => !this._isAddressUnavailable(candidate.address));
    if (!selected) {
      throw new Error('All Outlook Email API addresses are already reserved in this run');
    }

    claimedAddresses.add(selected.address.toLowerCase());
    this._currentReservation = selected;
    this._rememberUsedAddress(selected);
    this._log(
      `Reserved mailbox: ${selected.address}${selected.resolvedEmail && selected.resolvedEmail !== selected.address ? ` (resolved=${selected.resolvedEmail})` : ''}`,
    );
    return {
      address: selected.address,
      resolvedEmail: selected.resolvedEmail || selected.address,
      kind: selected.kind || 'primary',
    };
  }

  async waitForCode(email, timeout = 600, otpSentAt = Date.now()) {
    const deadline = Date.now() + timeout * 1000;
    const baselineMessages = await this._fetchMessages(email);

    const initialMatch = this._pickOtpMessage(baselineMessages, otpSentAt);
    if (initialMatch) {
      this._markMessageUsed(initialMatch);
      this._log(`Found OTP in initial mailbox snapshot: ${initialMatch.code}`);
      return initialMatch.code;
    }

    this._log(`Initial Outlook mailbox messages: ${baselineMessages.length}`);
    this._logMessageBatch('Initial Outlook mailbox content', baselineMessages);

    while (Date.now() < deadline) {
      await sleep(Math.min(this._pollIntervalMs, Math.max(0, deadline - Date.now())));

      const messages = await this._fetchMessages(email);
      this._log(`Polled Outlook mailbox messages: ${messages.length}`);
      this._logMessageBatch('Polled Outlook mailbox content', messages);

      const nextMatch = this._pickOtpMessage(messages, otpSentAt);
      if (nextMatch) {
        this._markMessageUsed(nextMatch);
        this._log(`Received OTP from Outlook mailbox: ${nextMatch.code}`);
        return nextMatch.code;
      }
    }

    this._log(`OTP wait timed out after ${timeout}s`);
    return null;
  }

  async close() {
    await this._disableReservedAccountIfNeeded();
  }

  _isAddressUnavailable(address) {
    const normalized = String(address || '').trim().toLowerCase();
    if (!normalized) {
      return true;
    }

    return claimedAddresses.has(normalized) || this._usedAddressMap.has(normalized);
  }

  _rememberUsedAddress(candidate) {
    if (!this._disableUsedAccounts) {
      return;
    }

    const address = String(candidate?.address || '').trim();
    if (!address) {
      return;
    }

    this._usedAddressMap.set(address.toLowerCase(), {
      address,
      accountId: candidate?.accountId ?? null,
      disabledAt: new Date().toISOString(),
      source: 'reserved',
    });
    saveUsedAddressMap(this._usedAddressesPath, this._usedAddressMap);
  }

  async _disableReservedAccountIfNeeded() {
    if (!this._disableUsedAccounts || !this._currentReservation?.accountId) {
      return;
    }

    const reservation = this._currentReservation;
    this._currentReservation = null;

    if (!this._loginPassword) {
      this._log(
        `Skipping remote disable for ${reservation.address}: OUTLOOK_EMAIL_LOGIN_PASSWORD is not configured`,
      );
      return;
    }

    try {
      await this._ensureInternalSession();
      await this._fetchJson(this._buildUrl(`/api/accounts/${reservation.accountId}`), {
        method: 'PUT',
        headers: {
          Cookie: this._internalCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: this._disableUsedStatus,
        }),
      });
      this._log(`Disabled used mailbox in remote pool: ${reservation.address} -> ${this._disableUsedStatus}`);
    } catch (error) {
      this._log(`Failed to disable used mailbox remotely: ${reservation.address} (${error.message})`);
    }
  }

  async _fetchAddressCandidates() {
    const payload = await this._requestJson({
      externalPath: '/api/external/accounts',
      internalPath: '/api/accounts',
      query: this._groupId === null ? {} : { group_id: this._groupId },
    });

    const accounts = normalizeAccounts(payload)
      .filter((account) => {
        const status = String(account?.status || 'active').trim().toLowerCase();
        return !status || status === 'active';
      })
      .sort((left, right) => {
        const leftTime = parseTimestampInfo(
          left?.last_refresh_at || left?.lastRefreshAt || left?.updated_at || left?.updatedAt || left?.created_at || left?.createdAt,
        ).timestamp || 0;
        const rightTime = parseTimestampInfo(
          right?.last_refresh_at || right?.lastRefreshAt || right?.updated_at || right?.updatedAt || right?.created_at || right?.createdAt,
        ).timestamp || 0;
        return leftTime - rightTime;
      });

    const seen = new Set();
    const pushCandidate = (list, address, resolvedEmail, kind, accountId = null) => {
      const normalizedAddress = String(address || '').trim();
      if (!normalizedAddress) {
        return;
      }

      const key = normalizedAddress.toLowerCase();
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      list.push({
        address: normalizedAddress,
        resolvedEmail: String(resolvedEmail || normalizedAddress).trim(),
        kind,
        accountId,
      });
    };

    const aliasCandidates = [];
    const primaryCandidates = [];

    for (const account of accounts) {
      const resolvedEmail = String(account?.email || '').trim();
      const accountId = account?.id ?? null;
      const aliases = Array.isArray(account?.aliases)
        ? account.aliases.map((item) => String(item || '').trim()).filter(Boolean)
        : [];

      for (const alias of aliases) {
        pushCandidate(aliasCandidates, alias, resolvedEmail || alias, 'alias', accountId);
      }

      if (resolvedEmail) {
        pushCandidate(primaryCandidates, resolvedEmail, resolvedEmail, 'primary', accountId);
      }
    }

    switch (this._addressMode) {
      case 'aliases-only':
        return aliasCandidates;
      case 'primary-only':
        return primaryCandidates;
      case 'primary-first':
        return [...primaryCandidates, ...aliasCandidates];
      case 'aliases-first':
      default:
        return [...aliasCandidates, ...primaryCandidates];
    }
  }

  async _fetchMessages(email) {
    const payload = await this._requestJson({
      externalPath: '/api/external/emails',
      internalPath: `/api/emails/${encodeURIComponent(email)}`,
      query: {
        email,
        folder: this._folder,
        top: this._fetchTop,
      },
      omitEmailForInternalPath: true,
    });

    return normalizeMessages(payload);
  }

  async _requestJson({ externalPath, internalPath, query = {}, omitEmailForInternalPath = false }) {
    const authOrder = this._resolveAuthOrder();
    let lastError = null;

    for (const mode of authOrder) {
      try {
        const isExternal = mode === 'external';
        const requestPath = isExternal ? externalPath : internalPath;
        const effectiveQuery = isExternal || !omitEmailForInternalPath
          ? query
          : Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'email'));
        const payload = await (isExternal
          ? this._requestExternal(requestPath, effectiveQuery)
          : this._requestInternal(requestPath, effectiveQuery));

        this._resolvedMode = mode;
        return payload;
      } catch (error) {
        lastError = error;
        if (mode !== authOrder[authOrder.length - 1]) {
          this._log(`Outlook Email ${mode} mode failed, trying fallback mode: ${error.message}`);
        }
      }
    }

    throw lastError || new Error('Outlook Email API request failed');
  }

  _resolveAuthOrder() {
    if (this._authMode === 'external') {
      return ['external'];
    }
    if (this._authMode === 'internal') {
      return ['internal'];
    }

    const modes = [];
    if (this._apiKey) {
      modes.push('external');
    }
    if (this._loginPassword) {
      modes.push('internal');
    }

    if (modes.length === 0) {
      throw new Error('Configure OUTLOOK_EMAIL_API_KEY or OUTLOOK_EMAIL_LOGIN_PASSWORD first');
    }

    return modes;
  }

  async _requestExternal(requestPath, query = {}) {
    if (!this._apiKey) {
      throw new Error('OUTLOOK_EMAIL_API_KEY is not configured');
    }

    return this._fetchJson(this._buildUrl(requestPath, query), {
      headers: {
        'X-API-Key': this._apiKey,
      },
    });
  }

  async _requestInternal(requestPath, query = {}) {
    await this._ensureInternalSession();
    return this._fetchJson(this._buildUrl(requestPath, query), {
      headers: {
        Cookie: this._internalCookie,
      },
    });
  }

  async _ensureInternalSession() {
    if (this._internalCookie) {
      return;
    }
    if (!this._loginPassword) {
      throw new Error('OUTLOOK_EMAIL_LOGIN_PASSWORD is not configured');
    }

    const response = await fetch(this._buildUrl('/login'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: this._loginPassword }),
      redirect: 'manual',
    });

    const text = await response.text();
    const payload = readJsonSafely(text);

    if (!response.ok || payload?.success === false) {
      const message = payload?.error || `Outlook Email login failed with HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    const cookieHeader = buildCookieHeader(setCookies);
    if (!cookieHeader) {
      throw new Error('Outlook Email login succeeded but no session cookie was returned');
    }

    this._internalCookie = cookieHeader;
  }

  async _fetchJson(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || undefined,
      redirect: 'manual',
    });
    const text = await response.text();
    const payload = readJsonSafely(text);

    if (!response.ok) {
      const message = payload?.error || payload?.message || `HTTP ${response.status} ${response.statusText}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      error.body = text;
      throw error;
    }

    if (payload && payload.success === false) {
      const error = new Error(payload.error || payload.message || 'Outlook Email API request failed');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  _buildUrl(requestPath, query = {}) {
    const url = new URL(requestPath, `${this._baseUrl}/`);
    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === null || rawValue === undefined || rawValue === '') {
        continue;
      }
      url.searchParams.set(key, String(rawValue));
    }
    return url.toString();
  }

  _pickOtpMessage(messages, otpSentAt) {
    const preferred = [];
    const fallback = [];

    for (const message of messages) {
      const code = this._extractCodeFromMessage(message);
      if (!code) {
        continue;
      }

      const signature = this._messageSignature(message);
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
    const from = String(message?.from || message?.sender || '').toLowerCase();
    const text = `${message?.subject || ''} ${message?.body_preview || message?.bodyPreview || message?.preview || ''}`.toLowerCase();

    if (from.includes('openai')) {
      return true;
    }

    return OPENAI_VERIFICATION_KEYWORDS.some((keyword) => {
      const normalizedKeyword = String(keyword || '').trim().toLowerCase();
      return normalizedKeyword && text.includes(normalizedKeyword);
    });
  }

  _extractCodeFromMessage(message) {
    const subject = String(message?.subject || '').trim();
    const preview = String(
      message?.body_preview ||
      message?.bodyPreview ||
      message?.preview ||
      message?.snippet ||
      message?.body ||
      message?.text ||
      '',
    ).trim();

    const subjectMatch = subject.match(OTP_CODE_PATTERN);
    if (subjectMatch) {
      return subjectMatch[1];
    }

    const previewMatch = `${subject}\n${preview}`.match(OTP_CODE_PATTERN);
    return previewMatch ? previewMatch[1] : null;
  }

  _messageSignature(message) {
    return [
      message?.id || '',
      message?.subject || '',
      message?.from || message?.sender || '',
      message?.date || message?.received_at || message?.receivedAt || '',
      message?.body_preview || message?.bodyPreview || message?.preview || '',
      message?.folder || '',
    ].join('|');
  }

  _isMessageFresh(message, otpSentAt) {
    if (!otpSentAt || otpSentAt <= 0) {
      return true;
    }

    const rawTime =
      message?.date ||
      message?.received_at ||
      message?.receivedAt ||
      message?.created_at ||
      message?.createdAt ||
      message?.timestamp;
    const { timestamp, precisionMs } = parseTimestampInfo(rawTime);

    if (!timestamp) {
      return true;
    }

    const slackMs = Math.max(precisionMs, 2000);
    const fresh = timestamp + slackMs >= otpSentAt;
    if (!fresh) {
      this._log(
        `Message treated as old: messageTime=${timestamp} rawTime="${rawTime}" otpSentAt=${otpSentAt} slackMs=${slackMs}`,
      );
    }
    return fresh;
  }

  _logMessageBatch(label, messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    const limit = Math.min(messages.length, 3);
    for (let index = 0; index < limit; index += 1) {
      const message = messages[index];
      this._log(
        `${label} [${index + 1}/${messages.length}] from="${previewText(message?.from || message?.sender || '(unknown)', 120)}" subject="${previewText(message?.subject || '(no subject)', 180)}" time="${message?.date || message?.receivedAt || message?.received_at || ''}" folder="${message?.folder || ''}" extractedCode=${this._extractCodeFromMessage(message) || '-'} preview="${previewText(message?.body_preview || message?.bodyPreview || message?.preview || '', 220) || '(empty)'}"`,
      );
    }
  }
}

module.exports = { MailOutlookEmail };
