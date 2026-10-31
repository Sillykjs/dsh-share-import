# AGENTS.md

本文件写给在本仓库工作的编码智能体。目标：改动不破坏「零构建、零依赖、静态导入」这三个前提。

## 这个仓库是什么

`dsh-share-import` 是 DSH（DeepSeek Harness 0.2.1-rc.2）的**树外插件**。输入一个公开的 `https://chat.deepseek.com/share/<id>` 链接，把该对话的问答写成一个真实 DSH 会话（v4 事件格式），落在用户选定的工作区里。

- 导入是**静态历史**：只写事件、不调 `session.prompt`，打开即已完成对话，不自动生成。
- 零 npm 依赖，**没有构建步骤**：`lib/client.js` 本身就是浏览器端 bundle。
- MIT。`lib/formats.js`、`lib/persistence.js` 移植自 [deepseek-web-import](https://www.npmjs.com/package/deepseek-web-import) v0.2.1（MIT, Copyright (c) 2026 wpc0323），文件头 attribution 必须保留。

## 硬约束

1. **不引入依赖、不引入构建**。不要 `npm install`，不要在 `package.json` 加 `dependencies`/`scripts.build`，不要引入 bundler。所有代码是可直接运行的 ESM（host 半）与浏览器 bundle（client 半）。
2. **client 半必须是即用 bundle**：整个文件包在 `window.__ModuleLoader__.load({ id: 'dsh-share-import', factory: (require) => { ... } })` 里（`lib/client.js:17`），内部只允许 `require('react')`（`lib/client.js:23`）。其它平台模块从宿主共享表取，写错 require 会在浏览器启动期抛错。
3. **host 半是 Cordis 插件**：`export const name`（`lib/index.js:45`）、`export const inject = ['webServer']`（`lib/index.js:48`）、`export function apply(ctx)`（`lib/index.js:170`）。除 `webServer` 外所有服务都用 `ctx.get()` 软读取；服务缺失时返回稳定错误码，不要抛到 500。
4. **导入语义不可漂移**：只写历史事件；不要加自动首轮、不要写 `plan/mode` 或 `sandbox/mode`（用户 m00277 明确撤销了自动规划/自动只读，M4 未做）。
5. **不要把移植文件重写成"更通用的抽象"**。`formats.js` / `persistence.js` 的价值是跟上上游契约（句柄时代与 append 时代两种后端、格式版本重试），只在明确为同步上游时改。
6. 用户可见文案走 `translate()`：新字符串同时加进 `DICT_ZH` 与 `DICT_EN`（`lib/client.js`），两边的键必须一一对应。

## 目录与关键位置

| 路径 | 职责 |
|---|---|
| `lib/index.js:45` / `:48` / `:170` | host 半：`name`、`inject`、`apply`；`ROUTE_PREFIX = '/__dsh-share-import/'`（`:51`）、`MAX_BODY_BYTES = 1 MiB`（`:57`） |
| `lib/index.js` actions | 三条 POST 路由：`workspaces` / `preview` / `import`；action 返回 `{ok:true,...}` 或 `{ok:false,code,message}` |
| `lib/share.js:41` `parseShareLink` | 接受裸 id、`/share/<id>` URL、`?share_id=`；非 https 或非 `chat.deepseek.com` 抛 `SHARE_LINK_INVALID` |
| `lib/share.js:85` `fetchShareContent` | 优先 `ctx.get('web').fetch()`（只 GET、只公网、`WebFetchBody` 只有 html/text 两种），失败降级 `globalThis.fetch` |
| `lib/share.js:128` `readSharePayload` | 从 `data.biz_data.messages` 取消息，容忍包装层 |
| `lib/events.js:59` `normalizeTitle` | 清控制字符、折叠空白、按 UTF-8 截 80 字节 |
| `lib/events.js:205` `completeConversation` | 裁到最后一条 assistant，丢弃悬空 user（保证不开 turn） |
| `lib/events.js:257` `buildStaticSessionEvents` | 生成 `session/title` → 每轮 `turn/start → step/start → user/message → assistant/message → step/end → turn/end` → `session/end-seed` |
| `lib/formats.js` / `lib/persistence.js` | 上游移植：格式版本探测、写句柄/旧式 append、写完读回校验 |
| `lib/client.js:25` / `:27` / `:525` | client 半：`NS`、`PANEL_ID = 'share-import'`、`apply`（挂 `settings.section` + `sidebar.panellist` + `main` 三个槽） |
| `test/smoke.mjs` | 纯逻辑自测：链接解析、真实拉取、切片、事件序列不变量 |
| `PLAN.md` | 设计记录（R3）。改语义先改这里，再改代码 |
| `docs/*.png` | 设置页/开关截图存档 |

## 数据流

```
用户贴链接
  → POST /__dsh-share-import/preview   parseShareLink → fetchShareContent → readSharePayload → importableMessages → completeConversation
  → POST /__dsh-share-import/import    writeVerifiedSession(persistence, {id, createdAt, cwd: ws.path}, buildStaticSessionEvents)
                                       → warmProjectionCache（coldSnapshot 预热标题，fail-soft）
                                       → workspace.attachSession(id)（重试 2 次）
                                       → recordImport（$DSH_HOME/share-import/index.json，去重）
  → 客户端 sessions.refresh() 刷新侧边栏
```

事件不变量（`test/smoke.mjs` 会断言）：`seq` 从 0 连续；`time` 单调不减；`step/start` 必须先于承载它的 surface 事件；`surfaceOp` 只能出现在 surface 类型上（`assistant/message` 不允许 `sourceEventSeqs`）；最后一条是 `session/end-seed`；不留 open turn。

## 常用命令

```bash
node --check lib/index.js && node --check lib/share.js && node --check lib/events.js \
  && node --check lib/formats.js && node --check lib/persistence.js && node --check lib/client.js

node test/smoke.mjs                                  # 真实访问 chat.deepseek.com，需联网
node test/smoke.mjs https://chat.deepseek.com/share/xxxx

dsh plugin --profile web add link:"$PWD"             # 安装/重链接（会自动写 dsh.profile.bundles）
```

装完**刷新页面**即可：`patchReload: live` 下 host 半热载，client bundle 由 `dsh-client-hmr` 每 500ms 轮询后重新发布。**不要重启 `dshweb.service`**——那是用户正在用的 3080 实例，重启会中断他的会话。

## 隔离实例验证配方

线上 3080 不能重启，所以 UI/E2E 验证一律在隔离实例里做：

```bash
rm -rf /tmp/dsh-verify-home && mkdir -p /tmp/dsh-verify-home/profiles
cp -a ~/.dsh/profiles/web /tmp/dsh-verify-home/profiles/web
cp ~/.dsh/.credentials.yaml ~/.dsh/.anonymous-user-id /tmp/dsh-verify-home/
rm -rf /tmp/dsh-verify-home/profiles/web/node_modules
ln -s ~/.dsh/profiles/web/node_modules /tmp/dsh-verify-home/profiles/web/node_modules

DSH_HOME=/tmp/dsh-verify-home nohup dsh --profile web --host 127.0.0.1 --port 3099 --no-open \
  > /tmp/dsh-verify-web.log 2>&1 &
sleep 9
grep -o 'http://127.0.0.1:3099/?token=[A-Za-z0-9_-]*' /tmp/dsh-verify-web.log | tail -1

fuser -k 3099/tcp          # 停实例；绝不用 pkill -f 'dsh --profile ...'（会杀掉自己的 shell）
rm -rf /tmp/dsh-verify-home
```

- 参数顺序：profile 在前、app 参数在后（`dsh --profile web --host ...`）；写成 `dsh --profile web web --port` 会报 `too many arguments`。
- 工作区数据：`$DSH_HOME/storages/workspace.json`，`tables.workspaces.<uuid>` 的记录里 `createdAt`/`updatedAt` **必须是 ISO-8601 字符串**，写成数字会让 workspace 域初始化失败、连带会话控制器一起 pending。
- 隔离实例首启会弹 Get started 模态；拷 `.credentials.yaml` 与 `.anonymous-user-id` 后消失。
- UI 自动化（Playwright/python，chromium 已装）：设置弹层只渲染**当前选中**的 section，必须先点自己那一行；链接输入是 `input.dssi-input`（`type=url`）；本插件面板有 `[data-testid="share-import-page"]`。

## 已知坑（踩过，别重复）

1. **热更新认绝对路径**：`clientModules` 把 client bundle 的绝对路径记进 `artifactBaseline`，`client-hmr` 每 500ms `stat` 它；项目目录被移动/删除后旧路径永远 ENOENT → 宿主一直下发旧 bundle，用户刷新也没用。判断：`GET /plugins/events`（SSE，公开）拿本包 rev，再抓 `/plugins/??dsh-share-import/client.js&rev=<rev>` 检查内容。临时解法：旧路径建符号链接。
2. **裸 `/plugins/<id>/client.js`（无 `?rev=`）一定 404**，不能用它判断插件是否装配。
3. **直写持久化后侧边栏显示 Untitled**：列表读 `session-projection-cache` 的 checkpoint；写完要调 `sessionProjectionCache.coldSnapshot(header, 0, events)` 预热（fail-soft）。
4. **`attachSession` 校验 realpath**：header 的 `cwd` 必须等于 `workspace.path`（realpath 后），否则抛 `cannot attach session`；写 header 时直接取 `ws.path`。
5. **无 delete API**：导入失败或去重都要能自愈；去重日志只是软状态，损坏时容错跳过即可。
6. **GUI 插件管理器后台安装会占 profile 锁**：它持 `~/.dsh/profiles/web/package.json.lock`，pnpm 子进程卡死时锁不释放；确认无进展后 `kill -TERM <pnpm pid> <dsh plugin pid>` 再重跑。不要手改 `package.json` 绕锁。
7. **事件合法性**：`step/start` 先于 surface 事件；`surfaceOp` 只加在 surface 类型；`assistant/message` 不带 `sourceEventSeqs`。
8. **`ctx.connection.rpc.handle()` 在 Web 进程不可用**（405）。路由用 `ctx.webServer.register({kind:'exact', path, handler})`，重复注册会抛错，所以 `apply()` 必须幂等（`claimRoute` + 代际表）。
9. **停实例用 `fuser -k <port>/tcp`**，`pkill -f` 会匹配到自己这条 shell。

## 收尾检查清单

- [ ] 六个 `lib/*.js` 全部 `node --check` 通过；`node test/smoke.mjs` 打印 `ALL CHECKS PASSED`。
- [ ] 改了 `lib/client.js` 或 UI 行为：在隔离实例里用 Playwright 跑一遍（入口可见、预览、导入、开关、刷新后仍存在），确认 console 无本插件相关错误。
- [ ] 改了语义/使用方式：同步 `README.md`「使用」节与 `PLAN.md`「12. 实现状态」。
- [ ] 线上核对：`/plugins/events` 里本包 rev 已变化，抓下的 bundle 含新字符串。
- [ ] 不留 3099 实例、不留 `/tmp/dsh-verify-home`。
- [ ] 不把 `~/.dsh` 的凭据、会话文件、profile 内容拷进仓库。

## 不要做

- 不要新增构建步骤、打包工具、运行时依赖。
- 不要把 host 半拆成多进程/子进程：分享接口是公开 GET，`ctx.web.fetch` 够用。
- 不要重启 `dshweb.service` 或改动用户其它插件配置（唯一允许的是 `dsh plugin add link:$PWD` 这类授权安装）。
- 不要用 `pkill -f dsh` 停服务。
- 不要为了"以后可能需要"加开关/配置项：当前只有「导航区显示入口」一个客户端开关，语义变化先和用户确认。
