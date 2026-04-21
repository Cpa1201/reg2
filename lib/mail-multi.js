const { BaseMailProvider } = require('./mail-base');

function providerLabel(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  switch (normalized) {
    case 'tempmail':
      return 'Temp Mail';
    case 'tenminutemail':
      return '10MinuteMail';
    case 'generator_email':
      return 'GeneratorEmail';
    case 'awamail':
      return 'AwaMail';
    case 'outlookapi':
      return 'Outlook Email';
    default:
      return normalized || 'unknown';
  }
}

class MultiMailProvider extends BaseMailProvider {
  constructor(config = {}, options = {}) {
    super(config);
    this._order = Array.isArray(options.order) ? options.order.filter(Boolean) : [];
    this._factories = { ...(options.factories || {}) };
    this._activeProvider = '';
    this._activeMailbox = null;
  }

  async init() {
    this._log(`Multi mailbox initialized: ${this._order.join(' -> ')}`);
  }

  async createAddress() {
    const errors = [];

    for (const provider of this._order) {
      const factory = this._factories[provider];
      if (typeof factory !== 'function') {
        errors.push(`${provider}: factory missing`);
        continue;
      }

      let mailbox = null;
      try {
        mailbox = factory();
        await mailbox.init();
        const created = await mailbox.createAddress();

        this._activeProvider = provider;
        this._activeMailbox = mailbox;

        this._log(`Mailbox allocated by ${providerLabel(provider)}: ${created?.address || ''}`);
        return {
          ...created,
          provider,
          providerLabel: providerLabel(provider),
        };
      } catch (error) {
        errors.push(`${providerLabel(provider)}: ${error.message}`);
        this._log(`${providerLabel(provider)} failed: ${error.message}`);
        if (mailbox) {
          await mailbox.close().catch(() => {});
        }
      }
    }

    throw new Error(`All mailbox providers failed. ${errors.join(' | ')}`);
  }

  async waitForCode(email, timeout = 600, otpSentAt = Date.now()) {
    if (!this._activeMailbox) {
      throw new Error('No active mailbox provider. Call createAddress() first.');
    }
    return this._activeMailbox.waitForCode(email, timeout, otpSentAt);
  }

  resetOtpTracking() {
    super.resetOtpTracking();
    if (this._activeMailbox && typeof this._activeMailbox.resetOtpTracking === 'function') {
      this._activeMailbox.resetOtpTracking();
    }
  }

  async close() {
    if (this._activeMailbox) {
      await this._activeMailbox.close().catch(() => {});
    }
    this._activeMailbox = null;
    this._activeProvider = '';
  }

  getActiveProvider() {
    return this._activeProvider;
  }
}

module.exports = { MultiMailProvider, providerLabel };
