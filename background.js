/* Network and sync operations live in MV3's service worker. */
importScripts('sync-core.js');
const C = SyncCore;
const ALARM = 'webdav-sync';
let busy = false;
const popups = new Set();

function trusted(sender, page) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(page);
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'password-popup' || !trusted(port.sender, 'popup.html')) return;
  popups.add(port);
  port.postMessage({ busy });
  port.onDisconnect.addListener(() => popups.delete(port));
});
function notifyPopups() {
  for (const port of popups) { try { port.postMessage({ busy }); } catch { popups.delete(port); } }
}
async function configureAlarm() {
  const { [C.CONFIG]: config } = await chrome.storage.local.get(C.CONFIG);
  if (config?.autoSync) {
    if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 15 });
  } else await chrome.alarms.clear(ALARM);
}
chrome.runtime.onInstalled.addListener(() => { configureAlarm().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { configureAlarm().catch(console.error); });
// Alarms can be lost across restarts; check on every worker start too.
configureAlarm().catch(console.error);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) return handle({ action: 'sync' }, true).catch(() => {});
});

async function request(config, method, extra = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(config.url, { method, cache: 'no-store', credentials: 'omit', redirect: 'error',
      signal: controller.signal, ...extra, headers: {
        Authorization: 'Basic ' + C.toBase64(new TextEncoder().encode(config.username + ':' + config.password)),
        ...extra.headers
      } });
    if (![200, 201, 204, 404].includes(response.status)) {
      const hints = { 401: '用户名或密码错误', 403: '服务器拒绝访问，请检查目录权限和 WebDAV 应用权限', 405: '服务器不支持此操作',
        409: '父目录不存在，请先在 WebDAV 中创建目录', 412: '云端文件刚被另一台设备修改，请重新同步',
        413: '服务器拒绝过大的文件', 423: '云端文件被锁定，请稍后重试', 507: '服务器空间不足' };
      throw new Error(`WebDAV ${response.status}：${hints[response.status] || '服务器请求失败'}`);
    }
    // Keep the timeout active until the entire body has been consumed.
    let text = '';
    if (method === 'GET' && response.ok) {
      if (Number(response.headers.get('Content-Length')) > C.MAX_BYTES * 1.5) throw new Error('云端文件过大');
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > C.MAX_BYTES * 1.5) { await reader.cancel(); throw new Error('云端文件过大'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      text = new TextDecoder().decode(bytes);
    }
    return { status: response.status, etag: response.headers.get('ETag'), text };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时，请检查 WebDAV 地址和网络');
    if (error instanceof TypeError) throw new Error('连接失败，请检查网络、证书、站点授权及地址是否发生重定向');
    throw error;
  } finally { clearTimeout(timeout); }
}
async function snapshot(config) {
  const all = await chrome.storage.local.get(null);
  const local = C.readLocalData(C.pickData(all), { forSync: true });
  const remoteResponse = await request(config, 'GET');
  const remote = remoteResponse.status === 404 ? null : await C.decrypt(remoteResponse.text, config.passphrase);
  return { local, remote, localHash: await C.hash(local), remoteHash: remote === null ? null : await C.hash(remote),
    etag: remoteResponse.etag, baseline: all[C.STATE]?.baseline || null };
}
async function backup(data, source) {
  await chrome.storage.local.set({ [C.BACKUP]: { data, source, createdAt: new Date().toISOString() } });
}
async function replaceLocal(data) {
  C.validateData(data, { forSync: false });
  const old = C.pickData(await chrome.storage.local.get(null));
  // Single set records rollback first; never clear storage before a successful write.
  await chrome.storage.local.set({ ...data, [C.BACKUP]: { data: old, source: '本地', createdAt: new Date().toISOString() } });
  const removed = Object.keys(old).filter(k => !Object.hasOwn(data, k));
  try { if (removed.length) await chrome.storage.local.remove(removed); }
  catch (error) {
    await chrome.storage.local.set(old);
    await chrome.storage.local.remove(Object.keys(data).filter(k => !Object.hasOwn(old, k)));
    throw error;
  }
}
async function saveState(values) {
  const { [C.STATE]: previous = {} } = await chrome.storage.local.get(C.STATE);
  await chrome.storage.local.set({ [C.STATE]: { ...previous, ...values } });
}
async function perform(config, action, expected) {
  const snap = await snapshot(config);
  if (action === 'preview') return { local: C.summary(snap.local), remote: snap.remote === null ? null : C.summary(snap.remote),
    token: { localHash: snap.localHash, remoteHash: snap.remoteHash }, hasEtag: !!snap.etag && !snap.etag.startsWith('W/') };
  let direction = C.direction(snap.localHash, snap.remoteHash, snap.baseline, C.isEmpty(snap.local));
  if (['upload', 'download'].includes(action)) {
    if (!expected || expected.localHash !== snap.localHash || expected.remoteHash !== snap.remoteHash) {
      throw new Error('确认后数据已变化，请重新查看并确认覆盖');
    }
    direction = action;
  }
  if (direction === 'conflict') throw new Error('同步冲突：两端不同或云端文件已删除。请先导出备份，再选择保留本地或云端。');
  if (direction === 'upload') {
    if (snap.remote !== null && (!snap.etag || snap.etag.startsWith('W/'))) {
      throw new Error('服务器未提供强 ETag，无法安全覆盖云端。请使用支持 ETag / If-Match 的 WebDAV 服务。');
    }
    if (snap.remote !== null) await backup(snap.remote, '云端');
    const body = await C.encrypt(snap.local, config.passphrase);
    const result = await request(config, 'PUT', { body, headers: { 'Content-Type': 'application/json',
      ...(snap.remote === null ? { 'If-None-Match': '*' } : { 'If-Match': snap.etag }) } });
    if (result.status === 404) throw new Error('上传失败：文件父目录不存在，请先创建目录');
    // Verify content, not just the status code. Do not advance baseline after failed writes.
    const verified = await request(config, 'GET');
    if (verified.status === 404 || await C.hash(await C.decrypt(verified.text, config.passphrase)) !== snap.localHash) {
      throw new Error('上传后校验失败，云端可能同时被修改，请重新同步');
    }
  } else if (direction === 'download') {
    if (snap.remote === null) throw new Error('云端还没有同步文件');
    await replaceLocal(snap.remote);
  }
  const message = { same: '两端数据一致，无需同步', upload: '本地数据已加密上传', download: '云端数据已下载到本地' }[direction];
  await saveState({ baseline: direction === 'download' ? snap.remoteHash : snap.localHash,
    lastSuccess: new Date().toISOString(), lastAttempt: new Date().toISOString(), message, error: '' });
  await chrome.action.setBadgeText({ text: '' });
  return { message };
}
async function handle(message, automatic = false) {
  if (busy) throw new Error('已有同步操作正在进行，请稍后重试');
  if (popups.size) {
    if (automatic) return { message: '使用密码面板期间跳过本次自动同步' };
    throw new Error('请先关闭插件的账号弹出面板，再进行同步操作');
  }
  busy = true;
  try {
    if (message.action === 'save') {
      const config = C.normalizeConfig(message.config);
      if (!await chrome.permissions.contains({ origins: [C.originPattern(config.url)] })) throw new Error('尚未授予 WebDAV 站点访问权限');
      const { [C.CONFIG]: old } = await chrome.storage.local.get(C.CONFIG);
      const changed = !old || old.url !== config.url || old.username !== config.username || old.passphrase !== config.passphrase;
      await chrome.storage.local.set({ [C.CONFIG]: config, ...(changed ? { [C.STATE]: {} } : {}) });
      await configureAlarm();
      return { message: '配置已保存' };
    }
    if (message.action === 'restore') {
      const all = await chrome.storage.local.get(null);
      if (!all[C.BACKUP]) throw new Error('没有可恢复的备份');
      if (!message.token || message.token !== await C.hash(all[C.BACKUP])) throw new Error('备份已变化，请重新确认');
      const restored = C.readLocalData(all[C.BACKUP].data);
      // Disable autosync before restoring, to avoid immediately uploading the restored copy.
      if (all[C.CONFIG]) await chrome.storage.local.set({ [C.CONFIG]: { ...all[C.CONFIG], autoSync: false } });
      await configureAlarm();
      await replaceLocal(restored);
      await chrome.storage.local.set({ [C.STATE]: { message: '已恢复备份，自动同步已关闭；下次同步请核对两端数据' } });
      return { message: '已恢复备份，自动同步已关闭' };
    }
    const { [C.CONFIG]: saved } = await chrome.storage.local.get(C.CONFIG);
    if (!saved) throw new Error('请先保存 WebDAV 配置');
    const config = C.normalizeConfig(saved);
    if (automatic && !config.autoSync) return {};
    if (!await chrome.permissions.contains({ origins: [C.originPattern(config.url)] })) throw new Error('WebDAV 站点访问权限已撤销，请重新保存配置并授权');
    if (message.action === 'test') {
      const response = await request(config, 'GET');
      if (response.status === 404) return { message: '已收到服务器响应，但文件不存在；尚未验证父目录和写权限，首次同步将尝试创建文件' };
      await C.decrypt(response.text, config.passphrase);
      return { message: '连接成功，云端密码库可以读取和解密；写权限将在上传时验证' };
    }
    return await perform(config, message.action, message.token);
  } catch (error) {
    if (message.action !== 'save' && message.action !== 'preview') {
      await saveState({ lastAttempt: new Date().toISOString(), error: error.message });
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    }
    throw error;
  } finally { busy = false; notifyPopups(); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!trusted(sender, 'options.html') || message?.type !== 'webdav' ||
      !['save', 'test', 'sync', 'preview', 'upload', 'download', 'restore'].includes(message.action)) return;
  handle(message).then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
  return true;
});
