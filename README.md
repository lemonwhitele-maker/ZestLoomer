# ZestLoomer

本地小说写作工作区，把正文、大纲、人物、设定、速记与 AI 对话放在一起。可以直接写作，也可以让 Agent 查阅书内资料、讨论情节并提出修改；正式修改由作者审阅确认。

当前为 **`0.1.0-beta.3` · Windows x64 预览版（2026-10-28）**，汇总本轮功能迭代与新版界面。下载见 [GitHub Releases](https://github.com/lemonwhitele-maker/ZestLoomer/releases/tag/v0.1.0-beta.3)。未配置 AI 时仍可使用本地写作。

## 相对旧版的功能迭代

对照基线为 GitHub 的 [Loom `0.1.0-beta.2` / `77ca7c1`](https://github.com/lemonwhitele-maker/ZestLoomer/commit/77ca7c19427352a07cd9ff8a6e99d1e430edad43)。本版汇总其后已在本地实现的改动：

- **新版写作空间**：单层顶栏、作品与文档菜单、纸张式正文、随正文滚动的标题、浮动编辑工具、底栏字数与章节目标。目录可调宽，窄窗口下改为浮层；作品菜单可切回经典布局。
- **写作交互**：浮层查找替换、蓝色选区、版心宽度、工具常驻、普通专注与 F11 全屏禅意。可选打字机模式和中文选区符号配对，后两项默认关闭。
- **章节与资料关系**：正文与章节大纲双向关联，支持按明确章节编号自动匹配；增加伏笔记录和起止章节关联。伏笔表按行手动保存，离开前需保存或取消。
- **AI 阅读与修改**：正文按绝对行号读取和分页；无选区修改按版本绑定的行范围定位，有选区时按精确选区定位。新正文修改提案会统一完整候选的段落换行，选区外排版也可能变化，请审阅最终差异；普通保存保留原文，接受与撤销仍受版本校验保护。
- **上下文与示例**：新增超重 Agent 偏好，可附带提示、大纲与正文窗口，选项默认关闭；整理近期历史和提案最新状态。新作品提供只读人物／设定示例及可编辑副本，示例不作为作品事实。
- **编辑与性能**：切章复用编辑器，各章分别保留撤销和阅读位置；改进字数统计、换行坐标、切书缓存、刷新队列和 AI 滚动跟随。大段提案对照按需在后台计算，弹窗按需加载，设置整理为五个分区。
- **更名与兼容**：统一为 ZestLoomer，并更新 Windows 安装包、程序和快捷方式名称；兼容旧 Loom 作品、配置和阅读位置。

既有的五类写作文档、自动保存、历史恢复、搜索、导入导出、备份、独立 AI 会话和提案审阅继续保留。详细变更见 [更新记录](docs/release/CHANGELOG.md)，界面实现记录见 [新工作区说明](README-newUI.md)。

## Windows 试用

在 [发布页面](https://github.com/lemonwhitele-maker/ZestLoomer/releases/tag/v0.1.0-beta.3) 下载，或直接选择：

- [Windows x64 安装包](https://github.com/lemonwhitele-maker/ZestLoomer/releases/download/v0.1.0-beta.3/ZestLoomer-0.1.0-beta.3-win-x64-setup.exe)：无需另装 Node.js 或 Electron。
- [Windows x64 免安装 ZIP](https://github.com/lemonwhitele-maker/ZestLoomer/releases/download/v0.1.0-beta.3/ZestLoomer-0.1.0-beta.3-win-x64.zip)：完整解压后运行 `ZestLoomer.exe`。
- [SHA-256 校验清单](https://github.com/lemonwhitele-maker/ZestLoomer/releases/download/v0.1.0-beta.3/SHA256SUMS.txt)。发布页面还附安装说明、指南及许可证。

自行打包后的本地交付目录为 `dist/release/ZestLoomer-0.1.0-beta.3/`。

首次启动选择书库 BookList，可建立空书库或打开已有书库。创建作品后先写一小段，确认自动保存；需要 AI 时，在「设置 → AI 接入」填写 Chat Completions 兼容地址、模型和密钥，分别测试连接与工具调用，再保存配置。

预览旧作品前建议备份整个书库，或用完整副本体验。ZestLoomer 与旧 Loom 使用独立安装身份，请选择独立安装目录。安装包未签名、没有自动更新，其他平台未验收。步骤见 [安装说明](docs/release/INSTALL.md)、[使用指南](docs/USER-GUIDE.md) 与 [已知限制](docs/release/KNOWN-ISSUES.md)。

## 配置与旧数据兼容

- 新用户本机配置默认在 `%APPDATA%\ZestLoomer`；该目录不存在而旧 `%APPDATA%\Loom` 已存在时，继续使用旧目录。
- 新书库配置使用 `.zestloomer`；只有 `.loom` 的旧书库继续使用 `.loom`。两者都存在时优先 `.zestloomer`，不自动合并、移动或覆盖旧配置。目录损坏或无权访问不会静默回退。
- 新作品目录使用 `ZestLoomer-xxxxxxxx`；旧 `Loom-xxxxxxxx` 作品按 `book.json` 识别，无需改名。书稿、文档 ID、历史、会话保持兼容，旧阅读位置可继续读取。
- 备份应保留整个书库及隐藏目录。正常编辑和保存设置会写入当前书库；复制配置到其他电脑后，API 密钥可能需要重新填写。
- 使用 AI 时，输入、附带选区、会话上下文和按任务读取的书内资料会发送到所配置的服务。完整运行日志也可能包含私人书稿与对话。

| 环境变量                 | 用途                   | 兼容旧变量         |
| ------------------------ | ---------------------- | ------------------ |
| `ZESTLOOMER_BOOKLIST`    | 指定书库               | `LOOM_BOOKLIST`    |
| `ZESTLOOMER_USER_DATA`   | 指定本机配置与缓存     | `LOOM_USER_DATA`   |
| `ZESTLOOMER_TEST_HIDDEN` | 测试时隐藏窗口         | `LOOM_TEST_HIDDEN` |
| `ZESTLOOMER_PERF`        | 启用性能计数，值为 `1` | `LOOM_PERF`        |

同名新变量显式设置时优先。测试需同时指定独立书库与本机配置，单独设置 `USER_DATA` 不会隔离书稿。

## 从源码运行与打包

准备 Node.js 22 和 npm，在项目目录执行：

```powershell
npm ci
npm run dev
```

已有依赖的本地副本可直接运行。生产构建与预览：

```powershell
npm run build
npm start
```

Windows x64 打包及打包后基础检查：

```powershell
npm run package:win
npm run test:packaged
```

打包生成第三方声明、构建应用，整理安装包、ZIP 与说明到 `dist/release/ZestLoomer-<版本>/` 并生成 SHA-256 清单，不上传或发布到远端。

开发验证运行 `npm run verify`，依次执行类型检查、Lint、单元测试、构建与桌面回归。测试使用 `.test-artifacts/` 中的隔离合成书库；真实模型测试需显式配置，否则跳过。本次结果见 [验证记录](docs/verification/ZestLoomer-beta.3-2026-10-28.md)。

## 当前边界

长会话的精确历史重读与上下文预算仍有已知问题，完整真实模型验收未通过；建议缩小任务范围，必要时新建会话。依据见 [长历史验收记录](docs/verification/LOOM-039-acceptance-2026-10-23.md)。历史整理使用确定性摘录，不是模型生成的语义摘要。

实体悬浮卡、行内 AI、正文 Diff 投影、逐段采纳与分卷仍待后续实现；Markdown 继续以源码编辑。本次不代表整份后续规划已完成。

中文输入法候选窗、125%／150% 系统缩放、独立电脑安装、完整跨版本升级、真实模型兼容性与长期连续写作仍需人工体验。会话输入草稿不承诺跨重启恢复，每个会话仅保留最近一轮完整运行日志。

## 来源与反馈

项目按 [MIT 许可证](LICENSE) 提供，保留上游版权与许可声明。Loom / ZestLoomer 延续 51mazi 系列的本地写作与 AI 协作实践，是独立重建项目；关系与实现边界见 [来源记录](docs/provenance.md) 和 [第三方声明](THIRD-PARTY-NOTICES.txt)。历史需求和验证记录保留原名称。

反馈请使用 [GitHub Issues](https://github.com/lemonwhitele-maker/ZestLoomer/issues)，附版本、系统和复现步骤；分享附件前检查私人书稿、密钥与本机路径。
