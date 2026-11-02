# WeldView 3D Studio

> 焊接结构三维焊缝识别与焊材定额核算工作台 —— 单V坡口深度识别 · 一键生成焊缝 · 人工补选 · 焊接图纸辅助判定

WeldView 3D Studio 面向钢箱梁、顶梁等大型焊接结构件，从三维模型（STEP / IGES / STL / SolidWorks）自动识别可焊边与坡口类型，生成带真实截面的 3D 焊道实体，并按坡口型号自动核算焊材消耗与标准定额工时。

当前版本：**V3.7** ｜ 平台：Windows x64

---

## 目录

- [核心能力](#1-核心能力)
- [快速开始](#2-快速开始)
- [系统架构](#3-系统架构)
- [目录结构](#4-目录结构)
- [源码完整度](#5-源码完整度重要)
- [识别基准](#6-典型样件识别结果)
- [构建](#7-构建)
- [版本与许可](#8-版本)

---

## 1. 核心能力

| 能力 | 说明 |
| :--- | :--- |
| **单V坡口深度识别** | 法平面正交截面坡口扫描算法：沿交界切向的法平面在 15.5 mm 半径内扫描配对零件斜面，以「与母材主壁面夹角 22°~68°」且「与配对壁面构成锐角槽口」双重判据区分单V坡口与角焊缝 |
| **坡口 / 角焊异侧分离聚类** | 禁止将单V坡口边与背侧角焊缝边混并为同一焊缝，保证条数与长度真实 |
| **⚡ 一键生成焊缝** | `Shift+A`，免逐条点选，一步完成全模型坡口检测、角焊识别与焊道建模；可切换「仅生成坡口焊缝」 |
| **✍️ 人工补选焊缝** | 模式 A 全模型几何边开放点选；模式 B 三维表面两点手绘焊道（自动提取表面法向） |
| **📐 导入图纸判定** | 支持 PNG/JPG/WEBP/PDF 施工图与 CSV/JSON/TXT 工艺表，内置 GB/T 324 与 AWS 焊缝符号解析，按规则批量校准坡口型号与焊脚 |
| **定额核算** | 按焊缝类型、坡口型号、K 值、施焊方式（人/机）输出焊材消耗（kg）与标准工时（min） |

---

## 2. 快速开始

### 方式一：单文件发行版（零依赖）

浏览器直接打开 `index.html`。完全自包含，无需 Node、无需 CDN、可离线运行。

> 建议 Chrome / Edge 最新版本以获得完整 WebGL 性能。

### 方式二：模块化版本（需 HTTP 服务）

```bash
python -m http.server 8080
# 浏览器访问 http://localhost:8080/WeldView_3D_Studio_V3.3.html
```

`file://` 下 WASM 与 ES Module 会被浏览器拦截，必须走 http。

### 方式三：桌面端

从 [Releases](../../releases) 下载 `WeldView_3D_Studio_Setup_V3.7.exe`，或自行编译：

```bat
scripts\build.bat
```

依赖：.NET SDK 8+、WebView2 Runtime、（打包时）Inno Setup 6。

### 方式四：SolidWorks 桥接（可选）

导入 `.sldprt` / `.sldasm` 时需要：

```bash
python tools/WeldView_3D_SolidWorks_Bridge_Service.py --port 18766
```

需本机安装 SolidWorks 并具备 COM 授权。

---

## 3. 系统架构

```
① 桌面宿主 (.NET 8 / WPF / WebView2)  ── 窗口 + 托盘 + 宿主 HTTP API
        │  虚拟主机映射 weldview.local，端口经 ?hostPort= 传入
        ▼
② 前端应用 (WebGL / ES Module / WASM) ── three.js + occt-import-js + 焊缝识别
        │  fetch 127.0.0.1:18766/api/open_sw
        ▼
③ SolidWorks 桥接 (Python)           ── COM 静默打开、装配体遍历、坡口测量
```

| 服务 | 端口 | 说明 |
| :--- | :--- | :--- |
| C# 宿主 API | 动态，默认 18765 | 文件读写、目录选择、工程存取 |
| Python 桥接 | 固定 18766 | SolidWorks COM |

完整接口契约见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

---

## 4. 目录结构

```
WeldView_3D_Studio/
├── index.html                          # V3.7 单文件发行版（自包含）
├── WeldView_3D_Studio_V3.3.html        # 桌面端宿主页面（exe 加载入口）
├── assets/
│   ├── app/wv33.js                     # 核心业务逻辑（232 KB）
│   ├── vendor/three/                   # three.js（MIT）
│   ├── vendor/occt/                    # OpenCASCADE WASM（LGPL-2.1）
│   └── icons/                          # 图标源文件与多尺寸资源
├── samples/                            # 样例 STEP 模型
├── examples/                           # 其他型号 V3.7 导出成果
├── desktop/                            # 桌面主程序（.NET 8 + WPF + WebView2）
├── installer/WeldView_Setup.iss        # 安装包配置（Inno Setup 6）
├── scripts/build.ps1 | build.bat       # 一键构建
├── tools/
│   ├── WeldView_3D_SolidWorks_Bridge_Service.py
│   └── build_icons.js
├── docs/
│   ├── ARCHITECTURE.md                 # 三层架构与接口契约
│   ├── RECONSTRUCTION.md               # 重建依据、验证结果、已知差异
│   ├── SOURCE_INVENTORY.md             # 源码构成与完整度
│   ├── RELEASE_NOTES_V3.7.md
│   └── ci/build.yml.example            # CI 模板（启用方式见文档）
├── CHANGELOG.md / LICENSE / README.md
├── package.json                        # 图标构建工具依赖
└── .gitignore / .gitattributes
```

> ⚠️ `assets/` 与宿主页面的相对位置不可更改，移动会导致页面白屏（CI 会自动校验）。

---

## 5. 源码完整度（重要）

原始开发工程未留存。仓库内源码分三类，**请勿混同**：

| 类别 | 位置 | 说明 |
| :--- | :--- | :--- |
| **原始运行时代码** | `assets/`、`tools/`、宿主页面、`index.html`、`samples/`、`examples/` | 直接复制自安装目录，与发行版逐字节一致 |
| **重建代码** | `desktop/`、`installer/`、`scripts/` | 依据二进制与前端代码静态分析重新编写，**功能等价但非原始源码** |
| **工程文档** | `README.md`、`docs/`、`CHANGELOG.md`、`LICENSE` | 本次整理 |

**重建部分的验证状态**：

- ✅ `dotnet build -c Release` 通过，0 错误 0 警告
- ✅ 程序可实际启动，宿主 API 7 个端点实测通过（含一次真实缺陷修复）
- ⚠️ Inno Setup 打包、SolidWorks 联调、三维渲染目视核验未完成

详见 **[docs/SOURCE_INVENTORY.md](docs/SOURCE_INVENTORY.md)** 与 **[docs/RECONSTRUCTION.md](docs/RECONSTRUCTION.md)**。

---

## 6. 典型样件识别结果

以 `21000顶梁一焊新` 为基准样件（V3.7 实测）：

| 指标 | 数值 |
| :--- | :--- |
| 焊缝总数 | **162 条** |
| 总长 | **167.13 m** |
| 坡口焊缝（Groove） | **29 条 / 18.38 m**（全部单V坡口 45°） |
| 角焊缝（Fillet） | **133 条 / 148.76 m** |
| 机器人焊（机） | 122 条 / 136.45 m |
| 人工焊（人） | 40 条 / 30.69 m |
| 理论焊材消耗 | **231.96 kg**（ER50-6） |
| 标准定额工时 | **55.4 h**（3,324 min） |

V3.7 新增检出 **8 处**此前被误判或吞并的关键单V坡口主焊缝
（W-01、W-03、W-20、W-32、W-34、W-36、W-38、W-60）。

---

## 7. 构建

```bat
scripts\build.bat          REM 构建 exe + 安装包
scripts\build.bat exe      REM 仅构建 exe
```

分步：

```powershell
dotnet publish desktop\WeldView.Desktop.csproj -c Release -r win-x64 `
  -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o dist\publish
```

图标重建：

```bash
npm install
npm run build:icons
```

---

## 8. 版本

| 版本 | 说明 |
| :--- | :--- |
| V3.7 | 单V坡口深度识别、一键生成焊缝、人工补选、图纸辅助判定四大升级 |
| V3.3 | 桌面端架构基线，保留于根目录作为宿主页面 |

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 9. 许可

本仓库为**专有软件**，包含特定工程型号的结构参数与焊接工艺数据。
未经授权不得复制、分发或用于其他工程项目。完整条款见 [LICENSE](LICENSE)。

第三方组件（three.js / OpenCASCADE / WebView2 / sharp）遵循各自原有许可。
