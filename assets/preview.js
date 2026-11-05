/**
 * 仅在线查阅：把解密后的字节画到 canvas，不生成下载链接。
 */
(function (global) {
  'use strict';

  var MAX_UNZIP_FILES = 400;
  var MAX_UNZIP_BYTES = 40 * 1024 * 1024;
  var MAX_SHEET_ROWS = 80;
  var MAX_SHEET_COLS = 16;

  function u16(v, o) { return v[o] | (v[o + 1] << 8); }
  function u32(v, o) {
    return (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] * 0x1000000)) >>> 0;
  }

  function decodeName(bytes, utf8) {
    try {
      return new TextDecoder(utf8 ? 'utf-8' : 'gbk').decode(bytes);
    } catch (e) {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  function findEOCD(v) {
    var min = Math.max(0, v.length - 65557);
    for (var i = v.length - 22; i >= min; i--) {
      if (u32(v, i) === 0x06054b50) return i;
    }
    return -1;
  }

  function parseZip(buf) {
    var v = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var eocd = findEOCD(v);
    if (eocd < 0) throw new Error('不是有效的压缩包');
    var count = u16(v, eocd + 10);
    var offset = u32(v, eocd + 16);
    if (count > MAX_UNZIP_FILES) throw new Error('压缩包文件过多');
    var entries = [];
    var p = offset;
    for (var n = 0; n < count && p + 46 <= v.length; n++) {
      if (u32(v, p) !== 0x02014b50) break;
      var method = u16(v, p + 10);
      var compSize = u32(v, p + 20);
      var uncomp = u32(v, p + 24);
      var nameLen = u16(v, p + 28);
      var extraLen = u16(v, p + 30);
      var commentLen = u16(v, p + 32);
      var flags = u16(v, p + 8);
      var localOff = u32(v, p + 42);
      var nameBytes = v.subarray(p + 46, p + 46 + nameLen);
      var name;
      try {
        name = decodeName(nameBytes, (flags & 0x800) !== 0);
      } catch (e) {
        name = decodeName(nameBytes, true);
      }
      var local = localOff;
      if (u32(v, local) !== 0x04034b50) {
        p += 46 + nameLen + extraLen + commentLen;
        continue;
      }
      var lName = u16(v, local + 26);
      var lExtra = u16(v, local + 28);
      var dataStart = local + 30 + lName + lExtra;
      entries.push({
        name: name.replace(/\\/g, '/'),
        method: method,
        size: uncomp,
        data: v.subarray(dataStart, dataStart + compSize)
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function inflate(entry) {
    if (entry.method === 0) {
      return Promise.resolve(entry.data.slice(0));
    }
    if (entry.method !== 8) {
      return Promise.reject(new Error('不支持的压缩方式'));
    }
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('当前浏览器无法解压'));
    }
    var stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function findEntry(entries, path) {
    path = path.replace(/^\//, '');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === path) return entries[i];
    }
    return null;
  }

  function xml(bytes) {
    var text = new TextDecoder('utf-8').decode(bytes);
    return new DOMParser().parseFromString(text, 'application/xml');
  }

  function cellRef(r) {
    var m = /^([A-Z]+)(\d+)$/.exec(r || '');
    if (!m) return null;
    var col = 0;
    for (var i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
    return { c: col - 1, r: Number(m[2]) - 1 };
  }

  function readSharedStrings(doc) {
    var nodes = doc.getElementsByTagName('si');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].getElementsByTagName('t');
      var s = '';
      for (var j = 0; j < t.length; j++) s += t[j].textContent || '';
      out.push(s);
    }
    return out;
  }

  function readSheet(doc, strings) {
    var cells = doc.getElementsByTagName('c');
    var grid = [];
    var maxR = 0;
    var maxC = 0;
    for (var i = 0; i < cells.length; i++) {
      var pos = cellRef(cells[i].getAttribute('r'));
      if (!pos || pos.r >= MAX_SHEET_ROWS || pos.c >= MAX_SHEET_COLS) continue;
      var t = cells[i].getAttribute('t');
      var vNode = cells[i].getElementsByTagName('v')[0];
      var isNode = cells[i].getElementsByTagName('is')[0];
      var val = '';
      if (isNode) val = isNode.textContent || '';
      else if (vNode) {
        val = vNode.textContent || '';
        if (t === 's') val = strings[Number(val)] || '';
      }
      if (!grid[pos.r]) grid[pos.r] = [];
      grid[pos.r][pos.c] = val;
      if (pos.r > maxR) maxR = pos.r;
      if (pos.c > maxC) maxC = pos.c;
    }
    return { grid: grid, rows: maxR + 1, cols: maxC + 1 };
  }

  function stamp(ctx, w, h, label) {
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#0e1a2f';
    ctx.font = '14px sans-serif';
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-0.32);
    var text = label || '仅供查阅 禁止保存';
    for (var y = -h; y < h; y += 90) {
      for (var x = -w; x < w; x += 220) {
        ctx.fillText(text, x, y);
      }
    }
    ctx.restore();
  }

  function drawTable(sheet, title) {
    var pad = 24;
    var rowH = 30;
    var colW = Math.max(88, Math.min(168, Math.floor(960 / Math.max(sheet.cols, 1))));
    var canvas = document.createElement('canvas');
    canvas.width = pad * 2 + colW * Math.max(sheet.cols, 1);
    canvas.height = pad * 2 + 36 + rowH * Math.max(sheet.rows, 1);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#101a2b';
    ctx.font = '600 16px sans-serif';
    ctx.fillText(title || '表格', pad, pad + 8);
    ctx.font = '13px sans-serif';
    ctx.strokeStyle = '#e2e8f0';
    for (var r = 0; r < sheet.rows; r++) {
      for (var c = 0; c < sheet.cols; c++) {
        var x = pad + c * colW;
        var y = pad + 24 + r * rowH;
        ctx.strokeRect(x, y, colW, rowH);
        var text = sheet.grid[r] && sheet.grid[r][c] != null ? String(sheet.grid[r][c]) : '';
        ctx.fillStyle = '#243049';
        ctx.fillText(text.slice(0, 18), x + 8, y + 20);
      }
    }
    stamp(ctx, canvas.width, canvas.height, title);
    return canvas;
  }

  function drawImage(bytes, title) {
    var type = 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) type = 'image/png';
    else if (bytes[0] === 0x47 && bytes[1] === 0x49) type = 'image/gif';
    else if (bytes[0] === 0x52 && bytes[1] === 0x49) type = 'image/webp';
    return createImageBitmap(new Blob([bytes], { type: type })).then(function (bmp) {
      var maxW = 960;
      var scale = Math.min(1, maxW / bmp.width);
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      stamp(ctx, canvas.width, canvas.height, title);
      return canvas;
    });
  }

  function isImageName(name) {
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
  }

  function isSheetZip(entries) {
    return entries.some(function (e) { return e.name === 'xl/workbook.xml'; });
  }

  function renderXlsx(bytes, title) {
    var entries = parseZip(bytes);
    var ss = findEntry(entries, 'xl/sharedStrings.xml');
    var sheet = findEntry(entries, 'xl/worksheets/sheet1.xml');
    if (!sheet) throw new Error('表格内容无法解析');
    var stringsP = ss ? inflate(ss).then(function (b) { return readSharedStrings(xml(b)); }) : Promise.resolve([]);
    return stringsP.then(function (strings) {
      return inflate(sheet).then(function (b) {
        return drawTable(readSheet(xml(b), strings), title);
      });
    });
  }

  function renderZipGallery(bytes, title, onPage) {
    var entries = parseZip(bytes).filter(function (e) {
      return !e.name.endsWith('/') && isImageName(e.name);
    });
    if (!entries.length) {
      return Promise.resolve({ kind: 'empty', total: 0 });
    }
    var total = 0;
    for (var i = 0; i < entries.length; i++) total += entries[i].size || entries[i].data.length;
    if (total > MAX_UNZIP_BYTES) throw new Error('内容过大，无法在线查阅');

    var index = 0;
    function show(i) {
      index = (i + entries.length) % entries.length;
      return inflate(entries[index]).then(function (img) {
        return drawImage(img, title).then(function (canvas) {
          if (onPage) onPage(canvas, index + 1, entries.length, entries[index].name);
          return canvas;
        });
      });
    }
    return show(0).then(function () {
      return { kind: 'gallery', total: entries.length, go: show };
    });
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toUpperCase() : '';
  }

  function render(bytes, name, onPage) {
    var ext = extOf(name);
    if (/^(PNG|JPE?G|JPG|GIF|WEBP|BMP)$/.test(ext)) {
      return drawImage(bytes, name).then(function (canvas) {
        if (onPage) onPage(canvas, 1, 1, name);
        return { kind: 'image', canvas: canvas, total: 1 };
      });
    }
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      var entries = parseZip(bytes);
      if (ext === 'XLSX' || isSheetZip(entries)) {
        return renderXlsx(bytes, name).then(function (canvas) {
          if (onPage) onPage(canvas, 1, 1, name);
          return { kind: 'sheet', canvas: canvas, total: 1 };
        });
      }
      return renderZipGallery(bytes, name, onPage);
    }
    return Promise.resolve({ kind: 'blocked' });
  }

  function burn(canvas) {
    if (!canvas) return;
    try {
      var ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    } catch (e) {}
    canvas.width = 1;
    canvas.height = 1;
  }

  global.Preview = {
    render: render,
    burn: burn
  };
})(window);
