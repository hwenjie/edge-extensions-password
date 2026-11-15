let currentUrl = '';
let siteRelations = {};  // 存储站点关联关系
let isPasswordVisible = false;  // 添加密码显示状态跟踪

// 获取当前标签页的URL
chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
  try { currentUrl = new URL(tabs[0]?.url || 'about:blank').hostname; } catch { currentUrl = ''; }
  for (const id of ['saveAccount', 'linkSites', 'clearCurrent']) document.getElementById(id).disabled = !currentUrl;
  loadSiteRelations();
});

// 添加新的函数来加载站点关联关系
function loadSiteRelations() {
  chrome.storage.local.get(['siteRelations'], function(result) {
    siteRelations = result.siteRelations || {};
    // 检查当前站点是否有关联站点
    const relatedGroup = findRelatedGroup(currentUrl);
    if (relatedGroup) {
      // 使用关联组中的主站点加载账号
      loadAccounts(relatedGroup[0]);
      // 显示关联站点在输入框中
      document.getElementById('relatedSites').value = relatedGroup.join(', ');
    } else {
      loadAccounts(currentUrl);
    }
  });
}

// 查找站点所属的关联组
function findRelatedGroup(site) {
  for (let group of Object.values(siteRelations)) {
    if (group.includes(site)) {
      return group;
    }
  }
  return null;
}

// 修改 loadAccounts 函数添加站点参数
function loadAccounts(site = currentUrl) {
  chrome.storage.local.get([site], function(result) {
    const accounts = result[site] || [];
    displayAccounts(accounts);
  });
}

// 显示账号列表
function displayAccounts(accounts) {
  const accountsList = document.getElementById('accountsList');
  accountsList.innerHTML = '';
  
  // 添加账号数量显示
  const countDiv = document.createElement('div');
  countDiv.className = 'accounts-count';
  countDiv.textContent = `共 ${accounts.length} 个账号`;
  accountsList.appendChild(countDiv);
  
  // 倒序遍历账号列表，但编号从1开始递增
  [...accounts].reverse().forEach((account, index) => {
    const div = document.createElement('div');
    div.className = 'account-item';
    div.innerHTML = `
      <div class="account-number">${index + 1}</div>
      <div class="account-info">
        <div class="account-field">
          <span class="field-label">用户名:</span>
          <span class="field-value">${escapeHtml(account.username)}</span>
        </div>
        <div class="account-field">
          <span class="field-label">密码:</span>
          <div class="password-wrapper">
            <span class="field-value password-value" type="password">
              ${isPasswordVisible ? escapeHtml(account.password) : '•'.repeat(account.password.length)}
            </span>
          </div>
        </div>
        ${account.note ? `
        <div class="account-field">
          <span class="field-label">备注:</span>
          <span class="field-value note-value">${escapeHtml(account.note)}</span>
        </div>
        ` : ''}
      </div>
      <div class="button-group">
        <button class="btn btn-fill" data-action="fill" data-index="${accounts.length - index - 1}">填充</button>
        <button class="btn btn-edit" data-action="edit" data-index="${accounts.length - index - 1}">编辑</button>
        <button class="btn btn-delete" data-action="delete" data-index="${accounts.length - index - 1}">删除</button>
      </div>
    `;
    accountsList.appendChild(div);
  });
}

