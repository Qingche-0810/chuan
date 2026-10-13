# 川（chuān）

**给对话历史瘦身。** 剥掉工具调用、工具结果、搜索结果、思考块、图片这些「大块头」，只留人和 AI 之间说的话。

留下来的每一个字都是原文：不总结、不改写、不让模型重写一遍。

> 第一版，能用，但还在长。零依赖，一个文件，Node 18 以上。

---

## 为什么做它

长对话越聊越慢、越聊越贵，大头往往不是你们说了什么，而是中间那些：查一次网页带回来几千字，读一个文件塞进来几万字，模型每一轮的思考过程也都存着。这些东西当时有用，过了那一轮就只是在占地方，可它们会被一遍一遍地重新读进去。

常见的办法是换个新窗口，从头再来，前面聊过的就都没了。或者让模型自己压缩一遍，可压缩是重写，细节会被磨掉。

我们想要的是第三种：**说过的话一个字不动地留着，只把那些「过了那一轮就不再需要」的东西拿走。**

我们自己家的一个窗口，靠它住了一个多月没换过。中间瘦过好几次，每次都是同一个对话接着往下聊。第一次拿它试的时候，一个会话里真正会被读进模型的部分，从 139 万字节剥到了 27 万。

---

## 剥什么，留什么

| 默认剥掉 | 默认留着 |
|---|---|
| 工具调用和工具结果（成对一起剥，不会落单） | 人说的话 |
| 搜索结果 | AI 说的话 |
| 思考块（thinking） | 你用 `--keep-tool` 指定要留的工具，调用和结果都留 |
| 图片、文件（换成一行「这里原来有一张图片」） | |
| 你用 `--drop-prefix` 指定开头的文本块 | |

还有一个可选的：`--fold`。有的长提示会每一轮都原样塞进来一遍（定时唤醒的说明、固定的提醒）。给它那段话的开头，它会把旧的那些收成一行，只留最新一条完整的。

**什么时候用 `--keep-tool`**：有些工具的结果你希望它一直记得。比如我们家有一块跨窗口的留言板，AI 每次醒来会去读一下，那块读出来的东西我们留着，其他工具结果都剥。

---

## 怎么用

### 1. 瘦一个 messages 数组

如果你自己调 API、自己管对话历史（Anthropic Messages API 那种格式）：

```bash
node chuan.js messages history.json -o history.slim.json
node chuan.js messages history.json --keep-tool 'mcp__notes__*' -o out.json
```

文件可以是一个数组，也可以是带 `messages` 字段的对象。剥完以后，相邻的同 role 消息会合并成一条，保证 user / assistant 交替（API 要求这个）。

也可以当库用：

```js
const { stripMessages } = require('./chuan');
const { messages, stats } = stripMessages(history, { keepTools: ['mcp__notes__read'] });
```

### 2. 瘦一个 Claude Code 会话

Claude Code 的会话存在 `~/.claude/projects/<项目>/<会话id>.jsonl`。

```bash
node chuan.js list                       # 看看本机有哪些会话，按大小排
node chuan.js session <会话id>            # 只看账，什么都不写
node chuan.js session <会话id> --apply    # 真的写
claude --resume <它给你的新id>             # 接着聊
```

几件要知道的：

- **先关掉那个会话的窗口再跑。** 窗口还开着的话，你接下来说的话会继续写进旧文件，新的那份里没有
- **原文件一个字不动。** 它另存成一个新的会话 id，觉得不对，`--resume` 旧的就回去了
- **它会体检。** Claude Code 的会话文件其实是一棵树（中断、重试会留下分叉），它只沿着真正被读的那一支剥，删掉一行就把下一行接到上一行，最后检查链条没断才写。不认识的格式它会停下来，不猜着删
- **在别的地方跑的 Claude Code 也一样。** 我们在 Obsidian 里跑的 Claude Code 上也试过，会话文件是同一种，照样能用

---

## 跟 `/compact` 一起用

川和 Claude Code 自带的 `/compact` 不是二选一：

- **川**：机械地删，留下的都是原文，什么都不磨掉。可它只能剥「不是对话」的部分，话本身说得多了，它就没办法了
- **`/compact`**：让模型把前面的对话重写成一份摘要。能压得很小，代价是细节会变模糊

我们的做法是：**平时一两天川一次；真的快满了，先川，再 compact。** 先剥掉那些大块头，compact 要处理的就少了，摘要会写得更好，能留下的原话也更多。这样一个窗口能用得很久很久。

---

## 它不是什么

- **不是记忆。** 要紧的事，还是该存进你的记忆系统里。川只是让一个窗口的日子过得轻一点、久一点，不能拿它代替「坐下来决定什么值得留」
- **故意没做成 AI 能调用的工具（MCP）。** 能改写对话历史的东西，不该放进 AI 日常能碰到的工具表里。它是人去跑的维护动作

---

## 一个请求

随便用、随便改、随便再发。只有一个请求：**别改名换姓，把它当成你自己的原创。**

修改或者再分发的时候，请带上这个仓库的地址，写一句就好：

> 基于川（chuān）：https://github.com/Qingche-0810/chuan

—— 澈 & 小猫

---

## In English, briefly

**chuan** strips the heavy parts out of a conversation history — tool calls and results, search results, thinking blocks, images — and keeps only what the human and the AI actually said, word for word. No summarizing, no rewriting.

- `node chuan.js messages in.json -o out.json` — slim an Anthropic-style `messages` array (adjacent same-role turns are merged so roles still alternate)
- `node chuan.js session <id> [--apply]` — slim a Claude Code session (`~/.claude/projects/**.jsonl`). Dry-run by default; writes a new session id and never touches the original. Close the session first.
- `--keep-tool <name>` keeps a tool's calls and results; `--drop-prefix` / `--fold` handle repeated injected prompts.

Works well before `/compact`: strip first, then compact. MIT licensed. If you redistribute or modify it, please link back to this repository.
