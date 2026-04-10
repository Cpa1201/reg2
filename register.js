#!/usr/bin/env node
/**
 * ChatGPT registration CLI entry point.
 * Runs a single continuous signup + token acquisition flow
 * while abstracting the mailbox provider behind a shared interface.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { ChatGPTClient } = require('./lib/chatgpt-client');
const { OAuthClient } = require('./lib/oauth-client');
const { MailTempMail } = require('./lib/mail-tempmail');
const { MailAwaMail } = require('./lib/mail-awamail');
const { MailOutlookEmail } = require('./lib/mail-outlook-email');
const { MultiMailProvider, providerLabel } = require('./lib/mail-multi');
const config = require('./config');
const { generateRandomPassword, generateDeviceId } = require('./lib/utils');
const { generateOAuthUrl, submitCallbackUrl, decodeJwtPayload } = require('./lib/oauth');
const { generateRandomUserInfo } = require('./lib/constants');

const AUTO_MAIL_PROVIDER_ORDER = ['tempmail', 'awamail'];
const ORDERABLE_MAIL_PROVIDERS = new Set(['tempmail', 'awamail', 'outlookapi']);

function normalizeMailProvider(value) {
  const provider = String(value || 'auto').trim().toLowerCase();
  if (provider === 'auto' || provider === 'tempmail' || provider === 'awamail' || provider === '2925' || provider === 'cfmail' || provider === 'outlookapi') {
    return provider;
  }
  throw new Error(`Unsupported mail provider: ${value}`);
}

function normalizeMailProviderOrder(value) {
  const rawList = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

  const normalized = rawList
    .map((item) => normalizeMailProvider(item))
    .filter((item) => ORDERABLE_MAIL_PROVIDERS.has(item));

  return [...new Set(normalized.length > 0 ? normalized : AUTO_MAIL_PROVIDER_ORDER)];
}

function shouldAutoAllocateMailbox(provider, email = '') {
  if (provider === 'auto' || provider === 'tempmail' || provider === 'awamail' || provider === 'cfmail') {
    return true;
  }

  if (provider === 'outlookapi') {
    return !String(email || '').trim();
  }

  return false;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    email: '',
    password: '',
    count: 1,
    prefix: 'dolphinthauto',
    browser: config.browser || 'edge',
    headless: config.headless,
    backgroundWindow: config.backgroundWindow,
    proxy: config.proxy || '',
    mailProvider: normalizeMailProvider(config.mailProvider || 'auto'),
    mailProviderOrder: normalizeMailProviderOrder(config.mailProviderOrder || AUTO_MAIL_PROVIDER_ORDER),
    manualOAuth: false,
    callbackUrl: '',
    oauthStateFile: '',
  };

  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--email':
        opts.email = args[++i];
        break;
      case '--password':
        opts.password = args[++i];
        break;
      case '--count':
        opts.count = parseInt(args[++i], 10) || 1;
        break;
      case '--prefix':
        opts.prefix = args[++i];
        break;
      case '--browser':
        opts.browser = args[++i];
        break;
      case '--headless':
        opts.headless = true;
        break;
      case '--background-window':
        opts.backgroundWindow = true;
        opts.headless = false;
        break;
      case '--proxy':
        opts.proxy = args[++i];
        break;
      case '--mail-provider':
        opts.mailProvider = normalizeMailProvider(args[++i]);
        break;
      case '--mail-provider-order':
        opts.mailProviderOrder = normalizeMailProviderOrder(args[++i]);
        break;
      case '--manual-oauth':
        opts.manualOAuth = true;
        break;
      case '--callback-url':
        opts.callbackUrl = args[++i];
        break;
      case '--oauth-state-file':
        opts.oauthStateFile = args[++i];
        break;
      case '--help':
        console.log(`
ChatGPT registration tool

Usage:
  node register.js --email <email> --password <password>
  node register.js --count 5 --prefix dolphinthauto
  node register.js --count 3 --mail-provider auto
  node register.js --count 3 --mail-provider tempmail
  node register.js --count 3 --mail-provider awamail
  node register.js --count 3 --mail-provider outlookapi
  node register.js --manual-oauth
  node register.js --manual-oauth --callback-url "<http://localhost:1455/auth/callback?...>"
  node register.js --help

Options:
  --email           Email address override for 2925/outlookapi mode
  --password        Password for the account
  --count           Number of accounts in batch mode (default 1)
  --prefix          Prefix for generated 2925 addresses
  --browser         edge | chrome
  --headless        Run in headless mode
  --background-window  Keep browser UI but start minimized/in background when possible
  --proxy           Main browser proxy, for example http://127.0.0.1:7890
  --mail-provider   auto | tempmail | awamail | outlookapi
  --mail-provider-order  Provider fallback order for auto mode, for example tempmail,awamail
  --manual-oauth    Generate or complete a manual OAuth PKCE flow for Codex tokens
  --callback-url    OAuth callback URL used to exchange the authorization code
  --oauth-state-file  Path to the saved OAuth state/code_verifier JSON
`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  return opts;
}

async function launchBrowser(opts) {
  const channel = opts.browser === 'chrome' ? 'chrome' : 'msedge';
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-web-security',
  ];
  if (!opts.headless && opts.backgroundWindow) {
    args.push(
      '--start-minimized',
      '--window-position=-2400,0',
    );
  }
  const launchOptions = {
    channel,
    headless: opts.headless,
    args,
  };

  if (opts.proxy) {
    launchOptions.proxy = { server: opts.proxy };
  }

  console.log(
    `Launching browser: ${channel} (headless=${opts.headless}, backgroundWindow=${Boolean(opts.backgroundWindow)})`,
  );
  return chromium.launch(launchOptions);
}

function createConcreteMailbox(provider, runtimeConfig) {
  if (provider === 'tempmail') {
    return {
      mailbox: new MailTempMail(runtimeConfig),
      mailContext: null,
    };
  }

  if (provider === 'awamail') {
    return {
      mailbox: new MailAwaMail(runtimeConfig),
      mailContext: null,
    };
  }

  if (provider === 'outlookapi') {
    return {
      mailbox: new MailOutlookEmail(runtimeConfig),
      mailContext: null,
    };
  }

  if (provider === '2925' || provider === 'cfmail') {
    throw new Error(`Mail provider ${provider} is not available in the current project build.`);
  }

  throw new Error(`Unsupported mail provider: ${provider}`);
}

async function createMailbox(browser, opts) {
  const runtimeConfig = {
    ...config,
    proxy: opts.proxy || config.proxy || '',
    mailProvider: opts.mailProvider,
    mailProviderOrder: normalizeMailProviderOrder(opts.mailProviderOrder || config.mailProviderOrder || AUTO_MAIL_PROVIDER_ORDER),
    tempmail: {
      ...(config.tempmail || {}),
      proxy: config.tempmail?.proxy || opts.proxy || config.proxy || '',
    },
    awamail: {
      ...(config.awamail || {}),
      proxy: config.awamail?.proxy || opts.proxy || config.proxy || '',
    },
    cfmail: {
      ...(config.cfmail || {}),
      proxy: config.cfmail?.proxy || opts.proxy || config.proxy || '',
    },
    outlookEmail: {
      ...(config.outlookEmail || {}),
    },
  };

  if (opts.mailProvider === 'auto') {
    return {
      mailbox: new MultiMailProvider(runtimeConfig, {
        order: runtimeConfig.mailProviderOrder,
        factories: {
          tempmail: () => new MailTempMail(runtimeConfig),
          awamail: () => new MailAwaMail(runtimeConfig),
          outlookapi: () => new MailOutlookEmail(runtimeConfig),
        },
      }),
      mailContext: null,
    };
  }

  return createConcreteMailbox(opts.mailProvider, runtimeConfig);
}

function splitUserInfo(userInfo) {
  const parts = String(userInfo?.name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    };
  }
  return {
    firstName: parts[0] || 'Alex',
    lastName: 'Smith',
  };
}

function ensureOutputDir() {
  const outputDir = path.join(__dirname, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

function ensureTokensDir() {
  const tokensDir = path.join(__dirname, 'tokens');
  fs.mkdirSync(tokensDir, { recursive: true });
  return tokensDir;
}

function getDefaultOAuthStateFile() {
  return path.join(ensureOutputDir(), 'manual-oauth-latest.json');
}

function sanitizeFileName(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/[<>:"/\\|?*\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function buildPerAccountFileName(prefix, result) {
  const emailLabel = sanitizeFileName(result.email || 'pending_email');
  return `${prefix}-${Date.now()}-${emailLabel}.json`;
}

function persistSingleAccountResult(result) {
  const savedAt = new Date().toISOString();

  if (result.success) {
    const tokensDir = ensureTokensDir();
    const filePath = path.join(tokensDir, buildPerAccountFileName('codex-account', result));
    const payload = {
      email: result.email,
      password: result.password,
      id_token: result.tokens?.idToken || '',
      access_token: result.tokens?.accessToken || '',
      refresh_token: result.tokens?.refreshToken || '',
      account_id: result.tokens?.accountId || '',
      expires_in: result.tokens?.expiresIn || 0,
      type: 'codex',
      saved_at: savedAt,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    console.log(`Saved successful account to: ${filePath}`);
    return filePath;
  }

  const outputDir = ensureOutputDir();
  const filePath = path.join(outputDir, buildPerAccountFileName('register-failure', result));
  const payload = {
    email: result.email,
    password: result.password,
    first_name: result.firstName,
    last_name: result.lastName,
    birthdate: result.birthdate,
    success: false,
    error: result.error || 'unknown error',
    saved_at: savedAt,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  console.log(`Saved failed account to: ${filePath}`);
  return filePath;
}

function shouldRetryFreshOAuth(lastError) {
  const text = String(lastError || '').toLowerCase();
  return text.includes('add_phone') && text.includes('workspace');
}

function formatProgressLine(label, value) {
  return `  ${label}: ${value}`;
}

function printRegistrationSummary(results, runState = {}, options = {}) {
  const {
    title = 'Registration summary',
    interrupted = false,
    includeDetails = true,
  } = options;

  const total = Number(runState.totalAccounts || results.length || 0);
  const processed = results.length;
  const successAccounts = results.filter((item) => item.success);
  const failedAccounts = results.filter((item) => !item.success);
  const inProgress = runState.currentAccount ? 1 : 0;
  const pending = Math.max(0, total - processed - inProgress);

  console.log(`\n\n${'='.repeat(60)}`);
  console.log(title);
  console.log('='.repeat(60));

  if (interrupted) {
    console.log('Shutdown mode: interrupted by Ctrl+C');
  }

  console.log(formatProgressLine('Total', total));
  console.log(formatProgressLine('Processed', processed));
  console.log(formatProgressLine('Success', successAccounts.length));
  console.log(formatProgressLine('Failed', failedAccounts.length));
  console.log(formatProgressLine('In Progress', inProgress));
  console.log(formatProgressLine('Pending', pending));

  if (runState.currentAccount) {
    console.log('\nCurrent account:');
    console.log(
      `  ${runState.currentAccount.email || '(pending email)'} | password=${runState.currentAccount.password || ''}`,
    );
  }

  if (!includeDetails) {
    return;
  }

  if (successAccounts.length > 0) {
    console.log('\nSuccessful accounts:');
    for (const item of successAccounts) {
      console.log(
        `  ${item.email} | AT=${(item.tokens?.accessToken || '').slice(0, 30)}... | RT=${(item.tokens?.refreshToken || '').slice(0, 30)}...`,
      );
    }
  }

  if (failedAccounts.length > 0) {
    console.log('\nFailed accounts:');
    for (const item of failedAccounts) {
      console.log(`  ${item.email || '(pending email)'} | reason: ${item.error}`);
    }
  }
}

function createRunState(totalAccounts) {
  return {
    totalAccounts,
    stopRequested: false,
    forceExitRequested: false,
    currentAccount: null,
    shutdownResolvers: new Set(),
  };
}

function wakeShutdownWaiters(runState) {
  for (const resolve of runState.shutdownResolvers) {
    try {
      resolve();
    } catch {}
  }
  runState.shutdownResolvers.clear();
}

async function waitWithShutdown(delayMs, runState) {
  if (!delayMs || delayMs <= 0) return;
  if (runState?.stopRequested) return;

  await new Promise((resolve) => {
    let wake;
    const timer = setTimeout(() => {
      runState?.shutdownResolvers?.delete(wake);
      resolve();
    }, delayMs);

    wake = () => {
      clearTimeout(timer);
      runState?.shutdownResolvers?.delete(wake);
      resolve();
    };

    runState?.shutdownResolvers?.add(wake);
  });
}

function installGracefulShutdown(results, runState) {
  const handleSigint = () => {
    if (!runState.stopRequested) {
      runState.stopRequested = true;
      console.log('\nReceived Ctrl+C, graceful shutdown requested.');
      printRegistrationSummary(results, runState, {
        title: 'Registration progress snapshot',
        interrupted: true,
        includeDetails: true,
      });
      console.log('\nThe current account will finish, then the process will exit gracefully.');
      wakeShutdownWaiters(runState);
      return;
    }

    if (!runState.forceExitRequested) {
      runState.forceExitRequested = true;
      console.log('\nReceived Ctrl+C again, forcing exit after printing current summary.');
      printRegistrationSummary(results, runState, {
        title: 'Registration forced-exit snapshot',
        interrupted: true,
        includeDetails: true,
      });
      process.exit(130);
    }
  };

  process.on('SIGINT', handleSigint);
  return () => {
    process.removeListener('SIGINT', handleSigint);
  };
}

async function requestCodexTokens(browser, email, password, mailbox, userProfile, opts, primaryContext, primaryDeviceId) {
  const { firstName, lastName, birthdate } = userProfile;
  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

  const sameSessionPage = await primaryContext.newPage();
  try {
    console.log('Requesting Codex tokens in the same browser session...');
    const oauthClient = new OAuthClient(sameSessionPage, {
      ...config,
      browserMode: opts.headless ? 'headless' : 'headed',
    });

    const tokens = await oauthClient.loginAndGetTokens(email, password, {
      deviceId: primaryDeviceId || generateDeviceId(),
      mailbox,
      forcePasswordLogin: true,
      forceNewBrowser: false,
      screenHint: 'login',
      completeAboutYouIfNeeded: true,
      firstName,
      lastName,
      birthdate,
    });

    if (tokens) {
      return tokens;
    }

    const primaryError = oauthClient.lastError || 'unknown OAuth error';
    if (!shouldRetryFreshOAuth(primaryError)) {
      throw new Error(`OAuth login failed: ${primaryError}`);
    }

    console.log(`Primary OAuth session blocked (${primaryError}), retrying in a fresh browser session...`);
  } finally {
    await sameSessionPage.close().catch(() => {});
  }

  const freshBrowser = await launchBrowser({
    ...opts,
    proxy: opts.proxy || config.proxy || '',
  });
  const freshContext = await freshBrowser.newContext({ userAgent });
  try {
    const freshPage = await freshContext.newPage();
    const fallbackClient = new OAuthClient(freshPage, {
      ...config,
      browserMode: opts.headless ? 'headless' : 'headed',
    });

    const fallbackTokens = await fallbackClient.loginAndGetTokens(email, password, {
      deviceId: generateDeviceId(),
      mailbox,
      forcePasswordLogin: true,
      forceNewBrowser: true,
      screenHint: 'login',
      completeAboutYouIfNeeded: true,
      firstName,
      lastName,
      birthdate,
    });

    if (!fallbackTokens) {
      throw new Error(`OAuth login failed after fresh-session retry: ${fallbackClient.lastError || 'unknown OAuth error'}`);
    }

    return fallbackTokens;
  } finally {
    await freshContext.close().catch(() => {});
    await freshBrowser.close().catch(() => {});
  }
}

async function runManualOAuthFlow(opts) {
  const outputDir = ensureOutputDir();
  const latestStatePath = opts.oauthStateFile || getDefaultOAuthStateFile();

  if (!opts.callbackUrl) {
    const oauth = generateOAuthUrl();
    const stateData = {
      authUrl: oauth.authUrl,
      state: oauth.state,
      codeVerifier: oauth.codeVerifier,
      redirectUri: oauth.redirectUri,
      createdAt: new Date().toISOString(),
    };
    const timestampedPath = path.join(outputDir, `manual-oauth-${Date.now()}.json`);

    fs.writeFileSync(timestampedPath, JSON.stringify(stateData, null, 2));
    fs.writeFileSync(latestStatePath, JSON.stringify(stateData, null, 2));

    console.log('Manual OAuth PKCE flow');
    console.log('-'.repeat(60));
    console.log('Open this URL in your browser and finish the login/authorize flow:');
    console.log(oauth.authUrl);
    console.log('-'.repeat(60));
    console.log(`Saved OAuth state to: ${timestampedPath}`);
    console.log(`Latest OAuth state file: ${latestStatePath}`);
    console.log('After the browser redirects to localhost, run this command:');
    console.log(`node register.js --manual-oauth --callback-url "<callback-url>" --oauth-state-file "${latestStatePath}"`);
    return;
  }

  if (!fs.existsSync(latestStatePath)) {
    throw new Error(`OAuth state file not found: ${latestStatePath}`);
  }

  const stateData = JSON.parse(fs.readFileSync(latestStatePath, 'utf8'));
  const tokenPayload = await submitCallbackUrl({
    callbackUrl: opts.callbackUrl,
    expectedState: stateData.state,
    codeVerifier: stateData.codeVerifier,
    redirectUri: stateData.redirectUri,
  });

  const emailLabel = sanitizeFileName(tokenPayload.email);
  const tokensDir = ensureTokensDir();
  const outputPath = path.join(tokensDir, `token_${emailLabel}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(tokenPayload, null, 2));

  console.log('OAuth token exchange succeeded.');
  console.log(`  Email: ${tokenPayload.email || '(unknown)'}`);
  console.log(`  Account ID: ${tokenPayload.account_id || ''}`);
  console.log(`  Access Token: ${(tokenPayload.access_token || '').slice(0, 40)}...`);
  console.log(`  Refresh Token: ${(tokenPayload.refresh_token || '').slice(0, 40)}...`);
  console.log(`Saved token payload to: ${outputPath}`);
}

async function registerSingleAccount(email, password, browser, opts) {
  const userInfo = generateRandomUserInfo();
  const { firstName, lastName } = splitUserInfo(userInfo);
  const birthdate = userInfo.birthdate;

  const result = {
    email,
    password,
    firstName,
    lastName,
    birthdate,
    success: false,
    tokens: null,
    error: '',
  };

  const chatgptContext = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });
  const chatgptPage = await chatgptContext.newPage();
  const { mailbox, mailContext } = await createMailbox(browser, opts);

  try {
    await mailbox.init();
    if (shouldAutoAllocateMailbox(opts.mailProvider, email)) {
      const requestedLabel = opts.mailProvider === 'auto'
        ? `mailbox (${opts.mailProviderOrder.join(' -> ')})`
        : providerLabel(opts.mailProvider);
      console.log(`\nRequesting ${requestedLabel} address...`);
      const created = await mailbox.createAddress();
      email = created.address;
      result.email = email;
      result.mailProvider = created.provider || mailbox.getActiveProvider?.() || opts.mailProvider;
      console.log(`${created.providerLabel || providerLabel(result.mailProvider)} address: ${email}`);
    } else {
      result.mailProvider = opts.mailProvider;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Registering account: ${email}`);
    console.log(`Password: ${password}`);
    console.log(`Name: ${firstName} ${lastName}`);
    console.log(`Birthdate: ${birthdate}`);
    console.log(`${'='.repeat(60)}`);

    console.log('\nStarting unified signup flow...');
    const chatgptClient = new ChatGPTClient(chatgptPage, {
      ...config,
      browserMode: opts.headless ? 'headless' : 'headed',
    });

    const [regOk, regMsg] = await chatgptClient.registerCompleteFlow(
      email,
      password,
      firstName,
      lastName,
      birthdate,
      mailbox,
      {
        stopBeforeAboutYouSubmission: false,
        otpWaitTimeout: config.otpWaitTimeout,
        otpResendWaitTimeout: config.otpResendWaitTimeout,
      },
    );

    if (!regOk) {
      if (regMsg.includes('already_exists') || regMsg.includes('already exists')) {
        console.log('Account already exists, trying OAuth login...');
      } else {
        result.error = `Registration failed: ${regMsg}`;
        console.log(result.error);
        return result;
      }
    }

    console.log(`Registration result: ${regMsg}`);

    if (regOk) {
      console.log('Ensuring About You profile is completed before requesting Codex tokens...');
      const [aboutOk, aboutStateOrMsg] = await chatgptClient.ensureAboutYouCompleted(
        firstName,
        lastName,
        birthdate,
      );
      if (!aboutOk) {
        result.error = `About You completion failed: ${aboutStateOrMsg}`;
        console.log(result.error);
        return result;
      }
    }

    const tokens = await requestCodexTokens(
      browser,
      email,
      password,
      mailbox,
      {
        firstName,
        lastName,
        birthdate,
      },
      opts,
      chatgptContext,
      chatgptClient.deviceId || generateDeviceId(),
    );

    const idTokenClaims = decodeJwtPayload(tokens.id_token || '');
    const authClaims = idTokenClaims['https://api.openai.com/auth'] || {};
    const accountId = authClaims.chatgpt_account_id || '';

    result.success = true;
    result.tokens = {
      accessToken: tokens.access_token || '',
      refreshToken: tokens.refresh_token || '',
      idToken: tokens.id_token || '',
      accountId,
      expiresIn: tokens.expires_in || 0,
    };

    console.log('\nRegistration succeeded.');
    console.log(`  Account ID: ${accountId}`);
    console.log(`  Access Token: ${(tokens.access_token || '').slice(0, 40)}...`);
    console.log(`  Refresh Token: ${(tokens.refresh_token || '').slice(0, 40)}...`);
  } catch (error) {
    result.error = `Exception: ${error.message}`;
    console.log(`\nRegistration exception: ${error.message}`);
  } finally {
    await mailbox.close().catch(() => {});
    if (mailContext) {
      await mailContext.close().catch(() => {});
    }
    await chatgptContext.close().catch(() => {});
  }

  return result;
}

async function main() {
  const opts = parseArgs();

  if (opts.manualOAuth || opts.callbackUrl) {
    await runManualOAuthFlow(opts);
    return;
  }

  const accounts = [];

  if (opts.mailProvider === 'auto' || opts.mailProvider === 'tempmail' || opts.mailProvider === 'awamail' || opts.mailProvider === 'cfmail') {
    if (opts.email) {
      console.log(`Ignoring --email in ${opts.mailProvider} mode. The mailbox will be created automatically.`);
    }
    for (let i = 1; i <= opts.count; i += 1) {
      accounts.push({
        email: '',
        password: opts.password && opts.count === 1 ? opts.password : generateRandomPassword(),
      });
    }
  } else if (opts.mailProvider === 'outlookapi') {
    if (opts.email) {
      accounts.push({
        email: opts.email,
        password: opts.password || generateRandomPassword(),
      });
    } else {
      for (let i = 1; i <= opts.count; i += 1) {
        accounts.push({
          email: '',
          password: opts.password && opts.count === 1 ? opts.password : generateRandomPassword(),
        });
      }
    }
  } else if (opts.email) {
    accounts.push({
      email: opts.email,
      password: opts.password || generateRandomPassword(),
    });
  } else {
    for (let i = 1; i <= opts.count; i += 1) {
      accounts.push({
        email: `${opts.prefix}-${String(i).padStart(3, '0')}@2925.com`,
        password: generateRandomPassword(),
      });
    }
  }

  console.log('ChatGPT registration');
  console.log(`Account count: ${accounts.length}`);
  console.log(`Browser: ${opts.browser}`);
  console.log(`Mail provider: ${opts.mailProvider}`);
  if (opts.mailProvider === 'auto') {
    console.log(`Mail provider order: ${opts.mailProviderOrder.join(' -> ')}`);
  }

  const browser = await launchBrowser(opts);
  const results = [];
  const runState = createRunState(accounts.length);
  const removeShutdownHandler = installGracefulShutdown(results, runState);

  try {
    for (const account of accounts) {
      if (runState.stopRequested) {
        console.log('\nGraceful shutdown requested, skipping remaining accounts.');
        break;
      }

      runState.currentAccount = {
        email: account.email,
        password: account.password,
      };
      const result = await registerSingleAccount(
        account.email,
        account.password,
        browser,
        opts,
      );
      runState.currentAccount = null;
      results.push(result);
      result.savedPath = persistSingleAccountResult(result);

      if (runState.stopRequested) {
        console.log('\nGraceful shutdown requested, current account finished.');
        break;
      }

      if (accounts.indexOf(account) < accounts.length - 1) {
        console.log('\nWaiting 5 seconds before continuing...');
        await waitWithShutdown(5000, runState);
      }
    }
  } finally {
    runState.currentAccount = null;
    removeShutdownHandler();
    await browser.close().catch(() => {});
  }

  printRegistrationSummary(results, runState, {
    title: runState.stopRequested ? 'Registration summary (graceful shutdown)' : 'Registration summary',
    interrupted: runState.stopRequested,
    includeDetails: true,
  });

  if (runState.stopRequested) {
    process.exitCode = 130;
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
