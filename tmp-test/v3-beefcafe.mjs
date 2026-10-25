// dsh-recall 0.9.7 第三轮定向独立复验（复验者自写，假会话 beefcafe）
// 只读 lib/index.js，不改它。结论只来自本脚本自己构造的输入。
// 运行：
//   C:/Users/41806/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe tmp-test/v3-beefcafe.mjs
// 产物：tmp-test/artifacts-v3-beefcafe/ 下每个用例的落盘快照 + results.json
// 私有目录：~/.dsh/[TheLifeofFish]/private/beefcafe/，脚本自身清理。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
// 复验期间作者把 HEAD 从 e0c9976 推到了 508ee8a/0.10.0，工作区文件也被重写。
// 任务指定的是 e0c9976，所以从 git blob 导出到隔离目录，锁死复验对象（不 import 工作区的 lib）。
const SRC = process.env.V3_SRC || path.join(HERE, "v3-beefcafe-src-e0c9976", "index.mjs");
const TAG = process.env.V3_TAG || "";
const LIB = SRC;
const ART = path.join(HERE, `artifacts-v3-beefcafe${TAG}`);
const { apply } = await import(pathToFileURL(SRC).href);
const ME = "beefcafe"; // 本复验专用假会话前缀，之前没用过
const SID = "session-beefcafe-1111-4222-8333-444444444444";
const PRIV = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME);
const ARCH = path.join(PRIV, "_压缩存档.md");
const MINOR = path.join(PRIV, "_次要规则.md");
const RULES = path.join(PRIV, "_额外规则.md");
const SEEN = path.join(PRIV, "_已归档.json");

const results = [];
let caseSeq = 0;
let cidSeq = 0;

