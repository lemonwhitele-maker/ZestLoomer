# ZestLoomer Windows 安装说明

版本：`0.1.0-beta.3`，2026-10-28 预览版。目标平台：Windows 10 / 11 x64。下载见 [GitHub Releases](https://github.com/lemonwhitele-maker/ZestLoomer/releases/tag/v0.1.0-beta.3)。

## 安装与试用

1. 双击 `ZestLoomer-0.1.0-beta.3-win-x64-setup.exe`。
2. 选择语言，阅读许可，选择可写的安装位置并完成安装。
3. 从桌面或开始菜单打开 **ZestLoomer**。无需另装 Node.js、npm 或 Electron。
4. 首次启动选择书库 BookList。建议先创建空书库或选择旧书库副本，再通过作品菜单新建作品、打开作品或导入 TXT / Markdown。
5. 新版界面使用顶栏作品／文档菜单，底栏提供「写作显示」；作品菜单可切回经典布局。AI 接入在设置中配置，未配置时仍可本地写作。

也可完整解压 `ZestLoomer-0.1.0-beta.3-win-x64.zip` 到可写目录，然后运行 `ZestLoomer.exe`。不要直接从压缩包内运行，也不要只复制其中的 EXE。免安装版沿用相同配置规则，设置与书库不会自动放在程序旁。

安装文件包含应用运行组件，安装时无需联网；使用远程 AI 需联网并自行配置服务。默认只为当前用户安装，不要求管理员权限，作品应保存在程序目录以外。

安装包没有代码签名，Windows 可能提示未知发布者或 SmartScreen。请核对来源、SHA-256 及电脑安全策略。本版通过 GitHub Releases 提供，没有自动更新。

## 旧 Loom 数据与安装身份

ZestLoomer 使用独立程序名与安装身份，可以与旧 Loom 分别安装。请为 ZestLoomer 选择自己的安装目录；旧 Loom 安装、卸载或跨品牌自动替换不属于本次安装器的升级行为。

新用户设置在 `%APPDATA%\ZestLoomer`；该目录不存在且 `%APPDATA%\Loom` 已存在时，沿用旧设置目录。新书库使用 `.zestloomer`，只有 `.loom` 的旧书库继续使用 `.loom`；两者都有时优先新目录，不自动合并或搬迁。旧作品目录无需改名。

沿用旧书库后的正常编辑和配置保存会写入该书库。独立试用请复制整个书库（包括隐藏目录）；只换本机设置目录并不能隔离真实作品。搬到其他电脑后，API 密钥可能需要重新输入。

升级前备份整个书库并关闭应用。后续 ZestLoomer 更新可运行对应新安装包；本版未完成独立干净电脑、完整跨版本升级和卸载重装验收。卸载通过 Windows「已安装的应用」完成，配置为保留用户设置，外部书稿不由卸载器管理。

## 校验

交付目录中的 `SHA256SUMS.txt` 包含安装包、ZIP 与随附文档校验值：

```powershell
Get-FileHash .\ZestLoomer-0.1.0-beta.3-win-x64-setup.exe -Algorithm SHA256
Get-FileHash .\ZestLoomer-0.1.0-beta.3-win-x64.zip -Algorithm SHA256
```

功能与验证边界见随附 `CHANGELOG.md`、`KNOWN-ISSUES.md` 和项目使用指南。
