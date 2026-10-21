# dsh-recall 🧠

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**极简跨会话记忆**：
3 个工具、零自动注入、按工作区一个 JSONL 文件，固定开销约 **726 tok/请求**。

> 同类方案 [dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)（MIT）约 4,452 tok/请求，
> 另有首轮注入与每轮关键词命中。本项目按「只在我真的需要时才付 token」的思路重做了一遍。
> 为什么这样取舍见 [docs/设计取舍.md](docs/设计取舍.md)。

## 特性

- **3 个工具**：`mem_save` / `mem_find` / `mem_forget`。
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
| `mem_save` | `text`（必填）、`kind`（fact/pref/lesson/task/proj）、`keywords`、`goal`、`scope` | 写一条；重叠系数 ≥0.9 视为重复并合并 |
| `mem_find` | `query`（可空）、`k`（1–20，默认 5）、`kind`、`scope` | `query` 留空 = 按时间倒序看最近 |
| `mem_forget` | `id`、`scope` | 删除；id 来自 `mem_find` |

`scope` 缺省 = 当前工作区目录名；写跨工作区的记忆传 `global`。

### 关键词是手写的，不是自动提取的

`keywords` 写同义词、别名、缩写、英文写法（`faster-whisper, ASR, 识别, 离线`），检索时按
**正文 ×1 / 关键词 ×1.8 / 目标句 ×1.4** 三个字段分别打分；关键词原样出现在查询里再额外加 0.9。

不写也能用（退回正文 bigram + BM25），但换个说法就搜不到——这是实测得出的取舍：
自动提取的关键词只是正文的子集，加权重没意义，所以宁可让写入时多想一步。
`goal` 只在 `kind: "task"` 时有意义，答的是「这件事要达成什么」而不是「做过什么」。

## 数据

```
~/.dsh/recall/<scope>.jsonl   # 真相（每行 {id,t,k,x}）
~/.dsh/recall/<scope>.md      # 人读版，随写入同步
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
| 工具 schema | 2,464 tok（8 个） | **620 tok**（3 个） |
| 常驻引导 | 1,988 tok（system prompt） | **106 tok**（AGENTS.md） |
| 首轮注入 | 有 | **无** |
| 每消息命中 | 有（top-2） | **无** |
| 后台任务 | 反思 + dream | **无** |
| 合计固定开销 | ≈ 4,452 tok/请求 | **≈ 726 tok/请求** |

## 许可

MIT，见 [LICENSE](LICENSE)。
