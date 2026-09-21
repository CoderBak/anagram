# 发布前文件与用户资料审计

审计日期：2026-09-22。范围是本轮工作树中的安装、注册、运行、更新、卸载和浏览器端文件操作；不是对第三方运行库或操作系统的全面安全认证。核查以源码、临时目录故障复现和本机隔离测试为依据，没有操作真实用户安装、真实浏览器注册或远程 CI。Windows 原生维护行为仍须在 Windows 上验证，不能由 macOS 上的模拟测试代替。

结论是：Anagram 有明确的应用目录和注册归属检查，浏览器阅读器没有自动写回原 PDF 的路径；但本地组件以用户权限运行，并非文件系统沙箱。完整卸载会删除整个组件目录，不能把个人文件放在该目录里。下述两个 P2 限制尚未解决。

精确 API、存储键和网络调用清单见 [footprint.md](footprint.md)；联网边界另见 [network-privacy.md](network-privacy.md)。本页不替代那两份清单。

## 安装与运行会写到哪里

| 位置 | 内容与边界 |
| --- | --- |
| macOS、Linux 默认 `~/.anagram` | 私有 Python、虚拟环境、应用和启动器、模型与下载中间文件、运行配置、基准结果、注册清单、锁和维护状态。自定义 `ANAGRAM_HOME` 时改用明确指定的专用目录。 |
| Windows 默认 `%LOCALAPPDATA%\Anagram` | 同类组件文件；可由安装命令的 `ComponentHome` 指定专用目录。 |
| 组件目录内的 `cache/`、`hf/`、`python/` 等 | 安装器将 uv、托管 Python、Hugging Face 等已知路径定向到组件内，更新可替换、清理属于组件的内容。它不是通用备份目录。 |
| 系统临时目录 | 安装下载、校验、解包、回滚备份等。Windows 维护还会复制固定脚本到独立临时目录，并写操作回执，因为组件本身可能正被删除。成功清理不是异常退出后不留临时文件的保证。 |
| 浏览器管理的扩展存储 | 设置、评分缓存、PDF 阅读位置等，详见下文；不与组件目录混为一处。 |
| 用户解压扩展 ZIP 的目录 | 由用户选择。若在组件目录之外，卸载组件不会替用户删除该目录或下载的 ZIP。若放进组件目录，则属于整目录删除范围。 |

安装器不要求修改系统 Python，不向现有 Python 环境安装包，不修改 shell profile 或用户 PATH，也不安装登录启动服务。组件中的 `venv/`、托管 `python/` 和启动器属于安装器管理范围。安装源、依赖和模型会联网下载，下载源及校验策略见 footprint；这些操作不能等同于“完全不联网”。

证据入口：[install.sh](../install.sh)、[install.ps1](../install.ps1)、[installer/anagram](../installer/anagram)、[installer/native_registration.py](../installer/native_registration.py)。

## 组件目录外的浏览器注册

这些是当前实现使用的用户级固定位置，不是扫描或改写整个浏览器 profile。原生主机名固定为 `dev.coderbak.anagram`。

| 平台 / 浏览器 | 注册位置 |
| --- | --- |
| macOS / Chrome | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.coderbak.anagram.json` |
| macOS / Firefox | `~/Library/Application Support/Mozilla/NativeMessagingHosts/dev.coderbak.anagram.json` |
| Linux / Chrome | `~/.config/google-chrome/NativeMessagingHosts/dev.coderbak.anagram.json` |
| Linux / Firefox | `~/.mozilla/native-messaging-hosts/dev.coderbak.anagram.json` |
| Windows / Chrome | `<ComponentHome>\native\chrome\dev.coderbak.anagram.json`；其路径写入 `HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.coderbak.anagram` 的默认值。 |
| Windows / Firefox | `<ComponentHome>\native\firefox\dev.coderbak.anagram.json`；其路径写入 `HKCU\Software\Mozilla\NativeMessagingHosts\dev.coderbak.anagram` 的默认值。 |

Windows 使用当前用户 HKCU 的 32 位和 64 位查找视图，不使用 HKLM。注册只允许安装页显示的准确 Chrome 扩展 ID，或固定 Firefox ID `anagram@coderbak.dev`。一个浏览器的这项用户级注册可以被其多个 profile 使用；删除组件会让这些 profile 一起失去连接。

注册清单记录组件位置、用户位置、平台、注册路径和内容哈希。普通注册拒绝替换不属于清单的已有注册；卸载前检查哈希和注册表归属，拒绝删除已被修改或换属的记录。Windows 键有额外子键、额外值或非预期类型时也拒绝清理。文件采用临时文件加替换方式写入。对外部注册路径的并发检查尚有下文 P2 限制。

## 浏览器读取和主动导出

| 操作 | 实际读写范围 |
| --- | --- |
| 网页分析 | 读取获授权页面或用户单次授权文档中的文本，并在该页面 DOM 中显示标记。不会修改网站服务器上的原文。 |
| PDF 文件选择、拖入 | 读取用户明确选择的 `File` 字节；当前上限为 100 MiB。没有获得可写文件句柄，也没有写回所选文件的接口。 |
| 接管 `file:///` PDF | 需要可选文件来源授权及浏览器文件访问开关。来源 ticket 绑定当前 tab / reader，私有 loader 只对该准确地址发 GET，检查最终地址、大小和 PDF 签名；上限 50 MiB。授权本身是文件来源范围，不是操作系统只允许读取某一个 PDF 的沙箱。 |
| 在线 PDF | 对已授权的原文地址读取，可能带浏览器正常凭据并使用 HTTP 缓存。缓存不能保证没有第二次网络请求；拒绝重定向。`?src=` 地址本身不是读取授权。 |
| 导入 UTF-8 文本 | 只读取用户选择的文件，当前限 1 MiB / 200,000 字符；文本和结果保存在页面内存中，没有原文件写回。 |
| 复制段落、报告、诊断、安装命令 | 用户点击时写系统剪贴板；未发现产品代码主动读取剪贴板。报告正文及标题 / URL 默认不包含，需明确启用；单段“复制”仍会复制用户明确要求的段落。 |
| PDF 下载 / 保存 | 通过浏览器的 Blob 下载产生副本，保存可填写表单的变更时可能生成更新后的 PDF 副本。Anagram 分析标记不写入原 PDF。浏览器“另存为”里用户自己选择覆盖原路径，属于另一次用户操作。 |
| PDF 附件、链接、打印 | 附件需主动下载；外部链接由用户点击打开。主动打印可能产生系统打印队列、临时文件或网络打印流量。已禁用 PDF 文档脚本和文档触发的自动打印。 |

