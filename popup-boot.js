// Keep manual edits and background snapshot replacements mutually exclusive.
const popupPort = chrome.runtime.connect({ name: 'password-popup' });
let loaded = false;
const loading = document.getElementById('syncLoading');
popupPort.onMessage.addListener(({ busy }) => {
  loading.hidden = !busy;
  if (!busy && !loaded) {
    loaded = true;
    const script = document.createElement('script');
    script.src = 'popup.js';
    document.body.appendChild(script);
  }
});
popupPort.onDisconnect.addListener(() => {
  loading.textContent = '后台连接已断开，请关闭并重新打开插件。';
  loading.hidden = false;
});
