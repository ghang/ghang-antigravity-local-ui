# ghang-antigravity-local-ui

面向 [chuanban-antigravity-theme-patch](https://github.com/Anarcadia/chuanban-antigravity-theme-patch) 的**纯本地 `user/` 层进阶 UI 增强套件**（Local-First UI Enhancements for Antigravity）。

> 完全运行在主题补丁的 `user/custom.js` + `user/custom.css` 用户定制层，**零修改 `core/` 内核，不碰客户端 `.asar` 或二进制签名**。上游升级 `core/` 时自动保留，零冲突同步。

---

## 仓库定位与准入准则（What We Merge & What We Reject）

为了避免项目变成杂乱无章的“大杂烩”，本仓库严格执行以下**四进四不进**边界准则：

### ✅ 什么会进入本仓库（准入四原则）
1. **严守 `user/` 契约（Zero-Core-Invasion）**：所有功能必须只靠 `user/custom.js` + `user/custom.css`（及浏览器原生 `localStorage`）即可独立闭环运行，**绝不要求用户修改上游 `core/daemon.mjs` 或 `core/runtime.js`**，保证上游发版随时无痛升级。
2. **纯本地只读可观测性（Local-First & Read-Only）**：专注于提升高频使用时的**态势感知与本地排版体验**（如常驻配额监控、独立池胶囊、倒计时预警、字体排版微调等），只读消费宿主前端已有状态。
3. **性能与生命周期零逃逸（Zero-Leak Discipline）**：默认严控甚至禁止全局 `MutationObserver`，优先采用 `ResizeObserver`、事件委托与可见态节流轮询；所有定时器、监听器和 DOM 节点必须 100% 注册到 `ctx.onCleanup`，支持 2.5s 热重载与 `uninstall` 瞬时无痕卸载。
4. **全预设原生融合（Theme-Native Craft）**：任何新增 UI 组件必须完整适配上游全部 5 套预设（`morandi` / `absolutely` / `native` 浅深 / `onyx` / `claude-warm`）与多语言切换（中/英/日），拒绝画风割裂的硬编码贴片。

### ❌ 什么坚决不进本仓库（放弃四红线）
1. **不碰自动化操控与请求篡改**：坚决不合入自动发消息、自动点确认、改写 Prompt、拦截/代理网络请求、绕过模型限制或读取导出 OAuth 凭证的功能，杜绝账号风控风险。
2. **不复刻上游 `core/` 已内建的能力**：凡是上游主线已原生提供且体验完备的功能（如基础皮肤预设、核心汉化词典、v6.0+ 原生「Token 统计」Tab），本仓库一律直接复用，不做平行分叉。
3. **不强绑重度后台进程给普通用户**：需要常驻魔改后台守护进程或依赖特定本机私有账本路径的实验性功能，仅通过 `window.__agQuotaBarHooks` 等轻量扩展钩子在个人本地层解耦挂载，不塞进公共默认安装包。
4. **不收无明确高频价值的视觉堆砌**：不合入常驻动效轰炸、遮挡对话阅读区的浮窗、或原生界面一键可达且无常驻价值的冗余按钮。

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