function judge(id, desc, ok, detail = "") {
  const row = { id, desc, ok: !!ok, detail: String(detail || "") };
  results.push(row);
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${desc}${detail ? `  — ${detail}` : ""}`);
}
function observe(id, desc, detail = "") {
  console.log(`OBS   ${id}  ${desc}${detail ? `  — ${detail}` : ""}`);
}

const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const exists = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};
const reset = () => fs.rmSync(PRIV, { recursive: true, force: true });
const cpLen = (s) => Array.from(String(s)).length;
const bytes = (s) => Buffer.byteLength(String(s), "utf8");

function saveCase(id) {
  const dst = path.join(ART, String(id).replace(/[^\w.-]+/g, "_"));
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const [src, name] of [
    [ARCH, "_压缩存档.md"],
    [MINOR, "_次要规则.md"],
    [RULES, "_额外规则.md"],
    [SEEN, "_已归档.json"],
  ]) {
    if (exists(src)) {
      fs.copyFileSync(src, path.join(dst, name));
      n += 1;
    }
  }
  if (!n) fs.writeFileSync(path.join(dst, "_empty.txt"), "本用例结束时没有落盘文件。\n", "utf8");
}

async function withCase(id, fn) {
  reset();
  try {
    await fn();
  } catch (e) {
    judge(`${id}.exception`, "用例自身没有抛异常", false, (e && e.stack) || String(e));
  }
  saveCase(id);
}

// ---------- 假 ctx：只按任务给的形态驱动 ----------
const handlers = {};
const tools = {};
let sectionDef = null;
apply({
  logger: { info() {}, error() {} },
  on(ev, fn) {
    handlers[ev] = fn;
  },
  inject(_deps, cb) {
    cb({
      effect(fn) {
        return fn();
      },
      tools: {
        register(def) {
          tools[def.name] = def;
          return () => {};
        },
      },
      systemPrompt: {
        section(def) {
          sectionDef = def;
          return () => {};
        },
      },
    });
  },
});
if (!handlers["session/event"]) throw new Error("没有捕获到 session/event handler");
if (!tools.mem_private) throw new Error("没有捕获到 tools");
const exec = { agent: { session: { header: { id: SID } } } };

function feed(blocks, cid) {
  handlers["session/event"](
    { header: { id: SID } },
    {
      type: "compaction/summary",
      data: { compactionId: cid || `v3-${++cidSeq}-beefcafe`, summary: blocks.map((text) => ({ text })) },
    },
  );
  return read(ARCH);
}
const archiveSay = (say) => tools.mem_private.execute({ which: "archive", say }, exec);
const minorSay = (say) => tools.mem_private.execute({ which: "minor", say }, exec);
const rulesSay = (say) => tools.mem_private.execute({ which: "rules", say }, exec);
const injectedPrompt = () => (sectionDef ? sectionDef.text({ agent: { session: { header: { id: SID } } } }) : "");

// ---------- 复验者自己的解析/检测（不调用插件内部函数） ----------
const EOL_RE = /\r\n|[\r\n\u2028\u2029]/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

function scan(raw) {
  const out = [];
  let fence = "";
  for (const rawLine of String(raw == null ? "" : raw).split(EOL_RE)) {
    const f = rawLine.match(FENCE_RE);
    let inFence = false;
    if (fence) {
      inFence = true;
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = "";
    } else if (f) {
      fence = f[1];
      inFence = true;
    }
    out.push({ line: rawLine, inFence });
  }
  return out;
}

function sectionHeads(raw) {
  const out = [];
  scan(raw).forEach((x, i) => {
    if (x.inFence) return;
    const m = x.line.match(/^## §(\d+) /);
    if (m) out.push({ n: Number(m[1]), i });
  });
  return out;
}
const sectionNums = (raw) => sectionHeads(raw).map((h) => h.n);

function hookRows(raw) {
  const rows = [];
  for (const x of scan(raw)) {
    if (x.inFence) continue;
    if (/^## §\d+ /.test(x.line)) break;
    const m = x.line.match(/^\| ([^|]+) \| §(\d+) \|$/);
    if (!m) continue;
    if (m[1].trim() === "钩子") continue;
    rows.push({ hooks: m[1].trim(), at: Number(m[2]) });
  }
  return rows;
}

function fenceFlagsOf(raw, needle) {
  return scan(raw)
    .filter((x) => x.line.includes(needle))
    .map((x) => x.inFence);
}

function sectionBody(raw, n) {
  const lines = scan(raw);
  const heads = sectionHeads(raw);
  const idx = heads.findIndex((h) => h.n === n);
  if (idx < 0) return "";
  const end = idx + 1 < heads.length ? heads[idx + 1].i : lines.length;
  let body = lines.slice(heads[idx].i + 1, end).map((x) => x.line);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  let content = body.join("\n");
  let fenced = false;
  if (body.length >= 2) {
    const open = body[0].match(FENCE_RE);
    const close = body[body.length - 1].match(FENCE_RE);
    const okClose = !!open && !!close && open[1][0] === close[1][0] && close[1].length >= open[1].length;
    if (okClose) {
      fenced = true;
      content = body.slice(1, -1).join("\n");
    }
  }
  return { fenced, body: content, lines: body };
}

// 字素完整性检测（只看落盘文本）
const PICT_RE = /\p{Extended_Pictographic}/u;
const RI_RE = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const M_RE = /\p{M}/u;
const isPict = (c) => !!c && PICT_RE.test(c);
const isRI = (c) => !!c && RI_RE.test(c);
const isMod = (c) => !!c && c >= "\u{1F3FB}" && c <= "\u{1F3FF}";
const isM = (c) => !!c && M_RE.test(c);
const isVS = (c) => c === "\uFE0E" || c === "\uFE0F";

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true;
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** 返回写坏的「半个字素」清单。 */
function badGraphemes(text) {
  const cs = Array.from(String(text));
  const bad = [];
  const note = (i, kind) =>
    bad.push({ kind, ctx: cs.slice(Math.max(0, i - 4), i + 5).join("") });
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === "\u200d") {
      if (!isPict(cs[i - 1]) || !isPict(cs[i + 1])) note(i, "悬挂 ZWJ");
    } else if (isRI(c)) {
      if (!isRI(cs[i - 1])) {
        if (isRI(cs[i + 1])) i += 1; // 成对
        else note(i, "孤立区域指示符");
      }
    } else if (isMod(c)) {
      if (!isPict(cs[i - 1])) note(i, "孤立肤色修饰符");
    } else if (isM(c)) {
      const prev = cs[i - 1];
      if (!prev || isM(prev) || /\s/.test(prev)) {
        if (!prev || /\s/.test(prev)) note(i, "孤立组合字符");
      }
    } else if (isVS(c)) {
      const prev = cs[i - 1];
      if (!prev || /\s/.test(prev) || isVS(prev)) note(i, "孤立变体选择符");
    }
  }
  return bad;
}

const sha256 = crypto.createHash("sha256").update(fs.readFileSync(LIB)).digest("hex");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });
reset();

console.log("# dsh-recall 0.9.7 第三轮独立复验（假会话 beefcafe）");
console.log(`# 复验对象（git blob 导出，不读工作区 lib）=${SRC}`);
console.log(`# lib=${LIB}`);
console.log(`# lib sha256=${sha256} bytes=${fs.statSync(LIB).size}`);
console.log(`# 私有目录=${PRIV}`);
console.log("");

const LEGACY_HEAD = (hook) => [
  "# 压缩存档",
  "",
  "> 已按体积淘汰 0 节 · 最新 —",
  "",
  "| 钩子 | 指向 |",
  "| --- | --- |",
  ...(hook ? [`| ${hook} | §1 |`] : []),
  "",
];
const NEW_REC = "新记录：端口 4002，路径 D:/new.log。";

// =====================================================================
// 根因 A：旧档正文自带围栏时伪节升格 —— 多方向变体
// =====================================================================

// A1：题面基准（文字 → js 代码块 → 伪节）。上一轮声称已修的形态。
await withCase("A1-fence-before-pseudo", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      ...LEGACY_HEAD("旧钩子"),
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "旧正文第一行，端口 4001。",
      "",
      "```js",
      'console.info("旧代码");',
      "```",
      "",
      "## §999 伪节",
      "",
      "伪节下面的内容",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  const sec1 = sectionBody(out, 1);
  judge("A1", "文字→代码块→伪节：节号 1,2 且伪节被包进围栏", nums.join(",") === "1,2" && flags.length === 1 && flags.every(Boolean) && sec1.fenced, `节号=${nums.join(",")}；伪节在围栏内=${JSON.stringify(flags)}；§1 有围栏=${sec1.fenced}`);
});

