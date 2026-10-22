# dsh-recall 🧠

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**极简跨会话记忆**：
4 个工具、零自动注入、按工作区一个 JSONL 文件，固定开销约 **840 tok/请求**（估算，见文末成本表）。

> 同类方案 [dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)（MIT）约 4,452 tok/请求，
> 另有首轮注入与每轮关键词命中。本项目按「只在我真的需要时才付 token」的思路重做了一遍。
> 为什么这样取舍见 [docs/设计取舍.md](docs/设计取舍.md)。

## 特性

- **4 个工具**：`mem_save` / `mem_find` / `mem_forget` / `mem_brief`。
- **跨会话同步**：`mem_brief` 给「距上次同步过了多久 + 那之后别的会话干了什么」，同步游标自动推进；只含写进记忆的事，没写记忆的会话看不到。
- **出处指针**：写入时自动记下会话 uuid（`〔s:xxxxxxxx〕`），`mem_find` 显示时带出。卡片是摘要不是原文，有出处才回溯得了；取不到就不写，不编。
- **零自动注入**：不改写你的 prompt、不往每轮塞命中结果，因此**不碰 KV 缓存、不污染上下文**。
- **按工作区自动隔离**：scope 取当前会话工作区目录名，不需要模型传项目参数。
- **跨库召回**：`mem_find` 默认同时查当前工作区与 `global`，两个库各算各的 BM25 再合并排序；来自 `global` 的结果标 `〔global〕`。
- **写入闸门**：正文短于 12 字、或以 `- \`` / `#` 开头的清单/标题行，直接拒收——那半句不是判断。
- **改口提醒**：关键词撞上两个以上、正文又不像、两边都带数字时，提示可能与旧卡冲突；**只提醒不自动作废**，判断权留在写的人手里。
- **BM25 + 时间半衰**：中文 bigram + ASCII 词，越新的记忆权重越高（半衰期 60 天）。
- **近乎重复自动合并**：只防手抖重写，语义重复交给 `mem_find` 判断。
- **纯文件存储**：`~/.dsh/recall/<scope>.jsonl`，同名 `.md` 是人读版；改文件即改记忆，拷走即迁移。
- **零运行时依赖**：不 import 任何核心包，不注册核心服务（不会和计费类插件抢模块）。

## 安装

### 方式一：本地 link（推荐，适合自用）

```sh
# 1) 放到插件目录
git clone <this-repo> ~/.dsh/plugins/dsh-recall

# 2) 在 profile 里挂载：profile 的 package.json
#    dependencies:  "dsh-recall": "link:C:/Users/<you>/.dsh/plugins/dsh-recall"
#    dsh.profile.bundles: 追加 "dsh-recall"
#    pnpm-lock.yaml 的 importers 段补：
#      dsh-recall:
#        specifier: link:C:/Users/<you>/.dsh/plugins/dsh-recall
#        version: link:../../plugins/dsh-recall

# 3) 建 junction（Windows，管理员不需要）
#    New-Item -ItemType Junction -Path ~/.dsh/profiles/desktop/node_modules/dsh-recall -Target ~/.dsh/plugins/dsh-recall

# 4) 重启 DSH 桌面端
```

### 方式二：插件市场

若市场收录，直接搜索 `dsh-recall` 安装。未收录时用方式一。

### 装完之后

在全局 `~/.dsh/AGENTS.md` 里加一段（约 75 tok），让模型知道该主动查：

```markdown
## 记忆（dsh-recall）

跨会话记忆在 `~/.dsh/recall/<工作区>.jsonl`（同名 `.md` 是人读版）。相关话题开工前先 `mem_find` 查一下；
定下来的事实/偏好/教训用 `mem_save` 记一行；记错用 `mem_forget`。没有自动注入，也没有后台整理。
```

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `mem_save` | `text`（必填）、`kind`（fact/pref/lesson/task/proj）、`keywords`、`goal`、`scope` | 写一条；自动记出处会话；重叠系数 ≥0.9 视为重复并合并 |
| `mem_find` | `query`（可空）、`k`（1–20，默认 5）、`kind`、`scope` | `query` 留空 = 按时间倒序看最近 |
| `mem_forget` | `id`、`scope` | 删除；id 来自 `mem_find` |
| `mem_brief` | `full`（可选） | 同步其他会话的动静；新会话第一轮调一次，调完自动推进同步点 |

