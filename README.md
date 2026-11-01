# 文件下载中心（加密版）

基于 GitHub Pages 的静态文件下载站。所有文件在**本地加密**后上传，页面上输入
密码才会在浏览器里解密显示和下载。

线上地址：<https://yyy20080711-2356.github.io>

## 安全模型

这里要说清楚，避免误判：

- 服务器上**只有密文**。GitHub 上存的是 `.enc` 文件，没有密码就是一堆随机字节。
- 密码**不会上传**，认证在浏览器本地完成，通过 AES-GCM 的认证标签校验。
- 仓库是公开的，**任何人都能下载到密文**，安全性完全取决于密码强度。
  4 位数字几秒就能穷举完，所以脚本强制要求密码至少 12 位。

这不是"登录鉴权"，而是"加密保护"。区别在于：前者由服务器拒绝未授权访问，
后者是数据本身就是密文，即使被拿走也读不出来。

## 目录结构

```
.
├── index.html            # 页面
├── assets/
│   ├── style.css         # 样式
│   ├── vault.js          # 浏览器端解密（PBKDF2 + AES-GCM）
│   └── app.js            # 解锁流程、列表渲染、下载
├── files/                # 密文（会提交到仓库）
│   ├── manifest.enc      # 加密后的文件清单
│   └── *.enc             # 加密后的文件
├── inbox/                # 明文源文件（已 gitignore，不会上传）
│   └── _meta.json        # 文件的分类和说明
├── tools/
│   ├── encrypt-vault.js  # 加密脚本
│   └── verify.js         # 验证解密是否与原文一致
├── vault.json            # 公开的加密参数（盐、迭代次数）
└── .nojekyll
```

## 如何新增文件

1. 把文件放进 `inbox/`。
2. 可选：在 `inbox/_meta.json` 里加上分类和说明：

   ```json
   {
     "文件名.xlsx": {
       "category": "班级资料",
       "description": "这是一句说明"
     }
   }
   ```

3. 执行加密（密码需与线上一致，否则页面解不开）：

   ```powershell
   $env:VAULT_PASSWORD="你的强密码"
   node tools/encrypt-vault.js
   ```

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

## 注意事项

- **明文只在 `inbox/` 里**。确认推送前，`git status` 里不应该出现 `inbox/`
  下的任何文件。`.gitignore` 已经拦住，但推送前扫一眼更稳妥。
- 单文件建议不超过 100 MB（GitHub 硬性限制）。
- 加密需要 HTTPS 环境。GitHub Pages 默认就是 HTTPS，没问题；本地预览请用
  `http://localhost`（浏览器把 localhost 视为安全上下文）。
- 忘记密码 = 文件永久无法解开。请把密码保存在密码管理器里。
