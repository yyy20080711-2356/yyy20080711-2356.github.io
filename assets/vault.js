/**
 * 浏览器端解密
 *
 * v2：PBKDF2-SHA-512 → HKDF 分离密钥 → AES-256-GCM（AAD 绑定路径）
 * v1：保留兼容，旧密文仍可解锁。
 */
(function (global) {
  'use strict';

  var ATTR = 'AES-GCM';
  var MAX_FILES = 2000;
  var SAFE_ENC = /^files\/[a-zA-Z0-9._-]+\.enc$/;
  var AAD_MANIFEST = 'vault-v2-manifest';

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var subtle = global.crypto && global.crypto.subtle;
  var encoder = new TextEncoder();

  function assertSupport() {
    if (!subtle) {
      throw new Error('当前浏览器不支持 Web Crypto，请使用较新版本的 Chrome / Edge / Safari。');
    }
    if (!global.isSecureContext) {
      throw new Error('解密功能需要 HTTPS 环境（或 localhost）才能使用。');
    }
  }

  function assertSafeResource(url) {
    if (typeof url !== 'string' || url.length > 180) {
      throw new Error('资源路径无效');
    }
    if (url.indexOf('..') !== -1 || url.indexOf(':') !== -1 || url.charAt(0) === '/') {
      throw new Error('资源路径无效');
    }
    if (url !== 'vault.json' && !SAFE_ENC.test(url)) {
      throw new Error('资源路径无效');
    }
  }

  function fetchBuffer(url) {
    assertSafeResource(url);
    return fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'same-origin',
      referrerPolicy: 'no-referrer'
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.arrayBuffer();
    });
  }

  function decrypt(key, ivB64, buffer, aad) {
    var data = new Uint8Array(buffer);
    if (data.length <= 16) {
      return Promise.reject(new Error('密文不完整'));
    }
    var params = {
      name: ATTR,
      iv: b64ToBytes(ivB64),
      tagLength: 128
    };
    if (aad) params.additionalData = encoder.encode(aad);
    return subtle.decrypt(params, key, data);
  }

  function importPassword(password) {
    return subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  }

  function deriveV1Key(password, kdf) {
    return subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
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

  function deriveV2Keys(password, vault) {
    var kdf = vault.kdf;
    var hkdf = vault.hkdf;
    if (!hkdf || !hkdf.salt || !hkdf.infoManifest || !hkdf.infoFiles) {
      return Promise.reject(new Error('vault.json 缺少 HKDF 参数'));
    }
    if (kdf.iterations < 100000 || kdf.iterations > 10000000) {
      return Promise.reject(new Error('KDF 参数异常'));
    }

    return importPassword(password).then(function (baseKey) {
      return subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: b64ToBytes(kdf.salt),
          iterations: kdf.iterations,
          hash: kdf.hash
        },
        baseKey,
        256
      );
    }).then(function (bits) {
      return subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    }).then(function (hkdfKey) {
      var salt = b64ToBytes(hkdf.salt);
      var hash = hkdf.hash || 'SHA-256';
      return Promise.all([
        subtle.deriveKey(
          { name: 'HKDF', hash: hash, salt: salt, info: encoder.encode(hkdf.infoManifest) },
          hkdfKey,
          { name: ATTR, length: 256 },
          false,
          ['decrypt']
        ),
        subtle.deriveKey(
          { name: 'HKDF', hash: hash, salt: salt, info: encoder.encode(hkdf.infoFiles) },
          hkdfKey,
          { name: ATTR, length: 256 },
          false,
          ['decrypt']
        )
      ]);
    }).then(function (keys) {
      return { manifestKey: keys[0], filesKey: keys[1] };
    });
  }

  function sanitizeEntry(f) {
    if (!f || typeof f !== 'object') return null;
    if (typeof f.name !== 'string' || !f.name || f.name.length > 255) return null;
    if (typeof f.path !== 'string' || !SAFE_ENC.test(f.path)) return null;
    if (typeof f.iv !== 'string' || f.iv.length < 8 || f.iv.length > 64) return null;
    if (f.name.indexOf('/') !== -1 || f.name.indexOf('\\') !== -1) return null;
    return {
      name: f.name,
      path: f.path,
      category: typeof f.category === 'string' ? f.category.slice(0, 64) : '未分类',
      description: typeof f.description === 'string' ? f.description.slice(0, 200) : '',
      size: Number(f.size) || 0,
      updated: typeof f.updated === 'string' ? f.updated.slice(0, 32) : '',
      iv: f.iv
    };
  }

  function parseManifest(plain) {
    var data = JSON.parse(new TextDecoder().decode(plain));
    var raw = (data && data.files) || [];
    if (!Array.isArray(raw) || raw.length > MAX_FILES) {
      throw new Error('清单异常');
    }
    var files = [];
    for (var i = 0; i < raw.length; i++) {
      var entry = sanitizeEntry(raw[i]);
      if (entry) files.push(entry);
    }
    return files;
  }

  function unlock(password, vault) {
    assertSupport();
    if (!vault || !vault.kdf || !vault.manifest) {
      return Promise.reject(new Error('vault.json 格式不正确'));
    }
    assertSafeResource(vault.manifest.path);

    var version = Number(vault.version) || 1;
    if (version > 2) {
      return Promise.reject(new Error('加密格式过新，请刷新页面后再试。'));
    }

    if (version >= 2) {
      return deriveV2Keys(password, vault).then(function (keys) {
        return fetchBuffer(vault.manifest.path).then(function (buf) {
          return decrypt(keys.manifestKey, vault.manifest.iv, buf, AAD_MANIFEST)
            .then(function (plain) {
              return {
                key: keys.filesKey,
                files: parseManifest(plain),
                version: 2
              };
            });
        });
      });
    }

    return deriveV1Key(password, vault.kdf).then(function (key) {
      return fetchBuffer(vault.manifest.path).then(function (buf) {
        return decrypt(key, vault.manifest.iv, buf).then(function (plain) {
          return {
            key: key,
            files: parseManifest(plain),
            version: 1
          };
        });
      });
    });
  }

  function reveal(key, entry, version) {
    if (!entry || !SAFE_ENC.test(entry.path)) {
      return Promise.reject(new Error('文件路径无效'));
    }
    var aad = version >= 2 ? ('vault-v2-file:' + entry.path) : null;
    return fetchBuffer(entry.path).then(function (buf) {
      return decrypt(key, entry.iv, buf, aad);
    }).then(function (plain) {
      return new Uint8Array(plain);
    });
  }

  global.Vault = {
    unlock: unlock,
    reveal: reveal
  };
})(window);
