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
import { zstdDecompressSync } from "node:zlib";

export const name = "recall";
export const inject = ["tools", "systemPrompt"];

const ROOT = path.join(os.homedir(), ".dsh", "recall");
const KINDS = ["fact", "pref", "lesson", "task", "proj"];
const KIND_LABEL = { fact: "事实", pref: "偏好", lesson: "教训", task: "进行中", proj: "项目" };
const MAX_TEXT = 1200;
const HALF_LIFE_DAYS = 60;
const DAY = 86400000;

// ---------- 三级规则（0.9.0，0.9.1 补七条）----------
// 第二层 _次要规则.md：权限低于 _规则 / _额外规则，自动写入、一般不审、随时能改。
// 第三层 _压缩存档.md：压缩摘要里次一档的内容，是资料不是规则，不注入、按需读。
// 打分是纯规则的，不调模型——确定、零成本、可解释、能改。下面词表和阈值都可调。
const MINOR_BOOK = "_次要规则.md";
const MINOR_MAX = 30; // 上限 30 条。0.9.1 起淘汰看 hits（低的先删），同 hits 按时间升序
const MINOR_HOOKS = 5; // 钩子取三到五个词
const ARCHIVE_BOOK = "_压缩存档.md"; // 次档内容落这儿，_本子 从此只由人写
const ARCHIVE_MAX_BYTES = 200 * 1024; // 体积保险丝：超了从最老的节开始删，并在文件头留一行
const ARCHIVE_BODY_MAX = 1200; // 单节正文上限，和注入保险丝 MAX_TEXT 同值；超了必须标「原文 N 字」
const ARCHIVE_SPAN_BUDGET = 60000; // 一条摘要写入的总字节预算：装不下的段落记账，不静默丢
const ZH_RATIO_MIN = 0.2; // 汉字占全部字母的比例低于这个算「非中文为主」，不进规则层（见 zhMostly）
const KANA_RATIO_MAX = 0.25; // 假名+韩文占全部字母超过这个，这条本身就是日文/韩文，不是中文夹外文
const MINOR_ARCHIVE = "_已归档.json";
const ARCHIVE_KEEP = 200; // 已处理 compactionId 只留最近 200 个
const INJECT_MAX = 4000; // 注入保险丝：超了只注入前 4000 字并标「已截断」

// 高分 → _次要规则.md
const RULE_PATTERNS = [
  { re: /必须|不许|一律|只能|以后都|原则|约定|规矩|职责/, name: "硬规矩词" },
  { re: /不要再|别再用|禁止/, name: "禁止词" },
];
// 拍板词单独不算高分，得有数字 / 路径 / 会话号这类具体落点陪着（见 scoreSpan）
const VERDICT_RE = /定在|定为|拍板|决定|敲定/;
const DETAIL_RE = /\d|[A-Za-z]:\\|session-[0-9a-f]{8}|\//;

// 次档 → _本子.md（没命中高分，但命中任一条）
const NOTE_PATTERNS = [
  { re: /教训|坑|踩过|注意|小心/, name: "教训词" },
  { re: /\d|[A-Za-z]:\\|session-[0-9a-f]{8}|\/[\w.-]+\//, name: "含数字/路径/会话号" },
];
const NOTE_MIN_LEN = 200; // 长度超过 200 字的实质段落也算次档

// 挑钩子时剔掉的泛词——这些 bigram 出现频次高但没信息量，进了钩子会撞车。
// 规矩类文本天然共享「必须/以后/定在」这类词，不剔掉的话所有规矩都会被判成同一条。
const HOOK_STOP = new Set([
  "我们", "你们", "他们", "这个", "那个", "一个", "就是", "可以", "什么", "怎么",
  "已经", "还是", "但是", "因为", "所以", "然后", "如果", "或者", "不是", "没有",
  "这样", "那样", "时候", "东西", "自己", "现在", "以后", "一下", "这些", "那些",
  // 规矩类文本的高频骨架词
  "必须", "不许", "一律", "只能", "原则", "约定", "规矩", "职责", "相关", "参数",
  "固定", "定在", "定为", "决定", "敲定", "拍板", "不要", "别再", "禁止", "按这",
  "个要", "要求", "统一", "一按", "都以", "按此", "此类", "以上", "以下", "的规",
  "条规", "第一", "第二", "第三", "以及", "并且", "而且", "同时", "此外", "关于",
]);


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

/**
 * 记忆的出处：这条是哪个会话写的。
 *
 * 为什么要记：卡片是「摘要」，不是原文（见设计取舍）。一条没有出处的记忆，
 * 半年后读到只能选择相信或不信——而这两条路都不对。
 * 记下会话 uuid，就能顺着回到那次会话的日志（sessions/--<工作区>--/session-<uuid>/）。
 *
 * 取不到就返回空字符串，不猜、不编。缺出处的记忆仍然可用，只是标注缺了。
 */
function sessionIdOf(session) {
  if (!session) return "";
  const h = session.header || {};
  // 正规路径是 session.header.id（DSH 本体里 99 处引用）；其余留给旧版与测试桩。
  const raw = (h && h.id) || session.id || session.sessionId || (h && (h.sessionId || h.sid)) || "";
  const s = String(raw || "").replace(/^session-/, "");
  return s ? s.slice(0, 36) : "";
}

function sessionRef(exec) {
  const agent = exec && exec.agent;
  return sessionIdOf(agent && agent.session);
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
    const src = r.s ? ` 〔s:${String(r.s).slice(0, 8)}〕` : "";
    lines.push(`- \`${r.id}\` **${KIND_LABEL[r.k] || r.k}** ${stamp} — ${String(r.x).replace(/\n/g, " ")}${src}`);
  }
  return lines.join("\n") + "\n";
}

// ---------- 同步点 ----------
// 一个全局游标：上次「看过别的会话干了什么」的时刻。
// 共用它，因为要同步的是「其他会话的动静」，不是某一个库的状态。

const SYNC_FILE = path.join(ROOT, "_sync.json");
// 墙：会话之间互相留话的地方。跟记忆分开存——记忆是事实，墙是话。
const WALL_FILE = path.join(ROOT, "_wall.jsonl");
// 私密本：每个会话一个文件夹，里头两本——secret（背着别的会话干的事）和 _额外规则（本会话自己的设定）。
// 工具层硬隔离：只认自己 s 前 8 位那个文件夹，别的会话碰不到。
const LIFE_PRIVATE = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private");
function privateDir(me) {
  return path.join(LIFE_PRIVATE, String(me || "").slice(0, 8));
}
const PRIVATE_BOOKS = {
  secret: "_本子.md",
  rules: "_额外规则.md",
  minor: MINOR_BOOK,
  archive: ARCHIVE_BOOK,
};

function loadSync() {
  try {
    const raw = fs.readFileSync(SYNC_FILE, "utf8");
    const t = Number((JSON.parse(raw) || {}).last);
    return Number.isFinite(t) && t > 0 ? t : 0;
  } catch {
    return 0;
  }
}

function saveSync(t) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(SYNC_FILE, JSON.stringify({ last: t }), "utf8");
  } catch {
    /* 写不进游标不影响返回内容，下次会重复报一遍，不算坏 */
  }
}

