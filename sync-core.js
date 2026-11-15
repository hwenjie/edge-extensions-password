/* Shared by the options page, service worker, and Node regression tests. */
(function (root) {
  'use strict';
  const PREFIX = '__webdav';
  const CONFIG = PREFIX + 'Config';
  const STATE = PREFIX + 'State';
  const BACKUP = PREFIX + 'Backup';
  const MAX_BYTES = 4 * 1024 * 1024;
  const ITERATIONS = 310000;
  const encoder = new TextEncoder();
  const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const unsafe = key => ['__proto__', 'prototype', 'constructor'].includes(key) || key.startsWith(PREFIX);
  function validateData(data, { forSync = true } = {}) {
    if (!plainObject(data)) throw new Error('密码库必须是 JSON 对象');
    for (const [key, value] of Object.entries(data)) {
      if (!key || unsafe(key)) throw new Error('密码库含有保留字段');
      if (key === 'siteRelations') {
        if (!plainObject(value)) throw new Error('站点关联格式错误');
        const seen = new Set();
        for (const [site, group] of Object.entries(value)) {
          if (unsafe(site) || !Array.isArray(group) || group.length < 2 || group[0] !== site ||
              group.some(s => typeof s !== 'string' || !s || unsafe(s))) throw new Error('站点关联格式错误');
          for (const s of group) {
            if (seen.has(s)) throw new Error('站点关联重复或交叉，请先修正关联');
            seen.add(s);
          }
        }
      } else if (key === 'domainRules') {
        if (!plainObject(value)) throw new Error('自定义规则格式错误');
        for (const [site, rule] of Object.entries(value)) {
          if (unsafe(site) || !plainObject(rule) || typeof rule.usernameSelector !== 'string' ||
              typeof rule.passwordSelector !== 'string') throw new Error('自定义规则格式错误');
        }
      } else if (!Array.isArray(value) || value.some(a => !plainObject(a) ||
        typeof a.username !== 'string' || typeof a.password !== 'string' ||
        (a.note !== undefined && typeof a.note !== 'string'))) {
        throw new Error('账号数据格式错误');
      }
    }
    if (forSync && encoder.encode(JSON.stringify(data)).length > MAX_BYTES) throw new Error('密码库超过 4 MB，无法同步');
    return data;
  }

  // v1.0.3 looked up a site in group arrays in order and used the first
  // matching array's first member. Its dictionary key could become stale.
  function readLocalData(data, { forSync = false } = {}) {
    if (plainObject(data) && plainObject(data.siteRelations)) {
      const owner = new Map();
      for (const [key, group] of Object.entries(data.siteRelations)) {
        if (unsafe(key) || !Array.isArray(group) || group.some(site =>
          typeof site !== 'string' || !site || unsafe(site))) throw new Error('站点关联格式错误');
        for (const site of group) {
          if (!owner.has(site)) owner.set(site, group[0]);
        }
      }
      const groups = new Map();
      for (const [site, primary] of owner) {
        if (site === primary) continue;
        if (owner.get(primary) !== primary) {
          throw new Error('旧备份的主站点同时属于另一组。请在备份副本的 siteRelations 中确认主站点后重试');
        }
        if (!groups.has(primary)) groups.set(primary, [primary]);
        groups.get(primary).push(site);
      }
      data = { ...data, siteRelations: Object.fromEntries(groups) };
    }
    return validateData(data, { forSync });
  }
  function pickData(storage) {
    return Object.fromEntries(Object.entries(storage).filter(([key]) => !key.startsWith(PREFIX)));
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (plainObject(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function hash(data) {
    return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical(data)))));
  }
  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  function fromBase64(text) {
    if (typeof text !== 'string') throw new Error('加密文件格式错误');
    return Uint8Array.from(atob(text), c => c.charCodeAt(0));
  }
  async function keyFor(passphrase, salt) {
    const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(data, passphrase) {
    validateData(data);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(passphrase, salt);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(data)));
    return JSON.stringify({ format: 'edge-password-webdav', version: 1, cipher: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) });
  }
  async function decrypt(text, passphrase) {
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw new Error('云端文件不是有效的 JSON'); }
    if (envelope?.format !== 'edge-password-webdav' || envelope.version !== 1 ||
        envelope.cipher !== 'AES-256-GCM' || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== ITERATIONS) {
      throw new Error('云端文件不是此插件支持的加密密码库，请检查文件地址');
    }
    let decoded;
    try {
      const salt = fromBase64(envelope.salt), iv = fromBase64(envelope.iv), data = fromBase64(envelope.data);
      if (salt.length !== 16 || iv.length !== 12 || data.length > MAX_BYTES + 16) throw new Error();
      const key = await keyFor(passphrase, salt);
      decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    } catch { throw new Error('解密失败：同步口令不一致，或云端文件已损坏'); }
    return validateData(JSON.parse(new TextDecoder().decode(decoded)));
  }
  function normalizeConfig(config) {
    const directoryMode = typeof config.directoryUrl === 'string';
    let url;
    try { url = new URL((directoryMode ? config.directoryUrl : config.url).trim()); }
    catch { throw new Error('请输入完整的 WebDAV 目录 URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('地址必须是 HTTP(S) 地址，不能带账号、查询参数或片段');
    }
    if (directoryMode) {
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      const directory = url.href;
      // Keep the exact target of an existing configuration, including custom
      // filenames, when saving unrelated settings in the same directory.
      if (config.url) {
        const previous = new URL(config.url);
        if (previous.username || previous.password || previous.search || previous.hash ||
            previous.pathname.endsWith('/') || new URL('.', previous).href !== directory) {
          throw new Error('已有同步文件与目录不一致，请重新填写目录');
        }
        url = previous;
      } else {
        url = new URL('vault.json', url);
      }
    } else if (url.pathname.endsWith('/')) {
      throw new Error('旧版同步文件地址无效，请重新填写 WebDAV 目录');
    }
    if (!config.username || /[:\r\n]/.test(config.username) || !config.password) throw new Error('请输入有效的 WebDAV 用户名和密码／应用密码');
    if (typeof config.passphrase !== 'string' || config.passphrase.length < 12) throw new Error('同步加密口令至少需要 12 个字符');
    if (url.protocol === 'http:' && !config.allowHttp) throw new Error('HTTP 会明文传输 WebDAV 登录凭据，请使用 HTTPS 或明确允许 HTTP');
    return { url: url.href, directoryUrl: new URL('.', url).href, username: config.username, password: config.password,
      passphrase: config.passphrase, allowHttp: !!config.allowHttp, autoSync: !!config.autoSync };
  }
  function originPattern(url) { const u = new URL(url); return u.protocol + '//' + u.hostname + '/*'; }
  function summary(data) {
    return { sites: Object.keys(data).filter(k => !['siteRelations', 'domainRules'].includes(k)).length,
      accounts: Object.entries(data).reduce((n, [k, v]) => n + (Array.isArray(v) ? v.length : 0), 0) };
  }
  function isEmpty(data) {
    return Object.values(data).every(v => Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
  }
  function direction(localHash, remoteHash, baseline, emptyLocal) {
    if (localHash === remoteHash) return 'same';
    if (!remoteHash) return baseline ? 'conflict' : 'upload';
    if (!baseline) return emptyLocal ? 'download' : 'conflict';
    if (remoteHash === baseline) return 'upload';
    if (localHash === baseline) return 'download';
    return 'conflict';
  }
  root.SyncCore = { PREFIX, CONFIG, STATE, BACKUP, MAX_BYTES, validateData, readLocalData, pickData, hash,
    encrypt, decrypt, normalizeConfig, originPattern, summary, isEmpty, direction, toBase64 };
  if (typeof module !== 'undefined') module.exports = root.SyncCore;
})(globalThis);