// A2：代码块在伪节之后（伪节紧跟一个 js 代码块）
await withCase("A2-fence-after-pseudo", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      ...LEGACY_HEAD("旧钩子"),
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "旧正文第一行，端口 4001。",
      "",
      "## §999 伪节",
      "",
      "伪节下面贴着一个代码块：",
      "```js",
      'console.info("伪节里的代码");',
      "```",
      "",
      "伪节尾注。",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  const rows = hookRows(out);
  judge(
    "A2",
    "伪节后紧跟代码块时，伪节不升格（节号 1,2）",
    nums.join(",") === "1,2",
    `实际节号=${nums.join(",")}；伪节围栏=${JSON.stringify(flags)}；钩子行=${JSON.stringify(rows.map((r) => `§${r.at}`))}`,
  );
  judge("A2b", "伪节留在 §1 正文里（围栏内）", flags.length === 1 && flags.every(Boolean), `伪节出现 ${flags.length} 次，围栏内=${JSON.stringify(flags)}`);
});

// A3：正文第一行就是代码块，伪节在代码块之后
await withCase("A3-fence-first", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      ...LEGACY_HEAD("旧钩子"),
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "```js",
      'console.info("正文开头就是代码块");',
      "```",
      "",
      "## §999 伪节",
      "",
      "伪节下面的内容",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  judge("A3", "旧档正文以代码块开头时伪节仍不升格（节号 1,2）", nums.join(",") === "1,2", `实际节号=${nums.join(",")}；伪节围栏=${JSON.stringify(flags)}；§1 有围栏=${sectionBody(out, 1).fenced}`);
});

// A4：更长反引号（4 个）围栏，伪节在闭合围栏之后且后面跟一个代码块
await withCase("A4-long-fence", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      ...LEGACY_HEAD("旧钩子"),
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "先一段旧正文，端口 4001。",
      "",
      "````js",
      'console.info("四反引号围栏");',
      "````",
      "",
      "## §999 伪节",
      "",
      "伪节里还嵌着三反引号代码块：",
      "```js",
      'console.info("inside pseudo");',
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  judge("A4", "更长反引号围栏 + 伪节后跟代码块：节号 1,2", nums.join(",") === "1,2", `实际节号=${nums.join(",")}；伪节围栏=${JSON.stringify(flags)}`);
});

// A5：正文里两段围栏，伪节在第二段围栏之后
await withCase("A5-two-fences", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      ...LEGACY_HEAD("旧钩子"),
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "```js",
      'console.info("第一段");',
      "```",
      "",
      "两段围栏之间的说明，端口 4001。",
      "",
      "```js",
      'console.info("第二段");',
      "```",
      "",
      "## §999 伪节",
      "",
      "伪节后跟第三段代码块：",
      "```js",
      'console.info("第三段");',
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  judge("A5", "两段围栏之后跟伪节：节号 1,2", nums.join(",") === "1,2", `实际节号=${nums.join(",")}；伪节围栏=${JSON.stringify(flags)}`);
});

// A6：旧档多节（§1 §2 都无围栏正文），§1 里伪节后跟代码块
await withCase("A6-multi-legacy", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      "# 压缩存档",
      "",
      "> 已按体积淘汰 0 节 · 最新 —",
      "",
      "| 钩子 | 指向 |",
      "| --- | --- |",
      "| 旧钩子一 | §1 |",
      "| 旧钩子二 | §2 |",
      "",
      "## §1 旧节一 · 2026-10-20 · s-old",
      "",
      "第一节正文，端口 4001。",
      "",
      "## §999 伪节",
      "",
      "伪节里贴代码块：",
      "```js",
      'console.info("pseudo");',
      "```",
      "",
      "## §2 旧节二 · 2026-10-21 · s-old",
      "",
      "第二节正文，端口 4003。",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  const rows = hookRows(out);
  judge(
    "A6",
    "旧档多节时 §1 里的伪节不升格，节号 1,2,3",
    nums.join(",") === "1,2,3",
    `实际节号=${nums.join(",")}；伪节围栏=${JSON.stringify(flags)}；钩子行=${JSON.stringify(rows.map((r) => `§${r.at}`))}`,
  );
});

