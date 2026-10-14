# 开源来源与致谢

Loom 按根目录 [MIT 许可证](../LICENSE) 发布，保留适用的上游版权和许可全文。第三方组件各自的许可证仍然适用。

## 项目来源

| 项目 | 作者／来源 | 参考与继承范围 | 许可 |
| --- | --- | --- | --- |
| [51mazi](https://github.com/xiaoshengxianjun/51mazi) | 小圣贤君（xiaoshengxianjun） | 本地小说写作的产品基础；部分工程格式化配置与历史许可声明 | [MIT](https://github.com/xiaoshengxianjun/51mazi/blob/main/LICENSE)，保留 Copyright (c) 2025 小圣贤君 |
| [51mazi_chatbox](https://github.com/lemonwhitele-maker/51mazi_chatbox) | lemonwhitele-maker 维护的衍生项目 | 围绕书稿的 Agent 协作、工具协议、读取覆盖、提案审阅、版本保护及人物／设定模板的设计参考 | 保留其适用的原项目 MIT 声明 |
| 51mazi_codex | 重建前的本地衍生工程阶段 | 工程配置与重建起点；不是另一个已核实的公开上游仓库 | 保留适用的原项目 MIT 声明 |

Loom 以独立品牌和工作区实现延续上述探索，不是 51mazi 的官方后续版本。当前应用以 TypeScript 重建业务模块，不因此否认设计参考和工程继承。感谢原作者及衍生项目贡献者。项目现有 Loom 图标作为应用素材随附，不宣称来自上游 51mazi。

## 主要组件

| 组件 | 锁定版本 | 用途 | 许可与来源 |
| --- | --- | --- | --- |
| Electron | 39.2.7 | 桌面运行时 | [MIT](https://github.com/electron/electron)，另含 Chromium、Node.js 等组件声明 |
| Vue | 3.5.22 | 工作区界面 | [MIT](https://github.com/vuejs/core) |
| CodeMirror commands / search / state / view | 6.11.1 / 6.7.2 / 6.7.6 / 6.43.13 | 文本编辑器 | [MIT](https://github.com/codemirror) |
| electron-vite / Vite | 5.0.0 / 6.4.0 | 构建 | [electron-vite MIT](https://github.com/alex8088/electron-vite)、[Vite MIT](https://github.com/vitejs/vite) |
| electron-builder | 26.15.3 | Windows 安装包 | [MIT](https://github.com/electron-userland/electron-builder) |
| TypeScript | 5.9.3 | 类型检查 | [Apache-2.0](https://github.com/microsoft/TypeScript) |
| Playwright | 1.63.0 | 窗口测试工具 | [Apache-2.0](https://github.com/microsoft/playwright) |

精确版本以 package-lock.json 为准。运行依赖及随应用打包的 Vue 组件许可全文见 [THIRD-PARTY-NOTICES.txt](../THIRD-PARTY-NOTICES.txt)；编辑器依赖全文见 [编辑器声明](third-party-editor-licenses.txt)。Electron 自身及 Chromium 等组件声明随安装后的程序提供于 LICENSE.electron.txt 和 LICENSES.chromium.html。开发工具由锁文件描述，不作为用户安装包中的工具分发。

发布源码不附带个人工作区、书稿、对话、API 配置、运行日志或内部验收材料。
