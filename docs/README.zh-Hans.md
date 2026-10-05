<div align="center">

# codex session continuity

**让长时间的 Codex 工作，有条理地交接下去。**

[English](../README.md) · [繁體中文](README.zh-Hant.md) · [简体中文](README.zh-Hans.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Deutsch](README.de.md)

![让长时间的 Codex 工作，有条理地交接下去。](images/hero.png)

</div>

用于本地原文保存、交接笔记和同项目续接的 Windows 小助手。新任务先读交接，再按需查证历史，不会把整段对话全部重新装入提示词。

> [!IMPORTANT]
> 实验性预览版，并非 OpenAI 官方产品。依赖桌面 App 的本地接口，更新后可能需要适配。新安装默认暂停自动续接，请先检查模型有效上下文和阈值。

## 能做什么

![能做什么](images/overview.png)

| 功能 | 说明 |
| --- | --- |
| 保留过程 | 增量保存已落盘的原始对话和工具记录，建立搜索索引。 |
| 整理交接 | 请原助手记录决策、进度、限制、验证和下一步。 |
| 保留原项目 | 检查项目、工作目录和权限，沿用 checkout 与未提交文件。 |
| 保存附件 | 保存支持的本地／内嵌附件和来源；保存文件不代表已理解内容。 |

## 三步交接

![三步交接](images/workflow.png)

1. 保存原文：后台进程建立本地历史和附件索引。
2. 准备交接：原助手完成 HANDOFF.md 并回复专属确认码。
3. 继续工作：原轮次结束且目录、权限检查通过后，创建一个新任务。

## Windows 安装

需要已登录的 Codex Desktop、Node.js 24+、PowerShell 7+。在 App 保存正确的项目目录，然后创建一个独立管理任务并复制 UUID／链接；它应与待续接任务分开。

从 Releases 下载 ZIP 和 SHA256SUMS，核对 SHA-256 后解压。用 PowerShell 7 打开解压目录，将以下占位内容换为真实管理任务 UUID。

[Releases](https://github.com/maiijhcg/codex-session-continuity/releases)

```powershell
pwsh -NoProfile -File .\install.ps1 -OwnerThreadId "PASTE_MANAGEMENT_TASK_UUID" -WithIntegration
```

默认安装到 `%LOCALAPPDATA%\CodexSessionContinuity`，并添加当前用户的 Windows 登录启动项。重启并登录后自动在后台运行，无需管理员权限；它不是登录前的系统服务。新安装的自动续接开关保持暂停，后续登录保留你的选择。

`-NoStartup` 不注册登录启动；`-NoStart` 暂不启动进程；`-InstallDir` 指定安装目录；`-CodexHome` 指定现有 Codex 数据目录；`-SoftLimit`／`-HardLimit` 调整阈值。省略 `-WithIntegration` 可延后安装 hook 和助手指引。Hook 需经过 Codex 正常信任流程，不会自动批准。

## 手动操作

![手动操作](images/control.png)

| 按键 | 操作 |
| --- | --- |
| **1** | 启用自动续接 |
| **2** | 暂停自动续接；原文保存继续 |
| **3** | 刷新进程、桌面连接和请求状态 |
| **4** | 明确选择一个任务手动续接；可粘贴完整 ID／链接 |
| **5** | 选择并保存菜单语言 |
| **0** | 退出菜单，不改变开关 |

先选 3，确认进程存活、心跳新鲜、桌面连接正常，再选 1 或 4。任务按运行中优先、最近活动倒序排列。排队不等于完成；重复选择会复用待处理请求。

菜单默认英文，支持英文、繁中、简中、日文、西语。文档另有法语、韩语、俄语、德语。任务标题、历史文本和底层技术诊断保留原语言。选项 5 保存语言，`-Language` 仅覆盖本次启动。

```powershell
.\Codex-Session-Continuity.cmd -Language zh-Hans
pwsh -NoProfile -File .\manual-switch.ps1 -Action Status -Language zh-Hans -Json
```

## 阈值与限制

示例默认软阈值 500,000／硬阈值 920,000，不适合所有模型。软阈值只在连续监视时向上跨越才触发；启动／恢复时已经超过软阈值不会补发，等待当前用量达到硬阈值。原生压缩可能使用不同计数或更小窗口。本工具不改变模型或原生压缩设置，也不扩展上下文容量。

## 数据与安全

安装目录内的 `archive/`、`notes/`、运行期 `assets/`、SQLite、设置和日志包含私密信息，不要上传 GitHub。工具不新增遥测或独立云上传客户端；正常 Codex 消息及任务创建仍通过现有账号与服务处理。

不会自动删除原文或媒体，请监控空间并独立备份。工具不提供加密、OCR 或语音转写，也不会自动下载远程附件。暂停不撤销已发送的操作；完全停止后台进程才停止后续归档。

[SECURITY.md](../SECURITY.md)

## 等待和错误

`waiting_handoff` 表示等待原任务交接；`soft_expired` 表示不补发过期软触发；`checkpoint_interrupted` 由你决定是否再次手动选择。遇到 `checkpoint_uncertain`／`creation_uncertain`，先核对结果，不能盲目重发。项目或权限不符时停止，不转到默认目录、不自动提权。

```powershell
node .\cli.mjs status
node .\cli.mjs tasks
node .\controller.mjs resolve "PASTE_TASK_UUID"
```

## 启动、升级和卸载

在安装目录执行以下命令。升级前停止进程并备份整个私密运行目录，再用相同目标运行新安装器。卸载会保留程序、设置、原文、笔记和附件，不删除 Codex 任务。

```powershell
pwsh -NoProfile -File .\install-startup.ps1
pwsh -NoProfile -File .\install-startup.ps1 -Remove
pwsh -NoProfile -File .\stop.ps1
pwsh -NoProfile -File .\restart.ps1
pwsh -NoProfile -File .\uninstall.ps1
```

[完整英文 Windows 指南](WINDOWS.md) · [CHANGELOG](../CHANGELOG.md) · [NOTICE](../NOTICE.md)

尚未指定公开许可证，未默认采用 MIT／GPL，详见 NOTICE.md。图片是 ImageGen 原创概念示意，不是实际界面截图或保证。

## 自动续接指示与权限继承

发给原 session 的交接通知及新 session 的开场指示均支持九种语言：`en`、`zh-Hant`、`zh-Hans`、`ja`、`es`、`fr`、`ko`、`ru`、`de`。默认英文，跟随菜单 5 保存的语言。新安装添加 `-HandoffLanguage zh-Hans` 可单独指定；已有安装先停止进程，在 `config.json` 中添加 `"handoffLanguage": "zh-Hans"` 属性，再重新启动。升级保留设置；删除该属性即可重新跟随菜单。单次 `-Language` 不改变后台指示。同一次交接固定使用所选语言；原任务标题、路径、命令、权限值和确认码不翻译，底层诊断保留原文。

新 session 自动继承上一个 session 的实际 sandbox 和审批权限，不要求它等于全局默认值，也不采用管理任务的权限。例如来源只读、全局 Full access，后续仍应只读。程序通过 Codex 的来源继承流程创建，发送前重新读取来源，创建后核对可写范围、网络限制及权限 profile。来源变化会重新读取；未知或不符时保留已有新 ID 并停止核查，不提权、不改全局、不重复创建。只读来源若无法保存 HANDOFF.md，须由用户按正常权限流程处理，程序不绕过限制。本机旧版不会因公开版变化而自动更新。

