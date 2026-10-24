# ZestLoomer · 临时源码版 2026-10-24

本分支版本为 `0.1.0-preview.20261024`，基于当前 ZestLoomer 开发源码，供试用和检查。本次仅提供源码与公开文档。

相对上次 `0.1.0-preview.20261019` 的主要更新：

- 开发版更名为 ZestLoomer，增加新配置目录、环境变量与阅读位置键，并兼容原 Loom 数据。
- 人物模板增加“经典发言”；新作品附带只读人物与设定示例，可复制为普通资料。
- 正文修改提案统一段落换行，并在审阅卡提示；补充选区与已读范围证据，减少重复读取。
- AI 会话按最近八轮与更早历史组织上下文，区分最终回答与过程记录，并同步提案的最新状态。

详细差异见 [更新说明](docs/release/CHANGELOG.md)。长历史精确定位与重读预算仍有已知问题，见 [已知问题](docs/release/KNOWN-ISSUES.md)。

## 从源码运行

准备 Windows 和 Node.js 22，下载并解压本分支源码，在项目目录运行：

```powershell
npm ci
npm run dev
```

首次启动选择书库 BookList。可以建立空书库或打开已有书库；试用时建议使用书库副本。未配置 AI 时可使用本地编辑功能。[使用指南](docs/USER-GUIDE.md)提供操作说明。

## 数据与兼容

新用户配置默认保存到 `%APPDATA%/ZestLoomer`。新目录不存在且原 `%APPDATA%/Loom` 存在时，继续使用原目录。已有书库使用 `.loom` 且没有 `.zestloomer` 时继续沿用 `.loom`；新旧目录同时存在时优先使用新目录，不自动合并。打开旧书库后的编辑和设置保存会写入该书库。

API、工具 API、工作区和 Agent 设置统一保存在当前书库的配置目录。备份时包含隐藏配置目录；跨电脑时加密凭据可能需要重新填写。旧作品、文档 ID 和历史会话保持兼容，不自动移动或复制原配置。

支持 `ZESTLOOMER_BOOKLIST`、`ZESTLOOMER_USER_DATA`、`ZESTLOOMER_TEST_HIDDEN`、`ZESTLOOMER_PERF`，兼容对应 `LOOM_*` 变量；同名新变量优先。自动化测试需同时隔离书库与本机配置目录。

## 检查与构建

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

本次复验：类型检查、Lint、210 项单元测试和本地构建通过；未重跑桌面测试或真实模型验收。

`npm run build` 仅生成本地运行代码。桌面测试使用独立合成书库；真实模型用例需显式启用。本次不提供安装包；保留的打包脚本与配置仍含 Loom 历史名称，详见 [构建说明](docs/release/BUILDING.md)。

公开文件包含程序源码、通用测试、许可证及使用文档；个人书库、API 配置、日志、内部验证资料、依赖及构建产物不属于上传材料。

项目按 [MIT 许可证](LICENSE) 提供，保留上游声明；来源见 [来源记录](docs/provenance.md)，第三方声明见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)。
