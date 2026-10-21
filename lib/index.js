/**
 * dsh-recall — 极简跨会话记忆（Host 半，零依赖）
 *
 * 设计取向（相对 meow-memory 的取舍）：
 *   - 只 3 个工具（save/find/forget），不做每消息命中、不做首轮整块注入、不做反思与 dream。
 *     → 固定开销 ≈ 3 个 schema，无每轮注入成本，不碰 KV 缓存。
 *   - 记忆是纯文本 JSONL，按工作区一个文件；随时能看、能改、能拷走。
 *   - 检索 = BM25（中文 bigram + ASCII 词）+ 时间半衰，纯本地内存计算。
 *   - 不注册任何核心服务，避免与计费类插件抢同一个模块。
 *
 * 本插件不 import 任何 @deepseek-ai/* 核心包（以 link: 装进 profile 时解析不到）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const name = "recall";
export const inject = ["tools"];

const ROOT = path.join(os.homedir(), ".dsh", "recall");
const KINDS = ["fact", "pref", "lesson", "task", "proj"];
const KIND_LABEL = { fact: "事实", pref: "偏好", lesson: "教训", task: "进行中", proj: "项目" };
const MAX_TEXT = 1200;
const HALF_LIFE_DAYS = 60;
const DAY = 86400000;

// ---------- 作用域 ----------

function safeName(value) {
  const s = String(value ?? "")
    .trim()
    .replace(/[^\w\u3400-\u9fff.-]+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "");
  return s.slice(0, 48) || "global";
}

function scopeOf(exec, explicit) {
  if (explicit) return safeName(explicit);
  const agent = exec && exec.agent;
  const session = agent && agent.session;
  // 真实结构是 exec.agent.session.header.cwd（见 @deepseek-ai/dsh-tool-lsp），
  // 其余分支留给旧版/测试桩。
  const header = session && session.header;
  const cwd =
    (header && (header.cwd || header.workspacePath)) ||
    (session && (session.cwd || session.workingDirectory || session.workspacePath)) ||
    (agent && agent.cwd);
  if (typeof cwd === "string" && cwd.trim()) {
    const base = path.basename(path.resolve(cwd));
    if (base) return safeName(base);
  }
  return "global";
}

// ---------- 存储 ----------

const fileOf = (scope) => path.join(ROOT, scope + ".jsonl");

function load(scope) {
  let raw = "";
  try {
    raw = fs.readFileSync(fileOf(scope), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row.id === "string" && typeof row.x === "string") rows.push(row);
    } catch {
      /* 坏行直接跳过，不阻塞读写 */
    }
  }
  return rows;
}

function persist(scope, rows) {
  fs.mkdirSync(ROOT, { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const target = fileOf(scope);
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, target);
  try {
    fs.writeFileSync(path.join(ROOT, scope + ".md"), renderMarkdown(scope, rows), "utf8");
  } catch {
    /* 人读索引写失败不影响主流程 */
  }
}

function renderMarkdown(scope, rows) {
  const lines = [`# 记忆 · ${scope}`, "", `共 ${rows.length} 条，按时间倒序。文件真相在 \`${scope}.jsonl\`。`, ""];
  for (const r of rows.slice().sort((a, b) => b.t - a.t)) {
    const d = new Date(r.t);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    lines.push(`- \`${r.id}\` **${KIND_LABEL[r.k] || r.k}** ${stamp} — ${String(r.x).replace(/\n/g, " ")}`);
  }
  return lines.join("\n") + "\n";
}

// ---------- 检索 ----------

function tokensOf(text) {
  const s = String(text || "").toLowerCase();
  const set = new Set();
  for (const m of s.matchAll(/[a-z][a-z0-9_./+-]{1,30}/g)) set.add(m[0]);
  const han = (s.match(/[\u3400-\u9fff]+/g) || []).join("");
  for (let i = 0; i + 1 < han.length; i++) set.add(han.slice(i, i + 2));
  if (han.length === 1) set.add(han);
  return set;
}

/** keywords 参数：逗号/顿号/分号/空白分隔，去重、截断到 6 个。 */
function parseKeywords(raw) {
  if (Array.isArray(raw)) raw = raw.join(",");
  return String(raw || "")
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1 && s.length <= 30)
    .filter((s, i, a) => a.indexOf(s) === i)
    .slice(0, 6);
}

/** 重叠系数：以较短一方为分母，短句被长句覆盖时即为 1。 */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

