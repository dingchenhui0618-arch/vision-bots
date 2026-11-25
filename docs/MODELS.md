# 模型接在哪、不接在哪、怎么换

这份文件是「模型参与度」的唯一说明。改路由、换模型、加一个模型调用点，都改这里和对应的校验器。

## 一句话原则

**模型只能提案，规则定生死；模型碰不到时间码。**

时间码一旦由模型产生，就会出现「字幕和口型差半秒」这种复现不了、也查不出来的错误，而且分段缓存立刻失效（同一份 scene 渲两次画面不一样）。所以管线里凡是「几秒到几秒」「第几帧」都是确定性代码算出来的。

## 现在真正调模型的地方（四处）

| 阶段 | 代码 | 模型要干什么 | 谁把关 |
|---|---|---|---|
| 制片人读需求 | `src/brief.mjs` → `src/llm.mjs` | 从用户一句话里提字段：平台、时长、画幅、模板、有没有稿 | `mergeBrief` 逐字段合成：用户原话 > 模型 > 默认；模型补的标 assumed，读岔的标 corrected；模板必须在名册里且真做过这个画幅 |
| 剪辑错字治理 | `src/asr-fix.mjs` | 按词位索引提「第 i 个词改成什么」 | `validate()`：只放行同音字（拼音一致）、术语表里的专名、阿拉伯数字纠错；不改词数、不改时间码；验不过只记录不改 |
| 剪辑大字（一句一条） | `src/headlines.mjs` | 给每张字幕卡写 3–6 字的大字标题 | `checkHeadline()`：长度 ≤8 字、**100% 的字必须来自这张卡**（不是 80%）、不许编数字、结尾不许是虚词/光杆动词/代词（半句话）、不许连接词开头；打回一次还不合格就按原文摘句。大字区间 = 字幕卡区间，字幕换卡那一刻大字一起换 |
| 质检语义审读 | `src/qa-semantic.mjs` | 读交付字幕全文，找数值查不出的错：同音错、整句崩、重复句、跑题 | 接地（引用必须逐字存在）、读全性（条数 + 首尾卡开头都要对上）、同音错要过硬校验；而且它**只能加严**，删不掉任何代码检查 |

## 不调模型的（全部确定性代码）

- **包装/动效**：模板 = 引擎代码 + `template.json`，内容 = `scene.json`；每一帧是「scene + 时间」的纯函数。这是分段缓存（改一句只重渲 79 帧）和逐帧一致的前提。
- **质检的数值层**：静音/响度用 ffmpeg 量，对比度从成片像素算 WCAG，排版盒子从版式数据算，重复句用字符串相似度，低置信词算占比。
- **剪辑的时间线**：转写是 faster-whisper（不是 LLM），气口检测、保留区间、段落合并、字幕断句都是规则。
- **群聊措辞**：bot 说话是模板句填真实数字（数字真、句式写死）。

## 怎么换模型

只改 `config/llm.local.json`（已 gitignore，不进仓库）：

```json
{
  "base": "https://…/v1",
  "key": "…",
  "models": { "fast": "qwen3.8-flash", "smart": "qwen3.8-max" },
  "thinking": false,
  "timeoutMs": 60000
}
```

环境变量优先级更高：`DSH_MEDIA_LLM_BASE` / `_KEY` / `_FAST` / `_SMART` / `_THINKING` / `_TIMEOUT_MS`。

`fast` 用在每片必经的检查（错字、语义审读、段落标题），`smart` 用在读需求和整句删这种要判断力的地方。

## 一条产线接两家服务：模型名自带路由（2026-11-25）

模型名可以写成 `<路由>:<模型>`，不带前缀的照旧走 `base`：

```json
"models": { "fast": "qwen3.8-flash", "smart": "qwen3.8-max" },
"routes": {
  "codesome": {
    "base": "https://v3.codesome.cn/v1",
    "key": "…",
    "models": { "fast": "claude-sonnet-5-5", "smart": "claude-opus-5-5" },
    "noTemperature": true,
    "noThinkingFlag": true,
    "minMaxTokens": 8000,
    "minTimeoutMs": 90000
  }
}
```

换成 Opus 只需把 `smart` 改成 `codesome:claude-opus-5-5`（或起服务时给
`DSH_MEDIA_LLM_SMART=codesome:claude-opus-5-5`）。**只有这一档过去**：`fast`、术语表、
音频证据、时间码一个字节都没动，提案回来仍旧过同一套校验器。

为什么不是直接改 `base`：两家网关的请求体不一样，硬换会以三种方式失败，其中一种**不报错**。

