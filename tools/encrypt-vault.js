/**
 * 加密文件库
 *
 * 把 inbox/ 里的明文文件加密成 files/ 下的 .enc 密文，并生成：
 *   vault.json              —— 公开的加密参数（盐、迭代次数、清单位置）
 *   files/manifest.enc      —— 加密后的文件清单
 *
 * 浏览器端用同一套参数派生出密钥，密码正确才能解开清单和文件。
 *
 * 用法：
 *   set VAULT_PASSWORD=你的密码
 *   node tools/encrypt-vault.js
 *
 *   node tools/encrypt-vault.js --password "你的密码"
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

/* 与浏览器端必须完全一致 */
const ITERATIONS = 600000;
const HASH = 'sha256';
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

const MIN_PASSWORD_LENGTH = 12;

/* ---------- 取密码 ---------- */

function getPassword() {
  const idx = process.argv.indexOf('--password');
  const fromArg = idx !== -1 ? process.argv[idx + 1] : '';
  const pwd = fromArg || process.env.VAULT_PASSWORD || '';

  if (!pwd) {
    console.error('✗ 缺少密码。请设置环境变量 VAULT_PASSWORD 或使用 --password 参数。');
    process.exit(1);
  }

  if (pwd.length < MIN_PASSWORD_LENGTH) {
    console.warn(
      '! 警告：密码只有 ' + pwd.length + ' 位。\n' +
      '  仓库是公开的，任何人都能下载密文并离线穷举。\n' +
      '  短密码（尤其是纯数字）几秒内就能被破解，加密保护形同虚设。\n' +
      '  如需继续，请加 --force 参数。'
    );

    if (process.argv.indexOf('--force') === -1) {
      process.exit(1);
    }

    console.warn('  已指定 --force，按当前密码继续加密。\n');
  }

  return pwd;
}

/* ---------- 加解密 ---------- */

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, ITERATIONS, KEY_LEN, HASH);
}

function encryptBuffer(key, plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { iv, body };
}

/* ---------- 收集文件 ---------- */

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

/**
 * 密文文件名用不可逆的短哈希，
 * 避免「姓名+身份证号」这类信息从仓库文件列表里泄露出去。
 */
function opaqueName(rel) {
  return crypto.createHash('sha256').update(rel, 'utf8').digest('hex').slice(0, 16) + '.enc';
}

/* ---------- 主流程 ---------- */

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

  // 先清掉上次生成的密文，避免已删除的源文件在线上残留
  for (const old of fs.readdirSync(OUT_DIR)) {
    if (old.endsWith('.enc')) fs.unlinkSync(path.join(OUT_DIR, old));
  }

  // 每次都用新的盐，避免重复使用同一密钥
  const salt = crypto.randomBytes(SALT_LEN);
  const key = deriveKey(password, salt);

  const meta = loadMeta();
  const entries = [];

  for (const abs of sources) {
    const rel = path.relative(INBOX, abs).split(path.sep).join('/');
    const plain = fs.readFileSync(abs);
    const { iv, body } = encryptBuffer(key, plain);

    const outName = opaqueName(rel);
    const outPath = path.join(OUT_DIR, outName);
    fs.writeFileSync(outPath, body);

    const info = meta[rel] || {};
    const stat = fs.statSync(abs);

    entries.push({
      name: info.name || path.basename(rel),
      path: 'files/' + outName,
      category: info.category || '未分类',
      description: info.description || '',
      size: plain.length,
      updated: stat.mtime.toISOString().slice(0, 10),
      iv: iv.toString('base64')
    });

    console.log('  ✓ ' + rel + ' → files/' + outName);  }

  entries.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));

  // 加密清单
  const manifestPlain = Buffer.from(JSON.stringify({ files: entries }), 'utf8');
  const manifestEnc = encryptBuffer(key, manifestPlain);
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.enc'), manifestEnc.body);

  // 公开的加密参数
  const vault = {
    version: 1,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: ITERATIONS,
      salt: salt.toString('base64')
    },
    manifest: {
      path: 'files/manifest.enc',
      iv: manifestEnc.iv.toString('base64')
    }
  };
  fs.writeFileSync(VAULT, JSON.stringify(vault, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('✓ 加密完成');
  console.log('  文件数量：' + entries.length);
  console.log('  输出目录：files/');
  console.log('  参数文件：vault.json');
  console.log('');
  console.log('  提醒：inbox/ 里的明文文件不会被上传（已加入 .gitignore）。');
  console.log('        确认无误后请自行删除，或留作本地备份。');
}

main();
