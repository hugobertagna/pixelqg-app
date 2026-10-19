'use strict';

// PixelQG licence (pixelqg-site/docs/ACCOUNTS.md §2): device hash, local storage of the signed
// certificate, offline Ed25519 verification, and the account flows against Supabase (password
// login, refresh-token renewal at startup and every 6 h, logout that releases this PC).
//
// Honest limit: this code runs on the user's PC, so a determined developer can always patch the
// check out. It stops casual sharing (copying the folder, one account on more than 3 PCs).

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const DEFAULT_CLOUD = require('./cloud-config');
const { LICENSE_PUBLIC_KEY } = require('./license-key');

const REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const REG_TIMEOUT_MS = 5000;
const MAX_CERT_LENGTH = 8192;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
// Built from a pattern, never from the literal placeholder: a release script that replaces the
// placeholders everywhere must not turn this check into a comparison with the real values.
const PLACEHOLDER_RE = /^__[A-Z0-9_]+__$/;
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const GUID_RE = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/;
const CLOUD_URL_RE = /^(https:\/\/[^\s/?#]+|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)$/i;

const MSG = Object.freeze({
  missing: 'Indique ton e-mail et ton mot de passe.',
  badEmail: 'Adresse e-mail invalide : vérifie ce que tu as saisi.',
  wrongPassword: 'E-mail ou mot de passe incorrect.',
  emailNotConfirmed: 'Confirme d’abord ton adresse e-mail (le lien est dans ta boîte de réception), puis reconnecte-toi.',
  noLicense: 'Aucune licence active sur ce compte : achète PixelQG depuis ton compte sur le site, puis reconnecte-toi.',
  tooManyDevices: 'Trop d’appareils : libère un PC depuis ton compte (3 PC maximum par licence), puis réessaie.',
  rateLimited: 'Trop de tentatives : patiente une minute avant de réessayer.',
  offline: 'Impossible de joindre le serveur des licences : vérifie ta connexion Internet, puis réessaie.',
  timeout: 'Le serveur des licences ne répond pas (délai dépassé) : réessaie dans un instant.',
  sessionExpired: 'Ta session a expiré : reconnecte-toi.',
  expired: 'Ta licence n’a pas pu être renouvelée depuis 14 jours : reconnecte-toi avec Internet.',
  badCertificate: 'Le certificat de licence reçu est invalide : mets PixelQG à jour, puis réessaie.',
  notConfigured: 'Mode développeur : les comptes ne sont pas configurés dans cette version de PixelQG.',
  saveFailed: 'Impossible d’enregistrer la licence sur ce PC',
  released: 'Tu es déconnecté de ce PC.',
  notReleased: 'Tu es déconnecté de ce PC, mais sa place n’a pas pu être libérée en ligne : libère-la depuis ton compte si besoin.',
  cloudError: (status) => `Le serveur des licences a renvoyé une erreur (${status}) : réessaie plus tard.`,
});

// Refresh failures after which the current certificate is dropped (the server said no for good).
const DEFINITIVE = new Set(['session_expired', 'no_license', 'too_many_devices']);

class LicenseError extends Error {
  /**
   * @param {number} status HTTP status the local API answers with (never 401: that one means
   *   « wrong HQ token » to the page)
   * @param {string} message French message shown to the user
   * @param {string} code machine-readable reason
   */
  constructor(status, message, code) {
    super(message);
    this.name = 'LicenseError';
    this.status = status;
    this.code = code;
  }
}

// ------------------------------------------------------------------------------------------------
// Cloud config

/** True while cloud-config.js still holds its placeholders (developer build). */
function isPlaceholderConfig(cloud) {
  const c = cloud || {};
  return PLACEHOLDER_RE.test(String(c.SUPABASE_URL || '')) || PLACEHOLDER_RE.test(String(c.SUPABASE_ANON_KEY || ''));
}

// ------------------------------------------------------------------------------------------------
// Device hash

function hashDevice(id) {
  return crypto.createHash('sha256').update('pixelqg:' + id, 'utf8').digest('hex');
}

function parseMachineGuid(text) {
  const m = GUID_RE.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}

function regExe() {
  const root = process.env.SystemRoot || process.env.windir;
  if (root) {
    const exe = path.join(root, 'System32', 'reg.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return 'reg';
}

/** Reads the Windows MachineGuid with a hidden `reg query` (64-bit view first). Null elsewhere. */
async function readMachineGuid(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return null;
  const run = opts.execFile || childProcess.execFile;
  const key = 'HKLM\\SOFTWARE\\Microsoft\\Cryptography';
  const attempt = (extra) => new Promise((resolve) => {
    try {
      run(regExe(), ['query', key, '/v', 'MachineGuid', ...extra], { windowsHide: true, timeout: REG_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
        resolve(err ? null : parseMachineGuid(stdout));
      });
    } catch {
      resolve(null);
    }
  });
  return (await attempt(['/reg:64'])) || attempt([]);
}

/** Fallback identity: hostname + first non-internal MAC address (interfaces sorted by name). */
function fallbackDeviceId() {
  let mac = '';
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets).sort()) {
      const hit = (nets[name] || []).find((ni) => ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00');
      if (hit) {
        mac = hit.mac.toLowerCase();
        break;
      }
    }
  } catch {
    /* no interface information */
  }
  return `${os.hostname().toLowerCase()}|${mac}`;
}

/** sha256("pixelqg:" + MachineGuid, or the hostname/MAC fallback) as lowercase hex. */
async function computeDeviceHash(opts = {}) {
  const guid = await readMachineGuid(opts);
  return hashDevice(guid || fallbackDeviceId());
}

// ------------------------------------------------------------------------------------------------
// Certificate

function loadPublicKey(key) {
  if (key && typeof key === 'object' && key.type === 'public') return key;
  const text = String(key || '').trim();
  const obj = text.startsWith('-----BEGIN')
    ? crypto.createPublicKey(text)
    : crypto.createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
  if (obj.asymmetricKeyType !== 'ed25519') throw new Error('Clé publique de licence : Ed25519 attendu.');
  return obj;
}

/**
 * Verifies a certificate offline: base64url(payload) + "." + base64url(Ed25519 signature over the
 * base64url payload string). Checks the signature, the payload shape, the device and `exp`.
 * @param {string} certificate
 * @param {{publicKey?: string|crypto.KeyObject, deviceHash: string, now?: number}} opts
 * @returns {{ok: true, payload: object} | {ok: false, reason: 'format'|'key'|'signature'|'payload'|'device'|'expired', payload?: object}}
 */
function verifyCertificate(certificate, opts = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof certificate !== 'string' || !certificate || certificate.length > MAX_CERT_LENGTH) return fail('format');
  const dot = certificate.indexOf('.');
  if (dot <= 0 || dot !== certificate.lastIndexOf('.')) return fail('format');
  const p64 = certificate.slice(0, dot);
  const s64 = certificate.slice(dot + 1);
  if (!B64URL_RE.test(p64) || !B64URL_RE.test(s64)) return fail('format');
  const signature = Buffer.from(s64, 'base64url');
  if (signature.length !== 64) return fail('signature');
  let key;
  try {
    key = loadPublicKey(opts.publicKey === undefined ? LICENSE_PUBLIC_KEY : opts.publicKey);
  } catch {
    return fail('key');
  }
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(p64, 'utf8'), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return fail('signature');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
  } catch {
    return fail('payload');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== 1) return fail('payload');
  if (typeof payload.lic !== 'string' || typeof payload.sub !== 'string') return fail('payload');
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return fail('payload');
  if (typeof payload.dev !== 'string' || typeof opts.deviceHash !== 'string' || payload.dev !== opts.deviceHash) return fail('device');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  // An expired certificate is still authentic: its payload comes back so the session can be renewed.
  if (payload.exp * 1000 <= now) return { ok: false, reason: 'expired', payload };
  return { ok: true, payload };
}