| 路由开关 | 不加会怎样 |
|---|---|
| `noTemperature` | Opus 5.5 开着 thinking 时 `temperature` 只许是 1，传 0 直接 **400** |
| `noThinkingFlag` | 它没有 vLLM 系的 `enable_thinking` 字段 |
| `minMaxTokens` | 思考与回答共用 `max_tokens`：29 句的选句题一次要 2000–2500 提示 + 2200–3000 思考 token。给 4000 会偶发 `finish_reason=length`、正文空白——**HTTP 200，不报错**，产品只会当成「模型没接上」然后退回规则排序 |
| `minTimeoutMs` | 单次 25–49s，默认 60s 的耐心不够 |
| `extraBody` | 网关方言（`output_config.effort`）原样带过去；只许加字段，不许改 model / messages / max_tokens / temperature / tools |

另外两条：

- **空正文只在 `finish_reason=length` 且该路由声明了思考下限时重试一次、预算翻倍**（`shouldRetryEmpty`）。
  别的空就是空，不重试。重试是基础设施行为：不改问题、不改答案的含义，也不替模型下结论。
- 名册只显示模型名（`modelLabel`），网关前缀是接线细节，不露给客户。

离线断言 `scripts/check-routes.mjs` 29 条（解析 8 / 请求体 11 / 重试 4 / 接线 6）：不联网、
不读本机凭证（路由用注入的假表），换机器照样能跑。出问题要看见网关原话时，
设 `VISION_BOTS_LLM_TRACE=<文件>`，每次调用的完整请求与响应都会落一行。

## 实测：把 Opus 5.5 接到提案侧，值不值（2026-11-25）

同一条真素材（自测29：29 句、首版成片 66.56s、目标 60s），同一套输入重放「整句删」：

| | qwen3.8-max（现用） | Opus（预算 4000） | Opus（预算 8000） |
|---|---|---|---|
| 重放次数 | 3 | 6 | 3 |
| 删到 60.05s | **3/3** | 3/6 | **3/3** |
| 删的是同一组句子 | 3/3 票一致 | 够票的那几次一致 | **3/3 票一致** |
| 一次重放总耗时 | **33–37s** | 110–152s | 167–293s |
| 单次调用 | **5–6s** | 20–27s | 39–49s |

读需求（`understand()`，同一句话 ×3）：两边字段 **3/3 完全一致**（抖音 / 9:16 / 90s / 折光 / 无稿），
Opus 3.6–5.5s、qwen 1.9–2.1s。

结论三句：

1. **接得通**：正文、JSON、工具调用（`tool_calls` → `tool` 回投）都正常，多轮那步 2.96s + 3.67s；
2. **「更稳」没被证实**：qwen3.8-max 在现有「3 次采样 + 2 票」的机制下已经 3/3 完全一致；
   Opus 预算够时也一样稳——两次不达标都不是模型判得不同，是**预算没给够**把答案截断了；
3. **代价是真的**：Opus 一次重放 167–293s，qwen 33–37s，慢 5–9 倍。

所以默认仍是 `smart: qwen3.8-max`。要再验一次，用固定手法：
`node scripts/model-ab.mjs <群 id> <标签> <第几次>`——同一条素材、同一套输入重放，
比「删的句子是否相同」「票数是否一致」「单次多久」，不比感觉。

## 实测（2026-11-23，TokenRouter 网关，26 个模型可选）

| 模型 | 结果 |
|---|---|
| `qwen3.8-flash` + `enable_thinking:false` | **选它**。2.8–5.6s 出结构化 JSON，10 段标题 4.1s，语义审读 5.6s |
| `qwen3.8-max` + `enable_thinking:false` | 可用，8s，判断力更强，留作 `smart` |
| `deepseek-flash` / `deepseek-v4.1-flash-economy` | **不可用**：这是思考模型，会把 `max_tokens` 全部烧在 `reasoning_content` 上，`content` 返回空、`finish_reason=length`。`enable_thinking:false` 与 `chat_template_kwargs.thinking:false` 都不生效 |
| `MiniMax-M3` | 同类问题，27s 还在思考，正文里带 `<think>` |
| `glm-5.3-flash` | 返回空正文（同上） |
| `doubao-seed-2-0-pro` | 404，名册里的 id 要带日期后缀（`-260215`） |

所以 `LLM.thinking` 默认 `false`，默认请求体里带 `enable_thinking:false`；不认这个字段的服务器会忽略它。

## 降级的规矩

模型连不上、超时、返回空、JSON 解析不出来，一律**不抛异常**，返回 `{ok:false, skipped}`，并在群里明说：

- 读需求降级 → 纯规则出规格卡，制片人说「模型没接上，这版是规则填的」
- 错字治理降级 → 只跑术语表，剪辑说「模型没接上，只做了术语表」
- 段落标题降级 → 沿用原句，剪辑报告里写明采纳了几条
- 语义审读降级 → **质检判不通过**（这一层没有证据），理由写清是超时还是没接上

最后一条是有意的：数值层全过、语义层没跑，只能说「数值层过了、语义层没查」，不能算交付合格。
