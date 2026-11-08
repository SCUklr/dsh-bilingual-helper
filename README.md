# 英文翻译学习助手 · Bilingual Learning Helper

在每个**提问**和每个**回答**下方各加一个 `EN` 按钮，点一下就在原消息下面展开这条消息的**完整英文翻译**；
再点一次收起。原文不动，译文以独立面板展示，方便中英对照学习。

A DSH bundle plugin that puts a small `EN` button under every question and every answer in a chat: one
click reveals the full English translation of exactly that message in a panel underneath it.

![行为示意](icon.svg)

仓库 · Repository: <https://github.com/SCUklr/dsh-bilingual-helper>

**Install (from GitHub)**: DSH sidebar → **Plugins** → **Add plugin** → enter
`https://github.com/SCUklr/dsh-bilingual-helper`. No local path is involved.

## 安装 · Install（从 GitHub）

**前提**：DSH 版本需自带 `@deepseek-ai/dsh-experimental-translator`（实测 `0.2.2-rc.1` 可用）；
安装时本机需要能访问 GitHub，并装有 `git`。

1. 打开侧边栏 **Plugins** 页 → **添加插件**。
2. 在输入框填入仓库地址，下面两种写法等价：
   - `https://github.com/SCUklr/dsh-bilingual-helper`
   - `github:SCUklr/dsh-bilingual-helper`
3. 点「安装」。DSH 会自动把插件装进当前 profile 并加入 profile 的 bundle 列表；
   profile 里记录的是 `github:...` 依赖（安装的是仓库默认分支的最新提交），**不涉及任何本机路径**。
4. 打开任意会话，中文的提问 / 回答下方会出现 `EN` 按钮。

> ⚠️ 不要用「本地目录路径」安装：那样 profile 会记成 `link:` / `file:` 绝对路径，之后移动或删除该目录就会失效。
> 用 GitHub 地址安装没有这个问题。
>
> 「安装源：中国大陆镜像源」只对 npm registry 生效，对 GitHub 安装无效；国内网络拉 GitHub 可能较慢或需要代理。

- **更新**：git 安装不会自动提示更新。在 Plugins 页先「卸载」旧版，再用同样的仓库地址重新安装。
- **卸载**：Plugins 页找到 `@local/dsh-bilingual-helper` → 卸载。
- **装完没出现 `EN` 按钮**：先刷新页面；仍然没有就重启一次 DSH（客户端模块元数据会按「Loader 行名 + 包根」
  缓存到进程重启，换装源或重装同名包后旧缓存可能还在）。
- 本插件在 profile 里的包名是 `@local/dsh-bilingual-helper`；它不是 npm 上的包，只能通过本仓库安装。

## 使用方法 · Use

1. 按上一节安装并启用插件（侧边栏 Plugins 页中显示为 `@local/dsh-bilingual-helper`）。
2. 打开任意会话。中文的提问下方、中文的回答下方会出现 `EN 英文翻译` 按钮。
3. 点击按钮 → 该消息的完整英文翻译展开；点击「收起翻译」→ 折叠。
4. 已经是英文的消息不出现按钮（没有可翻译的内容）。

- 每行独立展开、独立缓存：折叠后再展开是瞬时的，不会重复请求。
- 代码块（三个反引号围起来的部分）原样保留、不送翻译，只翻正文。
- 长消息会自动切块，逐块翻译后再按原文顺序拼回。
- 深色 / 浅色主题自动适配（只用主题 token）。

## 翻译来自哪里 · Where the translation comes from

点击按钮时，这条消息的正文会被发送到 DSH 内置的翻译服务（`ctx.translator`），返回纯文本译文。
默认配置为 **`deepseek-official` 付费路由**：`deepseek-flash` 模型、thinking 关闭、单条文本、
固定直译提示词（无对话历史、无工具），**按输入/输出 token 计费**（约 0.5–1.5 分/条，见
[DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing)）。

