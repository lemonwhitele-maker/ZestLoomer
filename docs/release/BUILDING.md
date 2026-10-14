# 从源码构建

Windows x64，Node.js 22，npm。

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run package:win
```

安装包生成在 dist；随附材料整理到源码目录旁的“安装包”目录。运行依赖和 Electron 版本按 package-lock.json 锁定。窗口测试需要正常桌面环境，可运行 npm run test:e2e。测试输出只用于本地检查，不随发行材料分发。