// 在文件顶部添加全局事件监听器
(function initializePopup() {
  // 处理账号列表的按钮点击
  document.getElementById('accountsList').addEventListener('click', function(e) {
    const button = e.target.closest('button');
    if (!button) return;

    const action = button.dataset.action;
    const index = parseInt(button.dataset.index);

    switch(action) {
      case 'fill':
        fillAccount(index);
        break;
      case 'edit':
        editAccount(index);
        break;
      case 'delete':
        deleteAccount(index);
        break;
    }
  });

  // 处理保存按钮点击
  document.getElementById('saveAccount').addEventListener('click', saveOrUpdateAccount);

  const togglePasswordsBtn = document.getElementById('togglePasswords');
  
  togglePasswordsBtn.addEventListener('click', function() {
    isPasswordVisible = !isPasswordVisible;  // 更新状态
    this.textContent = isPasswordVisible ? '隐藏密码' : '显示密码';
    this.classList.toggle('showing');
    updatePasswordDisplay();
  });

  // 修改更新密码显示的函数
  function updatePasswordDisplay() {
    const site = findRelatedGroup(currentUrl)?.[0] || currentUrl;
    chrome.storage.local.get([site], function(result) {
      const accounts = result[site] || [];
      const passwordValues = document.querySelectorAll('.password-value');
      
      // 由于账号列表是倒序显示的，我们需要反转账号数组来匹配显示顺序
      const reversedAccounts = [...accounts].reverse();
      
      passwordValues.forEach((passwordValue, index) => {
        const account = reversedAccounts[index];
        if (account) {  // 确保账号存在
          if (isPasswordVisible) {
            passwordValue.textContent = account.password;
            passwordValue.setAttribute('type', 'text');
          } else {
            passwordValue.textContent = '•'.repeat(account.password.length);
            passwordValue.setAttribute('type', 'password');
          }
        }
      });
    });
  }

  // 添加清除当前网站账号功能
  document.getElementById('clearCurrent').addEventListener('click', function() {
    const site = findRelatedGroup(currentUrl)?.[0] || currentUrl;
    if (confirm(`确定要清除 ${site} 下保存的所有账号吗？关联站点也会受影响。`)) {
      chrome.storage.local.get([site], function(result) {
        if (result[site] && result[site].length > 0) {
          chrome.storage.local.remove([site], function() {
            loadAccounts(site);
            alert('当前网站的账号数据已清除');
          });
        } else {
          alert('当前网站没有保存的账号');
        }
      });
    }
  });

  // 修改清除所有账号功能的提示
  document.getElementById('clearAll').addEventListener('click', function() {
    if (confirm('确定要清除所有网站的账号吗？此操作将清空密码库，并保留清空前备份；WebDAV 配置不变。')) {
      if (confirm('再次确认：是否清除所有网站的账号数据？')) {
        clearPasswordData(function() {
          siteRelations = {};
          loadAccounts();
          alert('所有网站的账号数据已清除');
        });
      }
    }
  });

  // 关联站点功能
  const modal = document.getElementById('linkSitesModal');
  const linkSitesBtn = document.getElementById('linkSites');
  const saveSiteLinksBtn = document.getElementById('saveSiteLinks');
  const cancelSiteLinksBtn = document.getElementById('cancelSiteLinks');

  // 显示弹窗
  linkSitesBtn.addEventListener('click', function() {
    if (findRelatedGroup(currentUrl)?.[0] && findRelatedGroup(currentUrl)[0] !== currentUrl) {
      alert('请在主站点 ' + findRelatedGroup(currentUrl)[0] + ' 管理关联关系'); return;
    }
    document.getElementById('currentSiteName').textContent = currentUrl;
    // 加载现有的关联站点
    chrome.storage.local.get(['siteRelations'], function(result) {
      const relations = result.siteRelations || {};
      const relatedGroup = findRelatedGroup(currentUrl);
      if (relatedGroup) {
        const otherSites = relatedGroup.filter(site => site !== currentUrl);
        document.getElementById('relatedSites').value = otherSites.join(', ');
      }
      modal.style.display = 'block';
    });
  });

  // 保存关联
  saveSiteLinksBtn.addEventListener('click', function() {
    const relatedSites = document.getElementById('relatedSites').value
      .split(',')
      .map(site => site.trim())
      .filter((site, index, sites) => site && site !== currentUrl && sites.indexOf(site) === index);

    chrome.storage.local.get(['siteRelations'], function(result) {
      const relations = result.siteRelations || {};
      
      // Prevent overlapping groups, which cannot be synchronized or filled reliably.
      if (relatedSites.some(site => {
        const group = Object.values(relations).find(group => group.includes(site));
        return group && group[0] !== currentUrl;
      })) { alert('所选站点已属于其他关联组，请先解除原关联'); return; }
      delete relations[currentUrl];

      if (relatedSites.length > 0) {
        // 添加新关联
        const allSites = [currentUrl, ...relatedSites];
        relations[currentUrl] = allSites;
        
        // 合并账号数据
        mergeAccountsData(allSites, function() {
          // 保存关联关系
          chrome.storage.local.set({ siteRelations: relations }, function() {
            modal.style.display = 'none';
            loadSiteRelations();
          });
        });
      } else {
        // 如果没有关联站点，直接保存空关系
        chrome.storage.local.set({ siteRelations: relations }, function() {
          modal.style.display = 'none';
          loadSiteRelations();
        });
      }
    });
  });

  // 取消按钮
  cancelSiteLinksBtn.addEventListener('click', function() {
    modal.style.display = 'none';
  });

  // 点击弹窗外关闭
  window.addEventListener('click', function(event) {
    if (event.target === modal) {
      modal.style.display = 'none';
    }
  });
})();

