# 源码构成与完整度说明

> 本文档说明本仓库中每类源码的**真实来源**与**完整度**，避免误判为完整工程。
> 最后更新：2026-11-02

---

## 一、三类来源，务必区分

| 类别 | 目录 | 来源 | 可信度 |
| :--- | :--- | :--- | :--- |
| **① 原始运行时代码** | `assets/`、`tools/`、`WeldView_3D_Studio_V3.3.html`、`index.html`、`samples/`、`examples/` | 直接复制自已安装程序目录，**未做任何修改** | 与发行版逐字节一致 |
| **② 重建代码** | `desktop/`、`installer/`、`scripts/` | 依据二进制与前端代码静态分析**重新编写**，并经运行时验证 | 功能等价，**非原始源码** |
| **③ 工程文档** | `README.md`、`CHANGELOG.md`、`LICENSE`、`docs/`、`package.json`、`.github/` | 本次整理编写 | — |

---

## 二、目录布局（与安装目录一致）

```
<repo root>/
├── WeldView_3D_Studio_V3.3.html     # ① 桌面端宿主页面（exe 加载的入口页）
├── index.html                       # ① V3.7 单文件发行版（自包含，可直接浏览器打开）
├── assets/
│   ├── app/wv33.js                  # ① 核心业务逻辑（232 KB）
│   ├── vendor/three/                # ① three.js（MIT）
│   ├── vendor/occt/                 # ① OpenCASCADE WASM 导入器（LGPL-2.1）
│   └── icons/                       # ① 图标 SVG 源文件与多尺寸资源
├── samples/                         # ① 样例 STEP 模型
├── examples/                        # ① 其他型号的 V3.7 导出成果（F341、前连杆）
├── tools/
│   ├── WeldView_3D_SolidWorks_Bridge_Service.py   # ① SolidWorks 桥接服务（31.7 KB）
│   └── build_icons.js               # ① 图标构建脚本（Node + sharp）
├── desktop/                         # ② 桌面主程序（.NET 8 + WPF + WebView2，重建）
├── installer/WeldView_Setup.iss     # ② 安装包配置（Inno Setup 6，重建）
├── scripts/build.ps1|build.bat      # ② 构建脚本（重建）
├── docs/
│   ├── ARCHITECTURE.md              # ③ 三层架构与接口契约
│   ├── RECONSTRUCTION.md            # ③ 重建依据、验证结果、已知差异
│   ├── SOURCE_INVENTORY.md          # ③ 本文档
│   ├── RELEASE_NOTES_V3.7.md        # ① V3.7 升级与打包说明
│   └── ci/build.yml.example         # ③ CI 模板（需 workflow 权限的 Token 才能启用）
├── CHANGELOG.md / LICENSE / README.md
├── package.json                     # ③ tools/build_icons.js 的依赖声明
└── .gitignore / .gitattributes
```

> ⚠️ `assets/` 与宿主页面的相对位置**不可更改**。宿主页用 `assets/app/wv33.js`
> 与 importmap `./assets/vendor/three/...` 引用资源，移动目录会导致页面白屏。
> CI 中的 `frontend-check` 任务会自动校验该约束。

---

## 三、桌面端源码构成

| 文件 | 职责 |
| :--- | :--- |
| `desktop/Program.cs` | 入口、单实例互斥（避免争用 WebView2 数据目录与宿主端口） |
| `desktop/AppPaths.cs` | 应用根目录解析、虚拟主机名、用户数据目录、导出目录 |
| `desktop/MainWindow.xaml(.cs)` | 窗口、托盘常驻、WebView2 初始化、虚拟主机映射、下载接管、窗口状态持久化 |
| `desktop/HostApi.cs` | 宿主 HTTP API（7 端点 + CORS + 动态端口探测） |
| `desktop/app.manifest` | DPI 感知、longPathAware |
| `desktop/WeldView.Desktop.csproj` | .NET 8 WPF，win-x64 单文件发布 |