`file://` 远程主机 / UNC 形式被拒绝，但操作系统已挂载的网络卷可表现为本地路径；读取这种路径仍可能触发文件系统网络访问。

证据入口：[reader/main.ts](../entrypoints/reader/main.ts)、[reader/viewer.ts](../entrypoints/reader/viewer.ts)、[sourceTransfer.ts](../lib/pdf/sourceTransfer.ts)、[loader.ts](../lib/pdf/loader.ts)、[paste/main.ts](../entrypoints/paste/main.ts)、[orchestrator.ts](../lib/capture/orchestrator.ts)。上游下载 / 保存实现保留在固定版本的 [PDF.js viewer.mjs](../vendor/pdfjs/5.7.284/web/viewer.mjs)。

## 浏览器存储与删除范围

- `storage.local` 只属于本扩展：阅读设置、用户选定的主机名规则、通知和缓存偏好等；未使用 `storage.sync`。清空它不会清空其他扩展或网站的存储。
- IndexedDB `anagram-scores` 保存规范化文本哈希、完整模型身份、分数和时间等，不保存原文。哈希并不匿名，能访问本机缓存的人仍可能用已知文本猜测匹配。评分缓存默认持久保存，内存模式与删除失败的行为见 footprint。
- PDF.js `localStorage` 的 `pdfjs.history` 保存最多 20 个文档指纹及页码、缩放、滚动、旋转等视图状态；`pdfjs.preferences` 是查看器偏好。文档指纹可能辨认已知文件。这些数据不是评分缓存，不会被“清除缓存判定”或内存评分模式删除。
- Google Docs 页面的 `sessionStorage` 有 `anagram-docs-return` 返回地址。PDF reader 当前地址也会包含原件来源；不要把报告隐藏 URL 的开关理解为浏览器 tab 地址、会话恢复或系统日志都不含来源。
- 粘贴文本、原始 PDF 和密码不由上述评分 / 阅读位置存储持久化。浏览器自身的页面缓存、下载记录、会话恢复和操作系统行为不在此结论的覆盖内。

确认组件卸载完成后，扩展桥接先清评分缓存和本扩展 `storage.local`，再请求浏览器移除自身。浏览器负责最终移除扩展存储。若清理或移除失败，界面必须报告失败；不能据一次调用推断磁盘已安全擦除。代码没有擦除自由空间或备份副本的机制。

## 完整卸载的边界

**完整卸载递归删除整个已验证组件目录，不是只删除安装清单中的文件。用户后来放进去的 PDF、笔记、备份或其他文件也会被删除。请只把它用作 Anagram 的专用目录。** “删除模型”与“完整卸载”是不同操作，不要混淆。

路径和归属检查用于拒绝根目录、用户 home、错误所有权标记、非预期注册以及危险链接。POSIX 使用的 `rmtree` 不跟随普通嵌套符号链接；Windows 维护在删除前检查 reparse point。这里的符号链接检查不是挂载点隔离或对恶意同用户进程的完整防护，不应把其他资料目录 / 挂载卷放进组件目录。

POSIX 只有注册清理与组件目录删除完成才返回完成。Windows 先调度一个可见维护窗口；“scheduled”不表示已删除，需等该窗口报告完成后再移除扩展。直接从浏览器删除扩展不会触发原生组件清理，通常会留下组件和模型。

