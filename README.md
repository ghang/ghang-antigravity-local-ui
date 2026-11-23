# ghang-antigravity-local-ui

面向 [chuanban-antigravity-theme-patch](https://github.com/Anarcadia/chuanban-antigravity-theme-patch) 的**纯本地 `user/` 层进阶 UI 增强套件**（Local-First UI Enhancements for Antigravity）。

> 完全运行在主题补丁的 `user/custom.js` + `user/custom.css` 用户定制层，**零修改 `core/` 内核，不碰客户端 `.asar` 或二进制签名**。上游升级 `core/` 时自动保留，零冲突同步。

---

## 已内置模块

### 1. 常驻模型配额监控（`quota-bar`）

- **左下角全局池常驻卡片**（系统设置上方）
  - 实时展示 **Gemini 全局池** 的 `周限额` 与 `5h限额` 剩余百分比与三级预警色（`>25%` 正常、`11%–25%` 橙色预警、`<=10%` 红色告警）。
  - 侧边栏收窄至 `<110px` 时通过 `ResizeObserver` 自动折叠为居中紧凑双圆环。
  - 默认显示周限额重置倒计时；当 `5h` 剩余 `<= 25%` 且比周限额更紧时自动切换显示 `5h` 重置倒计时（也可在外观设置开启双倒计时并列展示）。
- **顶栏独立配额池胶囊**（`#ag-titlebar-quota-pill`）
  - 当前会话切换至独立配额池模型（如 Claude / GPT / Pro 下的 Argon）时，在面包屑标题右侧自动挂载独立配额胶囊；切回 Gemini 自动隐藏。
- **详情浮窗 & 外观设置页即时可配**（`系统设置 → 常规设置 → 外观`）
  - **配额样式**：`进度条` / `圆环`（同步切换左下角卡、顶栏胶囊与详情浮窗）
  - **配额点击**：`详情卡` / `刷新` / `设置`（后两者支持悬停预览详情）
  - **同时展示 5h 倒计时**：开关（独立 `localStorage` 持久化与多窗口实时同步）

---

## 环境要求

- macOS / Windows / Linux 下的 Antigravity 客户端
- 已安装 [chuanban-antigravity-theme-patch](https://github.com/Anarcadia/chuanban-antigravity-theme-patch)（推荐 `>= 6.0.0`）

---

## 安装与卸载

### 方式一：一键脚本安装（推荐，保留已有 `custom.js` / `custom.css` 内容）

```bash
node install.mjs install
```

脚本会在 `~/.gemini/antigravity/theme-patch/user/custom.js` 与 `custom.css` 中使用标记块安全写入（幂等更新，不会覆盖你原有的自定义代码）；守护进程将在 ~2.5 秒内自动热重载生效。

如补丁安装在其他目录，可指定 `--target-dir`：

```bash
node install.mjs install --target-dir /path/to/theme-patch/user
```

查看安装状态或卸载：

```bash
node install.mjs status
node install.mjs uninstall
```

### 方式二：手动安装

1. 将 [quota-bar.css](./quota-bar.css) 的内容追加到 `~/.gemini/antigravity/theme-patch/user/custom.css`；
2. 将 [quota-bar.js](./quota-bar.js) 的内容追加到 `~/.gemini/antigravity/theme-patch/user/custom.js`；
3. 确保 `~/.gemini/antigravity/theme-patch/user/config.json` 中 `enabled`、`modules.customCss`、`modules.customJs` 均为 `true`（默认即为 `true`）。

---

## 扩展钩子（可选）

套件暴露可选的 `window.__agQuotaBarHooks` 对象，供本地私有模块在不修改公共源码的情况下扩展详情浮窗：

- `onQuotaUpdated({ account, rawAccountStatus, groups, rawGroups, nowSec })`
- `decorateBucketRow(rowEl, { style, group, bucket, resetEl, metaEl, account, rawAccountStatus, isZh })`
- `renderTooltipFooter(footerEl, { actionsEl, closeTooltip, isZh, hasTokenTabBtn })`
- `onTooltipClose()`

---

## 许可

MIT
