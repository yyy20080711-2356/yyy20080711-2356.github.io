/**
 * 端到端验证：用 Node 的 WebCrypto 复刻浏览器解密流程
 * 确认 PBKDF2 派生 + AES-GCM 解包（tag 追加在密文末尾）能与加密脚本互通。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');

const subtle = webcrypto.subtle;
const ROOT = path.resolve(__dirname, '..');

const PASSWORD = process.argv[2];
if (!PASSWORD) {
  console.error('用法：node tools/verify.js <密码>');
  process.exit(1);
}

function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function deriveKey(password, kdf) {
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b64ToBytes(kdf.salt),
      iterations: kdf.iterations,
      hash: kdf.hash
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

async function decrypt(key, ivB64, buffer) {
  const data = new Uint8Array(buffer);
  const body = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);

  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(ivB64), tagLength: 128 },
    key,
    concat(body, tag)
  );

  return new Uint8Array(plain);
}

async function main() {
  const vault = JSON.parse(fs.readFileSync(path.join(ROOT, 'vault.json'), 'utf8'));
  const key = await deriveKey(PASSWORD, vault.kdf);

  // 1. 解密清单
  const manifestBuf = fs.readFileSync(path.join(ROOT, vault.manifest.path));
  const manifestPlain = await decrypt(key, vault.manifest.iv, manifestBuf);
  const manifest = JSON.parse(new TextDecoder().decode(manifestPlain));

  console.log('✓ 清单解密成功，共 ' + manifest.files.length + ' 条记录');

  // 2. 逐个解密并与原始文件比对
  let allMatch = true;

  for (const entry of manifest.files) {
    const encBuf = fs.readFileSync(path.join(ROOT, entry.path));
    const plain = await decrypt(key, entry.iv, encBuf);

    const originalPath = path.join(ROOT, 'inbox', entry.name);
    const original = fs.readFileSync(originalPath);

    const same = Buffer.compare(Buffer.from(plain), original) === 0;
    if (!same) allMatch = false;

    console.log(
      '  ' + (same ? '✓' : '✗') + ' ' + entry.name +
      '  ' + plain.length + ' 字节' +
      (same ? '（与原文一致）' : '（内容不一致！）')
    );
  }

  console.log('');
  console.log(allMatch ? '✓ 全部文件解密后与原文完全一致' : '✗ 存在不一致的文件');
  process.exit(allMatch ? 0 : 1);
}

main().catch((err) => {
  if (err && /OperationError|decrypt/i.test(err.name + ' ' + err.message)) {
    console.error('✗ 密码错误（GCM 认证失败）');
  } else {
    console.error('✗ 失败：' + err.message);
  }
  process.exit(1);
});