function rank(rows, query, k) {
  const q = tokensOf(query);
  if (q.size === 0) return rows.slice().sort((a, b) => b.t - a.t).slice(0, k).map((r) => ({ r, s: 0 }));
  const docs = rows.map((r) => {
    const kw = new Set();
    for (const w of r.w || []) for (const t of tokensOf(w)) kw.add(t);
    return { r, body: tokensOf(r.x), kw, goal: tokensOf(r.g || "") };
  });
  // 字段化 BM25：正文、关键词、目标句分开计分——关键词是人工挑的同义词，
  // 同一句话换个说法也能命中，所以权重最高。
  const fields = [
    { get: (d) => d.body, boost: 1 },
    { get: (d) => d.kw, boost: 1.8 },
    { get: (d) => d.goal, boost: 1.4 },
  ];
  const N = docs.length;
  const lens = docs.map((d) => fields.reduce((s, f) => s + f.get(d).size, 0) || 1);
  const avgdl = lens.reduce((a, b) => a + b, 0) / Math.max(1, N) || 1;
  const df = new Map();
  for (const d of docs) {
    const all = new Set();
    for (const f of fields) for (const t of f.get(d)) all.add(t);
    for (const t of all) df.set(t, (df.get(t) || 0) + 1);
  }
  const k1 = 1.4;
  const b = 0.72;
  const scored = [];
  docs.forEach((d, i) => {
    let s = 0;
    let hit = 0;
    const norm = k1 * (1 - b + (b * lens[i]) / avgdl);
    for (const t of q) {
      const n = df.get(t);
      if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      let matched = false;
      for (const f of fields) {
        if (!f.get(d).has(t)) continue;
        matched = true;
        s += (f.boost * idf * (k1 + 1)) / (1 + norm);
      }
      if (matched) hit += 1;
    }
    if (s <= 0) return;
    // 关键词原文整串出现在查询里：同义词表里写对了，就该给足分。
    const qLower = String(query).toLowerCase();
    for (const w of d.r.w || []) {
      const k = String(w).toLowerCase();
      if (k && qLower.includes(k)) s += 0.9;
    }
    s *= 0.6 + 0.4 * (hit / q.size);
    const ageDays = Math.max(0, (Date.now() - d.r.t) / DAY);
    s *= Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    scored.push({ s, r: d.r });
  });
  scored.sort((x, y) => y.s - x.s);
  return scored.slice(0, k).map((x) => ({ r: x.r, s: x.s }));
}

function agoText(ms) {
  const d = Math.floor(ms / DAY);
  if (d <= 0) return "今天";
  if (d === 1) return "昨天";
  if (d < 30) return `${d}天前`;
  const m = Math.floor(d / 30);
  if (m < 12) return `${m}个月前`;
  return `${Math.floor(m / 12)}年前`;
}

function newId() {
  return "m" + Date.now().toString(36).slice(-5) + randomBytes(2).toString("hex").slice(0, 3);
}