// A7：伪节号「连续」（§1 里写 ## §2），作者的连续性判据分不出
await withCase("A7-consecutive-pseudo", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [...LEGACY_HEAD("旧钩子"), "## §1 旧节 · 2026-10-20 · s-old", "", "旧正文，端口 4001。", "", "## §2 正文里的小标题", "", "这句是 §1 的正文，不是新节。", ""].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  judge(
    "A7",
    "伪节号连续（## §2）时仍应留在 §1 正文里，节号 1,2",
    nums.join(",") === "1,2",
    `实际节号=${nums.join(",")}（伪节被当成真节的表现）`,
  );
});

// A8：旧档正文里有一个未闭合围栏，吞掉后面的 §2
await withCase("A8-unclosed-fence", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      "# 压缩存档",
      "",
      "> 已按体积淘汰 0 节 · 最新 —",
      "",
      "| 钩子 | 指向 |",
      "| --- | --- |",
      "| 旧钩子 | §1 |",
      "",
      "## §1 旧节一 · 2026-10-20 · s-old",
      "",
      "第一节正文，端口 4001。",
      "",
      "```js",
      'console.info("这个围栏没有关闭");',
      "",
      "## §2 旧节二 · 2026-10-21 · s-old",
      "",
      "第二节正文，端口 4003。",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const old2Flags = fenceFlagsOf(out, "## §2 旧节二");
  judge("A8", "旧档未闭合围栏不吞掉后面的 §2（节号 1,2,3）", nums.join(",") === "1,2,3", `实际节号=${nums.join(",")}；旧 §2 标题出现 ${old2Flags.length} 次，围栏内=${JSON.stringify(old2Flags)}`);
});

// A9：新格式档（插件自己写的）正文围栏内有 ## §999，再写一次不升格
await withCase("A9-own-new-format", async () => {
  await archiveSay(["第一段正文，端口 4001。", "", "```js", 'x();', "```", "", "## §999 正文里的小标题", "", "这段也是正文。"].join("\n"));
  const before = sectionNums(read(ARCH));
  const out = feed([NEW_REC]);
  const after = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999");
  judge("A9", "插件自己写的节里带 ## §999，再写一次不升格", before.join(",") === "1" && after.join(",") === "1,2" && flags.every(Boolean), `首次=${before.join(",")} 再次=${after.join(",")}；伪节围栏=${JSON.stringify(flags)}`);
});

// A10：单节旧档，伪节标题后**紧跟**代码块（无中间文字）
await withCase("A10-pseudo-then-fence", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      ...LEGACY_HEAD("旧钩子"),
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "旧正文第一行，端口 4001。",
      "",
      "## §999 伪节",
      "",
      "```js",
      'console.info("伪节里的代码");',
      "```",
      "",
      "伪节尾注。",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  judge("A10", "伪节标题后紧跟代码块时伪节不升格（节号 1,2）", nums.join(",") === "1,2", `实际节号=${nums.join(",")}；伪节围栏=${JSON.stringify(flags)}`);
});

// A11：4 反引号围栏之后，伪节标题后紧跟 3 反引号代码块
await withCase("A11-long-then-short", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      ...LEGACY_HEAD("旧钩子"),
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "先一段旧正文，端口 4001。",
      "",
      "````js",
      'console.info("四反引号围栏");',
      "````",
      "",
      "## §999 伪节",
      "",
      "```js",
      'console.info("伪节里的代码");',
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  judge("A11", "更长反引号围栏之后，伪节后紧跟代码块：节号 1,2", nums.join(",") === "1,2", `实际节号=${nums.join(",")}；伪节围栏=${JSON.stringify(flags)}`);
});

// A12：两段围栏之后，伪节标题后紧跟代码块
await withCase("A12-two-fences-then-pseudo", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      ...LEGACY_HEAD("旧钩子"),
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "```js",
      'console.info("第一段");',
      "```",
      "",
      "两段围栏之间的说明，端口 4001。",
      "",
      "```js",
      'console.info("第二段");',
      "```",
      "",
      "## §999 伪节",
      "",
      "```js",
      'console.info("第三段");',
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  judge("A12", "两段围栏之后伪节后紧跟代码块：节号 1,2", nums.join(",") === "1,2", `实际节号=${nums.join(",")}；伪节围栏=${JSON.stringify(flags)}`);
});

