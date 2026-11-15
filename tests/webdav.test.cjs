const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const C = require(path.join(root, 'sync-core.js'));
const account = (password = 'secret') => ({ 'example.com': [{ username: '测试用户 <img onerror=alert(1)>', password, note: '中文备注' }],
  siteRelations: { 'example.com': ['example.com', 'test.example.com'] },
  domainRules: { 'example.com': { usernameSelector: '#user', passwordSelector: '#pass' } } });
let server, url, remote = null, etag = 0, requests = [], rejectPut = false, weakEtag = false, forcedStatus = null;
before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (forcedStatus) { res.writeHead(forcedStatus); return res.end(); }
    if (req.headers.authorization !== 'Basic ' + Buffer.from('test:app-password').toString('base64')) { res.writeHead(401); return res.end(); }
    if (req.method === 'GET') {
      if (remote === null) { res.writeHead(404); return res.end(); }
      res.writeHead(200, weakEtag ? {} : { ETag: `"${etag}"` }); return res.end(remote);
    }
    if (req.method === 'PUT') {
      if (rejectPut || (req.headers['if-none-match'] === '*' && remote !== null) ||
          (req.headers['if-match'] && req.headers['if-match'] !== `"${etag}"`)) { res.writeHead(412); return res.end(); }
      remote = body; etag++; res.writeHead(201); return res.end();
    }
    res.writeHead(405); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/vault.json`;
});
after(() => new Promise(resolve => server.close(resolve)));
function device(initial = {}) {
  const data = structuredClone(initial), listeners = {}, alarms = new Map();
  let failSet = false;
  const event = key => ({ addListener: fn => { listeners[key] = fn; } });
  const chrome = {
    runtime: { id: 'test-id', getURL: file => 'chrome-extension://test-id/' + file,
      onMessage: event('message'), onConnect: event('connect'), onInstalled: event('install'), onStartup: event('startup') },
    storage: { local: {
      get: async keys => {
        if (keys === null) return structuredClone(data);
        if (typeof keys === 'string') keys = [keys];
        return structuredClone(Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])));
      },
      set: async values => { if (failSet && values[C.BACKUP]) throw new Error('QUOTA_BYTES quota exceeded'); Object.assign(data, structuredClone(values)); },
      remove: async keys => { for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]; }
    } },
    permissions: { contains: async () => true },
    alarms: { onAlarm: event('alarm'), get: async key => alarms.get(key), create: async (key, value) => alarms.set(key, value), clear: async key => alarms.delete(key) },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
  };
  const context = vm.createContext({ chrome, console, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, AbortController,
    Uint8Array, btoa, atob, setTimeout, clearTimeout, fetch, TypeError });
  context.importScripts = name => vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  async function call(action, fields = {}, sender = { id: 'test-id', url: chrome.runtime.getURL('options.html') }) {
    return new Promise((resolve, reject) => {
      const accepted = listeners.message({ type: 'webdav', action, ...fields }, sender, response => response.ok ? resolve(response) : reject(new Error(response.error)));
      if (!accepted) reject(new Error('Rejected sender'));
    });
  }
  return { data, call, listeners, chrome, alarms, failQuota: () => { failSet = true; } };
}
const config = () => ({ url, username: 'test', password: 'app-password', passphrase: 'a-long-sync-passphrase', autoSync: false, allowHttp: true });
async function setup(data = {}) { const d = device(data); await d.call('save', { config: config() }); return d; }
function reset() { remote = null; etag = 0; requests = []; rejectPut = false; weakEtag = false; forcedStatus = null; }

test('加密往返、随机盐、中文数据、错误口令、格式校验', async () => {
  const input = account();
  const a = await C.encrypt(input, config().passphrase), b = await C.encrypt(input, config().passphrase);
  assert.notEqual(a, b); assert.ok(!a.includes('secret')); assert.ok(!a.includes('example.com'));
  assert.deepEqual(await C.decrypt(a, config().passphrase), input);
  await assert.rejects(C.decrypt(a, 'wrong'), /解密失败/);
  await assert.rejects(C.decrypt(JSON.stringify(input), config().passphrase), /不是此插件/);
  const corrupt = JSON.parse(a); corrupt.data = corrupt.data.slice(0, -8) + 'AAAAAAAA';
  await assert.rejects(C.decrypt(JSON.stringify(corrupt), config().passphrase), /解密失败/);
  assert.throws(() => C.validateData({ __webdavConfig: {} }), /保留/);
  assert.throws(() => C.validateData({ 'bad.com': [{ username: 'x' }] }), /账号/);
  assert.deepEqual(C.pickData({ ...input, [C.CONFIG]: { password: 'no-export' }, [C.BACKUP]: {} }), input);
  assert.equal(await C.hash({ a: [], b: [] }), await C.hash({ b: [], a: [] }));
});
test('地址校验与 HTTP 显式授权', () => {
  assert.throws(() => C.normalizeConfig({ ...config(), allowHttp: false }), /HTTP/);
  for (const invalid of ['file:///vault.json', 'https://x.test/dir/', 'https://u:p@x.test/vault.json', 'https://x.test/vault.json?q=1']) {
    assert.throws(() => C.normalizeConfig({ ...config(), url: invalid }));
  }
  assert.throws(() => C.normalizeConfig({ ...config(), passphrase: 'short' }), /12/);
});
test('首次上传、空设备下载、一端修改、删除同步与凭据隔离', async () => {
  reset(); const a = await setup(account());
  assert.match((await a.call('sync')).message, /上传/);
  assert.equal(requests.find(r => r.method === 'PUT').headers['if-none-match'], '*');
  assert.deepEqual(await C.decrypt(remote, config().passphrase), account());
  const b = await setup(); await b.call('sync');
  assert.deepEqual(C.pickData(b.data), account());
  assert.ok(b.data[C.CONFIG]); assert.equal(b.data[C.STATE].baseline, a.data[C.STATE].baseline);
  a.data['example.com'][0].password = 'changed'; await a.call('sync'); await b.call('sync');
  assert.equal(b.data['example.com'][0].password, 'changed');
  delete a.data['example.com']; await a.call('sync'); await b.call('sync');
  assert.equal(b.data['example.com'], undefined);
  assert.equal(b.data[C.BACKUP].data['example.com'][0].password, 'changed');
});
test('首次两端非空和双端修改冲突，确认覆盖与备份恢复', async () => {
  reset(); const a = await setup(account()); await a.call('sync');
  const b = await setup(account('other')); const originalRemote = remote;
  await assert.rejects(b.call('sync'), /冲突/); assert.equal(remote, originalRemote);
  const preview = await b.call('preview'); await b.call('download', { token: preview.token });
  assert.equal(b.data[C.BACKUP].data['example.com'][0].password, 'other');
  a.data['example.com'][0].password = 'from-a'; b.data['example.com'][0].password = 'from-b';
  await a.call('sync'); await assert.rejects(b.call('sync'), /冲突/);
  const overwrite = await b.call('preview'); await b.call('upload', { token: overwrite.token });
  assert.equal(b.data[C.BACKUP].data['example.com'][0].password, 'from-a');
  await b.call('save', { config: { ...config(), autoSync: true } });
  await b.call('restore', { token: await C.hash(b.data[C.BACKUP]) });
  assert.equal(b.data['example.com'][0].password, 'from-a'); assert.equal(b.data[C.CONFIG].autoSync, false);
  assert.equal(b.data[C.STATE].baseline, undefined); assert.equal(b.alarms.size, 0);
});
test('确认后的数据变化和 If-Match 412 都阻止覆盖', async () => {
  reset(); const a = await setup(account()); await a.call('sync'); const preview = await a.call('preview');
  a.data['example.com'][0].password = 'newer';
  await assert.rejects(a.call('upload', { token: preview.token }), /确认后数据已变化/);
  const oldBaseline = a.data[C.STATE].baseline, oldRemote = remote;
  rejectPut = true; await assert.rejects(a.call('sync'), /412/);
  assert.equal(remote, oldRemote); assert.equal(a.data[C.STATE].baseline, oldBaseline);
  assert.equal(a.data['example.com'][0].password, 'newer');
});
test('损坏文件、错误口令、鉴权失败和配额不足均不清空本地', async () => {
  reset(); const a = await setup(account()); await a.call('sync');
  const b = await setup(); await b.call('sync');
  const before = C.pickData(b.data); remote = '{}';
  await assert.rejects(b.call('sync'), /不是此插件/); assert.deepEqual(C.pickData(b.data), before);
  remote = await C.encrypt(account('wrong-key'), 'different-passphrase');
  await assert.rejects(b.call('sync'), /解密失败/); assert.deepEqual(C.pickData(b.data), before);
  forcedStatus = 401; await assert.rejects(b.call('sync'), /401/); forcedStatus = null;
  remote = await C.encrypt(account('remote'), config().passphrase); etag++;
  b.failQuota(); await assert.rejects(b.call('sync'), /quota/); assert.deepEqual(C.pickData(b.data), before);
});
test('远端丢失和缺失 ETag 时拒绝自动覆盖', async () => {
  reset(); const a = await setup(account()); await a.call('sync');
  const saved = remote; remote = null; await assert.rejects(a.call('sync'), /冲突/);
  remote = saved; weakEtag = true; a.data['example.com'][0].password = 'new';
  await assert.rejects(a.call('sync'), /ETag/); assert.equal(remote, saved);
});
test('设置变更重置基线，网络消息拒绝网页来源', async () => {
  reset(); const a = await setup(account()); await a.call('sync');
  await a.call('save', { config: { ...config(), url: url.replace('vault', 'other') } });
  assert.equal(a.data[C.STATE].baseline, undefined);
  await assert.rejects(a.call('sync', {}, { id: 'test-id', url: 'https://example.com' }), /Rejected sender/);
});
test('弹窗使用期间阻止同步；同步期间新弹窗等待完成', async () => {
  reset(); const a = await setup(account());
  let disconnect, messages = [];
  const port = { name: 'password-popup', sender: { id: 'test-id', url: a.chrome.runtime.getURL('popup.html') },
    postMessage: value => messages.push(value), onDisconnect: { addListener: fn => { disconnect = fn; } } };
  a.listeners.connect(port);
  await assert.rejects(a.call('sync'), /关闭插件/); assert.equal(requests.length, 0);
  disconnect();
  const task = a.call('sync'); a.listeners.connect(port);
  assert.equal(messages.at(-1).busy, true); await task; assert.equal(messages.at(-1).busy, false);
});

test('自动同步闹钟与 worker 重启后基线延续', async () => {
  reset(); const a = await setup(account());
  await a.call('save', { config: { ...config(), autoSync: true } });
  assert.equal(a.alarms.get('webdav-sync').periodInMinutes, 15);
  await a.listeners.alarm({ name: 'webdav-sync' });
  assert.ok(remote); const baseline = a.data[C.STATE].baseline;
  const restarted = device(a.data);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarted.alarms.get('webdav-sync').periodInMinutes, 15);
  assert.equal(restarted.data[C.STATE].baseline, baseline);
  restarted.data['example.com'][0].password = 'after-restart';
  await restarted.listeners.alarm({ name: 'webdav-sync' });
  assert.equal((await C.decrypt(remote, config().passphrase))['example.com'][0].password, 'after-restart');
  await restarted.call('save', { config: { ...config(), autoSync: false } });
  const requestCount = requests.length;
  await restarted.listeners.alarm({ name: 'webdav-sync' });
  assert.equal(requests.length, requestCount);
});
test('撤销站点权限后不发送网络请求', async () => {
  reset(); const a = await setup(account()); a.chrome.permissions.contains = async () => false;
  await assert.rejects(a.call('sync'), /权限已撤销/);
  assert.equal(requests.length, 0); assert.deepEqual(C.pickData(a.data), account());
});

test('原版关联按首个匹配组迁移，保留账号、规则和每个别名原有的填充目标', async () => {
  reset();
  const legacy = account();
  legacy.siteRelations = {
    'stale.example': ['example.com', 'shared.example', 'shared.example'],
    'two.example': ['two.example', 'shared.example', 'only-two.example']
  };
  legacy['two.example'] = [{ username: 'second', password: 'dummy' }];
  const migrated = C.readLocalData(legacy);
  const target = (relations, site) => Object.values(relations).find(group => group.includes(site))?.[0] || site;
  for (const site of ['stale.example', ...Object.values(legacy.siteRelations).flat()]) {
    assert.equal(target(migrated.siteRelations, site), target(legacy.siteRelations, site));
  }
  assert.deepEqual(migrated['two.example'], legacy['two.example']);
  assert.deepEqual(migrated['example.com'], legacy['example.com']);
  assert.deepEqual(migrated.domainRules, legacy.domainRules);
  assert.deepEqual(C.readLocalData(migrated), migrated);
  const oldDevice = await setup(legacy); await oldDevice.call('sync');
  assert.deepEqual(await C.decrypt(remote, config().passphrase), migrated);
  assert.throws(() => C.readLocalData({ siteRelations: { a: ['a','b'], b: ['b','c'] } }), /确认主站点/);
  assert.throws(() => C.readLocalData({ siteRelations: { a: ['a','__webdavConfig'] } }), /格式错误/);
});
test('本地导入和恢复较大旧备份，云端仍执行同步大小限制', async () => {
  const large = account(); large['example.com'][0].note = 'a'.repeat(C.MAX_BYTES);
  assert.equal(C.readLocalData(large)['example.com'][0].note.length, C.MAX_BYTES);
  await assert.rejects(C.encrypt(large, config().passphrase), /无法同步/);
  const backup = { data: large, source: '本地', createdAt: '2026-10-27' };
  const d = await setup({ [C.BACKUP]: backup });
  await d.call('restore', { token: await C.hash(backup) });
  assert.deepEqual(C.pickData(d.data), large);
});

test('目录地址解析、结尾斜杠、中文路径和旧文件目标兼容', () => {
  for (const directory of ['https://dav.example.com/home/edge', 'https://dav.example.com/home/edge/']) {
    const normalized = C.normalizeConfig({ ...config(), url: undefined, directoryUrl: directory });
    assert.equal(normalized.directoryUrl, 'https://dav.example.com/home/edge/');
    assert.equal(normalized.url, 'https://dav.example.com/home/edge/vault.json');
    assert.deepEqual(C.normalizeConfig(normalized), normalized);
  }
  for (const directory of ['https://dav.example.com', 'https://dav.example.com/']) {
    assert.equal(C.normalizeConfig({ ...config(), url: undefined, directoryUrl: directory }).url, 'https://dav.example.com/vault.json');
  }
  const unicode = C.normalizeConfig({ ...config(), url: undefined, directoryUrl: 'https://dav.example.com/密码/账号%20备份' });
  assert.equal(decodeURI(unicode.url), 'https://dav.example.com/密码/账号 备份/vault.json');
  const dotted = C.normalizeConfig({ ...config(), url: undefined, directoryUrl: 'https://dav.example.com/archive.json' });
  assert.equal(dotted.url, 'https://dav.example.com/archive.json/vault.json');
  const legacy = C.normalizeConfig({ ...config(), url: 'https://dav.example.com/custom/my-passwords.json' });
  assert.equal(legacy.url, 'https://dav.example.com/custom/my-passwords.json');
  assert.equal(legacy.directoryUrl, 'https://dav.example.com/custom/');
  assert.deepEqual(C.normalizeConfig(legacy), legacy);
  assert.throws(() => C.normalizeConfig({ ...legacy, directoryUrl: 'https://dav.example.com/other/' }), /不一致/);
  for (const directoryUrl of ['https://u:p@dav.example.com/dir', 'https://dav.example.com/dir?q=1', 'file:///dir']) {
    assert.throws(() => C.normalizeConfig({ ...config(), url: undefined, directoryUrl }));
  }
});
test('目录配置测试只读取，首次同步自动创建文件，保存旧配置保留共同版本', async () => {
  reset(); const a = await setup(account());
  await a.call('save', { config: { ...config(), url: undefined, directoryUrl: new URL('/home/edge', url).href } });
  const result = await a.call('test');
  assert.match(result.message, /文件不存在/);
  assert.equal(remote, null);
  assert.deepEqual(requests.map(r => [r.method, r.url]), [['GET', '/home/edge/vault.json']]);
  await a.call('sync');
  assert.ok(requests.every(r => r.url === '/home/edge/vault.json'));
  assert.equal(requests.find(r => r.method === 'PUT').headers['if-none-match'], '*');
  assert.deepEqual(await C.decrypt(remote, config().passphrase), account());
  const b = await setup();
  await b.call('save', { config: { ...config(), url: undefined, directoryUrl: new URL('/home/edge/', url).href } });
  await b.call('sync');
  assert.deepEqual(C.pickData(b.data), account());
  const baseline = a.data[C.STATE].baseline;
  const legacy = { ...a.data[C.CONFIG] }; delete legacy.directoryUrl;
  a.data[C.CONFIG] = legacy;
  await a.call('save', { config: C.normalizeConfig(legacy) });
  assert.equal(a.data[C.STATE].baseline, baseline);
});
