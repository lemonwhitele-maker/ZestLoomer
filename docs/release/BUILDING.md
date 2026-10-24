# 开发构建

Windows、Node.js 22，在项目目录执行：

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run dev
```

`build` 生成本地 Electron 运行所需代码。`npm run test:e2e` 运行桌面测试，使用独立合成书库；真实模型测试默认跳过，需单独明确配置。

本次仅提供源码。`electron-builder.json`、`package:win` 及历史发布脚本仍保留 Loom 安装标识和名称；自行使用前需单独检查与验证。本分支不包含自动打包发布工作流。
