# 文件下载中心

基于 GitHub Pages 的静态文件下载站，用于集中存放 Excel 表格等资料。

线上地址：<https://yyy20080711-2356.github.io>

## 目录结构

```
.
├── index.html            # 页面结构
├── assets/
│   ├── style.css         # 样式
│   └── app.js            # 读取清单、渲染列表、排序
├── files/                # 存放待下载的文件（xlsx、csv、docx…）
├── files.json            # 文件清单，页面据此渲染表格
├── tools/
│   └── sync-manifest.js  # 扫描 files/ 重新生成 files.json
└── .nojekyll             # 关闭 Jekyll，避免构建问题
```

## 如何新增文件

1. 把文件放进 `files/` 目录（可以建子文件夹分类）。
2. 运行：

   ```bash
   node tools/sync-manifest.js
   ```

   脚本会按真实文件重新生成 `files.json`，自动填充大小和修改日期，已有的
   `description`、`category` 会原样保留。

3. 可选：编辑 `files.json`，给文件补上说明和分类：

   ```json
   {
     "name": "2026年考核表.xlsx",
     "path": "files/2026年考核表.xlsx",
     "category": "考核表",
     "description": "含各科室季度评分明细",
     "size": 20480,
     "updated": "2026-11-01"
   }
   ```

4. 提交并推送，GitHub Pages 会自动重新发布：

   ```bash
   git add -A
   git commit -m "新增文件：2026年考核表"
   git push
   ```

## 首次上线

1. 在仓库 **Settings → Pages** 中，Source 选择 `Deploy from a branch`，
   Branch 选 `main`、目录选 `/ (root)`，保存。
2. 等待 1～2 分钟，访问 <https://yyy20080711-2356.github.io>。

## 说明

- 仓库必须是公开的，否则 Pages 无法免费发布。
- 单个文件建议不超过 100 MB（GitHub 单文件硬性上限，超过无法推送）。
- `files.json` 每次修改后可能需要几分钟才会被 Pages 刷新。