// ------------------------------------------------------------------------------------------------
// Licence manager

class LicenseManager extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.bypass] gate always open (test-suite only: startServer({ license: { bypass: true } }))
   * @param {object} [opts.cloud] { SUPABASE_URL, SUPABASE_ANON_KEY, SITE_URL } (default cloud-config.js)
   * @param {string|crypto.KeyObject} [opts.publicKey] certificate key (default license-key.js)
   * @param {string} [opts.file] storage file (default ~/.pixelqg/license.json, or PIXELQG_HOME)
   * @param {string} [opts.deviceHash] precomputed device hash (64 hex chars)
   * @param {string} [opts.deviceName] name shown in the account's device list (default hostname)
   * @param {Function} [opts.fetch] fetch implementation
   * @param {Function} [opts.now] clock in ms
   * @param {number} [opts.timeoutMs=15000] per-request timeout
   * @param {number} [opts.refreshMs=6h] background renewal period
   */
  constructor(opts = {}) {
    super();
    const cloud = { ...DEFAULT_CLOUD, ...(opts.cloud || {}) };
    this.bypass = opts.bypass === true;
    this.devMode = !this.bypass && isPlaceholderConfig(cloud);
    this.supabaseUrl = String(cloud.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    this.anonKey = String(cloud.SUPABASE_ANON_KEY || '').trim();
    this.siteUrl = String(cloud.SITE_URL || DEFAULT_CLOUD.SITE_URL).trim().replace(/\/+$/, '');
    this.publicKey = opts.publicKey === undefined ? LICENSE_PUBLIC_KEY : opts.publicKey;
    const home = process.env.PIXELQG_HOME || path.join(os.homedir(), '.pixelqg');
    this.file = path.resolve(opts.file || path.join(home, 'license.json'));
    this.fetch = typeof opts.fetch === 'function' ? opts.fetch : globalThis.fetch;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : FETCH_TIMEOUT_MS;
    this.refreshMs = Number.isFinite(opts.refreshMs) && opts.refreshMs > 0 ? opts.refreshMs : REFRESH_MS;
    this.deviceName = String(opts.deviceName || os.hostname() || 'PC').slice(0, 60);
    this.deviceHash = typeof opts.deviceHash === 'string' && HASH_RE.test(opts.deviceHash) ? opts.deviceHash : null;

    this.cert = null; // { certificate, payload } — kept after `exp` so the file can still be renewed
    this.email = null;
    this.refreshToken = null;
    this.offline = false;
    this.lastError = null;
    this._queue = Promise.resolve();
    this._busy = 0;
    this._timer = null;
    this._expiryTimer = null;
    this._closed = false;
  }

  /** Gate open: test bypass, developer build, or a valid certificate for this PC. */
  isLicensed() {
    if (this.bypass || this.devMode) return true;
    return Boolean(this.cert && this.cert.payload.exp * 1000 > this.now());
  }

  /** State for GET /api/license (local page only). */
  state() {
    const licensed = this.isLicensed();
    const mode = this.bypass ? 'bypass' : this.devMode ? 'dev' : licensed ? 'active' : 'locked';
    const certEmail = this.cert && typeof this.cert.payload.email === 'string' ? this.cert.payload.email : null;
    return {
      licensed,
      mode,
      devMode: this.devMode,
      email: mode === 'active' || mode === 'locked' ? certEmail || this.email : null,
      expiresAt: mode === 'active' ? this.cert.payload.exp * 1000 : null,
      offline: mode === 'active' ? this.offline : false,
      error: mode === 'locked' ? this.lastError : null,
      siteUrl: this.siteUrl,
      accountUrl: `${this.siteUrl}/compte.html`,
    };
  }

  /** Computes the device hash and loads ~/.pixelqg/license.json (no network). */
  async init() {
    if (this.bypass || this.devMode) return this.state();
    if (!this.deviceHash) this.deviceHash = await computeDeviceHash();
    await this._load();
    this._armExpiry();
    return this.state();
  }

  /** Renews now (when a session is stored) and then every 6 h. */
  startAutoRefresh() {
    if (this.bypass || this.devMode || this._timer || this._closed) return;
    this._timer = setInterval(() => this.refresh().catch(() => {}), this.refreshMs);
    this._timer.unref();
    if (this.refreshToken) this.refresh().catch(() => {});
  }

  /** Resolves once no login / refresh / logout is running (or after `ms`). */
  whenIdle(ms) {
    if (!this._busy) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this._queue.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Signs in (Supabase password grant), then activates this PC (`license` activate). */
  login(email, password) {
    return this._exclusive(async () => {
      this._assertCloud();
      const mail = typeof email === 'string' ? email.trim() : '';
      if (!mail || typeof password !== 'string' || !password) throw new LicenseError(400, MSG.missing, 'missing_fields');
      if (mail.length > 320 || !EMAIL_RE.test(mail)) throw new LicenseError(400, MSG.badEmail, 'invalid_email');
      if (password.length > 1024) throw new LicenseError(400, MSG.wrongPassword, 'invalid_credentials');
      const session = await this._authToken('password', { email: mail, password });
      await this._activate(session, mail);
      return this.state();
    });
  }

  /** Renews the session (refresh_token grant) and the certificate. Keeps working offline until `exp`. */
  refresh() {
    if (this.bypass || this.devMode) return Promise.resolve(this.state());
    return this._exclusive(async () => {
      if (!this.refreshToken || !this.supabaseReady()) {
        this._checkExpiry();
        return this.state();
      }
      try {
        const session = await this._authToken('refresh_token', { refresh_token: this.refreshToken });
        // Supabase rotates refresh tokens: store the new one before anything else can fail.
        this.refreshToken = session.refreshToken;
        await this._persist().catch((err) => console.error('[licence]', MSG.saveFailed, err && err.message));
        await this._activate(session, null);
      } catch (err) {
        if (!(err instanceof LicenseError)) throw err;
        if (DEFINITIVE.has(err.code)) {
          await this._drop(err.message);
        } else {
          this.offline = err.code === 'offline' || err.code === 'timeout';
          this.lastError = err.message;
          this._checkExpiry();
          this._changed();
        }
        throw err;
      }
      return this.state();
    });
  }

  /** Releases this PC (`license` release), then deletes the local file — even when offline. */
  logout() {
    return this._exclusive(async () => {
      if (this.bypass || this.devMode) throw new LicenseError(409, MSG.notConfigured, 'not_configured');
      let released = false;
      if (this.refreshToken && this.supabaseReady()) {
        try {
          const session = await this._authToken('refresh_token', { refresh_token: this.refreshToken });
          await this._callLicense(session.accessToken, 'release');
          released = true;
        } catch (err) {
          if (!(err instanceof LicenseError)) console.error('[licence]', err && err.stack ? err.stack : err);
        }
      }
      await fsp.rm(this.file, { force: true });
      this.cert = null;
      this.email = null;
      this.refreshToken = null;
      this.offline = false;
      this.lastError = null;
      this._armExpiry();
      this._changed();
      return { released, message: released ? MSG.released : MSG.notReleased, license: this.state() };
    });
  }

  close() {
    this._closed = true;
    clearInterval(this._timer);
    clearTimeout(this._expiryTimer);
    this._timer = null;
    this._expiryTimer = null;
  }

  supabaseReady() {
    return CLOUD_URL_RE.test(this.supabaseUrl) && this.anonKey.length > 0;
  }

  // ---------------------------------------------------------------- internals

  _assertCloud() {
    if (this.bypass || this.devMode || !this.supabaseReady()) throw new LicenseError(503, MSG.notConfigured, 'not_configured');
  }

  /** Runs account operations one at a time (a background refresh never races a logout). */
  _exclusive(fn) {
    this._busy++;
    const run = this._queue.then(() => fn());
    this._queue = run.then(() => {}, () => {}).finally(() => {
      this._busy--;
    });
    return run;
  }

  _verify(certificate) {
    return verifyCertificate(certificate, { publicKey: this.publicKey, deviceHash: this.deviceHash, now: this.now() });
  }

  async _load() {
    let data;
    try {
      const st = await fsp.stat(this.file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
      data = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch {
      return; // no licence stored yet (or unreadable): login required
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const v = this._verify(data.certificate);
    // A file from another PC, or a tampered one, is ignored as a whole (its session included).
    if (!v.ok && v.reason !== 'expired') return;
    this.cert = { certificate: data.certificate, payload: v.payload };
    this.email = typeof data.email === 'string' ? data.email.slice(0, 320) : null;
    this.refreshToken = typeof data.refresh_token === 'string' && data.refresh_token.length <= 4096 ? data.refresh_token : null;
    if (!v.ok) this.lastError = this.refreshToken ? MSG.expired : MSG.sessionExpired;
  }

  async _persist() {
    const data = {
      certificate: this.cert ? this.cert.certificate : null,
      email: this.email,
      refresh_token: this.refreshToken,
    };
    const text = JSON.stringify(data, null, 2) + '\n';
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await fsp.writeFile(tmp, text, { mode: 0o600 });
      await fsp.rename(tmp, this.file);
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      await fsp.writeFile(this.file, text, { mode: 0o600 });
    }
    await fsp.chmod(this.file, 0o600).catch(() => {});
  }

  async _drop(message) {
    this.cert = null;
    this.refreshToken = null;
    this.offline = false;
    this.lastError = message;
    await fsp.rm(this.file, { force: true }).catch(() => {});
    this._armExpiry();
    this._changed();
  }

  _armExpiry() {
    clearTimeout(this._expiryTimer);
    this._expiryTimer = null;
    if (this._closed || !this.cert || !this.isLicensed()) return;
    const ms = this.cert.payload.exp * 1000 - this.now();
    this._expiryTimer = setTimeout(() => this._checkExpiry(true), Math.min(Math.max(ms, 0) + 100, MAX_TIMER_MS));
    this._expiryTimer.unref();
  }

  _checkExpiry(notify) {
    if (this.cert && !this.isLicensed()) {
      if (!this.lastError) this.lastError = MSG.expired;
      if (notify) this._changed();
    } else {
      this._armExpiry();
    }
  }

  _changed() {
    this.emit('change', this.state());
  }

  async _post(url, body, headers) {
    if (typeof this.fetch !== 'function') throw new LicenseError(503, MSG.offline, 'offline');
    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch (err) {
      const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw timeout ? new LicenseError(504, MSG.timeout, 'timeout') : new LicenseError(503, MSG.offline, 'offline');
    }
  }

  /** Supabase Auth REST: POST /auth/v1/token?grant_type=password|refresh_token. */
  async _authToken(grant, body) {
    const url = `${this.supabaseUrl}/auth/v1/token?grant_type=${grant}`;
    const { status, json } = await this._post(url, body, { apikey: this.anonKey });
    if (status === 200 && json && typeof json.access_token === 'string' && typeof json.refresh_token === 'string') {
      const email = json.user && typeof json.user.email === 'string' ? json.user.email : null;
      return { accessToken: json.access_token, refreshToken: json.refresh_token, email };
    }
    if (status === 429) throw new LicenseError(429, MSG.rateLimited, 'rate_limited');
    if (status >= 400 && status < 500) {
      if (grant !== 'password') throw new LicenseError(403, MSG.sessionExpired, 'session_expired');
      const code = json ? String(json.error_code || json.code || json.error || '') : '';
      const text = json ? String(json.msg || json.error_description || json.message || '') : '';
      if (code === 'email_not_confirmed' || /not confirmed/i.test(text)) {
        throw new LicenseError(403, MSG.emailNotConfirmed, 'email_not_confirmed');
      }
      throw new LicenseError(400, MSG.wrongPassword, 'invalid_credentials');
    }
    throw new LicenseError(502, MSG.cloudError(status), 'cloud_error');
  }

  /** Edge Function `license`: { action, device_hash, device_name } with the user's JWT. */
  async _callLicense(accessToken, action) {
    const url = `${this.supabaseUrl}/functions/v1/license`;
    const body = { action, device_hash: this.deviceHash, device_name: this.deviceName };
    const { status, json } = await this._post(url, body, { apikey: this.anonKey, Authorization: `Bearer ${accessToken}` });
    if (status === 200 && json && typeof json === 'object') return json;
    if (status === 402) throw new LicenseError(402, MSG.noLicense, 'no_license');
    if (status === 409) throw new LicenseError(409, MSG.tooManyDevices, 'too_many_devices');
    if (status === 401 || status === 403) throw new LicenseError(403, MSG.sessionExpired, 'session_expired');
    if (status === 429) throw new LicenseError(429, MSG.rateLimited, 'rate_limited');
    throw new LicenseError(502, MSG.cloudError(status), 'cloud_error');
  }

  async _activate(session, emailHint) {
    const json = await this._callLicense(session.accessToken, 'activate');
    const v = this._verify(json.certificate);
    if (!v.ok) throw new LicenseError(502, MSG.badCertificate, 'bad_certificate');
    const certEmail = typeof v.payload.email === 'string' && v.payload.email ? v.payload.email : null;
    this.cert = { certificate: json.certificate, payload: v.payload };
    this.email = certEmail || session.email || emailHint || this.email;
    this.refreshToken = session.refreshToken;
    this.offline = false;
    this.lastError = null;
    try {
      await this._persist();
    } catch (err) {
      // The licence still works for this run; the next start will ask to sign in again.
      console.error('[licence]', `${MSG.saveFailed} (${this.file}) :`, err && err.message ? err.message : err);
    }
    this._armExpiry();
    this._changed();
  }
}

module.exports = {
  LicenseManager,
  LicenseError,
  verifyCertificate,
  computeDeviceHash,
  readMachineGuid,
  parseMachineGuid,
  fallbackDeviceId,
  hashDevice,
  isPlaceholderConfig,
  REFRESH_MS,
};
