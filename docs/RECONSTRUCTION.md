# 源码重建说明

> **本文档说明：`desktop/`、`installer/`、`scripts/` 三个目录下的代码是「功能等价重建」，不是原始开发源码。**
> 原始工程未留存，发行版 exe 为编译产物，无法反编译还原。重建依据是对发行版二进制与安装目录的静态分析。
> 最后更新：2026-11-02

---

## 一、重建依据（可复现的取证结果）

| 观测项 | 实测结果 | 推断结论 |
| :--- | :--- | :--- |
| PE 架构 | x64 / PE32+，10 个节区 | 64 位原生程序 |
| 节区构成 | 含 `.CLR_UEF`、`.didat` | **.NET 应用**（非 Python / 非 Electron 打包） |
| 导入表 | 仅 `KERNEL32`、`ADVAPI32`、`ole32`、`OLEAUT32`、`USER32`、`SHELL32` + UCRT `api-ms-win-crt-*` | 无 Python 运行时、无 `mscoree.dll` 显式导入 → 自包含 .NET |
| 字符串特征 | `WebView2` 命中；`PyInstaller` / `python3` / `.asar` 未命中 | 使用 **WebView2** 内核，排除 Electron 与 PyInstaller |
| 安装目录 | 存在 `webview_profile\`（内含 `EBWebView\Default\Cache`） | WebView2 用户数据目录落在安装根目录 |
| 页面与脚本 | 宿主页 `WeldView_3D_Studio_V3.3.html` 以 `<script src="assets/app/wv33.js" defer>` 加载前端 | 桌面端只承载页面，业务逻辑全在前端 |
| 通信接口 | 宿主页与 `wv33.js` 中 **无** `chrome.webview` / `window.extern` / `postMessage` | **不存在 JS↔宿主 IPC**，宿主职责仅为窗口与文件下载 |
| 模块解析 | `<script type="importmap">{"three":"./assets/vendor/three/three.module.min.js"}</script>` | 依赖 ES Module + WASM，必须经 http(s) 源加载，`file://` 不可行 |
| 安装产物 | 根目录含 `WeldView_3D_Studio.exe`、`Uninstall.exe`、`assets\`、`samples\`、`exports\` | 安装器为常规桌面安装包，无服务、无驱动 |

由此确定重建技术栈：**.NET 8 + WPF + WebView2**。

---

## 二、重建产物清单

| 文件 | 作用 | 重建状态 |
| :--- | :--- | :--- |
| `desktop/WeldView.Desktop.csproj` | 工程定义，单文件发布，win-x64 | 重建 |
| `desktop/Program.cs` | 入口、单实例互斥 | 重建 |
| `desktop/AppPaths.cs` | 应用根目录解析、虚拟主机名、用户数据目录 | 重建 |
| `desktop/MainWindow.xaml` | 窗口骨架 + 启动遮罩 | 重建（视觉为重新设计） |
| `desktop/MainWindow.xaml.cs` | WebView2 初始化、虚拟主机映射、下载接管、窗口状态持久化 | 重建 |
| `desktop/app.manifest` | DPI 感知、longPathAware | 重建 |
| `desktop/app.ico` | 应用图标 | **原文件**（取自 `assets/icons/weldview.ico`） |
| `installer/WeldView_Setup.iss` | Inno Setup 6 安装脚本，含 WebView2 运行时检测 | 重建 |
| `scripts/build.ps1` | 一键构建（publish + 打包） | 重建 |
| `scripts/build.bat` | PowerShell 包装器 | 重建 |

---

## 三、关键实现说明

### 1. 为什么必须做虚拟主机映射

前端使用 `importmap` + ES Module + `.wasm`。若直接 `file://` 加载：

- ES Module 受 CORS 限制，`file://` 下 import 被拒绝；
- `WebAssembly.instantiateStreaming` 要求 `application/wasm` MIME 与 http(s) 源。

因此使用：

```csharp
core.SetVirtualHostNameToFolderMapping(
    "weldview.local", appRoot, CoreWebView2HostResourceAccessKind.Allow);
core.Navigate("https://weldview.local/WeldView_3D_Studio_V3.3.html");
```

这是页面能跑起来的前提，也是原版程序必然采用的机制。

### 2. 目录结构必须与安装目录一致

宿主页面使用相对路径 `assets/app/wv33.js`、`./assets/vendor/three/...`。
因此仓库根目录必须同时包含：

```
WeldView_3D_Studio_V3.3.html
assets/app/wv33.js
assets/vendor/{three,occt}
```

把 `assets/` 移到子目录会导致 404，页面白屏。这一点已在重建中修正。

### 3. 关闭 WebView2 的宿主能力

依据「页面无 IPC 调用」这一观测，重建中显式关闭：

```csharp
s.AreHostObjectsAllowed = false;
s.IsWebMessageEnabled   = false;
s.AreDefaultContextMenusEnabled = false;
```

若原版实际开启过 `AddHostObjectToScript`，则重建版本会缺少该能力——这是**已知不确定项**（见下节）。

---

## 四、与原版的已知差异

以下内容无法通过静态分析确定，重建版本可能与之不符：

| 项目 | 说明 |
| :--- | :--- |
| **窗口视觉** | 标题栏、启动画面为重新设计，原版外观未知 |
| **菜单与快捷键** | 原版是否有原生菜单栏、自定义快捷键未知；重建版仅保留 WebView2 默认加速键 |
| **下载目录策略** | 重建版固定输出到 `我的文档\WeldView Exports`，原版策略未知 |
| **卸载器文件名** | 原安装目录为 `Uninstall.exe`；Inno Setup 默认生成 `unins000.exe`，重建版未强行改名 |
| **安装路径默认值** | 原版安装在 `E:\WeldView 3D Studio`（自定义路径），重建脚本默认 `{autopf}\WeldView 3D Studio` |
| **签名与版本信息** | 原版可能带数字签名，重建版无 |
| **IPC 能力** | 若原版存在隐藏的宿主对象注入，重建版不具备 |

---

## 五、构建与验证

### 环境

- .NET SDK 8.0 或更高（本机验证用 9.0.309）
- Inno Setup 6（仅打包安装器时需要）
- Microsoft Edge WebView2 Runtime（运行时依赖）

### 构建

```bat
scripts\build.bat
```

或分步：

```powershell
dotnet publish desktop\WeldView.Desktop.csproj -c Release -r win-x64 `
  -p:PublishSingleFile=true -o dist\publish
```

### 本机验证结果

```
dotnet build -c Release
  已成功生成。
    0 个警告
    0 个错误
```

仅验证了**编译通过**。未做运行时验证（需要 WebView2 运行时与图形界面），
也未验证 Inno Setup 打包（本机未安装 Inno Setup）。

---

## 六、若找回原始工程

直接用原工程覆盖以下目录即可，本文档与重建代码可整体删除：

```
desktop/   installer/   scripts/
```

同时建议更新 `docs/SOURCE_INVENTORY.md` 中的「缺失内容」章节。