宿主 API 端点与三层架构详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 四、`assets/app/wv33.js` 关键函数对照

| 功能域 | 函数 |
| :--- | :--- |
| 宿主通信 | `hostBase`、`fetchCadBytes`、`checkDirState` |
| 模型导入 | `ensureOcct`、`buildModelFromOcct`、`buildSoup`、`decodeGeom` |
| 特征边提取 | `extractFeatureEdges`、`attachFeatureEdgesToParts`、`addEdge`、`candidateSignature` |
| 自动识别 | `autoIdentifyAllEdgesV33`、`evaluateWeldability`、`detectCrossPartJoints`、`computeSceneBoundsV33` |
| 焊缝建模 | `createWeldPrismGeometry`、`createFreehandEdgeAndWeldV38`、`buildInstances`、`rebuildAllWeldInstances` |
| 交互与渲染 | `boot`、`ensureThree`、`drawHud`、`drawAxis`、`applyCam`、`autoFit`、`pickSurface`、`pickWeld` |
| 统计核算 | `buildStats`、`updateAgStatTxt`、`renderWeldList` |
| 文件导出 | `exportDeliverableV33`、`buildDeliverablePayload`、`deliverableTemplate`、`encodePartGeometry` |
| 工程存取 | `serializeProjectV33`、`deserializeProjectV33`、`applySettings` |

---

## 五、完整度结论

| 模块 | 状态 | 说明 |
| :--- | :--- | :--- |
| 三维渲染与焊缝识别逻辑 | ✅ 完整 | `wv33.js` 为发行版实际执行代码 |
| 模型导入（STEP/IGES） | ✅ 完整 | OpenCASCADE WASM + `buildModelFromOcct` |
| SolidWorks 数据抽取 | ✅ 完整 | 桥接服务 Python 源码，含接口规范注释 |
| 文件导出 / 工程存取 | ✅ 完整 | 前端 + 宿主 API 两侧齐备 |
| 桌面主程序 | ⚠️ 重建 | 可编译、可启动、宿主 API 已实测通过 |
| 安装包配置 | ⚠️ 重建 | Inno Setup 脚本，未实际打包验证 |
| 构建脚本 | ⚠️ 重建 | 按重建工程编写 |
| CI 流水线 | ⚠️ 模板 | `docs/ci/build.yml.example`，启用需 `workflow` 权限的 Token |
| 原始 Git 历史 | ❌ 缺失 | 无法恢复 |

---

## 六、运行方式

### 单文件发行版（零依赖）

浏览器直接打开 `index.html`。

### 模块化版本（需 http 服务）

```bash
python -m http.server 8080
# 访问 http://localhost:8080/WeldView_3D_Studio_V3.3.html
```

`file://` 下 WASM 与 ES Module 会被浏览器拦截，必须走 http。

### 桌面端（重建）

```bat
scripts\build.bat
```

依赖：.NET SDK 8+、WebView2 Runtime、（打包时）Inno Setup 6。

### SolidWorks 桥接（可选）

```bash
python tools/WeldView_3D_SolidWorks_Bridge_Service.py --port 18766
```

需本机安装 SolidWorks 并具备 COM 授权。

---

## 七、第三方组件许可

| 组件 | 许可 | 文件 |
| :--- | :--- | :--- |
| three.js | MIT | `assets/vendor/three/three.module.min.js` |
| occt-import-js | LGPL-2.1 | `assets/vendor/occt/license.occt-import-js.txt` |
| OpenCASCADE | LGPL-2.1 | `assets/vendor/occt/license.occt.txt` |
| Microsoft.Web.WebView2 | 微软许可 | NuGet 引用，不随仓库分发 |
| sharp | Apache-2.0 | `package.json` devDependency，不随仓库分发 |

LGPL 组件以独立 WASM 形式分发，未静态链接进自有代码，符合 LGPL 分发要求。
