# Fairy-pi

把 [Fairy-DSH](https://github.com/Chengzhibense/Fairy-DSH) 的 Fairy 能力**适配**到 [Pi](https://pi.dev)（`@earendil-works/pi-coding-agent`）上的扩展包。不是复制文件：DSH 的宿主接口在 Pi 上不存在，每一个都换成了 Pi 的等价机制，并尽量让数值与文本口径与上游保持一致。

## 与上游的关系

| 上游（DSH / Cordis） | 本包（Pi） | 说明 |
|---|---|---|
| `webServer.register({path, handler})` | 无对应物 | Pi 扩展**不能注册 HTTP 端点**，一律改为命令 + 状态行 + 文件协议 |
| `ctx.on('session/event')` | `pi.on()` + [信号映射表](src/adapters/pi-events.ts) | 13 条归一化信号（`session:start`、`turn:end`…） |
| `ctx.effect(fn, label)` | [会话作用域](src/adapters/pi-lifecycle.ts) | `session_start` 建资源、`session_shutdown` 逆序幂等拆除 |
| `settings.register(ns, schema)` | [描述符表 + 注册表](src/adapters/pi-settings.ts) | Pi 的 `settings.json` 是固定 schema，装不下自定义命名空间 |
| `.credentials.yaml` 明文读密钥 | 宿主凭据接口注入 | 本包**不读密钥文件、不落日志、不写返回值** |
| `DSH_HOME`（`~/.dsh`） | `FAIRY_PI_DATA_DIR` 或 `~/.fairy-pi` | 运行时不写 pi 的 `agent_data` |
| `control-token` HTTP 鉴权 | 删除 | 没有 HTTP 写入面，留一个无用途的密钥文件只会误导 |
| `cordis.patch.yml` 注入 MCP | `pi.registerMcpServer()` | 默认不注册，是否引入浏览器自动化由使用方决定 |

## 安装

```bash
# 单次试载，不写 settings
pi -e /path/to/Fairy-pi

# 本地安装（会写 settings.json）
pi install /path/to/Fairy-pi
```

本包**没有**运行时依赖 `@earendil-works/*`（只有 `import type`），宿主包不存在重复实例问题。唯一的运行时依赖是朗读文本管线用的三个 mdast/micromark 包。

## 命令

| 命令 | 子命令 | 作用 |
|---|---|---|
| `/fairy-balance` | — | DeepSeek 余额 + 当日用量与费用估算（含峰谷档位） |
| `/fairy-voice` | `status` | 探测本地语音服务（默认 `http://127.0.0.1:9880`） |
| | `say <文本>` | 合成音频并写出可播放的 WAV；本地 TTS 不可用时回退到 Windows 内置语音 |
| | `brief <Markdown>` | 把长回答压成适合朗读的中文简报 |
| `/fairy-persona` | `on` / `off` | 开关人设注入（**默认关闭**，会话级、不持久化） |
| | `status` / `digest` / `corpus` / `reload` | 查看语料状态、预览将注入的段落、列出语料路径 |
| `/fairy-browser` | `state` / `frames` | 浏览器坞状态与帧文件 |
| | `bind` / `close` / `takeover <revision>` | 写控制命令（takeover 需状态允许） |
| | `mcp` | 查看 MCP 注册情况 |

## 前置条件与默认行为

- **数据目录**：`FAIRY_PI_DATA_DIR`，否则 `~/.fairy-pi/`。日账、参考音频、合成音频、浏览器坞状态都在这里。
- **本地 TTS**：`http://127.0.0.1:9880` 后端未部署时，`/fairy-voice status` 会**如实报「未启动」**——这是上游本地服务缺失时的既有行为，不是缺陷。参考音频放 `<数据目录>/fairy-voice/runtime/reference/fairy_ref.wav`（提示词同目录 `fairy_ref.txt`，缺失则退化为上游的固定文案）。
  `say` 不会因此变成死路：本地 TTS 失败时自动改用 **Windows 内置语音**（`System.Speech`）朗读，通知里写清「这不是 Fairy 的音色」。这是本包新增的回退（上游没有），只为让没有 9880 后端的机器也能出声；`speechFallback: false` 可关掉。文本走临时文件传入而不拼进 `-Command`，避免引号与注入。
- **人格注入**：默认关闭。`/fairy-persona on` 后，通过 `before_agent_start` 的 `systemPromptOptions.sections` 注入**有上界**的人设 + 语料摘要，不整体替换 `systemPrompt`。
- **浏览器坞**：`browser-dock` 的 `proxy.cjs`（生产者）不在本包内。需要浏览器状态时，让生产者按 `<数据目录>/browser-dock/` 的文件契约写 `state.json` 即可；MCP 服务器由使用方通过 `applyFairyBrowserDock(pi, { mcp })` 传入配置自行注册。

## 已验证口径

移植不是「看起来一样」，而是逐项对照过：

- 诊断日志：同一批输入，与上游 `fairy-contracts/diagnostics.js` 输出**逐行逐字节相同**。
- 计费：把上游的 `tokenCount` + 单价表 + 两个函数原样抽出来执行，709 项结果**bit 级相等**（覆盖整周 ×15 分钟的峰谷网格）。
- 朗读文本管线：3 个函数 × 34 组输入 + 31 组组合管道，共 **134 项完全一致**。

部分「怪」结果是**上游原样行为**（`第二句!` 半角标点、`负 负二百七十三点一五` 重复、千分位逗号转全角），测试里专门断言它们，防止后来者顺手优化而破坏一致性。

实机验证（pi 1.0.4）：`pi --mode json -p` 跑通，入口加载、四个功能的会话作用域建立、`message_end` 的用量累计真实写入 `<数据目录>/balance-meter-daily.json`；Windows 内置语音实测发声成功（本机装有三套 SAPI 语音）。

**估算口径的注意点**：单价表来自上游，只覆盖 `deepseek-v4-flash`。若会话用的是别的模型（例如默认的 `deepseek-v4-pro`），`/fairy-balance` 的「费用估算」是按 flash 单价推算的值，会与 Pi 自己的记账不一致——`Pi 记账` 那一行就是为此显示的。

## 目录结构

```text
Fairy-pi/
├── index.ts                 入口：只做装配
├── src/
│   ├── contracts/           契约层：日志 schema、脱敏、词汇表
│   ├── adapters/            DSH 接口 → Pi 机制的语义映射
│   └── features/
│       ├── balance/         费用估算、日账、余额查询
│       ├── voice/           朗读文本管线、本地 TTS、语音简报
│       ├── persona/         人设正文与语料摘要
│       └── browser/         浏览器坞文件协议与观察
├── skills/fairy-persona/    人格技能（SKILL.md）
├── assets/persona/          上游语料（Apache-2.0，未改动内容）
└── tests/                   88 项测试
```

## 开发

```bash
npm test              # 全部测试
npm run test:voice    # 单个模块
```

测试不依赖 Pi 进程：适配层与功能层都能用假的 `ExtensionAPI` 桩驱动，因此可以直接 `node --experimental-strip-types --test` 跑。

## 许可与来源

Apache-2.0。上游作品来源、被移植/再分发的内容清单、以及**未移植**的部分见 [NOTICE](NOTICE)。

值得说明的缺口：上游 `.agent-presets/fairy/runtime/{index.js, fairy_core.py, safety-gate.js}` 在公开仓库中**不存在**，所以语料驱动的检索内核无法移植；本包以「语料随包分发 + 有上界摘要 + 技能按需读取全文」作为可验证的降级方案。

本包不含 [pi-fairy](https://github.com/ymd-physics/pi-fairy) / pi-fairy-win 的任何内容——动画与桌面层由你已安装的那个独立包提供，两者不共享代码。
