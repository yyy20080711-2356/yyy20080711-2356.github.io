/**
 * 加密文件库（v2）
 *
 * 把 inbox/ 里的明文文件加密成 files/ 下的 .enc 密文，并生成：
 *   vault.json              —— 公开的加密参数（盐、迭代次数、清单位置）
 *   files/manifest.enc      —— 加密后的文件清单
 *
 * v2：PBKDF2-SHA-512 → HKDF 分离清单/文件密钥 → AES-256-GCM（带 AAD）
 *
 * 用法：
 *   set VAULT_PASSWORD=你的密码
 *   node tools/encrypt-vault.js
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INBOX = path.join(ROOT, 'inbox');
const OUT_DIR = path.join(ROOT, 'files');
const VAULT = path.join(ROOT, 'vault.json');
const META = path.join(INBOX, '_meta.json');

const VERSION = 2;
const ITERATIONS = 1000000;
const HASH = 'sha512';
const KEY_LEN = 32;
const SALT_LEN = 32;
const HKDF_HASH = 'sha256';
const HKDF_SALT_LEN = 32;
const IV_LEN = 12;
const MIN_PASSWORD_LENGTH = 16;

const INFO_MANIFEST = 'vault-v2-manifest';
const INFO_FILES = 'vault-v2-files';
const AAD_MANIFEST = 'vault-v2-manifest';

function aadForFile(encPath) {
  return 'vault-v2-file:' + encPath;
}

function passwordClasses(pwd) {
  let n = 0;
  if (/[a-z]/.test(pwd)) n++;
  if (/[A-Z]/.test(pwd)) n++;
  if (/[0-9]/.test(pwd)) n++;
  if (/[^a-zA-Z0-9]/.test(pwd)) n++;
  return n;
}

function assertPassword(pwd) {
  if (pwd.length < MIN_PASSWORD_LENGTH) {
    console.error(
      '✗ 密码至少 ' + MIN_PASSWORD_LENGTH + ' 位。仓库公开，短密码可被离线穷举。'
    );
    process.exit(1);
  }
  if (/^\d+$/.test(pwd)) {
    console.error('✗ 禁止纯数字密码。');
    process.exit(1);
  }
  if (passwordClasses(pwd) < 3) {
    console.error('✗ 密码须至少包含三类：小写、大写、数字、特殊字符。');
    process.exit(1);
  }
}

function getPassword() {
  const idx = process.argv.indexOf('--password');
  const fromArg = idx !== -1 ? process.argv[idx + 1] : '';
  const pwd = fromArg || process.env.VAULT_PASSWORD || '';

  if (!pwd) {
    console.error('✗ 缺少密码。请设置环境变量 VAULT_PASSWORD。');
    process.exit(1);
  }

  if (fromArg) {
    console.warn('! 命令行 --password 会出现在进程列表中，优先使用环境变量。');
  }

  assertPassword(pwd);
  return pwd;
}

function deriveMaster(password, salt) {
  return crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, ITERATIONS, KEY_LEN, HASH);
}

function derivePurposeKey(master, hkdfSalt, info) {
  return Buffer.from(crypto.hkdfSync(HKDF_HASH, master, hkdfSalt, Buffer.from(info, 'utf8'), KEY_LEN));
}

function encryptBuffer(key, plain, aad) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { iv, body };
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '_meta.json') continue;

    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs));
    } else {
      out.push(abs);
    }
  }

  return out;
}

function loadMeta() {
  if (!fs.existsSync(META)) return {};
  try {
    return JSON.parse(fs.readFileSync(META, 'utf8'));
  } catch (err) {
    console.warn('! _meta.json 解析失败，忽略：' + err.message);
    return {};
  }
}

function randomEncName() {
  return crypto.randomBytes(16).toString('hex') + '.enc';
}

function main() {
  const password = getPassword();

  if (!fs.existsSync(INBOX)) {
    fs.mkdirSync(INBOX, { recursive: true });
    console.log('已创建 inbox/ 目录，把要加密的文件放进去后重新运行。');
    return;
  }

  const sources = walk(INBOX);
  if (!sources.length) {
    console.error('✗ inbox/ 里没有文件。');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const old of fs.readdirSync(OUT_DIR)) {
    if (old.endsWith('.enc')) fs.unlinkSync(path.join(OUT_DIR, old));
  }

  const salt = crypto.randomBytes(SALT_LEN);
  const hkdfSalt = crypto.randomBytes(HKDF_SALT_LEN);
  const master = deriveMaster(password, salt);
  const manifestKey = derivePurposeKey(master, hkdfSalt, INFO_MANIFEST);
  const filesKey = derivePurposeKey(master, hkdfSalt, INFO_FILES);
  master.fill(0);

  const meta = loadMeta();
  const entries = [];
  const usedNames = Object.create(null);

  for (const abs of sources) {
    const rel = path.relative(INBOX, abs).split(path.sep).join('/');
    const plain = fs.readFileSync(abs);

    let outName = randomEncName();
    while (usedNames[outName]) outName = randomEncName();
    usedNames[outName] = true;

    const encPath = 'files/' + outName;
    const { iv, body } = encryptBuffer(filesKey, plain, aadForFile(encPath));
    fs.writeFileSync(path.join(OUT_DIR, outName), body);

    const info = meta[rel] || {};
    const stat = fs.statSync(abs);

    entries.push({
      name: info.name || path.basename(rel),
      path: encPath,
      category: info.category || '未分类',
      description: info.description || '',
      size: plain.length,
      updated: stat.mtime.toISOString().slice(0, 10),
      iv: iv.toString('base64')
    });

    console.log('  ✓ ' + rel + ' → files/' + outName);
  }

  entries.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));

  const manifestPlain = Buffer.from(JSON.stringify({ files: entries }), 'utf8');
  const manifestEnc = encryptBuffer(manifestKey, manifestPlain, AAD_MANIFEST);
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.enc'), manifestEnc.body);

  const vault = {
    version: VERSION,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-512',
      iterations: ITERATIONS,
      salt: salt.toString('base64')
    },
    hkdf: {
      hash: 'SHA-256',
      salt: hkdfSalt.toString('base64'),
      infoManifest: INFO_MANIFEST,
      infoFiles: INFO_FILES
    },
    manifest: {
      path: 'files/manifest.enc',
      iv: manifestEnc.iv.toString('base64')
    }
  };
  fs.writeFileSync(VAULT, JSON.stringify(vault, null, 2) + '\n', 'utf8');

  manifestKey.fill(0);
  filesKey.fill(0);

  console.log('');
  console.log('✓ 加密完成（v2）');
  console.log('  文件数量：' + entries.length);
  console.log('  输出目录：files/');
  console.log('  参数文件：vault.json');
  console.log('');
  console.log('  提醒：inbox/ 里的明文与 _meta.json 都不会被上传。');
}

main();
