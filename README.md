# Loom Preview · 2026-10-19

本分支是 ZestLoomer 的临时预览版，版本号为 `0.1.0-preview.20261019`。现有 `main`、`v0.1.0-beta.2` 标签与已发布安装包保持不变。

与 beta.2 相比，本次主要新增：

- 正文与大纲一对一关联、双向跳转，以及按章号自动匹配。
- 伏笔表格，记录内容、起始章节和回收章节；Agent 可查阅并提出修改。
- 超重 Agent 设置，可为新对话追加自定义提示、大纲及相关正文上下文。
- 书库内集中保存 API、工具、工作区及自定义提示配置。
- Agent 按绝对行号读取和修改，改善插入、续写的段落换行及提案差异预览。
- 支持修改作品名称。

## 安装和试用

预览安装包和程序显示为 **Loom Preview**，使用独立安装标识、快捷方式及 `%APPDATA%/Loom Preview` 资料目录，默认创建该目录下的空 `BookList`。它不会自动读取正式版配置或原书库。

请使用单独的测试作品或书库副本。手动打开原作品仍可能修改原文件。预览版不会自动导入正式版 API 密钥；可自行填写测试所需配置。

此版本尚未完成长期写作、独立干净电脑及所有真实模型验收。功能资料迁入书库后，跨电脑加密密钥可能需要重新填写。

## 构建

Windows x64、Node.js 22：

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run package:win
```

公开上传使用明确文件清单，仅包含程序源码、通用测试及发布说明。个人书库、运行日志、真实 API 配置、验证记录和测试输出不属于发布材料。

基于 [51mazi](https://github.com/xiaoshengxianjun/51mazi) 与后续改造项目开发；版权、许可及第三方声明见 `LICENSE`、`THIRD-PARTY-NOTICES.txt` 和 `docs/provenance.md`。
