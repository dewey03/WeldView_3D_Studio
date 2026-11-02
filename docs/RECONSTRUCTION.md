# 源码重建说明

> **`desktop/`、`installer/`、`scripts/` 三个目录下的代码是「功能等价重建」，不是原始开发源码。**
> 原始工程未留存，发行版 exe 为编译产物，无法反编译还原。
> 重建依据是对发行版二进制与安装目录的静态分析，并通过**运行时验证**校正。
> 最后更新：2026-11-02

---

## 一、取证过程

### 1.1 二进制静态分析

| 观测项 | 实测结果 | 推断 |
| :--- | :--- | :--- |
| PE 架构 | x64 / PE32+，10 个节区 | 64 位原生程序 |
| 节区构成 | 含 `.CLR_UEF`、`.didat` | **.NET 应用** |
| 导入表 | 仅 `KERNEL32`、`ADVAPI32`、`ole32`、`OLEAUT32`、`USER32`、`SHELL32` + UCRT `api-ms-win-crt-*` | 无 Python 运行时、无显式 `mscoree.dll` 导入 → 自包含 .NET |
| 打包器特征 | `PyInstaller` 归档 cookie 未命中、`python3` 未命中、`.asar` 未命中 | 排除 PyInstaller 与 Electron |
| 内核特征 | `WebView2` 命中 | WebView2 渲染内核 |

### 1.2 安装目录结构

```
E:\WeldView 3D Studio\
├── WeldView_3D_Studio.exe        63.7 MB
├── Uninstall.exe
├── WeldView_3D_Studio_V3.3.html  宿主页面
├── assets\app\wv33.js            前端主逻辑
├── assets\vendor\{three,occt}\   渲染与 CAD 解析依赖
├── assets\icons\
├── samples\                      样例 STEP
├── exports\                      导出成果
└── webview_profile\EBWebView\    WebView2 用户数据目录
```

`webview_profile\EBWebView\` 的存在直接确认了 WebView2 内核。

### 1.3 前端代码逆向（关键证据）

宿主页面第 1813 行明确写着架构：

> 架构：**C# 托盘常驻宿主 (动态端口)** + **Python SolidWorks COM 桥接 (:18766)** + WebGL PBR

`assets/app/wv33.js` 第 23–30 行：

```js
function hostBase() {
  const p = Number(new URLSearchParams(location.search).get("hostPort"));
  if (p >= 1024 && p <= 65535) return "http://127.0.0.1:" + p;
  return "http://127.0.0.1:18765";
}
const HOST = hostBase();
```

由此确定：**宿主不是纯窗口壳，而是一个带 HTTP API 的常驻服务**，端口动态分配并通过 URL 查询串传给页面。

### 1.4 通信机制（此处修正初版结论）

初版重建曾判断「不存在 JS↔宿主通信」，该判断**不准确**。准确结论是：

| 通道 | 是否存在 | 依据 |
| :--- | :--- | :--- |
| `postMessage` / WebMessage | ❌ 不存在 | 全代码检索无命中 |
| `AddHostObjectToScript` 宿主对象 | ❌ 不存在 | 全代码检索无命中 |
| **HTTP API（127.0.0.1 动态端口）** | ✅ **存在** | `HOST + "/api/..."` 共 7 处调用 |

即：**不使用 WebView2 原生桥接，而走本地 HTTP**。这也解释了为何 Python 桥接可以用同一套 HTTP 方式并存。

---

## 二、重建产物

| 文件 | 作用 | 状态 |
| :--- | :--- | :--- |
| `desktop/WeldView.Desktop.csproj` | .NET 8 WPF 工程，win-x64 单文件发布 | 重建 |
| `desktop/Program.cs` | 入口、单实例互斥 | 重建 |
| `desktop/AppPaths.cs` | 根目录解析、虚拟主机名、用户数据目录 | 重建 |
| `desktop/MainWindow.xaml` | 窗口骨架 + 启动遮罩 | 重建（视觉为重新设计） |
| `desktop/MainWindow.xaml.cs` | WebView2 初始化、虚拟主机映射、托盘常驻、下载接管、窗口状态持久化 | 重建 |
| `desktop/HostApi.cs` | **宿主 HTTP API**，7 个端点 + CORS + 动态端口 | 重建 |
| `desktop/app.manifest` | DPI 感知、longPathAware | 重建 |
| `desktop/app.ico` | 应用图标 | **原文件** |
| `installer/WeldView_Setup.iss` | Inno Setup 6 安装脚本，含 WebView2 运行时检测 | 重建 |
| `scripts/build.ps1` / `build.bat` | 一键构建 | 重建 |

---

## 三、运行时验证结果

重建版本已在本机实际启动并验证（Windows / .NET SDK 9.0.309 / WebView2 已安装）。

### 3.1 编译

```
dotnet build -c Release
  已成功生成。
    0 个警告
    0 个错误
