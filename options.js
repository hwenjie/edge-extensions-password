'use strict';
const C = SyncCore;
const $ = id => document.getElementById(id);
let dirty = false, running = false;
let savedConfig = null;
function feedback(message, error = false) { $('feedback').textContent = message; $('feedback').dataset.error = String(error); }
function configFromForm() {
  const config = C.normalizeConfig({ directoryUrl: $('url').value, username: $('username').value,
    password: $('password').value, passphrase: $('passphrase').value,
    autoSync: $('autoSync').checked, allowHttp: $('allowHttp').checked });
  if (savedConfig && config.directoryUrl === savedConfig.directoryUrl) config.url = savedConfig.url;
  return config;
}
function buttons() {
  document.querySelectorAll('input').forEach(input => { input.disabled = running; });
  document.querySelectorAll('button').forEach(button => {
    button.disabled = running || (dirty && ['sync', 'test', 'upload', 'download'].includes(button.id));
  });
  $('dirtyHint').hidden = !dirty;
}
async function send(action, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'webdav', action, ...fields });
  if (!response?.ok) throw new Error(response?.error || '后台没有响应，请重新打开设置页');
  return response;
}
async function run(task) {
  if (running) return;
  running = true; buttons(); feedback('正在处理，请稍候…');
  try { const result = await task(); if (result?.message) feedback(result.message); }
  catch (error) { feedback(error.message, true); }
  finally { running = false; buttons(); await refresh(); }
}
function formatTime(value) { return new Date(value).toLocaleString('zh-CN'); }
async function refresh() {
  const all = await chrome.storage.local.get([C.CONFIG, C.STATE, C.BACKUP]);
  const state = all[C.STATE] || {};
  $('statusTitle').textContent = state.error ? '需要处理' : all[C.CONFIG] ? '已配置' : '尚未配置';
  $('lastSuccess').textContent = state.lastSuccess ? '上次成功：' + formatTime(state.lastSuccess) : '还没有成功同步记录';
  $('backupInfo').textContent = all[C.BACKUP] ? `最近备份：${formatTime(all[C.BACKUP].createdAt)} · ${all[C.BACKUP].source} · ${C.summary(all[C.BACKUP].data).accounts} 个账号` : '暂无覆盖前备份';
}
$('configForm').addEventListener('input', () => { dirty = true; buttons(); });
$('configForm').addEventListener('submit', event => {
  event.preventDefault();
  let config, permission;
  // Permission request must happen directly in the click/submit user gesture.
  try { config = configFromForm(); permission = chrome.permissions.request({ origins: [C.originPattern(config.url)] }); }
  catch (error) { feedback(error.message, true); return; }
  run(async () => {
    if (!await permission) throw new Error('未授予站点访问权限，配置未保存');
    const result = await send('save', { config });
    savedConfig = config;
    $('url').value = config.directoryUrl;
    $('legacyFileHint').hidden = config.url === new URL('vault.json', config.directoryUrl).href;
    dirty = false; return result;
  });
});
$('test').addEventListener('click', () => run(() => send('test')));
$('sync').addEventListener('click', () => run(() => send('sync')));
function count(value) { return value ? `${value.sites} 个站点、${value.accounts} 个账号` : '文件不存在'; }
for (const action of ['upload', 'download']) {
  $(action).addEventListener('click', () => run(async () => {
    const preview = await send('preview');
    if (action === 'download' && !preview.remote) throw new Error('云端文件不存在，不能下载');
    if (action === 'upload' && preview.remote && !preview.hasEtag) throw new Error('服务器未提供强 ETag，无法安全覆盖云端');
    const question = `本地：${count(preview.local)}\n云端：${count(preview.remote)}\n\n` +
      (action === 'upload' ? '用本地整份密码库覆盖云端？' : '用云端整份密码库覆盖本地？') + '\n被覆盖的数据会保留为本机的最近一次备份。';
    if (!confirm(question)) return { message: '已取消覆盖' };
    return send(action, { token: preview.token });
  }));
}
$('restore').addEventListener('click', () => run(async () => {
  const { [C.BACKUP]: backup } = await chrome.storage.local.get(C.BACKUP);
  if (!backup) throw new Error('没有可恢复的备份');
  if (!confirm(`恢复 ${formatTime(backup.createdAt)} 的${backup.source}备份（${C.summary(backup.data).accounts} 个账号）？\n当前本地库会被替换，自动同步将关闭。`)) return { message: '已取消恢复' };
  const result = await send('restore', { token: await C.hash(backup) });
  $('autoSync').checked = false;
  return result;
}));
$('exportBackup').addEventListener('click', () => run(async () => {
  const { [C.BACKUP]: backup } = await chrome.storage.local.get(C.BACKUP);
  if (!backup) throw new Error('没有可导出的备份');
  if (!confirm('备份将以明文 JSON 导出，请妥善保存。是否继续？')) return { message: '已取消导出' };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup.data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'passwords_before_sync.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { message: '覆盖前备份已导出' };
}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  refresh();
  if (changes[C.STATE] && !running) {
    const state = changes[C.STATE].newValue || {};
    feedback(state.error || state.message || '配置已更新', !!state.error);
  }
});
(async function initialize() {
  const all = await chrome.storage.local.get([C.CONFIG, C.STATE]);
  const config = all[C.CONFIG];
  if (config) {
    savedConfig = C.normalizeConfig(config);
    $('url').value = savedConfig.directoryUrl;
    for (const key of ['username', 'password', 'passphrase']) $(key).value = config[key] || '';
    $('legacyFileHint').hidden = savedConfig.url === new URL('vault.json', savedConfig.directoryUrl).href;
    for (const key of ['autoSync', 'allowHttp']) $(key).checked = !!config[key];
    const state = all[C.STATE] || {};
    feedback(state.error || state.message || '配置已保存，可以开始同步', !!state.error);
  }
  await refresh();
})().catch(error => feedback(error.message, true));
