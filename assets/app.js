/**
 * 文件下载中心
 *
 * 流程：读取 vault.json → 用户输入密码 → 派生密钥 → 解密清单 → 渲染列表
 * 点下载时再解密单个文件，密码不对拿不到任何明文。
 */
(function () {
  'use strict';

  var VAULT_URL = 'vault.json';

  var state = {
    vault: null,
    key: null,
    files: [],
    sortKey: null,
    sortDir: 1,
    busy: false
  };

  var els = {
    rows: document.getElementById('fileRows'),
    tableScroll: document.getElementById('tableScroll'),
    hero: document.querySelector('.hero'),
    statsBar: document.getElementById('statsBar'),
    gatePanel: document.getElementById('gatePanel'),
    listPanel: document.getElementById('listPanel'),
    errorPanel: document.getElementById('errorPanel'),
    errorDetail: document.getElementById('errorDetail'),
    gateForm: document.getElementById('gateForm'),
    gateInput: document.getElementById('passwordInput'),
    gateSubmit: document.getElementById('gateSubmit'),
    gateMessage: document.getElementById('gateMessage'),
    empty: document.getElementById('emptyState'),
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

    els.rows.innerHTML = list.map(function (f, i) {
      var ext = extOf(f.name);
      var tone = toneOf(ext);
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
            '<button type="button" class="btn dl" data-index="' + i + '">' +
              downloadIcon + '<span>下载</span>' +
            '</button>' +
          '</td>' +
        '</tr>';
    }).join('');

    els.empty.hidden = list.length > 0;
    els.tableScroll.hidden = list.length === 0;
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

  /* ---------- 状态切换 ---------- */

  function showError(message) {
    els.errorPanel.hidden = false;
    els.errorDetail.textContent = message;
    els.gatePanel.hidden = true;
    els.listPanel.hidden = true;
    els.statsBar.hidden = true;
    els.hero.classList.add('is-compact');
  }

  function showLocked() {
    els.gatePanel.hidden = false;
    els.listPanel.hidden = true;
    els.errorPanel.hidden = true;
    els.statsBar.hidden = true;
    els.hero.classList.add('is-compact');
  }

  function showList() {
    els.gatePanel.hidden = true;
    els.listPanel.hidden = false;
    els.errorPanel.hidden = true;
    els.statsBar.hidden = false;
    els.hero.classList.remove('is-compact');
    renderStats();
    renderRows();
    bindRowActions();
  }

  function setGateMessage(text, isError) {
    els.gateMessage.textContent = text || '';
    els.gateMessage.classList.toggle('is-error', !!isError);
  }

  function setBusy(busy) {
    state.busy = busy;
    els.gateSubmit.disabled = busy;
    els.gateInput.disabled = busy;
    els.gateSubmit.textContent = busy ? '验证中…' : '解锁';
  }

  /* ---------- 解锁 ---------- */

  function handleUnlock(event) {
    event.preventDefault();
    if (state.busy) return;

    var password = els.gateInput.value;
    if (!password) {
      setGateMessage('请输入密码。', true);
      els.gateInput.focus();
      return;
    }

    setBusy(true);
    setGateMessage('正在验证…', false);

    Vault.unlock(password, state.vault)
      .then(function (result) {
        state.key = result.key;
        state.files = result.files.filter(function (f) {
          return f && f.name && f.path && f.iv;
        });

        els.gateInput.value = '';
        setGateMessage('', false);
        showList();
      })
      .catch(function (err) {
        // GCM 认证失败 = 密码错误
        var isWrong = err && /OperationError|认证|decrypt/i.test(
          (err.name || '') + ' ' + (err.message || '')
        );
        setGateMessage(
          isWrong
            ? '密码不正确，请重新输入。'
            : '解锁失败：' + (err && err.message ? err.message : '未知错误'),
          true
        );
        els.gateInput.select();
      })
      .then(function () {
        setBusy(false);
      });
  }

  /* ---------- 下载 ---------- */

  function bindRowActions() {
    Array.prototype.forEach.call(
      els.rows.querySelectorAll('.dl'),
      function (btn) {
        btn.addEventListener('click', function () {
          var entry = getSorted()[Number(btn.getAttribute('data-index'))];
          if (!entry || !state.key) return;

          var label = btn.querySelector('span');
          var original = label.textContent;

          btn.disabled = true;
          label.textContent = '解密中';

          Vault.download(state.key, entry)
            .then(function () {
              label.textContent = '已完成';
              setTimeout(function () {
                label.textContent = original;
                btn.disabled = false;
              }, 1600);
            })
            .catch(function (err) {
              label.textContent = '失败';
              console.error(err);
              setTimeout(function () {
                label.textContent = original;
                btn.disabled = false;
              }, 2200);
            });
        });
      }
    );
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
        bindRowActions();
      });
    });
  }

  /* ---------- 启动 ---------- */

  function init() {
    if (els.year) els.year.textContent = new Date().getFullYear();

    bindSorting();
    els.gateForm.addEventListener('submit', handleUnlock);
    els.gateInput.focus();

    fetch(VAULT_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (vault) {
        if (!vault || !vault.kdf || !vault.manifest) {
          throw new Error('vault.json 格式不正确');
        }
        state.vault = vault;
        showLocked();
      })
      .catch(function (err) {
        showError('无法读取加密参数 vault.json（' + err.message + '）。');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
