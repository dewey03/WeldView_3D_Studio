# 源码构成与缺失说明

> 本文档说明本仓库中源码的实际来源、完整度，以及尚未纳入版本管理的内容。
> 最后更新：2026-11-02

---

## 一、源码来源

原始开发工程目录在交付后未留存。本仓库中的源码**恢复自已安装程序目录**：

```
E:\WeldView 3D Studio\        （V3.3 – V3.7 运行时资源，安装后的实际运行目录）
```

恢复方式为直接复制运行时文件，**未做任何反编译或代码修改**。因此：

- 收录的是**运行时实际执行的代码**，逻辑与发行版一致；
- 但**不是**开发者的原始工程结构（无 Git 历史、无源目录组织、无注释级文档）。

---

## 二、已收录内容

| 路径 | 类型 | 大小 | 说明 |
| :--- | :--- | ---: | :--- |
| `app/wv33.js` | 应用源码 | 232.2 KB | **核心业务逻辑**，见下方函数对照 |
| `tools/WeldView_3D_SolidWorks_Bridge_Service.py` | Python 源码 | 31.7 KB | SolidWorks 桥接服务：装配体遍历、特征边提取、真实边长计算、坡口几何测量、STL 解析 |
| `tools/build_icons.js` | 构建脚本 | 2.2 KB | 图标构建脚本（Node + sharp，生成多尺寸 PNG 与 7 层 ICO） |
| `app/vendor/three/` | 第三方 | 678.9 KB | three.js 运行时（MIT），含 `RoomEnvironment.js` |
| `app/vendor/occt/` | 第三方 | 7.5 MB | OpenCASCADE WASM 导入器（LGPL-2.1），负责 STEP / IGES 解析 |
| `assets/icons/` | 资源 | 274 KB | 图标 SVG 源文件、多尺寸 PNG、ICO、manifest |
| `legacy/WeldView_3D_Studio_V3.3.html` | 历史版本 | 523.4 KB | V3.3 单文件版本，用于版本对照 |
| `index.html` | 发行版 | 1.6 MB | V3.7 单文件发行版（自包含，可直接运行） |

### `app/wv33.js` 关键函数对照

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

## 三、缺失内容

以下内容在本机**不存在**，无法纳入仓库：

| 缺失项 | 影响 | 说明 |
| :--- | :--- | :--- |
| **桌面主程序外壳源码** | 无法从源码重新编译出 `.exe` | 发行版 exe 为编译产物（含 Rust / WebView2 特征），无可读源码留存；反向提取无法还原为可维护代码 |
| **安装包配置** | 无法自动生成 Setup 安装程序 | 未发现 Inno Setup `.iss` 或 NSIS `.nsi` 脚本 |
| **打包 / 构建脚本** | 无法一键产出安装包 | 未发现 `.spec`、`package.json`、`build.bat`、CI 配置 |
| **独立标注页面源码** | 标注交互逻辑分散 | 相关逻辑内嵌于 `app/wv33.js`，无独立页面文件 |
| **开发期 Git 历史** | 无逐版本演进记录 | 原始工程未留存 |

> 上述缺失项如后续找回原始工程，可直接覆盖 `app/` 与 `tools/` 并补充 `build/`、`installer/` 目录。

---

## 四、运行方式

### 单文件发行版（推荐，零依赖）

直接用浏览器打开 `index.html`。完全自包含，无需 Node 或任何 CDN。

### 模块化源码（需本地静态服务）

`app/wv33.js` 依赖 ES Module 与 WASM，**必须通过 HTTP 服务访问**，`file://` 协议下 WASM 会被浏览器拦截：

```bash
# 在仓库根目录执行
python -m http.server 8080
# 浏览器访问 http://localhost:8080/app/
```

目录约定：`app/vendor/` 下的路径为运行时相对路径，移动文件需同步修改 `wv33.js` 中的引用。

### 图标构建

```bash
npm install sharp
node tools/build_icons.js
```

---

## 五、第三方组件许可

| 组件 | 许可 | 文件 |
| :--- | :--- | :--- |
| three.js | MIT | `app/vendor/three/three.module.min.js` |
| occt-import-js | LGPL-2.1 | `app/vendor/occt/license.occt-import-js.txt` |
| OpenCASCADE | LGPL-2.1 | `app/vendor/occt/license.occt.txt` |

LGPL 组件以独立 WASM 形式分发，未静态链接进自有代码，符合 LGPL 分发要求。
