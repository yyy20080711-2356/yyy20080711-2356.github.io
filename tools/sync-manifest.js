/**
 * 同步文件清单
 *
 * 扫描 files/ 目录，按实际文件重新生成 files.json。
 * 已存在记录里的 description / category 会被保留，不会丢失。
 *
 * 用法：
 *   node tools/sync-manifest.js
 *   node tools/sync-manifest.js --category "考核表"     # 给新增文件指定分类
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES_DIR = path.join(ROOT, 'files');
const MANIFEST = path.join(ROOT, 'files.json');

const DEFAULT_CATEGORY = '未分类';

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
let category = DEFAULT_CATEGORY;
const cIndex = argv.indexOf('--category');
if (cIndex !== -1 && argv[cIndex + 1]) {
  category = argv[cIndex + 1];
}

/* ---------- 读取旧清单，保留人工填写的字段 ---------- */
function loadExisting() {
  const map = new Map();
  if (!fs.existsSync(MANIFEST)) return map;

  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.files || [];
    for (const item of list) {
      if (item && item.path) map.set(item.path, item);
    }
  } catch (err) {
    console.warn('! 现有 files.json 解析失败，将重新生成：' + err.message);
  }

  return map;
}

/* ---------- 扫描目录（含子目录） ---------- */
function walk(dir, base) {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;

    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs, base));
    } else {
      out.push({
        abs,
        rel: path.relative(base, abs).split(path.sep).join('/')
      });
    }
  }

  return out;
}

/* ---------- 生成清单 ---------- */
const existing = loadExisting();
const found = walk(FILES_DIR, ROOT);

const files = found.map(({ abs, rel }) => {
  const stat = fs.statSync(abs);
  const old = existing.get(rel) || {};

  return {
    name: old.name || path.basename(rel),
    path: rel,
    category: old.category || category,
    description: old.description || '',
    size: stat.size,
    updated: stat.mtime.toISOString().slice(0, 10)
  };
});

// 按修改时间倒序，最新的文件排在最前
files.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));

fs.writeFileSync(MANIFEST, JSON.stringify({ files }, null, 2) + '\n', 'utf8');

const kept = files.filter((f) => existing.has(f.path)).length;
console.log('✓ files.json 已更新');
console.log('  文件总数：' + files.length);
console.log('  新增条目：' + (files.length - kept));
if (files.length) {
  console.log('  提示：可编辑 files.json 为文件补充 description / category');
}
