// 监听来自popup的消息
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'fillAccount') {
    // 查找用户名和密码输入框
    const usernameInput = document.querySelector('input[type="text"], input[type="email"]');
    const passwordInput = document.querySelector('input[type="password"]');
    
    // 填充账号密码
    if (usernameInput) {
      usernameInput.value = request.username;
    }
    if (passwordInput) {
      passwordInput.value = request.password;
    }
  }
}); 