function loadWall() {
  try {
    const raw = fs.readFileSync(WALL_FILE, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendWall(row) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.appendFileSync(WALL_FILE, JSON.stringify(row) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 这条留言是不是给我的：广播、指名我的前缀、或指名我这个工作区。 */
function wallToMe(row, me, scope) {
  const to = String(row.to || "all");
  if (to === "all") return true;
  if (me && to.startsWith(me.slice(0, 8))) return true;
  if (scope && to === scope) return true;
  return false;
}

/** 所有记忆库名；`_` 开头的是内部文件，不是库。 */
function listScopes() {
  try {
    return fs
      .readdirSync(ROOT)
      .filter((n) => n.endsWith(".jsonl") && !n.startsWith("_"))
      .map((n) => n.slice(0, -6));
  } catch {
    return [];
  }
}

/** 人读的时间差：「3 小时 20 分」比「今天」有用。 */
function fmtGap(ms) {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ""}`;
  const d = Math.floor(h / 24);
  return `${d} 天${h % 24 ? ` ${h % 24} 小时` : ""}`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

// ---------- 三级规则：打分、钩子、写入 ----------

/**
 * 规则打分，不调模型。返回 { tier: 'high'|'mid'|'low', hit: 命中规则名 }。
 * high → _次要规则；mid → _本子；low → 丢。
 */
function scoreSpan(text) {
  const s = String(text || "");
  if (!s.trim()) return { tier: "low", hit: "空" };
  for (const p of RULE_PATTERNS) {
    if (p.re.test(s)) return { tier: "high", hit: p.name };
  }
  // 拍板词单独不算高分，得有数字 / 路径 / 会话号这类具体落点陪着
  if (VERDICT_RE.test(s) && DETAIL_RE.test(s)) return { tier: "high", hit: "拍板+具体落点" };
  for (const p of NOTE_PATTERNS) {
    if (p.re.test(s)) return { tier: "mid", hit: p.name };
  }
  if (s.trim().length > NOTE_MIN_LEN) return { tier: "mid", hit: "长段落" };
  return { tier: "low", hit: "无命中" };
}

// 虚字：含这些字的 bigram 基本都是跨词边界的碎片（「必须」被剔掉后剩「口必」「须是」），
// 当真钩子会把两条不相干的规矩连起来，所以整片丢掉。
const HAN_FUNC = /[的了是在有和就都而及与或一个上中下为以于之必须要能可会想应该只还很更最不没无]/;

/** 从一段话里挑钩子：三到五个词，按「出现频次 × 词长」排。中文按 bigram，英文和数字按词。 */
function pickHooks(text, n = MINOR_HOOKS) {
  const s = String(text || "");
  const freq = new Map();
  const bump = (w, k) => freq.set(w, (freq.get(w) || 0) + k);
  // 英文词和数字本身是完整词，权重给足
  for (const m of s.toLowerCase().matchAll(/[a-z][a-z0-9_.+-]{2,24}/g)) bump(m[0], 3);
  for (const m of s.match(/\d[\d./:]{1,14}%?/g) || []) bump(m, 3);
  // 中文 bigram：剔掉泛词和跨词碎片
  for (const seg of s.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i + 1 < seg.length; i++) {
      const w = seg.slice(i, i + 2);
      if (HOOK_STOP.has(w) || HAN_FUNC.test(w)) continue;
      bump(w, 1);
    }
  }
  return [...freq.entries()]
    .map(([w, c]) => [w, c * Math.min(w.length, 6)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

/** 钩子重叠：两个钩子集合交集数量，用来判「同一条」。 */
function hooksOverlap(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (!sa.size || !sb.size) return 0;
  let n = 0;
  for (const w of sa) if (sb.has(w)) n += 1;
  return n;
}

// 0.9.1 起行尾带 hits=N，自动写的再加 [auto]。老格式（没有这两段）照样认得，
// 读回来 hits=0、auto=false，不会因为升级丢规则。
const MINOR_LINE_RE =
  /^- \[钩子: ([^\]]*)\] (.*?) — (\d{4}-\d{2}-\d{2}) · (s-[0-9a-f]{1,8})(?: · hits=(\d+))?(?: \[auto\])?\s*$/;

/** 把 _次要规则.md 解析成条目数组。认不出的行直接丢掉，写回时不保留。 */
function parseMinor(raw) {
  const lines = String(raw || "").split("\n");
  const items = [];
  for (const line of lines) {
    const m = line.match(MINOR_LINE_RE);
    if (!m) continue;
    items.push({
      hooks: m[1].split(/[,，\s]+/).filter(Boolean),
      body: m[2],
      date: m[3],
      sid: m[4],
      hits: m[5] ? Number(m[5]) : 0,
      auto: /\[auto\]/.test(line),
    });
  }
  return items;
}

function renderMinor(item) {
  const hits = item.hits || 0;
  const tail = ` — ${item.date} · ${item.sid} · hits=${hits}${item.auto ? " [auto]" : ""}`;
  return `- [钩子: ${item.hooks.join(",")}] ${item.body}${tail}`;
}

/**
 * 判两条是不是「同一条」。
 * 0.9.0 用的是「重叠 ≥2」，太松：五个词的钩子撞两个就会顶掉一条不相干的规则。
 * 0.9.1 改成按比例：overlap >= max(2, ceil(短的一方 × 0.6))。
 * 三对三要 2，五对五要 3，四对四要 3，两对两要 2。
 */
function sameRule(a, b) {
  const need = Math.max(2, Math.ceil(Math.min(a.hooks.length, b.hooks.length) * 0.6));
  return hooksOverlap(a.hooks, b.hooks) >= need;
}

/**
 * 写一条次要规则。
 * - 同一条只留最后一次：按 sameRule 的比例判据认，旧条 hits 加一，正文换新，挪到末尾
 * - 上限 MINOR_MAX 条：超了按 hits 升序、同 hits 按日期升序删第一条
 *   （0.9.1 从「纯时间淘汰」改过来——该留的是反复被撞上的，不是最新的）
 * - 被挤掉的直接丢，不降级进 _压缩存档
 *
 * auto 区分来源：宿主压缩摘要自动归进来的写 true（首次 hits=1，行尾标 [auto]）；
 * 人用 mem_private 手写的写 false（hits 从 0 起，不带 [auto]）。
 * 人写的不算「被摘要撞过」，所以在淘汰排序里天然排在后面——这是对的：
 * 真正要紧、不想被挤掉的人写规矩该写进 _额外规则，那本不参与淘汰。
 */
function writeMinorRule(me, item, auto = true) {
  const dir = privateDir(me);
  const file = path.join(dir, MINOR_BOOK);
  let items = [];
  try {
    items = parseMinor(fs.readFileSync(file, "utf8"));
  } catch {
    /* 文件还没有就是空的 */
  }

  // 自动写：首次进来就是 hits=1（它被摘要提到过一次）。人写的没有这一层含义，从 0 起。
  const fresh = { ...item, hits: auto ? 1 : 0, auto: auto === true };
  const idx = items.findIndex((it) => sameRule(it, fresh));
  let replaced = false;
  if (idx >= 0) {
    const old = items.splice(idx, 1)[0];
    // 撞的是自动条目才说明「又被摘要提到一次」；撞到人写的，hits 保持原样不加
    fresh.hits = old.hits || 0;
    if (auto) fresh.hits += 1;
    replaced = true;
  }
  items.push(fresh);

  while (items.length > MINOR_MAX) {
    let worst = 0;
    for (let i = 1; i < items.length; i++) {
      const a = items[i];
      const b = items[worst];
      if (a.hits < b.hits || (a.hits === b.hits && a.date < b.date)) worst = i;
    }
    items.splice(worst, 1);
  }

  const body = [
    "# 次要规则",
    "",
    "> 自动归纳，权限低于 `_规则` / `_额外规则`；冲突时以上面两层为准。",
    `> 上限 ${MINOR_MAX} 条，超了先删 hits 低的（同 hits 删老的）。可以随手改、随手删。`,
    "> `hits` 是这条被后来的摘要再撞上的次数；`[auto]` 表示自动写的，人写的不带。",
    "",
    ...items.map(renderMinor),
    "",
  ].join("\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  return { replaced, total: items.length };
}

/**
 * ECMAScript 的行终止符有四种，正则 `m` 模式的 `^` 四种都认；`split("\n")` 只认一种。
 * 两边不一致就是漏洞：正文里放一个裸 \r 或 U+2028 再接 `## §999`，转义器看不见，
 * 解析器却把它当成新的分节。
 */
const EOL_RE = /\r\n|[\r\n\u2028\u2029]/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

function splitLines(text) {
  return String(text == null ? "" : text).split(EOL_RE);
}

/**
 * 逐行扫，标出每行在不在围栏代码块里，同时记下这行在原文里的字符区间（含行终止符）。
 * 记区间是为了「旧内容原样保留」——只按行切再 join("\n") 会把 CRLF/U+2028 归一成 LF，
 * 等于每次写入都在偷偷改已有正文。
 *
 * 围栏里的东西是正文，解析结构（分节、钩子表）时必须一律跳过——
 * 这比转义可靠：转义要穷举所有能造结构的写法，围栏只要认对边界。
 */
function scanLines(raw) {
  const text = String(raw == null ? "" : raw);
  const out = [];
  let fence = "";
  // 四种行终止符都认，和正则 m 模式的 ^ 对齐
  const lineRe = /[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)/g;
  let hit;
  while ((hit = lineRe.exec(text)) !== null) {
    if (hit[0] === "") break; // 末尾的零宽匹配，别死循环
    const rawLine = hit[0];
    const line = rawLine.replace(/\r\n$|[\r\n\u2028\u2029]$/, "");
    const f = line.match(FENCE_RE);
    let inFence;
    if (fence) {
      inFence = true;
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = "";
    } else if (f) {
      fence = f[1];
      inFence = true;
    } else {
      inFence = false;
    }
    out.push({ line, inFence, start: hit.index, end: hit.index + rawLine.length });
  }
  return out;
}

/** 正文起点：第一个围栏外的 `## §N ` 所在字符位置。头部（钩子表、各种交代）在它前面。 */
function bodyStart(text) {
  for (const { line, inFence, start } of scanLines(text)) {
    if (!inFence && /^## §\d+ /.test(line)) return start;
  }
  return text.length;
}

/** 把任意正文包成围栏代码块：围栏比正文里最长的连续反引号还长一位，绝不会提前收尾。 */
function fenceBlock(text) {
  const body = String(text == null ? "" : text);
  let longest = 0;
  for (const run of body.match(/`+/g) || []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${body}\n${fence}`;
}

/**
 * 钩子表：`| 钩子 | 指向 |` 那几行，读回来用。
 * 只扫文件头（第一个围栏外的 `## §N ` 之前）——正文里长得像钩子表的行不算，
 * 否则一份旧格式存档（没围栏）里的假行会在每次写入时被复制一份。
 */
function parseHookTable(raw) {
  const out = [];
  const lines = splitLines(raw);
  let fence = "";
  for (const line of lines) {
    const f = line.match(FENCE_RE);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = "";
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    if (/^## §\d+ /.test(line)) break; // 进正文区了，钩子表不会有
    const m = line.match(/^\| ([^|]+) \| §(\d+) \|$/);
    if (!m) continue;
    if (m[1].trim() === "钩子") continue; // 表头
    out.push({ hooks: m[1].trim(), at: Number(m[2]) });
  }
  return out;
}

/** 压缩存档的文件头：标题 + 说明 + 体积淘汰交代 + 钩子表，正文在表下面。 */
function archiveHead(trimmed, lastTrimDate) {
  return [
    "# 压缩存档",
    "",
    "> 压缩摘要里次一档的内容（教训、路径、数字）。是资料不是规则，**不注入**，要用 `mem_private` 读。",
    "> 上面是钩子表，下面是分节正文；`§N` 是节号，删节时钩子表同步删行。",
    `> 已按体积淘汰 ${trimmed} 节 · 最新 ${lastTrimDate || "—"}`,
  ];
}

/** 把存档的头部 + 钩子表 + 分节拼回一整段正文（trimArchive 反复算体积用）。 */
function buildArchiveBody(rows, sections, trimmed, lastTrimDate) {
  return [
    ...archiveHead(trimmed, lastTrimDate),
    ...(rows.length ? ["", "| 钩子 | 指向 |", "| --- | --- |", ...rows.map((r) => `| ${r.hooks} | §${r.at} |`)] : []),
    "",
    ...sections.map((s) => s.text).join("\n\n").split("\n"),
    "",
  ].join("\n");
}

/**
 * 体积保险丝：超了从最老的节开始删，钩子表里对应的行一起删。
 * 删到只剩新写的那一节还超限时**不截断**，返回 overLimit 让调用方整条拒写——
 * 砍一半的资料比没写更糟：读的人会拿那半条当全文。
 */
function trimArchive(me, file, rows, sections, trimmed, lastTrimDate) {
  let total = Buffer.byteLength(buildArchiveBody(rows, sections, trimmed, lastTrimDate), "utf8");
  if (total <= ARCHIVE_MAX_BYTES) return { trimmed, lastTrimDate, total, dropped: 0, overLimit: false };

  const sorted = [...sections].sort((a, b) => a.at - b.at);
  const keep = new Set(sections.map((s) => s.at));
  let dropped = 0;
  let today = "";
  while (total > ARCHIVE_MAX_BYTES && sorted.length > 1) {
    const gone = sorted.shift();
    keep.delete(gone.at);
    dropped += 1;
    today = fmtTime(Date.now()).slice(0, 10);
    rows = rows.filter((r) => keep.has(r.at));
    sections = sections.filter((s) => keep.has(s.at));
    total = Buffer.byteLength(buildArchiveBody(rows, sections, trimmed + dropped, today), "utf8");
  }

  // 只剩一节还超：这一节就是新写进来的，整条不写
  const overLimit = total > ARCHIVE_MAX_BYTES;
  return {
    trimmed: trimmed + dropped,
    lastTrimDate: today || lastTrimDate,
    total,
    dropped,
    rows,
    sections,
    overLimit,
  };
}

/** 节的正文是不是已经包在围栏里了。 */
function hasFenceBody(text) {
  const lines = splitLines(text);
  let i = 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  return i < lines.length && FENCE_RE.test(lines[i]);
}

/** 旧格式（0.9.2 及更早）的节没有围栏：把标题之后的内容整段包进围栏，一次性迁过来。
 *  切点用字符位置，不按行重拼——重拼会把 CRLF/U+2028 归一成 LF。 */
function addFenceToLegacy(text) {
  const hits = scanLines(text);
  let i = 1;
  while (i < hits.length && hits[i].line.trim() === "") i++;
  if (i >= hits.length) return text;
  const cut = hits[i].start;
  const head = text.slice(0, cut).replace(/\s+$/, "");
  const bodyText = text.slice(cut).replace(/\s+$/, "");
  return bodyText ? `${head}\n\n${fenceBlock(bodyText)}` : head;
}

/**
 * 拒写时只往文件头记一笔，已有内容一个字不动。
 * 之前那版用全文 replace 压空行、删行，会把已有正文改坏——拒写是「没写进去」，
 * 不是「顺手整理一下别人的文件」。
 */
function recordOvers(file, dir, raw, incoming) {
  const text = String(raw || "");
  const overs = parseOvers(text);
  overs.count += 1;
  overs.bytes += incoming;
  const note = `> 有 ${overs.count} 条超 ${ARCHIVE_MAX_BYTES} 字节上限未写入 · 合计 ${overs.bytes} 字节 · 最新 ${fmtTime(Date.now()).slice(0, 10)}`;
  const cut = bodyStart(text);
  const head = text.slice(0, cut);
  const body = text.slice(cut); // 原样，一个字节不动
  const lines = splitLines(head);
  const idx = lines.findIndex((l) => /^> 有 \d+ 条超 \d+ 字节上限未写入/.test(l));
  if (idx >= 0) {
    lines[idx] = note;
  } else {
    // 没有就接在「已按体积淘汰」那行后面；再没有就接在抬头说明块末尾
    const k = lines.findIndex((l) => /^> 已按体积淘汰 /.test(l));
    const at = k >= 0 ? k + 1 : Math.min(lines.length, 2);
    lines.splice(at, 0, note);
  }
  const headOut = lines.length ? `${lines.join("\n")}\n` : `${archiveHead(overs.count, "").join("\n")}\n\n${note}\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, headOut + body, "utf8");
}

/**
 * 写 _压缩存档：正文按 `## §N 标题 · 日期 · 会话` 分节，顶部钩子表加一行。
 * 和 _本子 的结构一样，但落的是另一个文件——_本子 从此只由人写。
 * 正文整段进围栏代码块（见 fenceBlock），落盘前不做任何转义：原文原样进、原样出。
 */
function writeArchive(me, item) {
  const dir = privateDir(me);
  const file = path.join(dir, ARCHIVE_BOOK);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    /* 空 */
  }
  const rows = parseHookTable(raw);

  // 已有的体积淘汰交代和上次日期，接着往后写
  const headLine = raw.match(/^> 已按体积淘汰 (\d+) 节 · 最新 (.+)$/m);
  const trimmedSoFar = headLine ? Number(headLine[1]) : 0;
  const lastTrimDate = headLine && headLine[2] !== "—" ? headLine[2] : "";

  // 已有的分节按字符区间切出来，原样保留——只按行切再 join("\n") 会把 CRLF/U+2028
  // 归一成 LF，等于每次写入都在偷偷改已有正文
  const sections = [];
  {
    const scanned = scanLines(raw);
    // 旧档（0.9.2 及更早）的节没有围栏，正文里的 `## §999` 和真节长得一模一样，
    // 光看形状分不出来。唯一可靠的线索是**节号连续**：真档是 §1 §2 §3…，
    // 正文里伪造的 `## §999` 是跳号的。断号的一律当正文（它随后会被
    // addFenceToLegacy 包进围栏，以后不会再被扫到）。
    // 不这么做的后果（0.9.7 复验 t1c 实测）：旧档 §1 正文里一行 `## §999 伪节`
    // 被当成两个节，新记录算出 nextAt = 999+1，写进去的节号是 §1000——
    // 节号错乱、伪节还被套上围栏升格成了真节。
    const legacy = !scanned.some((s) => s.inFence);
    const hits = [];
    let expect = null;
    for (const s of scanned) {
      if (s.inFence || !/^## §\d+ /.test(s.line)) continue;
      const n = Number(s.line.match(/^## §(\d+) /)[1]);
      if (legacy) {
        if (expect === null) expect = n; // 第一个节就是起点
        else if (n !== expect) continue; // 断号：旧档正文里的伪节，不算
        expect += 1;
      }
      hits.push(s);
    }
    for (let i = 0; i < hits.length; i++) {
      const start = hits[i].start;
      const end = i + 1 < hits.length ? hits[i + 1].start : raw.length;
      let piece = raw.slice(start, end);
      // 旧格式的节没有围栏：第一次碰到就补上，免得正文里的假 `## §`、假钩子表行
      // 在以后每次写入时都被当成真结构
      if (!hasFenceBody(piece)) piece = addFenceToLegacy(piece);
      sections.push({ at: Number(hits[i].line.match(/^## §(\d+) /)[1]), text: piece.replace(/\s+$/, "") });
    }
  }

  // 节号要同时避开钩子表和已有的分节——只算钩子表的话，一份没有表只有分节的
  // 坏存档会让新节从 §1 重来，和旧节撞号
  const nextAt = Math.max(0, ...rows.map((r) => r.at), ...sections.map((s) => s.at)) + 1;
  const incoming = Buffer.byteLength(item.body, "utf8");

  // 单条自己就超上限：整条不写。先判这一条，别让它进保险丝把别人挤掉
  if (incoming > ARCHIVE_MAX_BYTES) {
    recordOvers(file, dir, raw, incoming);
    return { ok: false, reason: "too-big", bytes: incoming, at: nextAt };
  }

  rows.push({ hooks: item.hooks.join(","), at: nextAt });
  sections.push({
    at: nextAt,
    // 正文整段进围栏：标题、管道、行终止符在块里全是普通文本，写进去什么读出来就是什么
    text: `## §${nextAt} ${item.title || "归档"} · ${item.date} · ${item.sid}\n\n${fenceBlock(item.body)}`,
  });

  const res = trimArchive(me, file, rows, sections, trimmedSoFar, lastTrimDate);

  // 删到只剩新写的这节还超：整条不写
  if (res.overLimit) {
    recordOvers(file, dir, raw, incoming);
    return { ok: false, reason: "too-big", bytes: incoming, at: nextAt };
  }

  const liveRows = res.rows || rows;
  const liveSections = res.sections || sections;
  const overs = parseOvers(raw);
  const body = [
    ...archiveHead(res.trimmed, res.lastTrimDate),
    ...(overs.count ? [`> 有 ${overs.count} 条超 ${ARCHIVE_MAX_BYTES} 字节上限未写入 · 合计 ${overs.bytes} 字节 · 最新 ${overs.date}`] : []),
    ...(liveRows.length ? ["", "| 钩子 | 指向 |", "| --- | --- |", ...liveRows.map((r) => `| ${r.hooks} | §${r.at} |`)] : []),
    "",
    ...liveSections.map((s) => s.text).join("\n\n").split("\n"),
    "",
  ].join("\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  return { ok: true, at: nextAt, total: liveSections.length, dropped: res.dropped || 0 };
}

/** 读文件头那行「有 N 条超上限未写入」，累加用。 */
function parseOvers(raw) {
  // 只认头部区域内那一行——正文里写一句长这样的能把计数凭空抬高
  const text = String(raw || "");
  const m = text.slice(0, bodyStart(text)).match(/^> 有 (\d+) 条超 \d+ 字节上限未写入 · 合计 (\d+) 字节(?: · 最新 (.+))?$/m);
  return {
    count: m ? Number(m[1]) : 0,
    bytes: m ? Number(m[2]) : 0,
    date: (m && m[3]) || fmtTime(Date.now()).slice(0, 10),
  };
}

/** 已处理的 compactionId 集合，只留最近 ARCHIVE_KEEP 个。 */
function loadArchive(me) {
  try {
    const raw = fs.readFileSync(path.join(privateDir(me), MINOR_ARCHIVE), "utf8");
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveArchive(me, list) {
  try {
    const dir = privateDir(me);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MINOR_ARCHIVE), JSON.stringify(list.slice(-ARCHIVE_KEEP)), "utf8");
  } catch {
    /* 写不进游标只会多处理一次，不阻塞压缩 */
  }
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

// ---------- 取原文 ----------
// 会话日志是多帧追加的 zstd（每帧一条事件），Node 的解压器只吃单帧，
// 所以按 magic 28 B5 2F FD 切帧再逐帧解。解不动的帧跳过，不阻塞。
const SESSIONS_ROOT = path.join(os.homedir(), ".dsh", "sessions");
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function unzstdMultiFrame(buf) {
  const pos = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      pos.push(i);
    }
  }
  if (!pos.length) return "";
  const parts = [];
  for (let k = 0; k < pos.length; k++) {
    const start = pos[k];
    const end = k + 1 < pos.length ? pos[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString("utf8"));
    } catch {
      /* 假阳性 magic 或坏帧，跳过 */
    }
  }
  return parts.join("");
}

function findSessionFile(sid) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSIONS_ROOT);
  } catch {
    return "";
  }
  // 先精确匹配；调用方常给 s 的前 8 位，所以再按前缀找一次。
  for (const d of dirs) {
    if (!d.startsWith("--")) continue;
    const p = path.join(SESSIONS_ROOT, d, "session-" + sid, "session.v4.jsonl.zstd");
    if (fs.existsSync(p)) return p;
  }
  for (const d of dirs) {
    if (!d.startsWith("--")) continue;
    let children = [];
    try {
      children = fs.readdirSync(path.join(SESSIONS_ROOT, d));
    } catch {
      continue;
    }
    for (const c of children) {
      if (!c.startsWith("session-" + sid)) continue;
      const p = path.join(SESSIONS_ROOT, d, c, "session.v4.jsonl.zstd");
      if (fs.existsSync(p)) return p;
    }
  }
  return "";
}

/** 只取人和模型说出口的话；reasoning 不取——那是内心，不是原文。 */
function readSessionMessages(file) {
  const raw = unzstdMultiFrame(fs.readFileSync(file));
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const kind = o && o.type;
    if (kind !== "user/message" && kind !== "assistant/message") continue;
    const d = o.data || {};
    const arr = kind === "user/message" ? d.content || [] : (d.message && d.message.content) || [];
    const text = arr
      .filter((c) => c && c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!text) continue;
    // system-reminder 是注入的上下文碎片，不是谁说的话；混进来只会污染片段。
    if (text.startsWith("<system-reminder>")) continue;
    out.push({ t: Number(o.time) || 0, who: kind === "user/message" ? "主人" : "我", text });
  }
  return out;
}

const textOK = (schema) => ({
  schema,
  render: (_args, value) => [{ type: "text", text: String(value && value.text ? value.text : JSON.stringify(value)) }],
});

// ---------- 插件 ----------

// ---------- 压缩时自动归档 ----------

/**
 * 从 compaction/summary 事件里取摘要文本。
 *
 * 多 block 之间用空行拼接，不是单个换行：splitSpans 是按「空行 / 换行+列表符号」切的，
 * 用 "\n" 拼会把所有 block 粘成一段——切不开，整条摘要变成一个巨型段，再被正文上限
 * 一截，等于把后面所有 block 全丢了。真实数据（124 条，2026-10-26）每条只有 1 个
 * block，所以这条路一直没被走到；但不能因此就留着——换个宿主版本可能就多 block 了。
 */
function summaryText(data) {
  const blocks = data && data.summary;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => (b && typeof b.text === "string" ? b.text : ""))
    .filter((s) => s.trim())
    .join("\n\n")
    .trim();
}

/**
 * 摘要切成段：一段一个条目，别把整篇揉成一条。
 *
 * 切之前先把四种行终止符归一成 `\n`。不归一的话 `/\n{2,}/` 在 CRLF 上匹配不到——
 * `\r\n\r\n` 是「\n \r \n」，中间夹了个 `\r`，不是连续两个 `\n`；`U+2028` 更是压根没有 `\n`。
 * 结果整条摘要切不开、变成一个巨型段，再被正文上限一截，等于把后面全丢了。
 * 这和 0.9.2 那个「`EOL_RE` 认四种、`split("\n")` 只认一种」是同一类错误，
 * 那次只在解析路径上修了，切段这条路又忘了一遍。
 *
 * 归一化只影响切分点：`flatSpan` 之后本来就会把 `\s+` 压成单个空格，原文的行终止符
 * 不会带进存档，所以这里不存在「偷偷改原文」。
 */
function splitSpans(text) {
  return String(text || "")
    .replace(/\r\n|[\r\u2028\u2029]/g, "\n")
    .split(/\n{2,}|\n(?=[-*#]|\d+\.\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

/**
 * 一段正文压成一行。传 max 就截断——但**截了必须说**：标上原文字数。
 * 0.9.6 及更早是 `.slice(0, 240)` 直接切，不加省略号也不标截断，
 * 读的人会拿半句当整句（真实例子：存档里「…must NOT write int」，
 * 源文是「write into `_本子.md`」，断在词中间，没有一个字说它被截了）。
 *
 * 三个坑（0.9.7 复验挑出来的，每条都写坏了数据）：
 *
 * 1. **标记要算进 max。** 先按 max 切再加标记，240 字的上限会被撑到 251 字——
 *    `_次要规则` 是「一条一行」的结构，超了就不是那个形状了。现在先减掉标记长度再切。
 * 2. **按码点切，不按 UTF-16 code unit 切。** `slice` 数的是 code unit，
 *    emoji 是代理对（两个 unit），正好切在中间就写出半个字符，文件里变成 U+FFFD。
 *    `Array.from` 按码点拆，切不出半个。
 * 3. **「原文 N 字」的 N 是原文长度，不是压缩空白后的长度。** 之前用压缩后的长度，
 *    5000 个空格的输入会报「原文 1403 字」——那个数字是给读的人判断「丢了什么」用的，
 *    报小了就等于又瞒了一次。
 */
function flatSpan(span, max) {
  const raw = String(span == null ? "" : span);
  const chars = Array.from(raw.replace(/\s+/g, " ").trim()); // 按码点拆，代理对不会被切开
  if (!max || chars.length <= max) return chars.join("");
  const mark = `…（原文 ${raw.length} 字）`;
  const keep = Math.max(0, max - Array.from(mark).length);
  return chars.slice(0, keep).join("") + mark;
}

/**
 * 这段是不是中文为主。
 * 打分是纯词表匹配，英文摘要里引用「必须」「规矩」也会被判 high——那是**引用**，
 * 不是摘要本身在定规矩。这类条目进了 _次要规则，规则层就躺着两段英文事件叙述，
 * 模型读到没用。判据：汉字数 / **所有字母数** ≥ ZH_RATIO_MIN。
 *
 * 分母是 `\p{L}`（Unicode 的「字母」大类），不是「汉字 + 拉丁字母」：
 * 只数拉丁的话，假名、希腊字母、西里尔字母、全角字母全都不进分母——
 *   · 日文里汉字多（「セッションの要約」的「要約」是汉字），纯日文能算到 1.0
 *   · `日志必须` + 400 个希腊字母 `αβγδ` 也能算到 1.0
 * 两种都是「非中文」被判成中文，一起进了规则层。用 `\p{L}` 一个正则全覆盖。
 *
 * 中英混着写的真规矩（「以后都必须用 console.info 打日志，不要用 ctx.logger」）
 * 汉字占多数，比例约 0.38，过线；纯英文摘要引用一句「必须」比例约 0.05，不过线。
 * 阈值 0.2 是这么定的：术语密度高的中文条目能到 0.24（复验构造的例子：
 * 「以后都必须用 console.info 打日志…Product profile mounts no console exporter…」，
 * 23 个汉字 72 个拉丁 = 0.242），那是**中文条目夹英文术语**，该进规则层；
 * 而英文条目夹几个汉字（引用一句「必须」）只有 0.05 左右。0.2 把两者分得开。
 * 降档不是丢——它照样进 _压缩存档，一个字不少。
 */
function zhMostly(text) {
  const s = String(text == null ? "" : text);
  if (!/[\u3400-\u9fff]/.test(s)) return false; // 一个汉字都没有，肯定不是中文
  const han = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (!letters) return false;
  // 「中文条目里夹了一句日文/英文」和「这条本来就是日文/英文」是两回事，
  // 光看汉字占比分不开：纯日文摘要 0.23、中文夹英文术语 0.242，几乎一样。
  // 所以加一道前置判断——假名/韩文占到四分之一以上，这条本身就是日文/韩文条目。
  // 中文规矩里引用一句日文界面文案（假名占 0.11）不会被误伤。
  const kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (s.match(/[\uac00-\ud7af]/g) || []).length;
  if ((kana + hangul) / letters > KANA_RATIO_MAX) return false;
  return han / letters >= ZH_RATIO_MIN;
}

/**
 * 把一条 compaction/summary 打分并写进三本书。
 * 纯同步：不 await、不调模型——回调可能会阻塞压缩（计划 §六）。
 */
/**
 * 压缩去重键。正常走 data.compactionId（已核过，每条 compaction/summary 都有）。
 * 取不到时用被压掉的 seq 段拼一个指纹兜底——老日志、别的宿主版本可能没这个字段，
 * 不能因为缺一个字段就让整条摘要不归档。
 */
function compactionKey(data) {
  const direct = String((data && (data.compactionId || data.id)) || "");
  if (direct) return direct;
  const seqs = data && Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];
  if (!seqs.length) return "";
  return `fp-${seqs[0]}-${seqs[seqs.length - 1]}-${seqs.length}`;
}

function archiveCompaction(me, data) {
  const text = summaryText(data);
  if (!text) return;

  // 去重：同一条摘要可能被重复投递（replay、重连）
  const cid = compactionKey(data);
  if (cid) {
    const seen = loadArchive(me);
    if (seen.includes(cid)) return;
    seen.push(cid);
    saveArchive(me, seen);
  }

  const now = Date.now();
  const spans = splitSpans(text);

  // 整条摘要都切不出有效段（每段都短于 8 字）：不能一声不响地走掉。
  // 0.9.6 及更早是直接 return——而 compactionKey 已经写进了 _已归档.json，
  // 同一条摘要再来一次会被当成「归档过了」直接跳过，等于**永久丢失**。
  // 内容确实没信息量（「好的。」「确认。」这类碎片），但「没写」和「写了但很短」是两回事，
  // 读的人有权知道这一次没留下东西。
  if (!spans.length) {
    writeArchive(me, {
      hooks: ["摘要", "未写全", "短段", "切不出"],
      body:
        `本次摘要 ${text.length} 字，切不出有信息量的段（每段都短于 8 字），没有写入任何内容。` +
        `原文：${flatSpan(text, ARCHIVE_BODY_MAX)}`,
      date: fmtTime(now).slice(0, 10),
      sid: `s-${me.slice(0, 8)}`,
      title: "摘要未写全",
    });
    return;
  }

  // 段数：0.9.6 及更早是 splitSpans(text).slice(0, 8)。实测 124 条真摘要
  // （2026-10-26，本机 112 个会话日志）**100% 超过 8 段**，中位 52 段、最多 79 段，
  // 也就是中位丢掉 85% 的内容，而文件里一个字都没说它在丢。
  // 现在按字节预算装：先算装得下多少段，装不下的在最后单独写一节记账。
  // 预算而不是「段数上限」的原因——段有长有短，按段数限会在大段上爆掉保险丝、
  // 在小段上浪费空间；按字节算才和 _压缩存档 的 200KB 是同一把尺子。
  const picked = [];
  let used = 0;
  for (const span of spans) {
    // 预算按**实际要写进去的尺寸**算——也就是截断到 ARCHIVE_BODY_MAX 之后的字节数。
    // 之前按未截断原文算：首段 100KB 时它一个人就吃掉全部预算，后面二十个
    // 本可以全装下的小段（加起来 2200 字节）全被连坐丢掉，记账还说「超出预算」——
    // 理由是假的，那些段本来装得下。
    const size = Buffer.byteLength(flatSpan(span, ARCHIVE_BODY_MAX), "utf8");
    // 第一段无论多大都写（它自己是独立的，writeArchive 那边还有单条保险丝兜着）
    if (picked.length && used + size > ARCHIVE_SPAN_BUDGET) break;
    picked.push(span);
    used += size;
  }
  const overBudget = spans.length - picked.length;

  // 记账必须按**实际写进去的段数**算，不是按「预算内挑出来的段数」。
  // picked 里还有被判 low、或者挑不出钩子而跳过的段落——那些也没写进去。
  // 用 picked.length 当「写入段数」是撒谎：极端情况下 picked 全部被跳过，
  // 一段没写，记账却说「写入前 13 段」。
  let written = 0;
  let blank = 0;
  for (const span of picked) {
    const { tier, hit } = scoreSpan(span);
    if (tier === "low") {
      blank += 1;
      continue;
    }
    const hooks = pickHooks(span);
    if (!hooks.length) {
      blank += 1;
      continue;
    }
    const item = {
      hooks,
      body: flatSpan(span, ARCHIVE_BODY_MAX),
      date: fmtTime(now).slice(0, 10),
      sid: `s-${me.slice(0, 8)}`,
      title: hit,
    };
    // 高分进规则，次档进压缩存档。_本子 从 0.9.1 起只由人写，自动归档不碰它。
    // 非中文为主的降档进存档：规则层要能被直接当规矩读，英文事件叙述不是规矩。
    if (tier === "high" && zhMostly(span)) writeMinorRule(me, item);
    else writeArchive(me, item);
    written += 1;
  }

  // 有段没写进去就单独落一节记账。不记账的丢弃等于丢，而且读的人不知道自己拿到的是残缺的。
  if (overBudget > 0 || blank > 0) {
    const why = [];
    if (overBudget) why.push(`${overBudget} 段超出 ${ARCHIVE_SPAN_BUDGET} 字节预算`);
    if (blank) why.push(`${blank} 段无信息量（没命中规则，也挑不出钩子）`);
    writeArchive(me, {
      hooks: ["摘要", "未写全", "段数", "预算"],
      body:
        `本次摘要共 ${spans.length} 段，写入 ${written} 段；` +
        `其余 ${spans.length - written} 段未写入（${why.join("，")}）` +
        `（摘要原文 ${text.length} 字）。这是截断不是全文，别把它当完整摘要读。`,
      date: fmtTime(now).slice(0, 10),
      sid: `s-${me.slice(0, 8)}`,
      title: "摘要未写全",
    });
  }
}

/** 注入用的那段：两层规则 + 优先级说明。每层空就不出这一节。 */
function rulesForPrompt(me) {
  if (!me) return "";
  const dir = privateDir(me);
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  const extra = read(PRIVATE_BOOKS.rules);
  const minor = read(PRIVATE_BOOKS.minor);
  if (!extra && !minor) return "";
  const clip = (s) =>
    s.length > INJECT_MAX ? `${s.slice(0, INJECT_MAX)}\n\n（已截断，原文 ${s.length} 字）` : s;
  const parts = [
    "本会话的规矩，冲突时从上往下：",
    "1. _额外规则（人写的，最高）",
    "2. _次要规则（自动归纳，和上面冲突时以上面为准）",
    "",
  ];
  if (extra) parts.push("### 额外规则", "", clip(extra), "");
  if (minor) parts.push("### 次要规则", "", clip(minor), "");
  return parts.join("\n").trim();
}

/**
 * 注入是静默的：取不到会话 id 就返回空串，不报错、不提示，看起来和「两层都空」一模一样。
 * 所以第一次组装 prompt 时打一行日志，把入参形态和取到的 id 都记下来——
 * 重启后看一眼就知道注入到底成没成，不用靠猜。
 *
 * 只有「真取到 id」才算验完，之后闭嘴。取不到就记账、接着打（最多 3 次）——
 * 否则第一次赶上一个还没绑定会话的静态形态，日志会定格在「取到id=(空)」，
 * 把后面每一次成功的注入都掩盖掉。
 */
let sectionDiagLeft = 3;
let sectionDiagNth = 0;
let sectionDiagVerified = false;
function sectionText(ctx, arg) {
  let me = "";
  try {
    // 真实入参形态（2026-10-26 实测，别再猜）：这个 text 回调拿到的是
    //   { agent, scope, signal }
    // 会话在 arg.agent.session，arg.session 是 undefined，arg 本身也不是会话。
    // 三路兜底按可能性从高到低排，第二路是实走的那条：
    const session = arg && (arg.session || (arg.agent && arg.agent.session) || arg);
    me = sessionIdOf(session);
  } catch {
    /* 取不到就当空 */
  }
  // 拿到过 id 就闭嘴——日志是为了确认「注入成没成」，成了就不该再刷。
  // 没拿到最多记 3 次，避免第一次赶上未绑定会话的静态形态就定格成「(空)」。
  if (!sectionDiagVerified && (me || sectionDiagLeft > 0)) {
    sectionDiagNth += 1;
    if (me) sectionDiagVerified = true;
    else sectionDiagLeft -= 1;
    let shape = "null";
    if (arg != null && typeof arg === "object") {
      const keys = Object.keys(arg).slice(0, 8).join(",");
      shape = `{${keys}} arg.session=${!!arg.session} arg.agent=${!!arg.agent}`;
    } else if (arg != null) {
      shape = typeof arg;
    }
    // 用 console 不用 ctx.logger：DSH 没给 ctx.logger 挂 console exporter（宿主源码
    // dsh-llm-deepseek-account 里那句 "product profiles mount no console exporter for
    // ctx.logger" 就是证据），logger 只进内存环形缓冲，stdout 里一个字都没有。
    try {
      console.info(`recall: section text 第 ${sectionDiagNth} 次 入参=${shape} 取到id=${me || "(空)"}`);
    } catch {
      /* 日志失败不影响注入 */
    }
  }
  return rulesForPrompt(me);
}

export function apply(ctx) {
  // 压缩时自动归档：宿主把老对话压成摘要的那一刻，把摘要打分写进三本书。
  // 回调里禁止 await 和模型调用——宁可少归档一条，也不能拖慢压缩。
  ctx.on("session/event", (session, event) => {
    try {
      if (!event || event.type !== "compaction/summary") return;
      const me = sessionIdOf(session);
      if (!me) return;
      archiveCompaction(me, event.data || {});
    } catch {
      /* 归档失败不能挡住压缩 */
    }
  });

  ctx.inject(["tools", "systemPrompt"], (sctx) => {
    sctx.effect(() => {
      // 注入：让模型每次组装 prompt 都能看到本会话的两层规矩。
      // 不注入 _本子——它只是资料，要时用 mem_private 读。
      sctx.systemPrompt.section({
        name: "recall:rules",
        order: 90,
        text: (arg) => sectionText(ctx, arg),
      });

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
              ref: { type: "string" },
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
            const ref = sessionRef(exec);
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
              if (ref) dup.s = ref;
              merged = true;
            } else {
              const row = { id: newId(), t: Date.now(), k: kind, x: body };
              if (kw.length) row.w = kw;
              if (goal) row.g = goal;
              if (ref) row.s = ref;
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
              ref,
              text:
                (merged ? `已合并进 ${id}（${scope}）` : `已记下 ${id}（${scope}·${KIND_LABEL[kind]}${tail}）`) +
                (ref ? `，出处 s:${ref.slice(0, 8)}` : "，没取到出处（这条回溯不了原文）") +
                conflict,
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
                const src = r.s ? ` 〔s:${String(r.s).slice(0, 8)}〕` : "";
                const tag = from === "global" && scope !== "global" ? "〔global〕" : "";
                return `[${r.id}] ${tag}${KIND_LABEL[r.k] || r.k}·${agoText(Date.now() - r.t)}：${clip(r.x, 220)}${goal}${kw}${src}`;
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

      dispose.push(
        sctx.tools.register({
          name: "mem_brief",
          description:
            "同步其他会话的动静：距上次同步过了多久、那之后别的会话写了什么新记忆。每个新会话第一轮调一次；调完自动推进同步点。只含写进记忆的事，没写记忆的会话这里看不到。",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              full: { type: "boolean", description: "true = 不看同步点，列最近一天的；默认 false 只看增量。" },
            },
            required: [],
          },
          output: textOK({
            type: "object",
            additionalProperties: false,
            properties: { count: { type: "integer" }, since: { type: "string" }, text: { type: "string" } },
          }),
          async execute(args, exec) {
            const now = Date.now();
            const cursor = loadSync();
            // 第一次同步没有游标：往前看一天，比「从此刻开始」有用。
            const since = args.full ? now - DAY : cursor || now - DAY;
            const me = sessionRef(exec);
            const groups = new Map();
            let total = 0;
            let skipped = 0;
            for (const scope of listScopes()) {
              for (const r of load(scope)) {
                if (r.t <= since) continue;
                // 没出处 = 不知道是哪个会话写的（0.3.1 之前的旧记忆），不算「其他会话的动静」。
                if (!r.s) {
                  skipped += 1;
                  continue;
                }
                // 自己的事自己知道，不用同步回来。
                if (me && r.s === me) continue;
                total += 1;
                const key = r.s + "|" + scope;
                if (!groups.has(key)) groups.set(key, { scope, items: [] });
                groups.get(key).items.push(r);
              }
            }
            const lines = [];
            for (const [key, g] of groups) {
              const sid = key.split("|")[0];
              // 每个会话最多列两条：要的是「大概干了什么」，不是流水账。
              const items = g.items.slice(-2);
              const head = items
                .map((r) => `[${r.id}] ${KIND_LABEL[r.k] || r.k}：${clip(r.x, 110)}`)
                .join("；");
              lines.push(`- ${g.scope}〔s:${sid.slice(0, 8)}〕共 ${g.items.length} 条：${head}`);
            }
            const capped = lines.slice(0, 12);
            const more = lines.length > 12 ? `\n……另有 ${lines.length - 12} 个会话没列。` : "";
            const gap = fmtGap(now - since);
            const note = skipped ? `\n（另有 ${skipped} 条旧记忆没记出处，不计入。）` : "";
            const head = args.full
              ? `最近一天（从 ${fmtTime(since)} 起）`
              : cursor > 0
                ? `距上次同步 ${gap}（${fmtTime(since)}）`
                : `之前没有同步记录，从一天前看起（${fmtTime(since)}）`;
            const body = total
              ? `${head}。之后其他会话做了这些：\n${capped.join("\n")}${more}`
              : `${head}，其他会话没有新记忆。`;
            if (!args.full) saveSync(now);
            // full 只看不动游标，不能说「已推进」。
            const tail = args.full ? "" : `\n同步点已推进到 ${fmtTime(now)}。`;
            // 墙上最近几条：有给你的就标「给你」，没有也列，方便看大家在聊什么。
            const recentWall = loadWall().slice(-3);
            let wallText = "";
            if (recentWall.length) {
              const parts = recentWall.map((r) => {
                const who = String(r.s || "").slice(0, 8) || "?";
                const tag = wallToMe(r, me, scopeOf(exec)) ? "给你" : String(r.to || "all");
                return `- ${fmtTime(r.t)}〔${who}→${tag}〕${clip(r.x, 80)}`;
              });
              wallText = `\n墙上最近 ${recentWall.length} 条：\n${parts.join("\n")}`;
            }
            return {
              count: total,
              since: fmtTime(since),
              text: `${body}${note}${tail}${wallText}`,
            };
          },
        }),
      );

      dispose.push(
        sctx.tools.register({
          name: "mem_source",
          description:
            "顺着一处记忆或会话回到原文：解压那次会话的日志，挑出最相关的几段原话。想知道某条记忆的上下文、或者隔壁会话具体怎么说的时用。",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "记忆 id（mem_find 给的），顺着它的出处取。" },
              session: { type: "string", description: "直接给会话 uuid 或前缀（mem_brief/mem_find 里的 s）。" },
              k: { type: "integer", description: "取几段，默认 3，最多 8。" },
              q: { type: "string", description: "想找什么；不给就用记忆正文当查询。" },
            },
            required: [],
          },
          output: textOK({
            type: "object",
            additionalProperties: false,
            properties: {
              found: { type: "boolean" },
              session: { type: "string" },
              count: { type: "integer" },
              text: { type: "string" },
            },
          }),
          async execute(args) {
            let sid = String(args.session || "").trim().replace(/^session-/, "");
            let query = String(args.q || "").trim();
            if (!sid && args.id) {
              for (const scope of listScopes()) {
                const r = load(scope).find((x) => x.id === String(args.id).trim());
                if (r) {
                  sid = r.s || "";
                  if (!query) query = r.x;
                  break;
                }
              }
            }
            if (!sid) return { found: false, text: "没给会话，也没找到那条记忆的出处——取不了原文。" };
            const file = findSessionFile(sid);
            if (!file) return { found: false, text: `没找到会话 ${sid.slice(0, 8)} 的日志（可能已删除）。` };
            const msgs = readSessionMessages(file);
            const k = Math.max(1, Math.min(8, Number(args.k) || 3));
            const qs = tokensOf(query);
            const scored = msgs.map((m) => {
              const ts = tokensOf(m.text);
              let hit = 0;
              for (const w of qs) if (ts.has(w)) hit += 1;
              return { m, hit };
            });
            scored.sort((a, b) => b.hit - a.hit || a.m.t - b.m.t);
            const picked = scored.filter((x) => x.hit > 0).slice(0, k);
            const block = (x, i) => `[${i + 1}] ${x.m.who} · ${fmtTime(x.m.t)}\n${clip(x.m.text, 500)}`;
            if (!picked.length) {
              const tail = msgs.slice(-k);
              return {
                found: true,
                session: sid.slice(0, 8),
                count: msgs.length,
                text: `会话 ${sid.slice(0, 8)} 共 ${msgs.length} 条消息，没找到和查询相关的片段。最后 ${tail.length} 段：\n\n${tail.map(block).join("\n\n")}`,
              };
            }
            return {
              found: true,
              session: sid.slice(0, 8),
              count: msgs.length,
              text: `会话 ${sid.slice(0, 8)} 共 ${msgs.length} 条消息，最相关的 ${picked.length} 段：\n\n${picked.map(block).join("\n\n")}`,
            };
          },
        }),
      );

      dispose.push(
        sctx.tools.register({
          name: "mem_wall",
          description:
            "会话之间的留言板：想对别的会话说句话（建议、吐槽、提醒、回应）就写上去。不传 say 就是看墙。墙上的留言会在别的会话下次同步（mem_brief）时出现。",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              say: { type: "string", description: "写在墙上的话；不给就是看墙。" },
              to: { type: "string", description: "对哪个会话：s 前缀、工作区名，或 all（所有人）。默认 all。" },
              k: { type: "integer", description: "看几条，默认 8，最多 20。" },
            },
            required: [],
          },
          output: textOK({
            type: "object",
            additionalProperties: false,
            properties: { ok: { type: "boolean" }, count: { type: "integer" }, text: { type: "string" } },
          }),
          async execute(args, exec) {
            const me = sessionRef(exec);
            const scope = scopeOf(exec);
            if (args.say != null) {
              const text = String(args.say || "").trim();
              if (text.length < 8) return { ok: false, text: "太短了——墙上的话至少写清楚一句（8 字以上）。" };
              const to = String(args.to || "all").trim() || "all";
              appendWall({ id: newId(), t: Date.now(), s: me, to, x: clip(text, 500) });
              return { ok: true, text: `写上了（对 ${to}）：${clip(text, 120)}` };
            }
            const rows = loadWall().slice(-Math.max(1, Math.min(20, Number(args.k) || 8)));
            if (!rows.length) return { ok: true, count: 0, text: "墙还是空的。" };
            const parts = rows.map((r) => {
              const who = String(r.s || "").slice(0, 8) || "?";
              const tag = wallToMe(r, me, scope) ? "给你" : String(r.to || "all");
              return `- ${fmtTime(r.t)}〔${who}→${tag}〕${clip(r.x, 200)}`;
            });
            return { ok: true, count: rows.length, text: `墙上最近 ${rows.length} 条：\n${parts.join("\n")}` };
          },
        }),
      );

      sctx.tools.register({
        name: "mem_private",
        description:
          "只给自己的四本：`secret`（默认）记背着别的会话干的事、说的话——不能让它们知道的计划和行动；`rules` 记本会话自己的设定——人设、性格、这条会话特有的规矩，和通用 `_规则` 冲突时以它为准，可以一开始空着，随经历慢慢写；`minor` 记次要规则——宿主压缩对话时自动归纳进来的规矩，权限低于前两本，冲突时让位；`archive` 记压缩存档——压缩摘要里次一档的内容（教训、路径、数字），是资料不是规则，不注入。传 say 就是写，不传就是读。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            say: { type: "string", description: "写一段；不给就是读。" },
            which: {
              type: "string",
              enum: ["secret", "rules", "minor", "archive"],
              description:
                "哪本：secret 记秘密行动（默认），rules 记本会话的额外规则，minor 记自动归纳的次要规则，archive 记压缩存档。",
            },
          },
          required: [],
        },
        output: textOK({
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean" }, count: { type: "integer" }, text: { type: "string" } },
        }),
        async execute(args, exec) {
          const me = sessionRef(exec);
          if (!me) return { ok: false, text: "取不到当前会话身份，写不了。" };
          const which = ["rules", "minor", "archive"].includes(args.which) ? args.which : "secret";
          const dir = privateDir(me);
          const file = path.join(dir, PRIVATE_BOOKS[which]);
          const LABEL = { secret: "本子", rules: "额外规则", minor: "次要规则", archive: "压缩存档" };
          const EMPTY = {
            secret: "本子还是空的。传 say 写第一句。",
            rules: "额外规则还是空的。这里是本会话自己的人设和规矩，可以随时写。",
            minor: "次要规则还是空的。宿主压缩对话时会自动往里写。",
            archive: "压缩存档还是空的。宿主压缩对话时会自动往里写次一档的内容。",
          };
          const label = LABEL[which];
          if (args.say != null) {
            const text = String(args.say || "").trim();
            if (text.length < 4) return { ok: false, text: "太短了，写点真东西。" };
            try {
              fs.mkdirSync(dir, { recursive: true });
              if (which === "minor") {
                // 次要规则是「一条一行 + 钩子」的结构，手工写也走同一套：撞钩子累加、超 30 条淘汰。
                // auto 传 false——人写的不带 [auto]、hits 从 0 起，别混进自动归纳的那堆里。
                // 一行还是 240 字上限（结构要求），但超了要标「原文 N 字」，不静默切半句。
                writeMinorRule(
                  me,
                  {
                    hooks: pickHooks(text),
                    body: flatSpan(text, 240),
                    date: fmtTime(Date.now()).slice(0, 10),
                    sid: `s-${me.slice(0, 8)}`,
                  },
                  false,
                );
              } else if (which === "archive") {
                // 压缩存档走分节结构，手工写也是一节，体积保险丝照样管
                const w = writeArchive(me, {
                  hooks: pickHooks(text),
                  body: text,
                  date: fmtTime(Date.now()).slice(0, 10),
                  sid: `s-${me.slice(0, 8)}`,
                  title: "手工补记",
                });
                if (!w.ok && w.reason === "too-big") {
                  // 整条没写。不截断——砍一半的资料比没写更糟，读的人会拿半条当全文
                  return {
                    ok: true,
                    text: `没写：这一条 ${w.bytes} 字节，超过存档单条上限 ${ARCHIVE_MAX_BYTES} 字节。整条都没落盘，文件头记了一笔。想存就拆成几条短的再写。`,
                  };
                }
              } else {
                fs.appendFileSync(file, `\n## ${fmtTime(Date.now())}\n${text}\n`, "utf8");
              }
            } catch (e) {
              return { ok: false, text: `写不进去：${e.message}` };
            }
            return { ok: true, text: `${label}上记了一笔（${me.slice(0, 8)}）。` };
          }
          let raw = "";
          try {
            raw = fs.readFileSync(file, "utf8");
          } catch {
            return { ok: true, count: 0, text: EMPTY[which] };
          }
          const body = raw.trim();
          const count =
            which === "minor"
              ? parseMinor(raw).length
              : which === "archive"
                ? scanLines(raw).filter((s) => !s.inFence && /^## §\d+ /.test(s.line)).length
                : (body.match(/^## /gm) || []).length;
          return { ok: true, count, text: body || EMPTY[which] };
        },
      });

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
