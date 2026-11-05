# 资料查阅（加密版）

基于 GitHub Pages 的静态查阅站。所有文件在**本地加密**后上传，页面上输入
密码后仅可在线查阅，不提供下载。

线上地址：<https://yyy20080711-2356.github.io>

## 安全模型

- 服务器上**只有密文**。GitHub 上存的是 `.enc` 文件，没有密码就是随机字节。
- 密码**不会上传**，认证在浏览器本地完成，通过 AES-GCM 的认证标签校验。
- 仓库是公开的，**任何人都能下载到密文**，安全性完全取决于密码强度。
- 这是「加密保护」：数据本身是密文，即使被拿走也读不出来。

### 当前加密规格（v2）

| 项目 | 规格 |
|------|------|
| 密钥派生 | PBKDF2-HMAC-SHA-512，100 万次迭代，32 字节随机盐 |
| 密钥分离 | HKDF-SHA-256，清单密钥与文件密钥分开 |
| 对称加密 | AES-256-GCM，每文件独立 12 字节 IV，128 位认证标签 |
| 完整性绑定 | GCM AAD 绑定用途与密文路径，防清单/文件调包 |
| 密文文件名 | 每次加密重新生成的随机名，不从仓库文件名反推原文 |
| 口令策略 | 至少 16 位，且至少三类字符；禁止纯数字 |

浏览器仍可解锁旧的 v1 密文。要启用 v2，必须用当前密码重新运行加密脚本。

### 前端防护

- CSP、nosniff、no-referrer、禁止被嵌入
- 拉取密文仅限同源 `files/*.enc`
- 错误口令指数退避（客户端，防页面连点；离线穷举仍靠口令强度）
- 密钥只在内存；3 分钟闲置、离开页面、打开调试工具、或点「锁定」即丢弃
- 页面去掉下载按钮；明文只画到 canvas，关闭查阅即擦除
- 拦截保存 / 打印 / 复制 / 右键；打开开发者工具立即锁定

## 目录结构

```
.
├── index.html            # 页面
├── assets/
│   ├── style.css
│   ├── vault.js          # 浏览器端解密
│   └── app.js
├── files/                # 密文（会提交到仓库）
│   ├── manifest.enc
│   └── *.enc
├── inbox/                # 明文源文件（gitignore，不会上传）
│   └── _meta.json        # 本地分类说明，不要提交
├── tools/
│   ├── encrypt-vault.js
│   └── verify.js
├── vault.json            # 公开的加密参数
└── .nojekyll
```

## 如何新增文件

1. 把文件放进 `inbox/`。
2. 可选：在 `inbox/_meta.json` 里加上分类和说明（仅本地使用）：

   ```json
   {
     "example.xlsx": {
       "category": "资料",
       "description": "说明文字"
     }
   }
   ```

   `_meta.json` 不要写身份证号、电话等敏感字段，也不要提交到仓库。

3. 执行加密（密码需与线上一致，否则页面解不开）：

   ```powershell
   $env:VAULT_PASSWORD="你的强密码"
   node tools/encrypt-vault.js
   ```

   密码至少 16 位，并包含大小写、数字、符号中的至少三类。

4. 校验解密后与原文完全一致：

   ```powershell
   node tools/verify.js "你的强密码"
   ```

5. 提交推送：

   ```powershell
   git add -A
   git commit -m "新增文件：xxx"
   git push
   ```

   推送前确认 `git status` 里没有 `inbox/` 下的明文。

## 首次上线

1. 在组织下新建公开仓库 `yyy20080711-2356.github.io`。
2. **Settings → Pages**：Source 选 `Deploy from a branch`，Branch 选 `main`、
   目录选 `/ (root)`，保存。
3. 等 1～2 分钟，访问 <https://yyy20080711-2356.github.io>。

## 更换密码

密码换了，所有文件必须重新加密（盐也会变）：

```powershell
$env:VAULT_PASSWORD="新的强密码"
node tools/encrypt-vault.js
```

请把密码放在密码管理器里。忘记密码 = 文件永久无法解开。

## 注意事项

- **明文只在 `inbox/` 里**。确认推送前，`git status` 里不应该出现 `inbox/`
  下的任何文件。
- 单文件建议不超过 100 MB（GitHub 硬性限制）。
- 加密需要 HTTPS 环境。GitHub Pages 默认就是 HTTPS；本地预览请用
  `http://localhost`。
- 已发布的旧密文在重新加密前仍是 v1。升级到最高规格后，旧 `files/*.enc`
  会被新密文替换。
