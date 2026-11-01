/**
 * 浏览器端解密
 *
 * 从 vault.json 读取公开的加密参数，用密码派生密钥，
 * 解开 files/manifest.enc 得到文件清单，再逐个解密下载。
 *
 * 密码错误时 GCM 校验失败，无法解出任何明文。
 */
(function (global) {
  'use strict';

  var ATTR = 'AES-GCM';

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var subtle = global.crypto && global.crypto.subtle;

  function assertSupport() {
    if (!subtle) {
      throw new Error('当前浏览器不支持 Web Crypto，请使用较新版本的 Chrome / Edge / Safari。');
    }
    // 非 HTTPS 环境下 subtle 为 undefined，本地预览时给出明确提示
    if (!global.isSecureContext) {
      throw new Error('解密功能需要 HTTPS 环境（或 localhost）才能使用。');
    }
  }

  /**
   * 用密码派生 AES-256-GCM 密钥
   */
  function deriveKey(password, kdf) {
    assertSupport();

    var enc = new TextEncoder();
    return subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (baseKey) {
        return subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: b64ToBytes(kdf.salt),
            iterations: kdf.iterations,
            hash: kdf.hash
          },
          baseKey,
          { name: ATTR, length: 256 },
          false,
          ['decrypt']
        );
      });
  }

  /**
   * AES-GCM 解密。密文尾部 16 字节是认证标签。
   */
  function decrypt(key, ivB64, buffer) {
    var data = new Uint8Array(buffer);
    if (data.length <= 16) {
      return Promise.reject(new Error('密文不完整'));
    }

    var body = data.subarray(0, data.length - 16);
    var tag = data.subarray(data.length - 16);

    return subtle.decrypt(
      { name: ATTR, iv: b64ToBytes(ivB64), tagLength: 128 },
      key,
      // WebCrypto 要求 tag 拼在密文末尾
      new Uint8Array(concat(body, tag))
    );
  }

  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function fetchBuffer(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + '（' + url + '）');
      return res.arrayBuffer();
    });
  }

  /**
   * 解锁整个文件库
   * @returns {Promise<{key: CryptoKey, files: Array}>}
   */
  function unlock(password, vault) {
    return deriveKey(password, vault.kdf).then(function (key) {
      return fetchBuffer(vault.manifest.path).then(function (buf) {
        return decrypt(key, vault.manifest.iv, buf).then(function (plain) {
          var text = new TextDecoder().decode(plain);
          var data = JSON.parse(text);
          return {
            key: key,
            files: (data && data.files) || []
          };
        });
      });
    });
  }

  /**
   * 解密单个文件并触发浏览器下载
   */
  function download(key, entry) {
    return fetchBuffer(entry.path)
      .then(function (buf) {
        return decrypt(key, entry.iv, buf);
      })
      .then(function (plain) {
        var blob = new Blob([plain], { type: 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');

        a.href = url;
        a.download = entry.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // 给浏览器一点时间开始下载再回收
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      });
  }

  global.Vault = {
    unlock: unlock,
    download: download
  };
})(window);
