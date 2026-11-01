/**
 * 文件下载中心
 * 数据来源：站点根目录的 files.json
 * 新增文件时只需在 files.json 里追加一条记录，无需改动页面代码。
 */
(function () {
  'use strict';

  var MANIFEST_URL = 'files.json';

  var state = {
    files: [],
    sortKey: null,
    sortDir: 1
  };

  var els = {
    rows: document.getElementById('fileRows'),
    empty: document.getElementById('emptyState'),
    error: document.getElementById('errorState'),
    errorDetail: document.getElementById('errorDetail'),
    count: document.getElementById('statCount'),
    size: document.getElementById('statSize'),
    updated: document.getElementById('statUpdated'),
    year: document.getElementById('year')
  };

  /* ---------- 工具函数 ---------- */

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '—';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB'];
    var value = n;
    var i = -1;
    do {
      value = value / 1024;
      i++;
    } while (value >= 1024 && i < units.length - 1);
    return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[i];
  }

  function formatDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toUpperCase() : 'FILE';
  }

  function toneOf(ext) {
    if (/^(XLSX?|XLSM|CSV|NUMBERS)$/.test(ext)) return 'sheet';
    if (/^(DOCX?|PAGES|TXT|MD)$/.test(ext)) return 'word';
    if (ext === 'PDF') return 'pdf';
    if (/^(ZIP|RAR|7Z|GZ|TAR)$/.test(ext)) return 'zip';
    return '';
  }

  var downloadIcon =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 2v8"/><path d="M4.8 7.2 8 10.4l3.2-3.2"/><path d="M2.8 13.2h10.4"/></svg>';

  /* ---------- 渲染 ---------- */

  function getSorted() {
    var list = state.files.slice();
    var key = state.sortKey;
    if (!key) return list;

    list.sort(function (a, b) {
      var x = a[key];
      var y = b[key];

      if (key === 'size') {
        x = Number(x) || 0;
        y = Number(y) || 0;
        return (x - y) * state.sortDir;
      }

      if (key === 'updated') {
        x = Date.parse(x) || 0;
        y = Date.parse(y) || 0;
        return (x - y) * state.sortDir;
      }

      return String(x || '').localeCompare(String(y || ''), 'zh-CN') * state.sortDir;
    });

    return list;
  }

  function renderRows() {
    var list = getSorted();

    els.rows.innerHTML = list.map(function (f) {
      var ext = extOf(f.name);
      var tone = toneOf(ext);
      var path = escapeHtml(f.path || '');
      var desc = f.description
        ? '<span class="file-desc">' + escapeHtml(f.description) + '</span>'
        : '';

      return '' +
        '<tr>' +
          '<td>' +
            '<div class="file-cell">' +
              '<span class="badge"' + (tone ? ' data-tone="' + tone + '"' : '') +
                '>' + escapeHtml(ext) + '</span>' +
              '<span class="file-name">' + escapeHtml(f.name) + desc + '</span>' +
            '</div>' +
          '</td>' +
          '<td><span class="cate">' + escapeHtml(f.category || '未分类') + '</span></td>' +
          '<td class="num">' + formatSize(f.size) + '</td>' +
          '<td class="num">' + formatDate(f.updated) + '</td>' +
          '<td>' +
            '<a class="btn" href="' + path + '" download>' + downloadIcon + '下载</a>' +
          '</td>' +
        '</tr>';
    }).join('');

    els.empty.hidden = list.length > 0;
  }

  function renderStats() {
    var total = 0;
    var latest = 0;

    state.files.forEach(function (f) {
      total += Number(f.size) || 0;
      var t = Date.parse(f.updated) || 0;
      if (t > latest) latest = t;
    });

    els.count.textContent = state.files.length ? state.files.length + ' 个' : '0 个';
    els.size.textContent = formatSize(total);
    els.updated.textContent = latest ? formatDate(new Date(latest).toISOString()) : '—';
  }

  function showError(message) {
    els.error.hidden = false;
    els.errorDetail.textContent = message;
    els.rows.innerHTML = '';
    els.empty.hidden = true;
  }

  /* ---------- 排序交互 ---------- */

  function bindSorting() {
    var buttons = document.querySelectorAll('.sort');

    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-sort');

        if (state.sortKey === key) {
          state.sortDir = -state.sortDir;
        } else {
          state.sortKey = key;
          state.sortDir = 1;
        }

        Array.prototype.forEach.call(buttons, function (other) {
          other.parentNode.removeAttribute('aria-sort');
        });
        btn.parentNode.setAttribute(
          'aria-sort',
          state.sortDir === 1 ? 'ascending' : 'descending'
        );

        renderRows();
      });
    });
  }

  /* ---------- 启动 ---------- */

  function init() {
    if (els.year) els.year.textContent = new Date().getFullYear();
    bindSorting();

    fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var list = Array.isArray(data) ? data : (data && data.files) || [];
        state.files = list.filter(function (f) {
          return f && f.name && f.path;
        });

        renderStats();
        renderRows();
      })
      .catch(function (err) {
        showError('无法读取文件清单 files.json（' + err.message + '）。');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
