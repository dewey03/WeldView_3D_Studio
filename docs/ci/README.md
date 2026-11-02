# 持续集成（可选）

## 为什么是模板而不是直接启用

GitHub 规定：**推送 `.github/workflows/` 下的文件，Token 必须具备 `workflow` 权限**。
缺少该权限时，GitHub 不会返回明确的权限错误，而是返回 **404 Not Found**（刻意混淆），
极易被误判为「路径错误」或「仓库不存在」。

本仓库的 Token 仅有 `repo` 权限，因此 CI 配置以模板形式存放。

## 启用步骤

1. 生成具备 `workflow` 权限的 Token：
   https://github.com/settings/tokens → 勾选 `repo` + **`workflow`**

2. 复制模板：

   ```bash
   mkdir -p .github/workflows
   cp docs/ci/build.yml.example .github/workflows/build.yml
   ```

3. 提交并推送：

   ```bash
   git add .github/workflows/build.yml
   git commit -m "ci: 启用构建流水线"
   git push
   ```

## 流水线内容

| Job | 运行环境 | 作用 |
| :--- | :--- | :--- |
| `desktop` | windows-latest | 还原、编译、单文件发布 `.exe`，上传构建产物 |
| `frontend-check` | ubuntu-latest | 校验宿主页面引用的 `assets/**` 全部存在、importmap 目标存在 |

`frontend-check` 用于防止「移动 `assets/` 导致页面白屏」这类回归——
该约束在 `docs/ARCHITECTURE.md` 与 `README.md` 中均有说明。
