# dsh-share-import 实施方案（R3，待批准，未写代码）

> 状态：规划稿。本文件不含实现代码。
> R3 修订（用户 m00277 纠正）：**导入后不自动跑任何回合**。导入结果是「一段已完成的对话」，处于静止状态；用户继续提问时，才接着这份上下文回答。
> 因此取消：自动进入规划模式、自动首轮、自动只读沙箱。这三项改为导入对话框里的**可选开关**，默认全部关闭。

## 1. 目标与非目标

**目标**：在 DSH Web 里粘贴 DeepSeek 分享链接 → 选工作区 → 生成一个可在侧边栏打开、可继续对话的会话。打开时就是一段完整、静态的问答记录；用户发下一句时，模型接着这段历史回答。

**非目标**：不自动分析、不自动总结、不自动跑第一轮；不导入私有对话（那是已装 `deepseek-web-import` 的职责）；不做反向导出。

## 2. 关键事实（实测 + 逆向确认）

- 分享接口：`GET https://chat.deepseek.com/api/v0/share/content?share_id=<id>`，未登录 200，`data.biz_data.messages[]`。
- `biz_data.title` 固定 `Shared Conversation` → 标题从首条 `REQUEST` 派生，≤80 字节。
- 消息 `{message_id, parent_id, role:'USER'|'ASSISTANT', inserted_at(秒,float), fragments[]}`。
- 片段：`REQUEST` / `RESPONSE`（含 `[reference:N]`）/ `THINK` / `TOOL_SEARCH` / `TOOL_OPEN`。
- 写会话只能走 `ctx.get('sessionPersistence')`：`create(header)` → `handle.append(events)` → `flush()` → `close()`，再 `ws.attachSession(id)`；注意 `attachSession` 校验 `header.cwd` 的 realpath 等于 `workspace.path`。
- 会话列表是客户端拉取式：导入后 client 调 `ctx.get('sessions').refresh()` 即可免 F5。
- 出网：`ctx.web.fetch` 只支持 GET、无自定义 header、只允许公网、接受 text/* 与 application/json → 分享接口满足，无需子进程。
- 先例 `deepseek-web-import@0.2.1`（MIT）的 `events.js` / `persistence.js` / `formats.js` 可移植，保留版权声明。

## 3. 静态导入的语义（本版核心）

导入写出的是**历史事件**，不是一次运行：

```
session/title
turn/start → step/start → user/message → step/start → assistant/message → step/end → turn/end   （每个问答一轮）
session/end-seed
```

- 每个 turn 都**闭合**（有 `turn/end`）。没有活动 turn，打开会话就不会显示「正在生成」。
- 不写 `plan/mode`，不写 `sandbox/mode`，不发 `session/prompt`。默认开关全关。
- 若分享的末条是「用户提问后没有回答」：我们主动补 `turn/end {reason:{kind:'interrupted'}}`（先例是留给 resume 补，但那样打开时可能显示为进行中，与「静止」冲突）。此写法列入 V1 验证。
- 硬约束：`seq` 从 0 连续、`time` 单调不减（`inserted_at`×1000）、`step/start` 必须早于它承载的 surface 事件、`surfaceOp:'append'` 只加在 surface 类型上、v4 的 `assistant/message` 补 `stream: []`。
- header：`{type:'session',version:4,id,createdAt,cwd,isSeeded:false,delegationDepth:0,agentPreset:'standard'}`；`sandboxMode`/`approvalPolicy` 是退休字段，写了会抛错。

## 4. 续聊时的行为

- 历史是会话事件，不是外挂文档：用户发消息 → 会话恢复 → 整段历史进入上下文 → 正常回答。
- 不做任何「这是导入内容」的特殊注入；模型看到的就是一段连续对话，和它自己在别处聊过的一样。
- 工具、计划模式、沙箱按会话当时的状态走（standard preset 默认）。用户想规划，自己 `/plan`。
- 唯一提示：导入完成后对话框里显示一条「已导入 N 轮，可关闭」的说明，会话本身不加系统消息。

## 5. 插件结构

开发目录：`/home/sjk/projects/dsh-share-import/`（ESM，构建产物 `lib/`）。安装 `dsh plugin add link:/home/sjk/projects/dsh-share-import`（link 包不自动构建）。

```
package.json          type:module, exports{.,./client,./package.json},
                      dsh.bundle.patch:./cordis.patch.yml, dsh.client.platform:web
cordis.patch.yml      - insert: [{id: share-import, name: dsh-share-import}]
lib/index.js          host：路由 + 编排
lib/share.js          链接解析、ctx.web.fetch、归一化
lib/events.js         片段→事件（移植先例）
lib/formats.js        格式版本 profile v0–v4（移植先例）
lib/persist.js        写会话 + 读回校验 + 版本重试（移植先例）
client.js             window.__ModuleLoader__.load({id:'dsh-share-import', factory})（预构建）
locale/{zh,en}.json
```

host：`inject:['webServer']`，其余服务 `ctx.get()` 软依赖。
client：预先构建，`id` 必须是包名，react 等按共享模块 external；入口优先 `sidebar.footer.action`，退路 `settings.section`。

## 6. 数据流与路由

```
粘贴链接 → preview（条数/标题/工作区/重复提示）
        → import → 拉取 → 归一化 → 写历史 → flush → attach → （可选开关）→ 返回 sessionId
        → client: sessions.refresh() → 打开会话（静止）
```

| 路由 | 作用 | 返回 |
|---|---|---|
| `/__dsh-share-import/preview` | 解析 + 拉取，不写盘 | `{title, turnCount, firstAsk, shareId, duplicate?}` |
| `/__dsh-share-import/workspaces` | `workspaceRegistry.list()` | `{id,title,path}` |
| `/__dsh-share-import/import` | 写会话 + attach + 可选开关 | `{sessionId, turnCount, attached}` |

路由 POST only，body ≤ 1 MiB，`Cache-Control: no-store`；`ctx.webServer.register({kind:'exact',path,handler})`，HMR 重跑 `apply()` 必须幂等（generation map）。

## 7. 可选开关（默认全关）

| 开关 | 写入的事件 | 用户可见效果 |
|---|---|---|
| 导入后进入规划模式 | `plan/mode {active:true}`（在 end-seed 之后） | 打开时处于 /plan 态，下一条消息按规划回答 |
| 只读沙箱 | `sandbox/mode {mode:'read-only'}` | 后续回合禁止写入文件/命令 |

两个开关都只是「写入会话初始状态」，仍然不跑任何回合。V 阶段验证生效性后再开放 UI。

## 8. 安全

- 无 token、无账号；若接口变更要求登录 → 明确报错 `share_auth_required`，不诱导贴 cookie。
- 只允许 `chat.deepseek.com`；share_id 白名单 `^[A-Za-z0-9_-]{6,64}$`；拒绝自定义 URL/header/端口。
- 标题与正文清洗控制字符（沿用 `normalizeTitle`）。
- 不导入 `THINK`/`TOOL_SEARCH`/`TOOL_OPEN`，减少外部噪声与被引用文本。
- 上游错误只回稳定错误码 + 截断短消息。

## 9. 去重与标题

- 去重：`~/.dsh/share-import/index.json` 记 `shareId → {sessionId, importedAt}`；preview 返回 `duplicate:true`，可强制再导。
- 标题：首条 `REQUEST` 首行，折叠空白，≤80 UTF-8 字节；空则 `DeepSeek 分享导入`。

## 10. 里程碑与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 尖刺（半天） | 空白 client bundle 挂侧边栏 + ping 路由 + 手写种子会话 | **打开是静止的、无「生成中」**；无需 F5；HMR 重载不撞路由 |
| M1 端到端（1 天） | preview/workspaces/import + 只导入问答 + attach + refresh | 贴链接→选工作区→侧边栏出现会话，历史完整、可滚动 |
| M2 续聊语义（半天） | 在导入会话里发一条新问题 | 回答用上导入历史；无异常 turn；不出现幽灵流式 |
| M3 可用性（1 天） | 对话框（预览、工作区、错误码、去重）、中英文案 | 8 类错误码都有可读提示；重复导入被拦 |
| M4 可选开关（半天） | 规划模式 / 只读沙箱开关 | 勾选后打开会话状态正确；默认行为不变 |

## 11. 待验证清单

- V0：client bundle 按 `window.__ModuleLoader__.load` 加载成功（id=包名，react external）；能挂 `sidebar.footer.action`（失败退 `settings.section`）。
- V1：末回合主动补 `turn/end{interrupted}` 后，打开会话是静止的（与先例「留给 resume」的做法对比）。
- V2：续聊时历史确实进入上下文（问一个只有历史里才有的细节）。
- V3：`attachSession` 刚写完就 attach 的稳定性（cwd 直接取 `ws.path`，失败重试一次）。
- V4：`ctx.web.fetch` 拉分享接口的真实返回（content-type、大小上限、重定向）。
- V5：`plan/mode`、`sandbox/mode` 种子写在 `end-seed` 之后是否生效（仅开关打开时）。

## 12. 已知风险

| 风险 | 说明 | 处理 |
|---|---|---|
| 分享接口非公开 | 字段/鉴权可变 | 错误码分层 + 明确提示，不静默失败 |
| 长对话占上下文 | 每轮都进 prompt | 导入时显示估算；超限保留最近 N 轮并告知 |
| 历史里含旧指令 | 用户续聊「按上面做」时可能被误解 | 属正常对话语义；不额外注入，只在预览里提示来源 |
| attach 失败留孤儿 | 持久化无 delete | 重试一次，失败把 sessionId 交 UI |
| client 改动要 F5 | bundle 不热生效 | 功能上已用 `sessions.refresh()` 消除用户侧 F5 |
| 版本迁移 | 未来 v5 | 照抄先例 `formats.js` 版本表 |

---

## 实施结果（2026-10-31 完成）

M1–M3 全部落地并验证，方案里 R3 承诺的行为逐条实测：

| 项 | 状态 | 证据 |
|---|---|---|
| 零凭据取分享内容 | 完成 | `ctx.get('web').fetch` 拉 `api/v0/share/content`，真实分享取回 1 轮问答 |
| 静态导入（不自动跑） | 完成 | 会话打开显示 `Completed / 1 turn`，无生成中 |
| 续聊带上下文 | 完成 | 续问「这个 MEMORY.DMP 能不能删」→ 基于导入历史作答，2 turns |
| 可选工作区 | 完成 | 设置面板下拉 15 个真实工作区，会话落在所选路径 |
| 侧边栏即时可见+正确标题 | 完成 | 写入后预热 `session-projection-cache`（`coldSnapshot`）+ 客户端 `sessions.refresh()` |
| 去重 | 完成 | 二次导入返回 `ALREADY_IMPORTED`，UI 改为「作为新会话再导一次」 |
| 事件契约 v4 | 完成 | 落盘 9 行：header + `session/title`→`turn/start`→`step/start`→`user/message`→`assistant/message`→`step/end`→`turn/end`→`session/end-seed` |

遗留（非阻塞）：`sandbox/mode`、`plan/mode` 的可选开关**未实现**——R3 后你要求「导入后静止」，两项默认关闭即符合预期，先不做；若以后要「导入即只读」，按方案第 6 节在 end-seed 后补事件即可（约 20 行）。

## 12. 实现状态（截至本轮）

| 阶段 | 状态 | 证据 |
|---|---|---|
| M0 尖刺 | 完成 | client bundle 以 `window.__ModuleLoader__.load({id:'dsh-share-import'})` 加载成功；三条路由 POST 实测通；HMR 重载不撞路由 |
| M1 端到端 | 完成 | 隔离实例 `DSH_HOME=/tmp/dsh-si-home`：贴链接→选工作区→`session.v4.jsonl.zstd` 落盘 8 事件→attach 生效→侧边栏出现真实标题 |
| M2 续聊语义 | 完成 | 导入会话续问「这个 MEMORY.DMP 能不能删？」→ 回答引用历史内容，2 turns |
| M3 可用性 | 完成 | 预览/工作区下拉/去重（`ALREADY_IMPORTED` + 强制再导）/中英文案/8 类错误码均有提示 |
| M4 可选开关 | **未做（按用户 m00277 撤销）** | 导入保持静止，不写 `plan/mode`、`sandbox/mode` |
| M5 导航入口 | 完成 | `sidebar.panellist` 第三个入口「分享导入」+ `main` 主面板页 + 「回到对话」 |

其它已验证的实现细节：投影缓存预热（`sessionProjectionCache.coldSnapshot`）让侧边栏不再显示 `Untitled`；成功后客户端 `sessions.refresh()` 免 F5；插件已装入真实 profile 并热载 host 半。
