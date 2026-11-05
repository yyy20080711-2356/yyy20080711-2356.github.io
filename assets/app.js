/**
 * 仅在线查阅。不提供下载，明文只画到 canvas，打开调试工具立即锁定。
 */
(function () {
  'use strict';

  var VAULT_URL = 'vault.json';
  var MAX_PASSWORD_LENGTH = 128;
  var AUTO_LOCK_MS = 3 * 60 * 1000;
  var HIDDEN_LOCK_MS = 20 * 1000;
  var MAX_BACKOFF_MS = 60 * 1000;
  var FAIL_WINDOW_MS = 15 * 60 * 1000;

  var state = {
    vault: null,
    key: null,
    files: [],
    version: 1,
    sortKey: null,
    sortDir: 1,
    busy: false,
    failCount: 0,
    failWindowStart: 0,
    lockTimer: 0,
    hiddenTimer: 0,
    probeTimer: 0,
    gallery: null,
    canvas: null,
    viewing: false
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
    year: document.getElementById('year'),
    lockBtn: document.getElementById('lockBtn'),
    viewer: document.getElementById('viewer'),
    viewerStage: document.getElementById('viewerStage'),
    viewerTitle: document.getElementById('viewerTitle'),
    viewerMeta: document.getElementById('viewerMeta'),
    viewerClose: document.getElementById('viewerClose'),
    viewerPrev: document.getElementById('viewerPrev'),
    viewerNext: document.getElementById('viewerNext'),
    viewerMsg: document.getElementById('viewerMsg')
  };

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

  var viewIcon =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8s-2.4 4.4-6.4 4.4S1.6 8 1.6 8z"/>' +
    '<circle cx="8" cy="8" r="1.7"/></svg>';

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
            '<button type="button" class="btn view" data-index="' + i + '">' +
              viewIcon + '<span>查阅</span>' +
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

  function showError(message) {
    els.errorPanel.hidden = false;
    els.errorDetail.textContent = message;
    els.gatePanel.hidden = true;
    els.listPanel.hidden = true;
    els.statsBar.hidden = true;
    els.hero.classList.add('is-compact');
    closeViewer();
  }

  function showLocked() {
    els.gatePanel.hidden = false;
    els.listPanel.hidden = true;
    els.errorPanel.hidden = true;
    els.statsBar.hidden = true;
    els.hero.classList.add('is-compact');
    closeViewer();
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
    bumpActivity();
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

  function clearLockTimer() {
    if (state.lockTimer) {
      clearTimeout(state.lockTimer);
      state.lockTimer = 0;
    }
  }

  function clearHiddenTimer() {
    if (state.hiddenTimer) {
      clearTimeout(state.hiddenTimer);
      state.hiddenTimer = 0;
    }
  }

  function burnCanvas() {
    if (state.canvas && globalThis.Preview) Preview.burn(state.canvas);
    state.canvas = null;
    if (els.viewerStage) els.viewerStage.innerHTML = '';
  }

  function closeViewer() {
    state.gallery = null;
    state.viewing = false;
    burnCanvas();
    if (els.viewer) els.viewer.hidden = true;
    if (els.viewerMsg) els.viewerMsg.textContent = '';
  }

  function wipeSession() {
    state.key = null;
    state.files = [];
    state.sortKey = null;
    state.sortDir = 1;
    state.gallery = null;
    if (els.rows) els.rows.innerHTML = '';
    els.count.textContent = '—';
    els.size.textContent = '—';
    els.updated.textContent = '—';
    if (els.gateInput) els.gateInput.value = '';
    closeViewer();
    clearLockTimer();
    clearHiddenTimer();
  }

  function lockVault(reason) {
    wipeSession();
    showLocked();
    setGateMessage(reason || '已锁定，请重新输入密码。', false);
    if (els.gateInput) els.gateInput.focus();
  }

  function bumpActivity() {
    if (!state.key) return;
    clearLockTimer();
    state.lockTimer = setTimeout(function () {
      lockVault('闲置超时，已自动锁定。');
    }, AUTO_LOCK_MS);
  }

  function backoffMs() {
    if (state.failCount < 3) return 0;
    var shift = Math.min(state.failCount - 2, 10);
    return Math.min(MAX_BACKOFF_MS, 2000 * Math.pow(2, shift - 1));
  }

  function noteFailure() {
    var now = Date.now();
    if (!state.failWindowStart || now - state.failWindowStart > FAIL_WINDOW_MS) {
      state.failWindowStart = now;
      state.failCount = 0;
    }
    state.failCount += 1;
  }

  function noteSuccess() {
    state.failCount = 0;
    state.failWindowStart = 0;
  }

  function handleUnlock(event) {
    event.preventDefault();
    if (state.busy) return;

    var wait = backoffMs();
    if (wait > 0) {
      setGateMessage('尝试次数过多，请 ' + Math.ceil(wait / 1000) + ' 秒后再试。', true);
      return;
    }

    var password = els.gateInput.value;
    if (!password) {
      setGateMessage('请输入密码。', true);
      els.gateInput.focus();
      return;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      setGateMessage('密码过长。', true);
      return;
    }

    setBusy(true);
    setGateMessage('正在验证…', false);

    Vault.unlock(password, state.vault)
      .then(function (result) {
        password = '';
        noteSuccess();
        state.key = result.key;
        state.version = result.version || 1;
        state.files = result.files;
        els.gateInput.value = '';
        setGateMessage('', false);
        showList();
      })
      .catch(function (err) {
        password = '';
        noteFailure();
        var isWrong = err && /OperationError|认证|decrypt/i.test(
          (err.name || '') + ' ' + (err.message || '')
        );
        var extra = backoffMs() > 0
          ? ' 请等待 ' + Math.ceil(backoffMs() / 1000) + ' 秒后再试。'
          : '';
        var support = err && /Web Crypto|HTTPS/.test(err.message || '');
        setGateMessage(
          (support
            ? err.message
            : (isWrong ? '密码不正确，请重新输入。' : '解锁失败，请稍后重试。')) + extra,
          true
        );
        els.gateInput.select();
      })
      .then(function () {
        setBusy(false);
      });
  }

  function mountCanvas(canvas) {
    burnCanvas();
    state.canvas = canvas;
    canvas.className = 'view-canvas';
    els.viewerStage.innerHTML = '';
    els.viewerStage.appendChild(canvas);
  }

  function onPreviewPage(canvas, i, total, fileName) {
    mountCanvas(canvas);
    els.viewerMeta.textContent = total > 1
      ? ('仅供查阅  ' + i + ' / ' + total)
      : '仅供查阅，无法保存文件';
    els.viewerMeta.setAttribute('data-i', String(i));
    if (fileName) els.viewerTitle.textContent = fileName;
  }

  function openViewer(entry) {
    if (!entry || !state.key) return;
    bumpActivity();
    state.viewing = true;
    state.gallery = null;
    els.viewer.hidden = false;
    els.viewerTitle.textContent = entry.name;
    els.viewerMeta.textContent = '解密中…';
    els.viewerMsg.textContent = '不提供下载。打开调试工具会立即锁定。';
    els.viewerPrev.hidden = true;
    els.viewerNext.hidden = true;
    els.viewerStage.innerHTML = '';

    Vault.reveal(state.key, entry, state.version)
      .then(function (bytes) {
        return Preview.render(bytes, entry.name, onPreviewPage);
      })
      .then(function (result) {
        if (!state.viewing) return;
        if (!result || result.kind === 'blocked' || result.kind === 'empty') {
          els.viewerMeta.textContent = '该类型仅可在线查阅，当前格式无法预览。';
          return;
        }
        if (result.kind === 'gallery') {
          state.gallery = result;
          els.viewerPrev.hidden = result.total < 2;
          els.viewerNext.hidden = result.total < 2;
        }
      })
      .catch(function () {
        if (!state.viewing) return;
        els.viewerMeta.textContent = '查阅失败';
        els.viewerMsg.textContent = '内容无法在线显示。';
      });
  }

  function bindRowActions() {
    Array.prototype.forEach.call(
      els.rows.querySelectorAll('.view'),
      function (btn) {
        btn.addEventListener('click', function () {
          var entry = getSorted()[Number(btn.getAttribute('data-index'))];
          openViewer(entry);
        });
      }
    );
  }

  function bindSorting() {
    var buttons = document.querySelectorAll('.sort');

    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        bumpActivity();
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

  function blockExfil(event) {
    var type = event.type;
    if (type === 'contextmenu' || type === 'dragstart' || type === 'copy' || type === 'cut' || type === 'selectstart') {
      event.preventDefault();
      return false;
    }
    if (type === 'keydown') {
      var k = event.key;
      var ctrl = event.ctrlKey || event.metaKey;
      var blocked =
        k === 'F12' ||
        k === 'PrintScreen' ||
        (ctrl && event.shiftKey && (k === 'I' || k === 'J' || k === 'C' || k === 'i' || k === 'j' || k === 'c')) ||
        (ctrl && (k === 's' || k === 'S' || k === 'p' || k === 'P' || k === 'u' || k === 'U')) ||
        (event.altKey && (k === 'PrintScreen' || k === 'p' || k === 'P'));
      if (blocked) {
        event.preventDefault();
        if (state.key) lockVault('检测到调试或保存操作，已锁定。');
        return false;
      }
    }
  }

  function startProbe() {
    if (state.probeTimer) return;
    var last = Date.now();
    state.probeTimer = setInterval(function () {
      var now = Date.now();
      if (now - last > 1400 && state.key) {
        lockVault('检测到调试环境，已锁定。');
      }
      last = now;
      var gap = (window.outerWidth - window.innerWidth) > 180 ||
                (window.outerHeight - window.innerHeight) > 220;
      if (gap && state.key) {
        lockVault('检测到开发者工具，已锁定。');
      }
    }, 700);
  }

  function bindSessionGuards() {
    ['click', 'mousemove', 'touchstart'].forEach(function (evt) {
      document.addEventListener(evt, bumpActivity, { passive: true });
    });

    ['contextmenu', 'dragstart', 'copy', 'cut', 'selectstart', 'keydown'].forEach(function (evt) {
      document.addEventListener(evt, blockExfil);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearHiddenTimer();
        state.hiddenTimer = setTimeout(function () {
          if (document.hidden) lockVault('离开页面过久，已自动锁定。');
        }, HIDDEN_LOCK_MS);
      } else {
        clearHiddenTimer();
        bumpActivity();
      }
    });

    window.addEventListener('pagehide', function () {
      wipeSession();
    });
    window.addEventListener('blur', function () {
      if (state.viewing) closeViewer();
    });

    if (els.lockBtn) {
      els.lockBtn.addEventListener('click', function () {
        lockVault('已手动锁定。');
      });
    }
    if (els.viewerClose) {
      els.viewerClose.addEventListener('click', closeViewer);
    }
    if (els.viewerPrev) {
      els.viewerPrev.addEventListener('click', function () {
        if (state.gallery && state.gallery.go) {
          var idx = Number(els.viewerMeta.getAttribute('data-i') || '1') - 2;
          state.gallery.go(idx);
        }
      });
    }
    if (els.viewerNext) {
      els.viewerNext.addEventListener('click', function () {
        if (state.gallery && state.gallery.go) {
          var idx = Number(els.viewerMeta.getAttribute('data-i') || '1');
          state.gallery.go(idx);
        }
      });
    }

    startProbe();
  }

  function init() {
    if (location.search || location.hash) {
      history.replaceState(null, '', location.pathname);
    }
    if (els.year) els.year.textContent = new Date().getFullYear();

    bindSorting();
    bindSessionGuards();
    els.gateForm.addEventListener('submit', handleUnlock);
    els.gateInput.setAttribute('maxlength', String(MAX_PASSWORD_LENGTH));
    els.gateInput.focus();

    fetch(VAULT_URL, {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (vault) {
        if (!vault || !vault.kdf || !vault.manifest) {
          throw new Error('vault.json 格式不正确');
        }
        if (typeof vault.kdf.iterations !== 'number' || vault.kdf.iterations < 100000) {
          throw new Error('KDF 参数异常');
        }
        state.vault = vault;
        showLocked();
      })
      .catch(function () {
        showError('无法读取加密参数，请刷新页面重试。');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
