# dsh-share-import

把一个 **DeepSeek 网页版对话分享链接**（`https://chat.deepseek.com/share/…`）导入成 DSH 里的一个会话。

- **零凭据**：走公开分享接口 `https://chat.deepseek.com/api/v0/share/content?share_id=…`，不需要登录、不需要 token、不需要浏览器。
- **可选工作区**：导入前从当前实例的工作区列表里挑一个，会话落在该工作区的路径下。
- **静止导入**：只写历史事件，不发消息、不开 turn。打开后就是一段已完成对话；你之后接着提问时，这段历史自然成为上下文。

## 安装

```bash
# 本地开发（在仓库目录里执行）
dsh plugin --profile web add link:"$PWD"

# 发布到 npm 之后
dsh plugin --profile web add dsh-share-import
```

`dsh plugin add` 会自动把 `dsh-share-import` 写进 profile 的 `dsh.profile.bundles`；`cordis.patch.yml` 里的 `insert` 负责把插件挂上。装完**刷新页面**即可（host 半在 `patchReload: live` 下自动热载，client bundle 随页面加载更新）；重启 `dsh web` 不是必需的。

## 使用

1. 侧边栏「全局面板」导航区点 **分享导入**（第三个入口，下载箭头图标），主区域打开导入面板；也可从设置（账号菜单 → Settings / 设置 → **分享导入**，下载箭头图标）进入同一个表单。
2. 设置页顶部的开关 **在导航区显示入口** 控制侧边栏是否出现该入口（默认开）。开关状态存在当前浏览器的 localStorage（键 `dsh-share-import:show-nav`）；关掉后设置页入口仍在，可随时改回来。
3. 粘贴分享链接，选工作区。
4. **预览** 可先确认标题、轮数、首末问题；确认后 **导入会话**。
5. 成功后面板显示新会话 id；侧边栏会自动刷新，标题即为该对话的首个问题。面板右上角 **回到对话** 退回当前会话。

同一个分享第二次导入默认会被拦下（`ALREADY_IMPORTED`），面板会把按钮换成「作为新会话再导一次」，需要重复导入时点它即可。

## 语义与边界

| 项 | 行为 |
|---|---|
| 导入内容 | 只要问答正文（用户提问 + 助手回答）。思考过程、网页检索结果、打开过的页面、引用标记都不进会话。 |
| 末尾悬空提问 | 若最后一条是「问而无答」，该提问会被丢弃，保证会话里没有未闭合的 turn。 |
| 生成 | 不调用 `session.prompt`，所以导入完不会自动跑、也不会显示「生成中」。 |
| 沙箱/规划模式 | 不自动设置。会话沿用你当前的默认访问模式；需要只读/计划模式请自行切换。 |
| 标题 | 取首个用户提问，超过 80 字节按 UTF-8 边界截断。 |
| 去重记录 | `$DSH_HOME/share-import/index.json`，`shareId → {sessionId,title,importedAt}`。 |
| 会话文件 | `$DSH_HOME/sessions/<工作区编码>/<sessionId>/session.v4.jsonl.zstd`，由 `sessionPersistence` 写入并读回校验。 |

## 错误码

`SHARE_LINK_INVALID` · `SHARE_NOT_FOUND` · `SHARE_FETCH_FAILED` · `SHARE_MALFORMED` · `SHARE_EMPTY` ·
`ALREADY_IMPORTED` · `WORKSPACE_REQUIRED` · `WORKSPACE_UNKNOWN` · `WORKSPACES_UNAVAILABLE` ·
`PERSISTENCE_UNAVAILABLE` · `WRITE_FAILED` · `VERIFY_FAILED` · `INTERNAL`

## 结构

```
lib/index.js        host 半：三条 POST 路由（workspaces/preview/import）、去重、写会话、挂工作区、预热投影缓存
lib/share.js        分享链接解析、取内容（ctx.web.fetch）、载荷校验
lib/events.js       消息 → v4 会话事件（静态导入变体）
lib/formats.js      会话格式版本探测与 header 构造   ← 移植自 deepseek-web-import
lib/persistence.js  写会话 + 读回校验的兼容封装       ← 移植自 deepseek-web-import
lib/client.js       client bundle：侧边栏导航入口（sidebar.panellist）+ 主面板页（main）+ 设置分区（图标为宿主固定映射，插件内做了行级重绘）
test/smoke.mjs      纯逻辑 + 真实分享的冒烟自测
```

## 开发与自测

```bash
node --check lib/*.js
node test/smoke.mjs          # 解析/事件序列断言 + 真实拉取一次分享
```

隔离实例（不影响正在运行的 web 进程）：

```bash
DSH_HOME=/tmp/dsh-si-home dsh plugin --profile web add link:$PWD
DSH_HOME=/tmp/dsh-si-home dsh --profile web --host 127.0.0.1 --port 3099 --no-open
```

## 许可与归属

MIT。`lib/formats.js`、`lib/persistence.js` 移植自 [deepseek-web-import](https://www.npmjs.com/package/deepseek-web-import) v0.2.1（Copyright (c) 2026 wpc0323, MIT），文件头保留归属说明；其余为本插件自写。
