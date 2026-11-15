// Real Chromium extension check in an isolated, disposable browser profile.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
(async () => {
  const sourcePath = path.resolve(__dirname, '..');
  const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-extension-source-'));
  fs.cpSync(sourcePath, extensionPath, { recursive: true });
  // Headless Chromium cannot confirm its native optional-host permission bubble.
  // Pregrant only the loopback test host in this disposable copy; shipped manifest is unchanged.
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-extension-test-'));
  const screenshotPath = path.resolve(__dirname, '../test-results'); fs.mkdirSync(screenshotPath, { recursive: true });
  let context, server, remote = null, etag = 0;
  try {
    server = http.createServer(async (req, res) => {
      if (req.url === '/login') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<input id="user" autocomplete="username"><input id="pass" type="password">'); }
      if (req.headers.authorization !== 'Basic ' + Buffer.from('demo:demo-app-password').toString('base64')) { res.writeHead(401); return res.end(); }
      if (req.url !== '/home/edge/vault.json') { res.writeHead(403); return res.end(); }
      if (req.method === 'GET') { res.writeHead(remote === null ? 404 : 200, { ETag: `"${etag}"` }); return res.end(remote || ''); }
      if (req.method === 'PUT') {
        if ((req.headers['if-none-match'] === '*' && remote !== null) || (req.headers['if-match'] && req.headers['if-match'] !== `"${etag}"`)) { res.writeHead(412); return res.end(); }
        const chunks = []; for await (const chunk of req) chunks.push(chunk); remote = Buffer.concat(chunks).toString(); etag++; res.writeHead(201); return res.end();
      }
      res.writeHead(405); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`], viewport: { width: 1180, height: 1100 }
    });
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.goto(`chrome-extension://${id}/options.html`);
    await page.locator('#url').fill(base + '/home/edge');
    await page.locator('#username').fill('demo'); await page.locator('#password').fill('demo-app-password');
    await page.locator('#passphrase').fill('demo-sync-passphrase'); await page.locator('#allowHttp').check();
    await page.getByRole('button', { name: '保存配置并授权' }).click();
    await page.waitForFunction(() => document.getElementById('feedback').textContent === '配置已保存', null, { timeout: 10000 }).catch(async error => { console.log('Save feedback:', await page.locator('#feedback').innerText()); console.log('Page errors:', errors); throw error; });
    await worker.evaluate(async () => chrome.storage.local.set({ '127.0.0.1': [{ username: '<b>demo-user</b>', password: 'demo-vault-secret', note: '演示测试' }], domainRules: { '127.0.0.1': { usernameSelector: '#user', passwordSelector: '#pass' } } }));
    await page.locator('#test').click();
    await page.waitForFunction(() => document.getElementById('feedback').textContent.includes('文件不存在'));
    assert.equal(remote, null);
    await page.getByRole('button', { name: '立即双向同步' }).click();
    await page.waitForFunction(() => document.getElementById('feedback').textContent === '本地数据已加密上传');
    assert.ok(remote && !remote.includes('demo-vault-secret'));
    await page.screenshot({ path: path.join(screenshotPath, 'webdav-settings.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(screenshotPath, 'webdav-settings-mobile.png'), fullPage: true });
    // A real popup document executes its deferred bootstrap and account interactions.
    const popup = await context.newPage(); popup.on('pageerror', error => errors.push(error.message)); popup.on('dialog', dialog => dialog.accept());
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(() => typeof loadAccounts === 'function');
    await popup.evaluate(() => { currentUrl = '127.0.0.1'; loadSiteRelations(); });
    await popup.waitForFunction(() => document.querySelector('.field-value')?.textContent === '<b>demo-user</b>');
    assert.equal(await popup.locator('.account-info b').count(), 0);
    await popup.locator('#togglePasswords').click();
    assert.equal((await popup.locator('.password-value').innerText()).trim(), 'demo-vault-secret');
    await popup.screenshot({ path: path.join(screenshotPath, 'password-popup.png') });
    const downloadPromise = popup.waitForEvent('download'); await popup.locator('#exportData').click();
    const download = await downloadPromise; const downloadPath = await download.path();
    const exported = JSON.parse(fs.readFileSync(downloadPath, 'utf8'));
    assert.ok(!Object.keys(exported).some(k => k.startsWith('__webdav')));
    const legacy = { ...exported, siteRelations: { 'old-key.example': ['127.0.0.1', 'linked.example', 'linked.example'] } };
    await popup.locator('#importFile').setInputFiles({ name: 'passwords_backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
    await popup.waitForFunction(async () => {
      const { siteRelations } = await chrome.storage.local.get('siteRelations');
      return siteRelations?.['127.0.0.1']?.length === 2;
    });
    const imported = await worker.evaluate(() => chrome.storage.local.get(null));
    assert.deepEqual(imported['127.0.0.1'], exported['127.0.0.1']);
    assert.deepEqual(imported.domainRules, exported.domainRules);
    assert.equal(imported.__webdavConfig.url, base + '/home/edge/vault.json');
    assert.deepEqual(imported.__webdavBackup.data, exported);
    await popup.close();
    // Reloading the options page preserves settings. Restore downloads via real worker.
    await page.reload();
    await page.waitForFunction(() => document.getElementById('url').value.endsWith('/home/edge/'));
    await worker.evaluate(async () => chrome.storage.local.remove(['127.0.0.1', 'domainRules']));
    await page.locator('#download').click();
    await page.waitForFunction(() => document.getElementById('feedback').textContent === '云端数据已下载到本地');
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('127.0.0.1'))['127.0.0.1'][0].password), 'demo-vault-secret');
    const login = await context.newPage(); await login.goto(base + '/login'); await login.keyboard.press('Alt+1');
    await login.waitForFunction(() => document.getElementById('pass').value === 'demo-vault-secret');
    assert.equal(await login.locator('#user').inputValue(), '<b>demo-user</b>');
    // Old custom filenames must survive a credentials-only save through the new directory UI.
    await worker.evaluate(async () => {
      const saved = (await chrome.storage.local.get('__webdavConfig')).__webdavConfig;
      saved.url = new URL('/custom/old-passwords.json', saved.url).href;
      delete saved.directoryUrl;
      await chrome.storage.local.set({ __webdavConfig: saved });
    });
    await page.reload();
    await page.waitForFunction(() => document.getElementById('url').value.endsWith('/custom/'));
    await page.locator('#password').fill('replacement-app-password');
    await page.getByRole('button', { name: '保存配置并授权' }).click();
    await page.waitForFunction(() => document.getElementById('feedback').textContent === '配置已保存');
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('__webdavConfig')).__webdavConfig.url), base + '/custom/old-passwords.json');
    await page.locator('#url').fill(base + '/home/edge/');
    await page.getByRole('button', { name: '保存配置并授权' }).click();
    await page.waitForFunction(() => document.getElementById('feedback').textContent === '配置已保存');
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('__webdavConfig')).__webdavConfig.url), base + '/home/edge/vault.json');
    assert.deepEqual(errors, []);
    console.log('PASS: Chromium MV3 loads; options save (loopback permission pregranted in test copy); encrypted upload/download; popup controls; export isolation; Alt+1 fill; responsive layout; no page errors.');
  } finally {
    if (context) await context.close();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(extensionPath, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
