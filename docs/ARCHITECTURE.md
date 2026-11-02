# 系统架构

> 本文档描述 WeldView 3D Studio 的整体架构与进程间通信契约。
> 架构由发行版二进制、安装目录结构与前端代码逆向确定，非原始设计文档。

---

## 一、三层架构

```
┌──────────────────────────────────────────────────────────────┐
│  ① 桌面宿主  WeldView_3D_Studio.exe  (.NET 8 / WPF)           │
│     ├─ 主窗口 + 系统托盘常驻                                   │
│     ├─ WebView2 内核                                          │
│     ├─ 虚拟主机映射  weldview.local → 安装目录                 │
│     └─ 宿主 HTTP API  http://127.0.0.1:{动态端口}              │
└───────────────────────────┬──────────────────────────────────┘
                            │ 加载 https://weldview.local/...?hostPort=NNNN
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  ② 前端应用  宿主页面 + wv33.js  (WebGL / ES Module / WASM)    │
│     ├─ three.js          三维渲染（PBR）                       │
│     ├─ occt-import-js    STEP / IGES B-rep 解析（WASM）        │
│     ├─ 焊缝识别与建模    法平面正交截面坡口扫描                 │
│     └─ 定额核算与成果导出                                      │
└───────────────────────────┬──────────────────────────────────┘
                            │ fetch http://127.0.0.1:18766/api/open_sw
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  ③ SolidWorks 桥接  Python  (WeldView_3D_SolidWorks_Bridge)   │
│     ├─ COM 静默打开 .SLDASM / .SLDPRT（原路径，不复制）        │
│     ├─ 递归装配体遍历 → 零件 / 边拓扑                          │
│     └─ 真实边长、坡口几何测量、PersistReference 持久化引用     │
└──────────────────────────────────────────────────────────────┘
```

---

## 二、端口分配

| 端口 | 归属 | 说明 |
| :--- | :--- | :--- |
| **动态端口**（默认 18765） | C# 宿主 API | 端口被占用时顺延；实际端口经 `?hostPort=` 传给页面 |
| **18766** | Python 桥接 | 固定端口，桥接服务注释明确要求不得与宿主冲突 |
| — | WebView2 虚拟源 | `https://weldview.local/`，无真实端口 |

前端 `hostBase()` 的解析逻辑（`assets/app/wv33.js:23`）：

```js
function hostBase() {
  const p = Number(new URLSearchParams(location.search).get("hostPort"));
  if (p >= 1024 && p <= 65535) return "http://127.0.0.1:" + p;
  return "http://127.0.0.1:18765";   // 缺省回退
}
```

---

## 三、宿主 API 契约

由 `wv33.js` 的调用点逆向确定，`desktop/HostApi.cs` 按此实现。

| 方法 | 路径 | 请求 | 响应 |
| :--- | :--- | :--- | :--- |
| GET | `/api/read_cad_file` | `?path=&raw=1` | `raw=1` 返回原始字节；否则 `{ok, fileName, size, base64}` |
| GET | `/api/check_dir` | `?path=` | `{writable, path, reason?}` |
| GET | `/api/pick_folder` | `?initial=` | `{ok, path}` / `{ok:false, canceled:true}` |
| POST | `/api/open_folder` | `?path=` | `{ok, path}` |
| POST | `/api/save_deliverable` | `{fileName, content, dir}` | `{ok, savedPath}` |
| POST | `/api/save_project` | `?ask=1` + `{fileName, content, dir}` | `{ok, savedPath}` |
| POST | `/api/open_project` | `?path=`（省略则弹框） | `{ok, content, path}` / `{ok:false, canceled:true}` |
| GET | `/api/health` | — | `{ok, service, version, port, features}` |

### 跨源要求

页面源为 `https://weldview.local`，调用 `http://127.0.0.1:PORT` 属**跨源请求**，因此宿主必须返回：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

并处理 `OPTIONS` 预检（返回 204）。

> 浏览器将 `127.0.0.1` 视为「潜在可信来源」，https 页面调用 http 本地端口不会被混合内容策略拦截。

---

## 四、桥接服务 API

`tools/WeldView_3D_SolidWorks_Bridge_Service.py`，默认 `127.0.0.1:18766`。

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/health` | 返回 `{ok, service, port, version, features}`，features 含 `brep-step`、`sw-com-sta`、`custom-props-writeback`、`origin-whitelist` |
| GET | `/api/open_sw` | `?path=` 原路径打开 SolidWorks 文档，返回零件 / 边拓扑 JSON |

设计要点（源自源码文件头注释）：

1. **原路径打开**，绝不把装配体复制到临时目录；
2. 递归遍历 `walk(comp, parent_id, depth, out_parts, out_edges)`；
3. 真实三维弧长：`edge.GetCurve().GetLength3(...)` 或 16 点弦长积分，米 → 毫米（×1000）；
4. 持久化边引用：`GetPersistReference3` / `GetObjectByPersistReference3`（Base64）；
5. 实际 B-rep 坡口测量：`angle` / `depth` / `rootGap` / `thickness` / `confidence`；
6. 始终 `Visible = False`、`UserControl = False`，`finally` 中 `CloseDoc`；
7. **零伪数据**：任何错误返回明确 HTTP 4xx/5xx + `{ok:false, error}`。

---

## 五、数据流：从模型到定额

```
STEP/IGES 文件
   │ ① 用户选择文件
   ├─► 宿主 /api/read_cad_file?raw=1 ──► 原始字节
   │        │
   │        ▼
   │   ② occt-import-js (WASM) 解析 B-rep
   │        ▼
   │   buildModelFromOcct → 零件网格 + 拓扑边
   │        │
   │        ├─ extractFeatureEdges      提取特征边
   │        ├─ evaluateWeldability      二面角判据
   │        └─ detectCrossPartJoints    法平面正交截面坡口扫描
   │        ▼
   │   ③ 焊缝实体建模 createWeldPrismGeometry
   │        ▼
   │   ④ 定额核算 buildStats
   │        ▼
   └─► ⑤ 导出 exportDeliverableV33 → 宿主 /api/save_deliverable
```

SolidWorks 原生格式（`.sldprt` / `.sldasm`）走旁路：

```
.sldasm → ③ Python 桥接 /api/open_sw → 零件+边拓扑 JSON → ② 之后的流程
```

---

## 六、目录映射关系

WebView2 把应用根目录映射到 `https://weldview.local/`，因此**仓库根目录必须与安装目录一致**：

| URL | 文件 |
| :--- | :--- |
| `https://weldview.local/WeldView_3D_Studio_V3.3.html` | 宿主页面 |
| `https://weldview.local/assets/app/wv33.js` | 前端主逻辑 |
| `https://weldview.local/assets/vendor/three/three.module.min.js` | three.js |
| `https://weldview.local/assets/vendor/occt/occt-import-js.wasm` | OpenCASCADE |

宿主页面内的相对引用（`assets/app/wv33.js`、importmap `./assets/vendor/three/...`）依赖此布局。
**移动 `assets/` 会导致 404 与白屏。**