// 新增一个变量来跟踪编辑状态
let editingIndex = null;

// 修改保存账号的函数
function saveOrUpdateAccount() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const note = document.getElementById('note').value;
  
  if (!username || !password) {
    alert('请输入用户名和密码');
    return;
  }

  // 检查当前站点是否属于某个关联组
  const relatedGroup = findRelatedGroup(currentUrl);
  const siteToSave = relatedGroup ? relatedGroup[0] : currentUrl;
  
  saveAccountData(siteToSave, username, password, note);
}

// 新增保存账号数据的辅助函数
function saveAccountData(site, username, password, note) {
  chrome.storage.local.get([site], function(result) {
    const accounts = result[site] || [];
    const accountData = { username, password, note };
    
    if (editingIndex !== null) {
      accounts[editingIndex] = accountData;
      editingIndex = null;
    } else {
      const existingIndex = accounts.findIndex(acc => acc.username === username);
      if (existingIndex !== -1) {
        if (confirm('已存在相同用户名的账号，是否更新？')) {
          accounts[existingIndex] = accountData;
        }
      } else {
        accounts.push(accountData);
      }
    }
    
    chrome.storage.local.set({
      [site]: accounts
    }, function() {
      loadAccounts(site);
      resetForm();
    });
  });
}

// 重置表单
function resetForm() {
  document.getElementById('username').value = '';
  document.getElementById('password').value = '';
  document.getElementById('note').value = '';
  document.getElementById('saveAccount').textContent = '保存账号';
  editingIndex = null;
}

// 修改编辑账号功能
function editAccount(index) {
  const relatedGroup = findRelatedGroup(currentUrl);
  const siteToLoad = relatedGroup ? relatedGroup[0] : currentUrl;
  
  chrome.storage.local.get([siteToLoad], function(result) {
    const accounts = result[siteToLoad] || [];
    const account = accounts[index];
    
    document.getElementById('username').value = account.username;
    document.getElementById('password').value = account.password;
    document.getElementById('note').value = account.note || '';
    
    const saveButton = document.getElementById('saveAccount');
    saveButton.textContent = '更新账号';
    editingIndex = index;
  });
}

// 自动填充账号密码
function fillAccount(index) {
  const relatedGroup = findRelatedGroup(currentUrl);
  const siteToLoad = relatedGroup ? relatedGroup[0] : currentUrl;
  
  chrome.storage.local.get([siteToLoad], function(result) {
    const accounts = result[siteToLoad] || [];
    const account = accounts[index];
    
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'fillAccount',
        username: account.username,
        password: account.password
      });
    });
  });
}