// A13：多节旧档（§1 §2 都无围栏正文），§1 里伪节标题后紧跟代码块
await withCase("A13-multi-then-fence", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      "# 压缩存档",
      "",
      "> 已按体积淘汰 0 节 · 最新 —",
      "",
      "| 钩子 | 指向 |",
      "| --- | --- |",
      "| 旧钩子一 | §1 |",
      "| 旧钩子二 | §2 |",
      "",
      "## §1 旧节一 · 2026-10-20 · s-old",
      "",
      "第一节正文，端口 4001。",
      "",
      "## §999 伪节",
      "",
      "```js",
      'console.info("pseudo");',
      "```",
      "",
      "## §2 旧节二 · 2026-10-21 · s-old",
      "",
      "第二节正文，端口 4003。",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  const rows = hookRows(out);
  judge("A13", "多节旧档 + 伪节后紧跟代码块：节号 1,2,3", nums.join(",") === "1,2,3", `实际节号=${nums.join(",")}；伪节围栏=${JSON.stringify(flags)}；钩子行=${JSON.stringify(rows.map((r) => `§${r.at}`))}`);
});

// =====================================================================
// 根因 B：手工 archive 写极短内容，钩子表不能出空单元格 / 不能丢行
// =====================================================================

await withCase("B-hooks", async () => {
  const r1 = await archiveSay("必须要的");
  const a1 = read(ARCH);
  const rows1 = hookRows(a1);
  const emptyCell = /\|\s{2,}\|\s*§\d+\s*\|/.test(a1) || /\|\s*\|\s*§\d+\s*\|/.test(a1);
  judge(
    "B1",
    "第一次手工写 4 字内容后：无空单元格，§1 有能解析回来的非空钩子",
    !emptyCell && rows1.length === 1 && rows1[0].at === 1 && rows1[0].hooks.trim().length > 0,
    `钩子行=${JSON.stringify(rows1)} 空单元格=${emptyCell} 返回=${JSON.stringify(r1).slice(0, 120)}`,
  );
  const sec1 = sectionBody(a1, 1);
  judge("B1b", "§1 正文在围栏内且是原文", sec1.fenced && sec1.body === "必须要的", `fenced=${sec1.fenced} body=${JSON.stringify(sec1.body)}`);

  await archiveSay("必须要的");
  const a2 = read(ARCH);
  const rows2 = hookRows(a2);
  judge(
    "B2",
    "第二次写入后 §1、§2 的钩子行都还在，都能解析",
    rows2.length === 2 && new Set(rows2.map((r) => r.at)).size === 2 && rows2.every((r) => r.hooks.length > 0),
    `钩子行=${JSON.stringify(rows2)}`,
  );

  await archiveSay("必须要的");
  const a3 = read(ARCH);
  const rows3 = hookRows(a3);
  const nums3 = sectionNums(a3);
  judge(
    "B3",
    "第三次写入后三个节的钩子行都在（无空单元格）",
    rows3.length === 3 && rows3.map((r) => r.at).join(",") === "1,2,3" && nums3.join(",") === "1,2,3",
    `钩子行=${JSON.stringify(rows3)} 节号=${nums3.join(",")}`,
  );
  const countRead = await tools.mem_private.execute({ which: "archive" }, exec);
  judge("B4", "mem_private 读回 count 与文件实际节数一致", countRead.count === nums3.length, `返回 count=${countRead.count} 实际节数=${nums3.length}`);
});

// B5（额外）：钩子文本恰好等于表头「钩子」时，钩子行会被 parseHookTable 当表头丢掉
await withCase("B5-hook-eq-header", async () => {
  await archiveSay("钩子了钩子了");
  const a1 = read(ARCH);
  const tableLines1 = scan(a1).filter((x) => !x.inFence && /^\| .* \| §\d+ \|$/.test(x.line)).map((x) => x.line);
  const rows1 = hookRows(a1);
  await archiveSay("必须要的好");
  const a2 = read(ARCH);
  const tableLines2 = scan(a2).filter((x) => !x.inFence && /^\| .* \| §\d+ \|$/.test(x.line)).map((x) => x.line);
  const rows2 = hookRows(a2);
  const nums2 = sectionNums(a2);
  observe("B5.file", "第一次写入后文件里的表格行", JSON.stringify(tableLines1));
  observe("B5.parse", "第一次解析回来的钩子行", JSON.stringify(rows1));
  judge(
    "B5",
    "手工内容挑出「钩子」这个钩子时，§1 的钩子行不能被当表头丢掉",
    tableLines1.length === 1 && rows1.length === 1,
    `表格行=${JSON.stringify(tableLines1)} 解析到=${JSON.stringify(rows1)}`,
  );
  judge(
    "B5b",
    "第二次写入后 §1、§2 的钩子行都在",
    tableLines2.length === 2 && rows2.length === 2 && nums2.join(",") === "1,2",
    `表格行=${JSON.stringify(tableLines2)} 解析到=${JSON.stringify(rows2)} 节号=${nums2.join(",")}`,
  );
});