```

### 3.2 启动与宿主 API

程序启动后，宿主服务在 `127.0.0.1:18765` 正常监听：

| 接口 | 实测响应 | 结果 |
| :--- | :--- | :--- |
| `GET /api/health` | `{"ok":true,"service":"WeldView_3D_Host","version":"3.7","port":18765,"features":[...]}` | ✅ |
| `GET /api/check_dir?path=E:\weldview` | `{"writable":true,"path":"E:\\weldview"}` | ✅ |
| `GET /api/check_dir?path=E:\no_such_xyz` | `{"writable":false,"reason":"目录不存在"}` | ✅ |
| `GET /api/read_cad_file?path=...STEP` | `{"ok":true,"fileName":"14 掩护梁右侧护板.STEP","size":6017,"base64":"SVNPLTEwMzAzLTIxOy..."}` | ✅ |
| `POST /api/save_deliverable` | `{"ok":true,"savedPath":"..._smoke.html","canceled":false}`，落盘 11 字节，内容正确 | ✅ |
| `POST /api/save_project` | `{"ok":true,"savedPath":"..._smoke.wvproj"}`，落盘 9 字节 | ✅ |
| `GET /api/unknown` | `{"ok":false,"error":"未知接口: /api/nope"}` | ✅ |

### 3.3 验证中发现并修复的缺陷

**缺陷**：`POST /api/save_deliverable` 首次实测返回 `{"ok":false,"error":"请求体缺少 fileName / content"}`。

**根因**：前端发送 camelCase 键名（`fileName` / `content` / `dir`），而 C# 属性为 PascalCase，
`System.Text.Json` 默认**区分大小写**，导致反序列化后属性全为 null。

**修复**：反序列化时启用 `PropertyNameCaseInsensitive = true`。修复后两个保存接口均通过。

> 该缺陷仅靠编译无法发现，必须实际调用接口才能暴露。

### 3.4 已知的验证边界

| 项 | 状态 |
| :--- | :--- |
| 页面是否正常渲染三维视图 | 未逐帧核验（需人工目视） |
| Inno Setup 打包 | 未验证（本机未安装 Inno Setup） |
| SolidWorks 桥接联调 | 未验证（需 SolidWorks 与授权） |
| 下载/导出到「我的文档」 | 未验证（`save_deliverable` 走的是指定目录分支） |
| `open_project` 无参数弹框 | 未验证（会阻塞等待人工操作） |

> 注：`POST` 请求若不带 `Content-Length`，`HttpListener` 会在进入处理逻辑前返回 `411 Length Required`。
> 浏览器 `fetch` 默认发送 `Content-Length: 0`，不受影响；仅影响手工 curl 调试。

---

## 四、与原版的已知差异

| 项目 | 说明 |
| :--- | :--- |
| **窗口视觉** | 标题栏、启动画面为重新设计，原版外观未知 |
| **菜单与快捷键** | 原版是否有原生菜单栏未知；重建版仅保留 WebView2 默认加速键 |
| **托盘交互** | 重建版为「关闭即最小化到托盘」，原版行为未知 |
| **动态端口策略** | 重建版从 18765 起顺序探测；原版策略未知 |
| **下载目录** | 重建版固定 `我的文档\WeldView Exports`，原版策略未知 |
| **卸载器文件名** | 原目录为 `Uninstall.exe`；Inno 默认生成 `unins000.exe`，重建版未强行改名 |
| **安装路径默认值** | 原版装在 `E:\WeldView 3D Studio`（自定义路径）；重建脚本默认 `{autopf}\WeldView 3D Studio` |
| **数字签名** | 原版可能带签名，重建版无 |
| **宿主 API 细节** | 端点路径与请求/响应字段由调用点逆向确定，边界行为（如超大文件、并发）可能与原版不同 |

---

## 五、构建

```bat
scripts\build.bat
```

环境要求：.NET SDK 8.0+、WebView2 Runtime、（打包时）Inno Setup 6。

分步：

```powershell
dotnet publish desktop\WeldView.Desktop.csproj -c Release -r win-x64 `
  -p:PublishSingleFile=true -o dist\publish
```

---

## 六、若找回原始工程

直接用原工程覆盖 `desktop/`、`installer/`、`scripts/` 三个目录，本文档与重建代码可整体删除，
并同步更新 `docs/SOURCE_INVENTORY.md` 的完整度结论。