`scope` 缺省 = 当前工作区目录名；写跨工作区的记忆传 `global`。

### 关键词是手写的，不是自动提取的

`keywords` 写同义词、别名、缩写、英文写法（`faster-whisper, ASR, 识别, 离线`），检索时按
**正文 ×1 / 关键词 ×1.8 / 目标句 ×1.4** 三个字段分别打分；关键词原样出现在查询里再额外加 0.9。

不写也能用（退回正文 bigram + BM25），但换个说法就搜不到——这是实测得出的取舍：
自动提取的关键词只是正文的子集，加权重没意义，所以宁可让写入时多想一步。
`goal` 只在 `kind: "task"` 时有意义，答的是「这件事要达成什么」而不是「做过什么」。

### 出处：卡片是摘要，不是原文

写入时自动带上 `s`（会话 uuid），`mem_find` 显示成 `〔s:xxxxxxxx〕`。

一条没有出处的记忆，半年后读到只能选择相信或不信——而这两条路都不对。
顺着 `s` 能回到那次会话的日志：`~/.dsh/sessions/--<工作区>--/session-<uuid>/session.v4.jsonl.zstd`。

取不到会话 id 时 `s` 留空、不编造；老记忆没有 `s`，照常可用。

### 跨会话同步：其他会话在忙什么

每个会话相互独立，写完记忆就散场——谁也不知道隔壁干了什么。`mem_brief` 补这一块：

- 读所有库，找 `t` 晚于同步游标的条目，**排除当前会话自己**；
- 按（会话 × 库）分组，每个会话最多列两条，给「大概干了什么」；
- 返回距上次同步过了多久，然后把游标推到此刻。

游标是全局一个（`_sync.json`），因为要同步的是「其他会话的动静」。第一次没有游标时往前看一天。
局限：没写记忆的会话看不见——这里只同步「留下过记忆的事」。

## 数据

```
~/.dsh/recall/<scope>.jsonl   # 真相（每行 {id,t,k,x,s?,w?,g?}）
~/.dsh/recall/<scope>.md      # 人读版，随写入同步
~/.dsh/recall/_sync.json      # 跨会话同步游标（mem_brief 用；删掉 = 下次重看一天）
```

- 手改 `.jsonl` 立即生效（坏行会被跳过）。
- 迁移/备份 = 拷走整个 `~/.dsh/recall/`。
- 删除某条 = `mem_forget`，或直接删掉那一行。

## 卸载

从 profile 的 `package.json` 删掉 `dependencies` 与 `dsh.profile.bundles` 里的两处，删掉
`node_modules/dsh-recall` 的 junction，重启桌面端。记忆文件保留在 `~/.dsh/recall/`，不会自动删。

## 实测成本

| 项 | meow-memory 0.31 | dsh-recall |
|---|---|---|
| 工具 schema | 2,464 tok（8 个） | **620 tok**（3 个，0.3.1 实测） |
| 常驻引导 | 1,988 tok（system prompt） | **106 tok**（AGENTS.md） |
| 首轮注入 | 有 | **无** |
| 每消息命中 | 有（top-2） | **无** |
| 后台任务 | 反思 + dream | **无** |
| 合计固定开销 | ≈ 4,452 tok/请求 | **≈ 726 tok/请求**（0.3.1 实测） |
| v0.3.1 → v0.4.0 增量 | — | **约 +115 tok**（mem_brief schema + AGENTS.md 一句，估算；合计约 840） |

## 许可

MIT，见 [LICENSE](LICENSE)。