// =====================================================================
// 根因 C：1200 字切点落在多码点字素里
// =====================================================================

const G = {
  family: "👨\u200d👩\u200d👧",
  heart: "❤️",
  acute: "e\u0301",
  flag: "🇨🇳",
  thumb: "👍🏽",
};

function buildCut(max, grapheme, cutOffset, suffixLen = 12) {
  const suffix = "B".repeat(suffixLen);
  let d = 4;
  let raw = "";
  for (let iter = 0; iter < 6; iter++) {
    const keep = max - (8 + d);
    const prefix = keep - cutOffset;
    raw = "A".repeat(Math.max(0, prefix)) + grapheme + suffix;
    const nd = String(raw.length).length;
    if (nd === d) break;
    d = nd;
  }
  return raw;
}

const C_CASES = [
  ["C1-family-mid", G.family, 2, "👨‍👩‍👧 中间（切在 ZWJ 与 👩 之间）"],
  ["C2-family-start", G.family, 0, "👨‍👩‍👧 开头（切在整字素前）"],
  ["C3-heart-mid", G.heart, 1, "❤️ 中间（U+2764 与 U+FE0F 之间）"],
  ["C4-acute-mid", G.acute, 1, "e+U+0301 中间（base 与组合符号之间）"],
  ["C5-flag-mid", G.flag, 1, "🇨🇳 中间（两个区域指示符之间）"],
  ["C6-flag-start", G.flag, 0, "🇨🇳 开头"],
  ["C7-thumb-mid", G.thumb, 1, "👍🏽 中间（base 与肤色修饰符之间）"],
];

for (const [id, grapheme, offset, desc] of C_CASES) {
  await withCase(id, async () => {
    const raw = buildCut(1200, grapheme, offset);
    feed([raw]);
    const arch = read(ARCH);
    const minor = read(MINOR);
    const all = arch + minor;
    const sec = sectionBody(arch, 1);
    const bad = badGraphemes(sec.body);
    const fffd = all.includes("\uFFFD");
    const lone = hasLoneSurrogate(all);
    const prefixKept = sec.body.startsWith("A");
    observe(
      `${id}.where`,
      `切点在${desc}；落盘 §1 正文 ${cpLen(sec.body)} 码点`,
      `尾部=${JSON.stringify(Array.from(sec.body).slice(-14).join(""))}`,
    );
    judge(
      id,
      `${desc}：文件里没有半个字素（无悬挂/孤立代理/U+FFFD）`,
      !bad.length && !fffd && !lone,
      `字素问题=${JSON.stringify(bad)} U+FFFD=${fffd} 孤立代理=${lone} 前缀保留=${prefixKept}`,
    );
  });
}

// C8：切点处是 emoji 修饰符前面已经完整（suffix 里放），确认不误报
await withCase("C8-emoji-intact-240", async () => {
  // 手工 minor 的 240 字上限，切点落在 🇨🇳 中间（suffix 拉长到确实触发截断）
  const raw = buildCut(240, G.flag, 1, 12);
  await minorSay(raw);
  const minor = read(MINOR);
  const m = minor.match(/^- \[钩子: [^\]]*\] (.*?) — \d{4}-\d{2}-\d{2} · s-[0-9a-f]{1,8}/m);
  const body = m ? m[1] : "";
  const bad = badGraphemes(body);
  const truncated = body.includes("…（原文");
  judge(
    "C8",
    "手工 minor 240 字切点落在 🇨🇳 中间时不留悬挂区域指示符",
    truncated && !bad.length,
    `确实截断=${truncated} 字素问题=${JSON.stringify(bad)} 尾部=${JSON.stringify(Array.from(body).slice(-12).join(""))}`,
  );
});

// =====================================================================
// 额外方向：记账被正文劫持、注入截断、行终止符、体积淘汰、超长单条
// =====================================================================

// D1：正文里的「已按体积淘汰 N 节」被当成文件头记账
await withCase("D1-trim-head-injection", async () => {
  const body = ["手工补记正文第一行，端口 4001。", "> 已按体积淘汰 777 节 · 最新 2020-01-01", "最后一行。"].join("\n");
  await archiveSay(body);
  const before = read(ARCH);
  const headBefore = (before.match(/^> 已按体积淘汰 .*$/m) || [""])[0];
  await archiveSay("第二条手工记录，端口 4002。");
  const after = read(ARCH);
  const headAfter = (after.match(/^> 已按体积淘汰 .*$/m) || [""])[0];
  const nums = sectionNums(after);
  observe("D1.head", "写入前后文件头「已按体积淘汰」那一行", `before=${JSON.stringify(headBefore)} after=${JSON.stringify(headAfter)}`);
  judge(
    "D1",
    "正文里的假「已按体积淘汰」行不能改写文件头记账",
    headAfter.includes("0 节") && !headAfter.includes("777"),
    `实际头=${JSON.stringify(headAfter)}（没有任何节被淘汰，节号=${nums.join(",")}）`,
  );
});

