/**
 * 完整回归：在真实 Chrome 里跑一遍解锁、下载、错误密码拒绝
 * 用法：node tools/e2e.js <密码> [http端口]
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const password = process.argv[2];
const PORT_HTTP = Number(process.argv[3] || process.env.URL_PORT || 8790);

if (!password) {
  console.error('用法：node tools/e2e.js <密码> [http端口]');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2edl-'));

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

  const url = 'http://127.0.0.1:' + PORT_HTTP + '/';
  await send('Page.navigate', { url });
  await sleep(2500);

  // 1. 初始应是锁定状态
  const gateVisible = await send('Runtime.evaluate', {
    expression: '!document.getElementById("gatePanel").hidden',
    returnByValue: true
  });
  check(gateVisible.result.value === true, '初始显示密码验证框');

  const listHidden = await send('Runtime.evaluate', {
    expression: 'document.getElementById("listPanel").hidden',
    returnByValue: true
  });
  check(listHidden.result.value === true, '未解锁时文件列表隐藏');

  // 2. 错误密码
  await send('Runtime.evaluate', {
    expression:
      'document.getElementById("passwordInput").value="definitely-wrong";' +
      'document.getElementById("gateForm").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));',
    awaitPromise: true
  });
  await sleep(3500);

  const wrongMsg = await send('Runtime.evaluate', {
    expression: 'document.getElementById("gateMessage").textContent',
    returnByValue: true
  });
  check(/密码不正确/.test(wrongMsg.result.value), '错误密码提示「密码不正确」');

  const stillHidden = await send('Runtime.evaluate', {
    expression: 'document.getElementById("listPanel").hidden',
    returnByValue: true
  });
  check(stillHidden.result.value === true, '错误密码不解锁列表');

  // 3. 正确密码
  await send('Runtime.evaluate', {
    expression:
      'document.getElementById("passwordInput").value=' + JSON.stringify(password) + ';' +
      'document.getElementById("gateForm").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));',
    awaitPromise: true
  });
  await sleep(3500);

  const rows = await send('Runtime.evaluate', {
    expression: 'document.querySelectorAll("#fileRows tr").length',
    returnByValue: true
  });
  check(rows.result.value === 3, '正确密码显示 3 条文件记录（实际 ' + rows.result.value + '）');

  const statsShown = await send('Runtime.evaluate', {
    expression: '!document.getElementById("statsBar").hidden',
    returnByValue: true
  });
  check(statsShown.result.value === true, '解锁后显示统计栏');

  // 4. 下载
  await send('Runtime.evaluate', {
    expression: 'document.querySelector(".dl").click()',
    awaitPromise: true
  });
  await sleep(7000);

  const downloads = fs.readdirSync(downloadDir);
  check(downloads.length === 1, '点击下载后触发保存（' + downloads.length + ' 个文件）');

  if (downloads.length) {
    const size = fs.statSync(path.join(downloadDir, downloads[0])).size;
    check(size === 6676774, '下载文件大小与原文一致（' + size + ' 字节）');
    check(/\.zip$/.test(downloads[0]), '文件名恢复为 .zip（' + downloads[0] + '）');
  }

  // 5. 排序
  const sortOk = await send('Runtime.evaluate', {
    expression:
      '(function(){var b=document.querySelector(\'.sort[data-sort="size"]\');' +
      'b.click(); var a=document.querySelectorAll("#fileRows tr td:nth-child(3)");' +
      'var vals=[].map.call(a,function(t){return t.textContent.trim()});' +
      'return b.parentNode.getAttribute("aria-sort")+"|"+vals.join(",");})()',
    returnByValue: true
  });
  check(/ascending/.test(sortOk.result.value), '按大小排序生效（' + sortOk.result.value + '）');

  console.log('');
  console.log(failed ? '✗ 失败 ' + failed + ' 项' : '✓ 全部通过');

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
