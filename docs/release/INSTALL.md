# 临时源码预览版运行说明

本次只发布源码，不提供新的安装包。请下载 `preview/20261019` 分支，或使用该分支的源码 ZIP。

在 Windows x64、Node.js 22 环境运行：

```powershell
npm ci
npm run dev
```

程序显示为 **Loom Preview**，使用独立的 `%APPDATA%/Loom Preview` 资料目录，默认书库为该目录中的 `BookList`。首次为空，不会自动迁移正式版配置或原作品。

用测试作品或正式书库的副本体验新功能。手动打开原作品仍会直接操作原文件。API 配置需要自行填写。

现有 beta.2 安装包、标签和主分支保持不变。如需自行构建临时安装器，参见 `BUILDING.md`；构建产物及个人资料不属于本次上传内容。