// D2：注入 prompt 的 4000 字截断切坏代理对
await withCase("D2-inject-clip", async () => {
  const text = "A".repeat(3979) + "😀" + "B".repeat(20);
  await rulesSay(text);
  const fileBody = read(RULES).trim();
  const injected = injectedPrompt();
  const lone = hasLoneSurrogate(injected);
  const fffd = injected.includes("\uFFFD");
  const cutCtx = Array.from(injected).slice(-16).join("");
  observe("D2", `_额外规则 文件 ${fileBody.length} 字符；注入 ${injected.length} 字符`, `注入尾部=${JSON.stringify(cutCtx)}`);
  judge("D2", "注入截断在 4000 字上限时不切出半个代理对", !lone && !fffd, `孤立代理=${lone} U+FFFD=${fffd} 尾部=${JSON.stringify(cutCtx)}`);
});

// D3：四种行终止符
await withCase("D3-ls-2028-legacy", async () => {
  const EOL = "\u2028";
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    ["# 压缩存档", "", "> 已按体积淘汰 0 节 · 最新 —", "", "## §1 旧节 · 2026-10-20 · s-old", "", "旧正文第一行，端口 4001。", "## §999 伪节", "伪节内容", ""].join(EOL),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  judge("D3", "旧档用 U+2028 分行时伪节不升格（节号 1,2）", nums.join(",") === "1,2" && flags.every(Boolean), `节号=${nums.join(",")} 伪节围栏=${JSON.stringify(flags)}`);
});

await withCase("D3b-crlf-fence-after-pseudo", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      ...LEGACY_HEAD("旧钩子"),
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "旧正文，端口 4001。",
      "",
      "## §999 伪节",
      "",
      "伪节后跟代码块：",
      "```js",
      "x();",
      "```",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  judge("D3b", "CRLF 旧档 + 伪节后跟代码块：节号仍 1,2", nums.join(",") === "1,2", `实际节号=${nums.join(",")}`);
});

await withCase("D3c-split-spans-u2028", async () => {
  const blocks = ["第一段：端口 4001。" + "\u2028\u2028" + "第二段：路径 D:/x.log。"];
  feed(blocks);
  const out = read(ARCH);
  const nums = sectionNums(out);
  judge("D3c", "摘要内用 U+2028 空行分隔时切成两节", nums.join(",") === "1,2", `节号=${nums.join(",")}`);
});

await withCase("D3d-cr-only-legacy", async () => {
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(
    ARCH,
    ["# 压缩存档", "", "> 已按体积淘汰 0 节 · 最新 —", "", "## §1 旧节 · 2026-10-20 · s-old", "", "旧正文第一行，端口 4001。", "## §999 伪节", "伪节内容", ""].join("\r"),
    "utf8",
  );
  const out = feed([NEW_REC]);
  const nums = sectionNums(out);
  const flags = fenceFlagsOf(out, "## §999 伪节");
  judge("D3d", "旧档用单 \\r 分行时伪节不升格（节号 1,2）", nums.join(",") === "1,2" && flags.every(Boolean), `节号=${nums.join(",")} 伪节围栏=${JSON.stringify(flags)}`);
});

// D4：体积淘汰记账与实际节数一致
await withCase("D4-trim-bookkeeping", async () => {
  // 手写一个接近 200KB 的旧档（新格式，每节有围栏），再写一条触发淘汰
  const head = [
    "# 压缩存档",
    "",
    "> 压缩摘要里次一档的内容（教训、路径、数字）。是资料不是规则，**不注入**，要用 `mem_private` 读。",
    "> 上面是钩子表，下面是分节正文；`§N` 是节号，删节时钩子表同步删行。",
    "> 已按体积淘汰 0 节 · 最新 —",
    "",
  ];
  const rows = ["| 钩子 | 指向 |", "| --- | --- |"];
  const secs = [];
  const per = 9000;
  for (let i = 1; i <= 24; i++) {
    rows.push(`| 钩子${i} | §${i} |`);
    secs.push(`## §${i} 旧节${i} · 2026-10-20 · s-old\n\n\`\`\`text\n${"旧".repeat(per)}\n\`\`\``);
  }
  fs.mkdirSync(PRIV, { recursive: true });
  fs.writeFileSync(ARCH, [...head, ...rows, "", ...secs, ""].join("\n"), "utf8");
  const beforeBytes = bytes(read(ARCH));
  const beforeNums = sectionNums(read(ARCH));
  // 手工写一条 1200 字左右的新节，触发保险丝
  await archiveSay("新写的一条，端口 4002。" + "新".repeat(1200));
  const after = read(ARCH);
  const afterNums = sectionNums(after);
  const trimmedLine = (after.match(/^> 已按体积淘汰 (\d+) 节 · 最新 (.+)$/m) || [])[0] || "";
  const m = trimmedLine.match(/已按体积淘汰 (\d+) 节/);
  const claimed = m ? Number(m[1]) : 0;
  const actuallyGone = beforeNums.length + 1 - afterNums.length;
  const rowsAfter = hookRows(after);
  judge(
    "D4",
    "体积淘汰的节数记账与实际消失的节数一致",
    claimed === actuallyGone && afterNums.length === beforeNums.length + 1 - actuallyGone && rowsAfter.length === afterNums.length,
    `写入前 ${beforeBytes} 字节 ${beforeNums.length} 节；写入后 ${bytes(after)} 字节 ${afterNums.length} 节；记账淘汰 ${claimed} 节；实际少了 ${actuallyGone} 节；钩子行 ${rowsAfter.length} 条`,
  );
});

