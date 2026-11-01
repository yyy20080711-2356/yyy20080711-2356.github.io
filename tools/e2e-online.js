/**
 * 线上站点验证：直接对 GitHub Pages 跑完整流程
 * 用法：node tools/e2e.js <密码> <URL>
 *   例：node tools/e2e.js 2356 https://yyy20080711-2356.github.io/
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;

const password = process.argv[2];
const target = process.argv[3];

if (!password || !target) {
  console.error('用法：node tools/e2e-online.js <密码> <URL>');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'online-'));
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlinedl-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--window-size=1280,1000',
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(ok, label) {
  console.log((ok ? '✓ ' : '✗ ') + label);
  if (!ok) failed++;
}

async function main() {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await res.json();
      if (targets && targets.length) break;
    } catch (e) {}
    await sleep(250);
  }

  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
    });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  });

  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir
  });

  await send('Page.navigate', { url: target });
  await sleep(4000);

  // 页面加载检查
  const title = await send('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true
  });
  check(/文件下载中心/.test(title.result.value), '页面标题正确（' + title.result.value + '）');

  const gateVisible = await send('Runtime.evaluate', {
    expression: '!document.getElementById("gatePanel").hidden',
    returnByValue: true
  });
  check(gateVisible.result.value === true, '线上显示密码验证框');

  // 错误密码
  await send('Runtime.evaluate', {
    expression:
      'document.getElementById("passwordInput").value="0000";' +
      'document.getElementById("gateForm").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));',
    awaitPromise: true
  });
  await sleep(4000);

  const wrongMsg = await send('Runtime.evaluate', {
    expression: 'document.getElementById("gateMessage").textContent',
    returnByValue: true
  });
  check(/密码不正确/.test(wrongMsg.result.value), '线上错误密码被拒绝');

  // 正确密码
  await send('Runtime.evaluate', {
    expression:
      'document.getElementById("passwordInput").value=' + JSON.stringify(password) + ';' +
      'document.getElementById("gateForm").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));',
    awaitPromise: true
  });
  await sleep(5000);

  const rows = await send('Runtime.evaluate', {
    expression: 'document.querySelectorAll("#fileRows tr").length',
    returnByValue: true
  });
  check(rows.result.value === 3, '线上正确密码显示 3 条记录（实际 ' + rows.result.value + '）');

  const names = await send('Runtime.evaluate', {
    expression: '[].map.call(document.querySelectorAll(".file-name"),function(e){return e.textContent.trim()}).join(" | ")',
    returnByValue: true
  });
  console.log('  文件列表：' + names.result.value);

  const hasDash2 = /-2\.xlsx/.test(names.result.value);
  check(!hasDash2, '文件名未出现 -2 后缀');

  // 下载
  await send('Runtime.evaluate', {
    expression: 'document.querySelector(".dl").click()',
    awaitPromise: true
  });
  await sleep(10000);

  const downloads = fs.readdirSync(downloadDir);
  check(downloads.length === 1, '线上下载成功触发（' + downloads.length + ' 个）');

  if (downloads.length) {
    const size = fs.statSync(path.join(downloadDir, downloads[0])).size;
    check(size === 6676774, '线上下载文件大小正确（' + size + ' 字节）');
    console.log('  下载文件：' + downloads[0]);
  }

  console.log('');
  console.log(failed ? '✗ 失败 ' + failed + ' 项' : '✓ 线上全部通过');

  ws.close();
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (e) {}

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常：' + err.message);
  chrome.kill();
  process.exit(1);
});
