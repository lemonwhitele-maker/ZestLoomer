# 从源码构建

Windows x64，Node.js 22，npm。

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run package:win
```

安装包与免安装 ZIP 生成在 `dist/`；可交付文件及文档整理到 `dist/release/ZestLoomer-<版本>/`，并生成 `SHA256SUMS.txt`。发布版本下载见 [v0.1.0-beta.3](https://github.com/lemonwhitele-maker/ZestLoomer/releases/tag/v0.1.0-beta.3)。本地打包命令不会自动上传或发布。

运行依赖和 Electron 版本按 `package-lock.json` 锁定。窗口测试需要正常桌面环境，可运行 `npm run test:e2e`；打包后基础检查运行 `npm run test:packaged`。测试使用独立合成书库，原始输出只用于本地检查，不随发行材料分发。