// D5：单条超 200KB 拒写时，已有正文一个字节不动
await withCase("D5-overs", async () => {
  await archiveSay("第一条，端口 4001。");
  const before = read(ARCH);
  const beforeBody = before.slice(before.indexOf("## §"));
  const huge = "超大内容，端口 4002。" + "Z".repeat(210 * 1024);
  const r = await archiveSay(huge);
  const after = read(ARCH);
  const afterBody = after.slice(after.indexOf("## §"));
  const oversLine = (after.match(/^> 有 \d+ 条超 \d+ 字节上限未写入.*$/m) || [""])[0];
  const nums = sectionNums(after);
  judge("D5", "单条超 200KB 整条拒写，已有正文逐字节不变", r.ok === true && afterBody === beforeBody && nums.join(",") === "1", `返回=${JSON.stringify(r)} 节号=${nums.join(",")} 正文不变=${afterBody === beforeBody}`);
  judge("D5b", "拒写后文件头记了一笔超限账", /^> 有 1 条超 \d+ 字节上限未写入 · 合计 \d+ 字节/.test(oversLine), `头行=${JSON.stringify(oversLine)}`);
  // 再写一条正常记录：超限账是否保留
  await archiveSay("第二条正常记录，端口 4003。");
  const after2 = read(ARCH);
  const overs2 = (after2.match(/^> 有 \d+ 条超 \d+ 字节上限未写入.*$/m) || [""])[0];
  judge("D5b2", "下一次正常写入后超限账仍在", /^> 有 1 条超/.test(overs2), `头行=${JSON.stringify(overs2)}`);
});

// D6：空输入 / 全部过滤
await withCase("D6-empty", async () => {
  feed([]);
  const a0 = read(ARCH);
  observe("D6.empty", "空 summary 后存档是否存在", exists(ARCH) ? JSON.stringify(a0.slice(0, 40)) : "不存在");
  feed(["好。"]);
  const a1 = read(ARCH);
  const nums1 = sectionNums(a1);
  judge("D6", "空摘要不写垃圾；全短段摘要仍落记账节", !a0 && nums1.join(",") === "1" && a1.includes("短于 8 字"), `空后=${JSON.stringify(a0)} 短段后节号=${nums1.join(",")}`);
});

// D7：首次写入就是超 200KB 时文件头是否完整
await withCase("D7-overs-first-write", async () => {
  const huge = "超大内容，端口 4001。" + "Z".repeat(210 * 1024);
  await archiveSay(huge);
  const out = read(ARCH);
  const hasTitle = /^# 压缩存档/m.test(out);
  const hasHookHeader = out.includes("| 钩子 | 指向 |");
  const oversLine = (out.match(/^> 有 \d+ 条超 \d+ 字节上限未写入.*$/m) || [""])[0];
  judge("D7", "首次就超限时文件仍是一份有头的存档", hasTitle && hasHookHeader && /^> 有 1 条超/.test(oversLine), `有标题=${hasTitle} 有钩子表头=${hasHookHeader} 头行=${JSON.stringify(oversLine)} 全文=${JSON.stringify(out.slice(0, 120))}`);
});

// =====================================================================
// 汇总
// =====================================================================
const pass = results.filter((r) => r.ok).length;
const fails = results.filter((r) => !r.ok);
console.log("");
console.log(`# 合计 ${results.length} 条断言：PASS ${pass} / FAIL ${fails.length}`);
for (const f of fails) console.log(`FAIL  ${f.id}  ${f.desc}  — ${f.detail}`);
fs.writeFileSync(path.join(ART, "results.json"), JSON.stringify({ sha256, results }, null, 2), "utf8");
console.log(`# 结果 JSON: ${path.join(ART, "results.json")}`);

// 清理本复验自己的私有目录（用户要求跑完自己删）
reset();
console.log(`# 私有目录已清理: ${!fs.existsSync(PRIV)}`);
