/**
 * 端到端验证：用 Node 的 WebCrypto 复刻浏览器解密流程
 * 同时支持 v1 与 v2。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');

const subtle = webcrypto.subtle;
const ROOT = path.resolve(__dirname, '..');
const encoder = new TextEncoder();

const PASSWORD = process.env.VAULT_PASSWORD || process.argv[2];
if (!PASSWORD) {
  console.error('用法：VAULT_PASSWORD=... node tools/verify.js');
  process.exit(1);
}

function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function deriveV1Key(password, kdf) {
  const baseKey = await subtle.importKey(
    'raw',
    encoder.encode(password),
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

async function deriveV2Keys(password, vault) {
  const baseKey = await subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: b64ToBytes(vault.kdf.salt),
      iterations: vault.kdf.iterations,
      hash: vault.kdf.hash
    },
    baseKey,
    256
  );
  const hkdfKey = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const salt = b64ToBytes(vault.hkdf.salt);
  const hash = vault.hkdf.hash || 'SHA-256';
  const manifestKey = await subtle.deriveKey(
    { name: 'HKDF', hash, salt, info: encoder.encode(vault.hkdf.infoManifest) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const filesKey = await subtle.deriveKey(
    { name: 'HKDF', hash, salt, info: encoder.encode(vault.hkdf.infoFiles) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  return { manifestKey, filesKey };
}

async function decrypt(key, ivB64, buffer, aad) {
  const params = {
    name: 'AES-GCM',
    iv: b64ToBytes(ivB64),
    tagLength: 128
  };
  if (aad) params.additionalData = encoder.encode(aad);
  const plain = await subtle.decrypt(params, key, buffer);
  return new Uint8Array(plain);
}

async function main() {
  const vault = JSON.parse(fs.readFileSync(path.join(ROOT, 'vault.json'), 'utf8'));
  const version = Number(vault.version) || 1;

  let manifestKey;
  let filesKey;
  if (version >= 2) {
    const keys = await deriveV2Keys(PASSWORD, vault);
    manifestKey = keys.manifestKey;
    filesKey = keys.filesKey;
  } else {
    manifestKey = await deriveV1Key(PASSWORD, vault.kdf);
    filesKey = manifestKey;
  }

  const manifestBuf = fs.readFileSync(path.join(ROOT, vault.manifest.path));
  const manifestAad = version >= 2 ? 'vault-v2-manifest' : null;
  const manifestPlain = await decrypt(manifestKey, vault.manifest.iv, manifestBuf, manifestAad);
  const manifest = JSON.parse(new TextDecoder().decode(manifestPlain));

  console.log('✓ 清单解密成功（v' + version + '），共 ' + manifest.files.length + ' 条记录');

  let allMatch = true;

  for (const entry of manifest.files) {
    const encBuf = fs.readFileSync(path.join(ROOT, entry.path));
    const fileAad = version >= 2 ? ('vault-v2-file:' + entry.path) : null;
    const plain = await decrypt(filesKey, entry.iv, encBuf, fileAad);

    const originalPath = path.join(ROOT, 'inbox', entry.name);
    if (!fs.existsSync(originalPath)) {
      console.log('  ? ' + entry.name + '  inbox 中无对应原文，跳过比对');
      continue;
    }
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
