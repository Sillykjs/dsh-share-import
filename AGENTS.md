# AGENTS.md

本文件写给在本仓库工作的编码智能体。目标：改动不破坏「零构建、零依赖、静态导入」这三个前提。

## 这个仓库是什么

`dsh-share-import` 是 DSH（DeepSeek Harness 0.2.1-rc.2）的**树外插件**。输入一个公开的分享链接（DeepSeek `https://chat.deepseek.com/share/<id>` 或豆包 `https://[www.]doubao.com/thread/<id>`），把该对话的问答写成一个真实 DSH 会话（v4 事件格式），落在用户选定的工作区里。

- 导入是**静态历史**：只写事件、不调 `session.prompt`，打开即已完成对话，不自动生成。
- 零 npm 依赖，**没有构建步骤**：`lib/client.js` 本身就是浏览器端 bundle。
- MIT。`lib/formats.js`、`lib/persistence.js` 移植自 [deepseek-web-import](https://www.npmjs.com/package/deepseek-web-import) v0.2.1（MIT, Copyright (c) 2026 wpc0323），文件头 attribution 必须保留。

## 硬约束

1. **不引入依赖、不引入构建**。不要 `npm install`，不要在 `package.json` 加 `dependencies`/`scripts.build`，不要引入 bundler。所有代码是可直接运行的 ESM（host 半）与浏览器 bundle（client 半）。
2. **client 半必须是即用 bundle**：整个文件包在 `window.__ModuleLoader__.load({ id: 'dsh-share-import', factory: (require) => { ... } })` 里（`lib/client.js:17`），内部只允许 `require('react')`（`lib/client.js:23`）。其它平台模块从宿主共享表取，写错 require 会在浏览器启动期抛错。
3. **host 半是 Cordis 插件**：`export const name`（`lib/index.js:46`）、`export const inject = ['webServer']`（`lib/index.js:49`）、`export function apply(ctx)`（`lib/index.js:184`）。除 `webServer` 外所有服务都用 `ctx.get()` 软读取；服务缺失时返回稳定错误码，不要抛到 500。
4. **导入语义不可漂移**：只写历史事件；不要加自动首轮、不要写 `plan/mode` 或 `sandbox/mode`（用户 m00277 明确撤销了自动规划/自动只读，M4 未做）。
5. **不要把移植文件重写成"更通用的抽象"**。`formats.js` / `persistence.js` 的价值是跟上上游契约（句柄时代与 append 时代两种后端、格式版本重试），只在明确为同步上游时改。
6. **不要在仓库里写真实分享链接、个人绝对路径或账号信息**：测试用合成 id（如 `abc123def456`），联网断言通过 `DSH_SHARE_LINK` 传入。
7. 用户可见文案走 `translate()`：新字符串同时加进 `DICT_ZH` 与 `DICT_EN`（`lib/client.js`），两边的键必须一一对应。

## 目录与关键位置

| 路径 | 职责 |
|---|---|
| `lib/index.js:46` / `:49` / `:184` | host 半：`name`、`inject`、`apply`；`ROUTE_PREFIX = '/__dsh-share-import/'`（`:52`）、`MAX_BODY_BYTES = 1 MiB`（`:58`） |
| `lib/index.js` actions | 三条 POST 路由：`workspaces` / `preview` / `import`；action 返回 `{ok:true,...}` 或 `{ok:false,code,message}` |
| `lib/index.js:198` `readShare` | 唯一读入口：`parseShareLink` → `readShareDocument` → `importableMessages` → `completeConversation`；豆包优先用 `share_name` 作标题；去重键 `source:id`（`:124` `journalEntry` 兼容旧的裸 DeepSeek id） |
| `lib/share.js:87` `parseShareLink` | 返回 `{source:'deepseek'|'doubao', id}`；接受裸 id（视为 DeepSeek）、`/share/<id>`、`?share_id=`、`/thread/<id>`（豆包）；非 https 或陌生域名抛 `SHARE_LINK_INVALID` |
| `lib/share.js:151` `fetchShareText` | 唯一 GET 出网点：优先 `ctx.get('web').fetch()`（只 GET、只公网、`WebFetchBody` 只有 html/text 两种）；seam 缺位、抛错，或返回文本不满足 `options.isUsable`（`:47` `isJsonText` / `:64` `isDoubaoMarkup`）时，降级 `globalThis.fetch` 取原始正文；两者都不可用按「直连错误 → seam 错误 → 空响应」顺序报错 |
| `lib/share.js:224` `fetchShareJson` | 唯一 POST 出网点（豆包 JSON 快照）：seam 只支持 GET，所以这里必须用原生 `fetch`；`redirect:'error'`、8 MiB 上限，非 JSON 报 `SHARE_MALFORMED` |
| `lib/share.js:289` / `:309` `fetchShareContent` / `fetchDoubaoHtml` | DeepSeek 走 JSON 接口、豆包抓 SSR HTML，各自只是 `fetchShareText` 的薄包装（带 `isUsable` 形状校验） |
| `lib/share.js:257` `readDoubaoTarget` | 豆包读入口：先 `doubaoSnapshotRequest` → `fetchShareJson` → `readDoubaoSnapshot`（消息非空即返回），失败再退回 SSR 页 `readDoubaoPage`；页面懒加载且 JSON 也失败才报 `SHARE_LAZY` |
| `lib/share.js:325` `readShareDocument` | 按 `source` 分发到 `readSharePayload`（DeepSeek）或 `readDoubaoTarget`（豆包），统一返回 `{source, shareId, title, author, messages}` |
| `lib/share.js:354` `readSharePayload` | 从 `data.biz_data.messages` 取消息，容忍包装层 |
| `lib/doubao.js:282` / `:315` `doubaoSnapshotRequest` / `readDoubaoSnapshot` | 豆包 JSON 快照路由：`x` 开头走 `POST /im/message/share/get`（含三个 `need_*` 标志），普通 ID 走 `POST /alice/message/share/get`，`c`/`d` 开头返回 null 交给页面读取；快照读消息块兼容 `content_block[]`、`content` 字符串包块、对象形态 `{text}`，按 `index_in_conv`/`index` 排序，秒级 `create_time` 不再除 1000；API 错误码报 `SHARE_NOT_FOUND` |
| `lib/doubao.js:352` / `:390` `readDoubaoHtml` / `readDoubaoPage` | 豆包分享页：`data-fn-args`（双引号 + 单引号两种形态）→ 递归解 JSON 字符串 → `share_info` + `message_snapshot`；10000 文本块进会话，2074/10050 丢弃（纯媒体消息写一行占位）；`readDoubaoHtml` 保持「lazy → 抛 `SHARE_LAZY`」旧语义，`readDoubaoPage` 返回 `{lazy,shareId,title,author,messages}` 供分发层选择 |
| `lib/doubao.js:246` `messageBlocks` | 消息块归一：块数组 > `content`（数组 / JSON 字符串 / 对象）；无 `block_type` 的对象按文本块包裹（JSON 路由的 `{text}` 形态） |
| `lib/errors.js` | 跨两个来源读者共用的 `ShareError`（`lib/share.js` 继续 re-export，导入方不必改） |
| `lib/events.js:59` `normalizeTitle` | 清控制字符、折叠空白、按 UTF-8 截 80 字节 |
| `lib/events.js:205` `completeConversation` | 裁到最后一条 assistant，丢弃悬空 user（保证不开 turn） |
| `lib/events.js:257` `buildStaticSessionEvents` | 生成 `session/title` → 每轮 `turn/start → step/start → user/message → assistant/message → step/end → turn/end` → `session/end-seed` |
| `lib/formats.js` / `lib/persistence.js` | 上游移植：格式版本探测、写句柄/旧式 append、写完读回校验 |
| `lib/client.js:25` / `:27` / `:528` | client 半：`NS`、`PANEL_ID = 'share-import'`、`apply`（挂 `settings.section` + `sidebar.panellist` + `main` 三个槽） |
| `test/smoke.mjs` | 纯逻辑自测（默认不联网）；设 `DSH_SHARE_LINK` 或传参才做真实拉取 |
| `PLAN.md` | 设计记录（R3）。改语义先改这里，再改代码 |
| `docs/*.png` | 设置页/开关截图存档 |

## 数据流

```
用户贴链接
  → POST /__dsh-share-import/preview   parseShareLink → readShareDocument（DeepSeek JSON ／ 豆包 JSON 快照优先、SSR HTML 兜底）→ importableMessages → completeConversation
  → POST /__dsh-share-import/import    writeVerifiedSession(persistence, {id, createdAt, cwd: ws.path}, buildStaticSessionEvents)
                                       → warmProjectionCache（coldSnapshot 预热标题，fail-soft）
                                       → workspace.attachSession(id)（重试 2 次）
                                       → recordImport（$DSH_HOME/share-import/index.json，键 `source:id`，去重）
  → 客户端 sessions.refresh() 刷新侧边栏
```

事件不变量（`test/smoke.mjs` 会断言）：`seq` 从 0 连续；`time` 单调不减；`step/start` 必须先于承载它的 surface 事件；`surfaceOp` 只能出现在 surface 类型上（`assistant/message` 不允许 `sourceEventSeqs`）；最后一条是 `session/end-seed`；不留 open turn。

## 常用命令

```bash
node --check lib/index.js && node --check lib/share.js && node --check lib/doubao.js \
  && node --check lib/errors.js && node --check lib/events.js \
  && node --check lib/formats.js && node --check lib/persistence.js && node --check lib/client.js

node test/smoke.mjs                                  # 纯逻辑，不联网（含豆包 HTML fixture）
DSH_SHARE_LINK='https://chat.deepseek.com/share/…' node test/smoke.mjs   # 联网部分
DSH_SHARE_LINK='https://www.doubao.com/thread/…'   node test/smoke.mjs   # 豆包联网部分

dsh plugin --profile web add link:"$PWD"             # 安装/重链接（会自动写 dsh.profile.bundles）
```

装完**刷新页面**即可让页面重新拉 client bundle；但 0.2.1-rc.2 实测**不会在进程内释放旧的包代码**：改过 `lib/*.js`（host 半）或 `lib/client.js`（bundle）后，3080 仍按旧版运行（`/plugins/events` 的 rev 也不变，preview 还能看到旧文案），`client-hmr` 的轮询同样不触发。要生效只能重启承载进程。**不要自己重启 `dshweb.service`**——那是用户正在用的 3080 实例，重启会中断他的会话，先问用户（见收尾清单）。

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
10. **`ctx.web.fetch` 的 seam 只支持 GET**：`WebFetchRequest` 只有 `{url}`（`dsh-web/lib/types/types.d.ts:59-61`），豆包 JSON 快照是 POST，必须走原生 `fetch`；URL 只由已校验的分享 id 拼出，仍然 `redirect:'error'`。
11. **`fetchProvider` 可能不给你原始正文**：本机 profile（`~/.dsh/profiles/web/cordis.patch.yml:63`）配的是 `deepseek-fetch-api`，`ctx.web.fetch` 返回的是**渲染成 Markdown 的可读文本**（豆包分享页实测 1198 字节纯文本），不是 SSR HTML → 抓不到 `data-fn-args` 里的 `share_info`/`message_snapshot`，只剩 `SHARE_NOT_FOUND`。所以结构化读取（豆包 HTML、DeepSeek JSON）必须带 `isUsable` 形状校验并允许直连兜底；判断 seam 是否好用要看正文形态，不能只看状态码。

## 收尾检查清单

- [ ] 八个 `lib/*.js` 全部 `node --check` 通过；`node test/smoke.mjs` 打印 `ALL CHECKS PASSED`（联网断言可选，需自备链接）。
- [ ] 改了 `lib/client.js` 或 UI 行为：在隔离实例里用 Playwright 跑一遍（入口可见、预览、导入、开关、刷新后仍存在），确认 console 无本插件相关错误。
- [ ] 改了语义/使用方式：同步 `README.md`「使用」节与 `PLAN.md`「12. 实现状态」。
- [ ] 线上核对：`/plugins/events` 里本包 rev 已变化，抓下的 bundle 含新字符串。**改了 host 半或 client bundle 后 3080 必须重启 `dshweb.service` 才生效**（DSH 无进程内重载包代码的入口，`dsh plugin` 只转发 pnpm）；重启会中断用户会话，先问用户。重启前 3080 仍跑旧版，别据此判断代码没生效。
- [ ] 不留 3099 实例、不留 `/tmp/dsh-verify-home`。
- [ ] 不把 `~/.dsh` 的凭据、会话文件、profile 内容拷进仓库。

## 不要做

- 不要新增构建步骤、打包工具、运行时依赖。
- 不要把 host 半拆成多进程/子进程：分享接口都是公开的（GET 页面/JSON、豆包快照的 POST），原生 `fetch` 够用。
- 不要重启 `dshweb.service` 或改动用户其它插件配置（唯一允许的是 `dsh plugin add link:$PWD` 这类授权安装）。
- 不要用 `pkill -f dsh` 停服务。
- 不要为了"以后可能需要"加开关/配置项：当前只有「导航区显示入口」一个客户端开关，语义变化先和用户确认。