// 导出数据
document.getElementById('exportData').addEventListener('click', function() {
  chrome.storage.local.get(null, function(data) {
    const jsonString = JSON.stringify(SyncCore.pickData(data));
    const blob = new Blob([jsonString], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'passwords_backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
});

// 导入数据
document.getElementById('importData').addEventListener('click', function() {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async function(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = SyncCore.readLocalData(JSON.parse(await file.text()));
    if (!confirm('导入将替换本地密码库，并保留覆盖前备份。WebDAV 配置会保留。是否继续？')) return;
    const old = SyncCore.pickData(await chrome.storage.local.get(null));
    await chrome.storage.local.set({ ...data, [SyncCore.BACKUP]: { data: old, source: '本地导入前', createdAt: new Date().toISOString() } });
    await chrome.storage.local.remove(Object.keys(old).filter(key => !Object.hasOwn(data, key)));
    resetForm();
    loadSiteRelations();
    alert('数据导入成功');
  } catch (error) { alert('导入失败：' + error.message); }
  finally { e.target.value = ''; }
});

// 添加删除账号功能
function deleteAccount(index) {
  if (confirm('确定要删除这个账号吗？')) {
    const relatedGroup = findRelatedGroup(currentUrl);
    const siteToLoad = relatedGroup ? relatedGroup[0] : currentUrl;
    
    chrome.storage.local.get([siteToLoad], function(result) {
      const accounts = result[siteToLoad] || [];
      accounts.splice(index, 1);
      
      chrome.storage.local.set({
        [siteToLoad]: accounts
      }, function() {
        loadAccounts(siteToLoad);
      });
    });
  }
}

// 修改输入框密码显示切换功能
document.querySelector('.toggle-password').addEventListener('click', function() {
  const passwordInput = document.getElementById('password');
  
  if (passwordInput.type === 'password') {
    passwordInput.type = 'text';
    this.textContent = '✕';
  } else {
    passwordInput.type = 'password';
    this.textContent = '👁';
  }
});

// 合并关联站点的账号数据
function mergeAccountsData(sites, callback) {
  chrome.storage.local.get(sites, function(result) {
    let allAccounts = [];
    
    // 收集所有站点的账号
    sites.forEach(site => {
      if (result[site]) {
        allAccounts = allAccounts.concat(result[site]);
      }
    });

    // 去重
    const uniqueAccounts = allAccounts.filter((account, index, self) =>
      index === self.findIndex(a => a.username === account.username)
    );

    // 将合并后的账号保存到主站点
    chrome.storage.local.set({
      [sites[0]]: uniqueAccounts
    }, function() {
      // 删除其他站点的数据
      const sitesToRemove = sites.slice(1);
      if (sitesToRemove.length > 0) {
        chrome.storage.local.remove(sitesToRemove, callback);
      } else {
        callback();
      }
    });
  });
}

// 添加一个辅助函数来获取国际化消息
function getMessage(messageName, substitutions = null) {
  return chrome.i18n.getMessage(messageName, substitutions);
}

// 修改相关文本
document.getElementById('togglePasswords').textContent = getMessage('showPassword');
document.getElementById('linkSites').textContent = getMessage('linkSites');
document.getElementById('exportData').textContent = getMessage('export');
// ... 其他文本替换 

// ========== 自定义域名规则管理 ==========
document.getElementById('customRules').addEventListener('click', function() {
  chrome.storage.local.get(['domainRules'], function(result) {
    const currentRules = result.domainRules || {};
    const currentJson = JSON.stringify(currentRules, null, 2);
    
    const input = prompt(
      '请输入自定义域名规则（JSON格式）：\n\n' +
      '格式示例：qq企业邮箱\n' +
      '{\n' +
      '  "exmail.qq.com": {\n' +
      '    "usernameSelector": "input[name=\'pp\']",\n' +
      '    "passwordSelector": "input[name=\'inputuin\']"\n' +
      '  }\n' +
      '}\n\n' +
      '当前规则：',
      currentJson
    );
    
    if (input === null) return; // 用户点击取消
    
    if (input.trim() === '') {
      // 清空规则
      chrome.storage.local.set({ domainRules: {} }, function() {
        alert('自定义规则已清空');
      });
      return;
    }
    
    try {
      const newRules = JSON.parse(input);
      
      // 验证格式
      if (typeof newRules !== 'object' || newRules === null) {
        throw new Error('规则必须是对象格式');
      }
      
      for (const [domain, rule] of Object.entries(newRules)) {
        if (!rule.usernameSelector || !rule.passwordSelector) {
          throw new Error(`域名 "${domain}" 缺少 usernameSelector 或 passwordSelector`);
        }
      }
      
      // 保存规则
      chrome.storage.local.set({ domainRules: newRules }, function() {
        alert('自定义规则保存成功');
      });
    } catch (e) {
      alert('JSON格式错误：' + e.message);
    }
  });
});
// Sync settings and credentials are never exported or removed by account cleanup.
document.getElementById('webdavSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
function clearPasswordData(callback) {
  chrome.storage.local.get(null, async data => {
    try {
      const library = SyncCore.pickData(data);
      await chrome.storage.local.set({ [SyncCore.BACKUP]: { data: library, source: '本地清空前', createdAt: new Date().toISOString() } });
      await chrome.storage.local.remove(Object.keys(library));
      callback();
    } catch (error) { alert('清除失败：' + error.message); }
  });
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
