# 源码构成与完整度说明

> 本文档说明本仓库中每类源码的**真实来源**与**完整度**，避免误判为完整工程。
> 最后更新：2026-11-02

---

## 一、三类来源，务必区分

| 类别 | 目录 | 来源 | 可信度 |
| :--- | :--- | :--- | :--- |
| **① 原始运行时代码** | `assets/app/`、`assets/vendor/`、`assets/icons/`、`tools/`、`WeldView_3D_Studio_V3.3.html`、`index.html` | 直接复制自已安装程序目录，**未做任何修改** | 与发行版逐字节一致 |
| **② 重建代码** | `desktop/`、`installer/`、`scripts/` | 依据二进制与目录结构静态分析**重新编写** | 功能等价，**非原始源码**，详见 [RECONSTRUCTION.md](RECONSTRUCTION.md) |
| **③ 文档** | `README.md`、`docs/` | 本次整理编写 | — |

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
├── tools/
│   ├── WeldView_3D_SolidWorks_Bridge_Service.py   # ① SolidWorks 桥接服务（31.7 KB）
│   └── build_icons.js               # ① 图标构建脚本（Node + sharp）
├── desktop/                         # ② 桌面主程序（.NET 8 + WPF + WebView2，重建）
├── installer/WeldView_Setup.iss     # ② 安装包配置（Inno Setup 6，重建）
├── scripts/build.ps1|build.bat      # ② 构建脚本（重建）
└── docs/                            # ③ 文档
```

> ⚠️ `assets/` 与宿主页面的相对位置**不可更改**。宿主页用 `assets/app/wv33.js`
> 与 importmap `./assets/vendor/three/...` 引用资源，移动目录会导致页面白屏。

---

## 三、`assets/app/wv33.js` 关键函数对照

| 功能域 | 函数 |
| :--- | :--- |
| 模型导入 | `ensureOcct`、`fetchCadBytes`、`buildModelFromOcct`、`buildSoup`、`decodeGeom` |
| 特征边提取 | `extractFeatureEdges`、`attachFeatureEdgesToParts`、`addEdge`、`candidateSignature` |
| 自动识别 | `autoIdentifyAllEdgesV33`、`evaluateWeldability`、`detectCrossPartJoints`、`computeSceneBoundsV33` |
| 焊缝建模 | `createWeldPrismGeometry`、`createFreehandEdgeAndWeldV38`、`buildInstances`、`rebuildAllWeldInstances` |
| 交互与渲染 | `boot`、`ensureThree`、`drawHud`、`drawAxis`、`applyCam`、`autoFit`、`pickSurface`、`pickWeld` |
| 统计核算 | `buildStats`、`updateAgStatTxt`、`renderWeldList` |
| 文件导出 | `exportDeliverableV33`、`buildDeliverablePayload`、`deliverableTemplate`、`encodePartGeometry` |
| 工程存取 | `serializeProjectV33`、`deserializeProjectV33`、`applySettings`、`checkDirState` |

---

## 四、完整度结论

| 模块 | 状态 | 说明 |
| :--- | :--- | :--- |
| 三维渲染与焊缝识别逻辑 | ✅ 完整 | `wv33.js` 为发行版实际执行代码 |
| 模型导入（STEP/IGES） | ✅ 完整 | OpenCASCADE WASM + `buildModelFromOcct` |
| SolidWorks 数据抽取 | ✅ 完整 | 桥接服务 Python 源码 |
| 文件导出 | ✅ 完整 | `exportDeliverableV33` 等函数 |
| 桌面主程序 | ⚠️ 重建 | 可编译，行为等价，非原始代码 |
| 安装包配置 | ⚠️ 重建 | Inno Setup 脚本，非原始配置 |
| 构建脚本 | ⚠️ 重建 | 按重建工程编写 |
| 原始 Git 历史 | ❌ 缺失 | 无法恢复 |

---

## 五、运行方式

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

---

## 六、第三方组件许可

| 组件 | 许可 | 文件 |
| :--- | :--- | :--- |
| three.js | MIT | `assets/vendor/three/three.module.min.js` |
| occt-import-js | LGPL-2.1 | `assets/vendor/occt/license.occt-import-js.txt` |
| OpenCASCADE | LGPL-2.1 | `assets/vendor/occt/license.occt.txt` |
| Microsoft.Web.WebView2 | 微软许可 | NuGet 包引用（不随仓库分发） |

LGPL 组件以独立 WASM 形式分发，未静态链接进自有代码，符合 LGPL 分发要求。