卸载不承诺删除组件目录外的 ZIP、解压目录、用户下载 / 保存的 PDF 副本、系统剪贴板、打印产物、浏览器原站缓存、OS 临时文件或日志。它也不应修改其他浏览器注册、系统 Python、shell profile、登录启动配置或所读取的原 PDF / 文本文件。

## 本轮修复状态

以下状态针对本次审计工作树；最终集成测试数量和发布检查结果由发布前汇总补充。

| 项目 | 状态与验证要求 |
| --- | --- |
| 注册清单丢失仍报告卸载完成 | 已修。更新、取消注册、卸载必须存在有效清单；缺失时保留目录和外部注册并报告错误。已用临时用户目录复现旧行为并加入回归。 |
| 安装与维护并发锁 | 已集成。直接安装、更新和原生进程使用兼容的锁协议；POSIX 验证继承描述符与锁文件是同一普通文件，Windows 借用实际已锁句柄而非字符串跳锁。真实 shell / Python 继承锁、活跃 host 拒绝重装和安装器竞争回归通过；Windows 实际执行仍待验证。 |
| 安装回滚与运行状态文件的链接 / 硬链接写穿 | 已修。安装器预检固定目标，使用随机暂存文件和原子替换，回滚只恢复本次已改动文件。运行配置和哈希缓存改为有界读取与原子替换；续传文件写入前核对普通文件、链接数和 inode。隔离回归检查外部哨兵文件保持不变。 |
| 依赖缓存未在实际推理进程定向 | 已修。Native Host 同一进程在加载模型库之前设置 HF、Torch、XDG、临时及编译缓存目录，清除继承的 HF token；不修改 HOME。`doctor` 也使用相同环境并在组件内运行。安装器 curl 禁用用户级 curl 配置，Mac 依赖禁止源码编译。 |

本轮复现只创建临时组件目录、假用户路径和内存注册表，不使用用户真实注册。macOS 的本机结果不能替代 Windows 的 reparse point、共享句柄、文件删除和注册表实际验证。

本机针对性验证：安装器 42 项、注册 helper 24 项、原生状态 / 下载 / 配置 / 网络约束 131 项通过。完整锁定运行环境在 CPython 3.12.13 上使用 `--no-build` 安装成功；预编译语言识别包的 10 个多语言 / 边界输入与原包预测一致。这是安装和接口回归，不是检测器质量评估。Windows 嵌入 C# 编译通过，但本机没有 PowerShell，未验证其解析或运行。

## 尚未解决的 P2 限制

### 删除中途失败后，残留组件不能简单重试卸载

卸载先撤销 `.native-component.json` 启动权，再递归删除目录，避免其他进程启动半删除组件。但如果目录删除失败，残留文件仍在，后续正常卸载又会因所有权标记缺失被拒绝。POSIX 故障注入已复现；Windows 维护有相同的先撤销后删除次序。

应对：报告未完成并保留错误信息，关闭相关连接后检查准确残留目录。不要为绕过校验手动恢复“可启动”所有权标记，也不要对上级目录运行递归删除。后续应增加独立的 retiring 标记和仅允许清理的恢复流程，既可重试，又不恢复半删除组件的启动权限。

### 不同 `ANAGRAM_HOME` 并行注册同一用户 / 浏览器

两个不同组件目录可能同时通过“目标注册不存在”的检查，之后最后一个写入者覆盖前一个注册，两边却都记录安装成功。临时目录中的同步竞争已复现。每个组件目录自己的安装锁不能串行化这个共享的用户级注册位置。

应对：当前不要同时向不同自定义目录安装同一用户 / 浏览器的 Anagram；保持一个明确的组件目录。后续应增加以用户和固定主机名为边界的注册锁，覆盖检查、写入、取消注册和回滚。此问题不是网页获得任意文件写权限，但会造成注册误覆盖和安装状态不一致。

## 权限边界与未覆盖项

Native Messaging 组件是普通本地程序，拥有运行用户的 OS 权限；扩展 CSP、消息白名单和路径校验都不能把它变成 OS 文件系统沙箱。无需管理员权限不等于只能访问组件目录。不要以 root / 管理员身份运行安装命令。

依赖库、Python、浏览器、GPU 驱动和操作系统可能在用户缓存目录、着色器缓存、诊断 / 崩溃日志、交换区或临时目录额外写入。本项目将已知缓存尽量定向到专用位置，但本次审计没有穷举所有 OS / 驱动版本的实际系统调用，也没有证明剪贴板管理器、备份、杀毒或索引服务不会保留副本。发布说明不应承诺“零外部写入”“卸载后零残留”或“零风险”。

强制杀死安装进程也不等于所有第三方子进程立即停止。Windows 直接安装入口的强杀 / 子进程存活场景尚未验证；不要把文件锁加固描述成完整的崩溃恢复保证。POSIX 异常中止可能留下 `.installer-lock` 或 staging，安装器会拒绝盲目删除它们。
