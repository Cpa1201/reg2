const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.warn('Warning: .env not found. Copy .env.example to .env and fill in the values.');
    return {};
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex < 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    env[key] = value;
  }

  return env;
}

function parseBoolean(value, defaultValue = false) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(text);
}

function parseInteger(value, defaultValue = 0) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseOptionalInteger(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }

  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolvePreferredPath(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) {
      continue;
    }
    const resolved = path.resolve(__dirname, value);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  const first = String(candidates.find((item) => String(item || '').trim()) || '').trim();
  return first ? path.resolve(__dirname, first) : '';
}

const env = loadEnv();

const defaultCfmailConfigPath = resolvePreferredPath(
  env.CFMAIL_CONFIG_PATH || 'cfmail_accounts.json',
  '..\\..\\chat_gpt_add_phone\\cfmail_accounts.json',
);

const config = {
  mailProvider: env.MAIL_PROVIDER || 'tempmail',
  mail2925: {
    account: env.MAIL2925_ACCOUNT || '',
    password: env.MAIL2925_PASSWORD || '',
  },
  tempmail: {
    baseUrl: env.TEMPMAIL_BASE_URL || 'https://temp-mail.app',
    proxy: env.TEMPMAIL_PROXY || '',
    part: env.TEMPMAIL_PART || 'main',
    expireMinutes: parseInteger(env.TEMPMAIL_EXPIRE_MINUTES, 1440),
  },
  cfmail: {
    configPath: defaultCfmailConfigPath,
    profile: env.CFMAIL_PROFILE || 'auto',
    workerDomain: env.CFMAIL_WORKER_DOMAIN || '',
    emailDomain: env.CFMAIL_EMAIL_DOMAIN || '',
    adminPassword: env.CFMAIL_ADMIN_PASSWORD || '',
    mailSubdomains: env.CFMAIL_MAIL_SUBDOMAINS || '',
    failThreshold: parseInt(env.CFMAIL_FAIL_THRESHOLD || '3', 10),
    cooldownSeconds: parseInt(env.CFMAIL_COOLDOWN_SECONDS || '300', 10),
    proxy: env.CFMAIL_PROXY || env.PROXY || '',
  },
  outlookEmail: {
    baseUrl: env.OUTLOOK_EMAIL_BASE_URL || '',
    authMode: env.OUTLOOK_EMAIL_AUTH_MODE || 'auto',
    apiKey: env.OUTLOOK_EMAIL_API_KEY || '',
    loginPassword: env.OUTLOOK_EMAIL_LOGIN_PASSWORD || '',
    groupId: parseOptionalInteger(env.OUTLOOK_EMAIL_GROUP_ID),
    addressMode: env.OUTLOOK_EMAIL_ADDRESS_MODE || 'aliases-first',
    addressPool: env.OUTLOOK_EMAIL_ADDRESS_POOL || '',
    folder: env.OUTLOOK_EMAIL_FOLDER || 'all',
    fetchTop: parseInteger(env.OUTLOOK_EMAIL_FETCH_TOP, 10),
    disableUsedAccounts: parseBoolean(env.OUTLOOK_EMAIL_DISABLE_USED_ACCOUNTS, true),
    disableUsedStatus: env.OUTLOOK_EMAIL_DISABLE_USED_STATUS || 'inactive',
    usedAddressesPath: env.OUTLOOK_EMAIL_USED_ADDRESSES_PATH || path.join('output', 'outlook-email-used-addresses.json'),
  },
  browser: env.BROWSER || 'edge',
  headless: parseBoolean(env.HEADLESS, false),
  backgroundWindow: parseBoolean(env.BACKGROUND_WINDOW, false),
  proxy: env.PROXY || '',
  otpWaitTimeout: parseInt(env.OTP_WAIT_TIMEOUT || '600', 10),
  otpResendWaitTimeout: parseInt(env.OTP_RESEND_WAIT_TIMEOUT || '300', 10),
  otpReceiveAttempts: parseInt(env.OTP_RECEIVE_ATTEMPTS || '5', 10),
  otpResendMaxAttempts: parseInt(env.OTP_RESEND_MAX_ATTEMPTS || '3', 10),
  otpPollIntervalSeconds: parseInt(env.OTP_POLL_INTERVAL_SECONDS || '5', 10),
  mail2925BaseUrl: 'https://mail.2925.com',
  mail2925AuthPath: path.resolve(__dirname, '../2925_mail_automation/.auth/storage-state.json'),
};

// Backward-compatible aliases used by existing local scripts.
config.mail2925Account = config.mail2925.account;
config.mail2925Password = config.mail2925.password;

module.exports = config;
