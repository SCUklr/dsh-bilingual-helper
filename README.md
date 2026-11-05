# 英文翻译学习助手 · Bilingual Learning Helper

在每个**提问**和每个**回答**下方各加一个 `EN` 按钮，点一下就在原消息下面展开这条消息的**完整英文翻译**；
再点一次收起。原文不动，译文以独立面板展示，方便中英对照学习。

A DSH bundle plugin that puts a small `EN` button under every question and every answer in a chat: one
click reveals the full English translation of exactly that message in a panel underneath it.

![行为示意](icon.svg)

## 使用方法 · Use

1. 插件已安装并启用（Settings → Plugins → `@local/dsh-bilingual-helper`）。装好后无需重启，浏览器页面会自动加载。
2. 打开任意会话。中文的提问下方、中文的回答下方会出现 `EN 英文翻译` 按钮。
3. 点击按钮 → 该消息的完整英文翻译展开；点击「收起翻译」→ 折叠。
4. 已经是英文的消息不出现按钮（没有可翻译的内容）。

- 每行独立展开、独立缓存：折叠后再展开是瞬时的，不会重复请求。
- 代码块（``` 围起来的部分）原样保留、不送翻译，只翻正文。
- 长消息会自动切块，逐块翻译后再按原文顺序拼回。
- 深色 / 浅色主题自动适配（只用主题 token）。

## 翻译来自哪里 · Where the translation comes from

点击按钮时，这条消息的正文会被发送到 DSH 内置的翻译服务（`ctx.translator`），返回纯文本译文。
当前配置为 **`deepseek-official` 付费路由**：`deepseek-flash` 模型、thinking 关闭、单条文本、
固定直译提示词（无对话历史、无工具），**按输入/输出 token 计费**（约 0.5–1.5 分/条，见
[DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing)）。

- 付费路由必须携带**当前会话 id**：浏览器半边从 Chat 节点的标准 props 里读取 `sessionId`，
  随 `POST /dsh-en-translation/translate` 一起发给 Host 半边（见 `client.js` / `index.js`）。
- 译文按会话持久化：同一会话内同一段文本重复展开不会再请求（面板瞬时打开）；
  页面内存里另有一份缓存（最多 200 条）。
- 会话必须处于活跃状态；历史/已归档会话里点击会失败并在面板显示错误（不会静默挂起）。

> 隐私：点击按钮即表示把该消息的正文发送给 DeepSeek。不点击就不发送任何内容。

想换回免费路线：把 `cordis.patch.yml`（以及 profile 的 `cordis.patch.yml` 覆盖行）里两处
`provider: deepseek-official` 改成 `bing` 或 `google`（匿名接口，不花 token、不需要会话 id，但译文质量是 NMT 直译）。

## 实现方式 · How it is built

```
dsh-plugins/en-translation/
├── package.json        bundle 清单：dsh.bundle.patch + dsh.client（web, immediately）
├── cordis.patch.yml    插入两行：translator（内置翻译服务）+ 本插件
├── index.js            Host 半边：在同源 Web 上注册 /dsh-en-translation/* 路由
├── client.js           浏览器半边：Chat 行定义 + 渲染器 + 按钮 UI
├── locale/{zh,en}.json 插件面板里的标题与说明
└── icon.svg            原创图标
```

- **行从哪来**：浏览器半边通过官方扩展点注册两个 Conversation Definition
  （`en-translation-question` 匹配 `user/message`，`en-translation-answer` 匹配 `assistant/message`），
  各自发布一个 `kind: "en-translation"` 的 Chat Node，锚在该消息自己的 seq 上，
  因此行就落在消息正下方；渲染器注册在 `conversation.chat.node` 的 `en-translation` 键上。
- **桥接**：bundle 的浏览器半边不能直接调用 Host 服务，也没有 `host.call`。所以 Host 半边用
  `ctx.webServer` 注册一个同源 JSON 端点，浏览器只 `fetch` 它。
  - `GET  /dsh-en-translation/health` → 翻译服务是否可用、可用 provider
  - `POST /dsh-en-translation/translate` `{text, sessionId?}` → `{ok, translation, chunks, elapsedMs}`
  - `POST /dsh-en-translation/debug` → 仅开发用（`DEBUG=true` 时把诊断写进系统临时目录）
- **失败处理**：网络/服务错误在面板内以红色文案显示，按钮变成「重试」；不会静默失败。

## 配置 · Configuration

`cordis.patch.yml` 中本插件行的 `config`：

| 键 | 默认 | 含义 |
|---|---|---|
| `targetLanguage` | `en` | 目标语言（BCP 47，如 `en`、`ja`） |
| `provider` | `deepseek-official` | 付费路由（DeepSeek Flash，计费、需会话）；也可改 `bing` / `google` 走匿名 NMT |

## 搬迁与重装注意 · Moving or reinstalling

- 插件目录当前在 `~/Agent&AI_dev/dsh-plugins/en-translation`，profile 只保存一个
  `link:` 依赖和一条 `node_modules` 软链；**移动目录后必须重新安装并更新链接**。
- 坑：`dsh-client-modules` 会把「Loader 行名 + 根目录」对应的包元数据缓存到**进程重启为止**
  （`sourceKey = baseUrl + '\0' + loaderName`）。所以「删掉同名包 → 原地改名/换路径重装」时，
  它会继续用缓存的旧 `client.js` 路径，前端半边会静默不加载（Host 半边却正常）。
  解决办法二选一：① 重装时换一个新包名（当前就是这么做的：`@local/dsh-bilingual-helper`）；
  ② 重启 DSH 应用。原地改文件内容（路径不变）不受影响。
- 目录名含 `&`：浏览器资源 URL 只用包名，不经目录路径，所以运行没问题；但 shell 里操作这个
  路径记得加引号（`"/Users/.../Agent&AI_dev/..."`）。

## 已知限制 · Known limitations

- **付费路由比匿名 NMT 慢**：实测 270 字约 1.5 s、800 字约 3 s、接近 3000 字的单块约 10–20 s；
  超长回答会被切成多块串行翻译，前端总超时 90 s，极长消息可能失败，面板会提示原因。
- 付费路由**绑定活跃会话**：历史/已归档会话里点翻译会失败（`TRANSLATION_SESSION_INACTIVE` 或会话不存在），
  需要回到活跃会话再点。
- 切到付费路由后每条新消息都会**消耗 token**（同一会话内重复展开命中缓存则免费）；会话日志里会新增
  `plugin:translator/request|result` 记录。
- 机器翻译会改写 Markdown 排版与专有名词；原文始终保留在上方，可对照阅读。
- 一条回复如果分多个 assistant 消息（多步工具调用），中文的每一步都会有自己的按钮。
- 翻译结果不落盘、不跨页面持久化；刷新页面后需重新点一次。