function clip(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const textOK = (schema) => ({
  schema,
  render: (_args, value) => [{ type: "text", text: String(value && value.text ? value.text : JSON.stringify(value)) }],
});

// ---------- 插件 ----------

export function apply(ctx) {
  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const dispose = [];

      dispose.push(
        sctx.tools.register({
          name: "mem_save",
          description:
            "把一条值得跨会话记住的事写进长期记忆（事实/偏好/教训/进行中的事/项目）。keywords 写同义词和别名，检索主要靠它；几乎重复的自动合并。只在真的有用时写，别把闲聊塞进来。",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string", description: "记忆正文，一句话说清，不超过 300 字。" },
              kind: { type: "string", enum: KINDS, description: "fact=事实、pref=偏好、lesson=教训、task=进行中、proj=项目。" },
              keywords: { type: "string", description: "检索关键词，逗号分隔 2~5 个：同义词、别名、缩写、英文写法，别抄正文原词。" },
              goal: { type: "string", description: "仅 kind=task 用：这件事要达成什么，一句话。" },
              scope: { type: "string", description: "记忆库名，默认取当前工作区名；写全局记忆填 global。" },
            },
            required: ["text"],
          },
          output: textOK({
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean" },
              id: { type: "string" },
              merged: { type: "boolean" },
              scope: { type: "string" },
              text: { type: "string" },
            },
          }),
          async execute(args, exec) {
            const scope = scopeOf(exec, args.scope);
            const raw = String(args.text ?? "").trim();
            const body = clip(raw, MAX_TEXT);
            if (!body) return { ok: false, id: "", merged: false, scope, text: "内容为空，没写。" };
            // 闸门一：太短的不是记忆，是半句话。
            if (raw.length < 12) {
              return { ok: false, id: "", merged: false, scope, text: `才 ${raw.length} 字，太短，不记。宁可少一条，也别留半句在半路上。` };
            }
            // 闸门二：清单行、标题行是从别处抄来的排版，不是判断。
            if (/^[-*]\s+`/.test(raw) || /^#{1,3}\s/.test(raw)) {
              return { ok: false, id: "", merged: false, scope, text: "这看着像清单行或标题，不是一条判断，没记。" };
            }
            const kind = KINDS.includes(args.kind) ? args.kind : "fact";
            const kw = parseKeywords(args.keywords);
            const goal = clip(args.goal, 120);
            const rows = load(scope);
            const tok = tokensOf(body);
            let merged = false;
            const dup = rows.find((r) => overlap(tok, tokensOf(r.x)) >= 0.9);
            if (dup) {
              dup.x = body;
              dup.t = Date.now();
              if (kind !== "fact") dup.k = kind;
              if (kw.length) dup.w = Array.from(new Set([...(dup.w || []), ...kw])).slice(0, 6);
              if (goal) dup.g = goal;
              merged = true;
            } else {
              const row = { id: newId(), t: Date.now(), k: kind, x: body };
              if (kw.length) row.w = kw;
              if (goal) row.g = goal;
              rows.push(row);
            }
            persist(scope, rows);
            const id = dup ? dup.id : rows[rows.length - 1].id;
            const tail = kw.length ? `，关键词：${kw.join(" ")}` : "，没给关键词（以后检索会弱一些）";
            // 可能是改口：关键词撞上两个以上、正文又不像、两边都带数字（端口/版本/路径这类）。
            // 只提醒，不自动标记——是不是取代，写的人比相似度清楚。
            let conflict = "";
            if (!merged && kw.length >= 2) {
              const kset = new Set(kw.map((w) => w.toLowerCase()));
              for (const r of rows) {
                if (r.id === id) continue;
                const share = (r.w || []).filter((w) => kset.has(String(w).toLowerCase())).length;
                if (share < 2) continue;
                if (overlap(tok, tokensOf(r.x)) >= 0.5) continue;
                if (!(/\d/.test(body) && /\d/.test(r.x))) continue;
                conflict = `，注意 ${r.id} 讲的是同一件事但说法不同——要是这条是更新，说一声我把它作废`;
                break;
              }
            }
            return {
              ok: true,
              id,
              merged,
              scope,
              text: (merged ? `已合并进 ${id}（${scope}）` : `已记下 ${id}（${scope}·${KIND_LABEL[kind]}${tail}）`) + conflict,
            };
          },
        }),
      );

      dispose.push(
        sctx.tools.register({
          name: "mem_find",
          description: "按关键词检索长期记忆（BM25+时间衰减）。默认同时查当前工作区和 global 库，global 的来源会标出来。query 留空则按时间倒序看最近几条。",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", description: "关键词或短句；留空=最近记忆。" },
              k: { type: "integer", minimum: 1, maximum: 20, description: "返回条数，默认 5。" },
              kind: { type: "string", enum: KINDS, description: "只看某一类。" },
              scope: { type: "string", description: "记忆库名，默认当前工作区。" },
            },
            required: [],
          },
          output: textOK({
            type: "object",
            additionalProperties: false,
            properties: { count: { type: "integer" }, text: { type: "string" } },
          }),
          async execute(args, exec) {
            const scope = scopeOf(exec, args.scope);
            const k = Math.min(20, Math.max(1, Number(args.k) || 5));
            // 跨库召回：当前工作区 + global。两个库各自按自己的语料算 BM25，
            // 再合起来按分数排——混在一起算 avgdl 会让小库被大库带偏。
            const scopes = scope === "global" ? ["global"] : [scope, "global"];
            const buckets = scopes.map((s) => {
              let rows = load(s);
              if (args.kind && KINDS.includes(args.kind)) rows = rows.filter((r) => r.k === args.kind);
              return { scope: s, rows };
            });
            const total = buckets.reduce((n, b) => n + b.rows.length, 0);
            const merged = [];
            for (const b of buckets) {
              for (const h of rank(b.rows, args.query || "", k)) merged.push({ r: h.r, s: h.s, scope: b.scope });
            }
            if (!merged.length) {
              return { count: 0, text: total ? `「${scope}」里没有匹配的记忆（共 ${total} 条）。` : `「${scope}」还没有记忆。` };
            }
            merged.sort((x, y) => y.s - x.s);
            const hits = merged.slice(0, k);
            const text = hits
              .map(({ r, scope: from }) => {
                const goal = r.g ? ` 〔目标：${r.g}〕` : "";
                const kw = r.w && r.w.length ? ` [${r.w.join("/")}]` : "";
                const tag = from === "global" && scope !== "global" ? "〔global〕" : "";
                return `[${r.id}] ${tag}${KIND_LABEL[r.k] || r.k}·${agoText(Date.now() - r.t)}：${clip(r.x, 220)}${goal}${kw}`;
              })
              .join("\n");
            return { count: hits.length, text: `「${scope}」命中 ${hits.length}/${total}：\n${text}` };
          },
        }),
      );

      dispose.push(
        sctx.tools.register({
          name: "mem_forget",
          description: "删除一条记忆（id 来自 mem_find）。删错了只能重写，慎用。",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "记忆 id，如 m1a2b3c。" },
              scope: { type: "string", description: "记忆库名，默认当前工作区。" },
            },
            required: ["id"],
          },
          output: textOK({
            type: "object",
            additionalProperties: false,
            properties: { removed: { type: "boolean" }, text: { type: "string" } },
          }),
          async execute(args, exec) {
            const scope = scopeOf(exec, args.scope);
            const rows = load(scope);
            const next = rows.filter((r) => r.id !== String(args.id || "").trim());
            if (next.length === rows.length) return { removed: false, text: `没找到 ${args.id}（${scope}）。` };
            persist(scope, next);
            return { removed: true, text: `已删 ${args.id}（${scope} 剩 ${next.length} 条）。` };
          },
        }),
      );

      return () => {
        for (const d of dispose) {
          try {
            if (typeof d === "function") d();
          } catch {
            /* 卸载失败不阻塞 */
          }
        }
      };
    });
  });
}