> 默认的付费路由要求：本机 DSH 已登录 DeepSeek 账号或配置了 DeepSeek API Key、账号模型目录里有
> `deepseek-flash`，并且当前会话处于活跃状态。不满足时请按下面的「免费路线」改配置，否则点击 `EN`
> 会报 `TRANSLATION_UNAVAILABLE` / `TRANSLATION_SESSION_INACTIVE`。

- 付费路由必须携带**当前会话 id**：浏览器半边从 Chat 节点的标准 props 里读取 `sessionId`，
  随 `POST /dsh-en-translation/translate` 一起发给 Host 半边（见 `client.js` / `index.js`）。
- 译文按会话持久化：同一会话内同一段文本重复展开不会再请求（面板瞬时打开）；
  页面内存里另有一份缓存（最多 200 条）。
- 会话必须处于活跃状态；历史/已归档会话里点击会失败并在面板显示错误（不会静默挂起）。

> 隐私：点击按钮即表示把该消息的正文发送给当前 provider。默认的 `deepseek-official` 会发给 DeepSeek；
> 换成免费的 `bing` / `google` 则发给 Microsoft / Google。不点击就不发送任何内容。

**免费路线**：在 profile 的 `cordis.patch.yml` 里覆盖本插件与 translator 两行的 `provider`（写法见
下面的「配置」一节），改成 `bing` 或 `google` —— 匿名接口，不花 token、不需要会话 id，但译文质量是
NMT 直译。

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

默认值来自仓库里的 `cordis.patch.yml`。个人想覆盖时，在 profile 的 `cordis.patch.yml`
（macOS 桌面版默认是 `~/.dsh/profiles/desktop/cordis.patch.yml`）末尾追加同样 id 的覆盖行。例如改成免费路线：

```yaml
- id: translator
  config:
    provider: bing
    maxTextChars: 3996
- id: en-translation
  config:
    targetLanguage: en
    provider: bing
```

改完保存；如果页面没有生效，刷新或重启一次 DSH。

## 升级 / 重装 / 本地开发 · Upgrade, reinstall, local development

- **GitHub 安装（推荐）**：profile 记录 `github:SCUklr/dsh-bilingual-helper`，与本地目录无关，
  移动任何文件夹都不影响。更新 = 先卸载再重新安装（见「安装」一节）。
- **本地开发**：把仓库 clone 到任意目录，在 Plugins 页用该目录的**绝对路径**安装。此时 profile
  记录的是 `link:` / `file:` 绝对路径，**移动或重命名该目录后必须重新安装**。
- **缓存坑（本地开发 / 重装时注意）**：`dsh-client-modules` 会把「Loader 行名 + 包根」对应的包元数据
  缓存到**进程重启为止**（`sourceKey = baseUrl + '\0' + loaderName`）。所以「删掉同名包 → 原地改名 /
  换路径重装」时，它可能继续用缓存的旧 `client.js` 路径，前端半边会静默不加载（Host 半边却正常）。
  解决办法二选一：① 重装后重启 DSH 应用；② 换一个新包名。原地改文件内容（路径不变）不受影响。

## 常见问题 · Troubleshooting

| 现象 | 原因 / 处理 |
|---|---|
| 装完看不到 `EN` 按钮 | 先刷新页面；仍没有就重启一次 DSH（见「安装」和「升级 / 重装」） |
| 点 `EN` 报 `TRANSLATION_UNAVAILABLE` | 当前 DSH 没有可用的 `deepseek-official` 路由（未登录 DeepSeek / 未配 API Key / 账号无 `deepseek-flash`）。改走免费 provider，或登录后重试 |
| 报 `TRANSLATION_SESSION_INACTIVE` | 在历史 / 已归档会话里点击；回到活跃会话再点 |
| 报 `TRANSLATE_FAILED` 或超时 | 网络或上游服务问题；点「重试」，或改成 `bing` / `google` |
| 「添加插件」安装失败 | 检查本机能否访问 GitHub、是否装有 `git`；国内网络可尝试代理后重试 |

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

## 许可证 · License

[MIT](LICENSE) © 2026 SCUklr
