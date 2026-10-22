if (window.location.protocol === 'file:') {
  document.getElementById('app-shell').hidden = true;
  document.getElementById('file-help').hidden = false;
} else {
  import('./app.js').catch(() => {
    const message = document.getElementById('message');
    message.textContent = '页面脚本加载失败。请刷新页面，或重新启动本地服务。';
    message.classList.add('error');
  });
}
