// 监听来自popup的消息
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'fillAccount') {
    const { usernameInput, passwordInput } = findLoginInputs();

    if (usernameInput) {
      setNativeValue(usernameInput, request.username);
    }
    if (passwordInput) {
      setNativeValue(passwordInput, request.password);
    }
  }
});

/**
 * 智能查找登录表单的用户名和密码输入框
 * 策略：先定位密码框（特征最明显），再在附近找用户名框
 */
function findLoginInputs() {
  const allInputs = Array.from(document.querySelectorAll('input'))
    .filter(el => el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button');

  // 密码框关键词（用于 name/id/placeholder/aria-label/autocomplete）
  const passwordKeywords = [
    'password', 'passwd', 'pwd', 'pass', '密码', '口令', '密令'
  ];
  // 用户名框关键词
  const usernameKeywords = [
    'user', 'username', 'userid', 'user_name', 'user_id',
    'login', 'loginname', 'login_name', 'account', 'email',
    'mobile', 'phone', 'tel', 'name', 'uid', 'uname',
    '账号', '用户', '邮箱', '手机', '姓名', '工号', '学号'
  ];

  // autocomplete 属性值（浏览器/框架标准）
  const usernameAutocomplete = ['username', 'email', 'tel'];
  const passwordAutocomplete = ['current-password', 'new-password'];

  // ---------- 1. 找密码框 ----------
  let passwordInput = null;

  // 1a. 直接 type="password"（最可靠）
  const typePasswordInputs = allInputs.filter(el => el.type === 'password');
  if (typePasswordInputs.length > 0) {
    // 如果有多个密码框，优先选可见的那个
    passwordInput = typePasswordInputs.find(el => isVisible(el)) || typePasswordInputs[0];
  }

  // 1b. 退而求其次：通过属性关键词匹配
  if (!passwordInput) {
    passwordInput = findInputByKeywords(allInputs, passwordKeywords, passwordAutocomplete);
  }

  // ---------- 2. 找用户名框 ----------
  let usernameInput = null;

  // 2a. 通过 autocomplete 属性精确匹配
  usernameInput = allInputs.find(el =>
    el !== passwordInput &&
    el.autocomplete &&
    usernameAutocomplete.some(v => el.autocomplete.toLowerCase().includes(v))
  );

  // 2b. 通过关键词评分
  if (!usernameInput) {
    const candidates = allInputs
      .filter(el => el !== passwordInput)
      .map(el => ({ el, score: scoreInput(el, usernameKeywords) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score);

    if (candidates.length > 0) {
      usernameInput = candidates[0].el;
    }
  }

  // 2c. 如果还没找到，尝试在密码框附近找（同一个 form 或最近的共同祖先内的文本类输入框）
  if (!usernameInput && passwordInput) {
    usernameInput = findNearbyTextInput(passwordInput, allInputs);
  }

  // 2d. 最后的兜底：第一个可见的 text/email/tel 输入框
  if (!usernameInput) {
    usernameInput = allInputs.find(el =>
      el !== passwordInput &&
      isVisible(el) &&
      ['text', 'email', 'tel'].includes(el.type)
    );
  }

  return { usernameInput, passwordInput };
}

/**
 * 通过关键词在 name/id/placeholder/aria-label 中匹配输入框
 */
function findInputByKeywords(inputs, keywords, autocompleteValues) {
  // 先尝试 autocomplete
  if (autocompleteValues) {
    const match = inputs.find(el =>
      el.autocomplete &&
      autocompleteValues.some(v => el.autocomplete.toLowerCase().includes(v))
    );
    if (match) return match;
  }
  // 再用关键词评分
  const candidates = inputs
    .map(el => ({ el, score: scoreInput(el, keywords) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score);
  return candidates.length > 0 ? candidates[0].el : null;
}

/**
 * 给输入框打分：根据 name/id/placeholder/aria-label 中包含关键词的情况
 */
function scoreInput(input, keywords) {
  let score = 0;
  const fields = [
    { value: (input.name || '').toLowerCase(), weight: 3 },
    { value: (input.id || '').toLowerCase(), weight: 3 },
    { value: (input.placeholder || '').toLowerCase(), weight: 2 },
    { value: (input.getAttribute('aria-label') || '').toLowerCase(), weight: 2 },
    { value: getLabelText(input).toLowerCase(), weight: 2 },
  ];

  for (const kw of keywords) {
    for (const field of fields) {
      if (field.value.includes(kw)) {
        score += field.weight;
      }
    }
  }
  return score;
}

/**
 * 在密码框附近找用户名输入框
 * 策略：沿着 DOM 向上找，在同一 form 或共同祖先内找文本类输入框
 */
function findNearbyTextInput(passwordInput, allInputs) {
  let parent = passwordInput.parentElement;
  // 向上最多找 5 层
  for (let i = 0; i < 5 && parent; i++) {
    // 如果找到了 form，在 form 内搜索
    if (parent.tagName === 'FORM') {
      const textInputs = Array.from(parent.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"]'))
        .filter(el => isVisible(el));
      if (textInputs.length > 0) return textInputs[0];
    }
    parent = parent.parentElement;
  }
  // 退而求其次：找密码框之前紧邻的可见文本输入框
  const textInputs = allInputs.filter(el =>
    isVisible(el) && ['text', 'email', 'tel'].includes(el.type)
  );
  const pwdIndex = allInputs.indexOf(passwordInput);
  if (pwdIndex > 0) {
    // 找密码框前面最近的文本类输入框
    for (let i = pwdIndex - 1; i >= 0; i--) {
      if (['text', 'email', 'tel'].includes(allInputs[i].type) && isVisible(allInputs[i])) {
        return allInputs[i];
      }
    }
  }
  return null;
}

/**
 * 获取与输入框关联的 <label> 文本
 */
function getLabelText(input) {
  // 通过 for 属性关联
  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) return label.textContent;
  }
  // 通过父级 label 包裹
  const parentLabel = input.closest('label');
  if (parentLabel) return parentLabel.textContent;
  return '';
}

/**
 * 判断元素是否可见
 */
function isVisible(el) {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

// 使用原生 setter 设置值并派发事件，让 Vue/React 等框架能感知到变化
function setNativeValue(element, value) {
  // 获取原生 value setter，绕过框架可能重写的 setter
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;

  element.focus();
  nativeInputValueSetter.call(element, value);

  // 依次派发多种事件，确保 Vue2/Vue3/React/Angular 都能响应
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
}

// ========== 快捷键填充：Alt+1~5 快速切换账号 ==========
document.addEventListener('keydown', function(e) {
  // 仅响应 Alt+数字键 1~5
  if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;

  const num = parseInt(e.key);
  if (isNaN(num) || num < 1 || num > 5) return;

  // 阻止浏览器默认的 Alt+数字 行为（如切换标签页）
  e.preventDefault();

  const site = window.location.hostname;

  // 先检查是否有关联站点，取主站点
  chrome.storage.local.get(['siteRelations'], function(relResult) {
    const relations = relResult.siteRelations || {};
    let targetSite = site;
    for (let group of Object.values(relations)) {
      if (group.includes(site)) {
        targetSite = group[0];
        break;
      }
    }

    chrome.storage.local.get([targetSite], function(result) {
      const accounts = result[targetSite] || [];
      if (accounts.length === 0) return;

      // 与 popup 保持一致：列表倒序显示，Alt+1 对应最后一条（即倒序后第1条）
      const index = accounts.length - num;
      if (index < 0) return; // 没有这么多账号，忽略

      const account = accounts[index];
      const { usernameInput, passwordInput } = findLoginInputs();

      if (usernameInput) {
        setNativeValue(usernameInput, account.username);
      }
      if (passwordInput) {
        setNativeValue(passwordInput, account.password);
      }

      // 填充成功提示
      showFillToast(`已填充: ${account.username} (账号${num})`);
    });
  });
});

// 轻量填充提示（不依赖页面原有 UI）
function showFillToast(message) {
  let toast = document.getElementById('__pwd-ext-toast__');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = '__pwd-ext-toast__';
    toast.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
      'padding:10px 20px', 'border-radius:6px',
      'background:#409eff', 'color:#fff', 'font-size:14px',
      'box-shadow:0 4px 12px rgba(0,0,0,.15)',
      'transition:opacity .3s', 'pointer-events:none',
      'font-family:system-ui,-apple-system,sans-serif'
    ].join(';');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 1500);
} 