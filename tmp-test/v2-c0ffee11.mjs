// dsh-recall 0.9.7 第二轮独立复验（复验者自写，会话 c0ffee11）
// 目标：不看作者报告，只用自己的输入构造，找坏状态。
// 运行：
//   node tmp-test/v2-c0ffee11.mjs
// 产物：tmp-test/artifacts-v2-c0ffee11/ 下每个用例的存档快照；结果 JSON 同目录。
// 说明：本脚本只读 lib/index.js，不改它；私有目录用假会话 c0ffee11，跑完删除。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const LIB = path.join(PLUGIN_ROOT, "lib", "index.js");
const ART = path.join(HERE, "artifacts-v2-c0ffee11");
const ME = "c0ffee11";
const SID = "session-c0ffee11-0000-4000-8000-000000000000";
const PRIV = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME);
const ARCH = path.join(PRIV, "_压缩存档.md");
const MINOR = path.join(PRIV, "_次要规则.md");
const SEEN = path.join(PRIV, "_已归档.json");

const results = [];
const failures = [];
let caseSeq = 0;
let cidSeq = 0;

function judge(id, desc, ok, detail = "") {
  const row = { id, desc, ok: !!ok, detail: String(detail || "") };
  results.push(row);
  if (!ok) failures.push(row);
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
const reset = () => fs.rmSync(PRIV, { recursive: true, force: true });
const cpLen = (s) => Array.from(String(s)).length;
const bytes = (s) => Buffer.byteLength(String(s), "utf8");

function saveCase(id) {
  const dst = path.join(ART, String(id).replace(/[^\w.-]+/g, "_"));
  fs.mkdirSync(dst, { recursive: true });
  const files = [
    [ARCH, "_压缩存档.md"],
    [MINOR, "_次要规则.md"],
    [SEEN, "_已归档.json"],
  ];
  let n = 0;
  for (const [src, name] of files) {
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
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

// ---------- 假 ctx ----------
const handlers = {};
const tools = {};
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
        section() {
          return () => {};
        },
      },
    });
  },
});
if (!handlers["session/event"]) throw new Error("没有捕获到 session/event handler");
const exec = { agent: { session: { header: { id: SID } } } };

function feed(blocks, cid = `v2-${++cidSeq}`) {
  handlers["session/event"](
    { header: { id: SID } },
    {
      type: "compaction/summary",
      data: { compactionId: cid, summary: blocks.map((text) => ({ text })) },
    },
  );
  return read(ARCH);
}

async function archiveSay(say) {
  return tools.mem_private.execute({ which: "archive", say }, exec);
}
async function minorSay(say) {
  return tools.mem_private.execute({ which: "minor", say }, exec);
}

// ---------- 结构解析（复验者自己写，不调用插件内部函数） ----------
const EOL_RE = /\r\n|[\r\n\u2028\u2029]/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

function scanLines(raw) {
  const out = [];
  let fence = "";
  for (const line of String(raw == null ? "" : raw).split(EOL_RE)) {
    const f = line.match(FENCE_RE);
    let inFence = false;
    if (fence) {
      inFence = true;
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = "";
    } else if (f) {
      fence = f[1];
      inFence = true;
    }
    out.push({ line, inFence });
  }
  return out;
}

function parseArchive(raw) {
  const lines = scanLines(raw);
  const heads = [];
  lines.forEach((x, i) => {
    if (x.inFence) return;
    const m = x.line.match(/^## §(\d+) /);
    if (m) heads.push({ n: Number(m[1]), i });
  });
  const sections = heads.map((h, j) => {
    const end = j + 1 < heads.length ? heads[j + 1].i : lines.length;
    let body = lines.slice(h.i + 1, end).map((x) => x.line);
    while (body.length && !body[0].trim()) body.shift();
    while (body.length && !body[body.length - 1].trim()) body.pop();
    let fenced = false;
    let content = body.join("\n");
    if (body.length >= 2) {
      const open = body[0].match(FENCE_RE);
      const close = body[body.length - 1].match(FENCE_RE);
      fenced = !!open && !!close && open[1][0] === close[1][0] && close[1].length >= open[1].length;
      if (fenced) content = body.slice(1, -1).join("\n");
    }
    return { n: h.n, line: h.i, body, content, fenced };
  });
  return { sections, lines };
}

function sectionNums(raw) {
  return parseArchive(raw).sections.map((s) => s.n);
}

function hookRows(raw) {
  const rows = [];
  for (const x of scanLines(raw)) {
    if (x.inFence) continue;
    if (/^## §\d+ /.test(x.line)) break;
    const m = x.line.match(/^\| ([^|]+) \| §(\d+) \|$/);
    if (!m) continue;
    if (m[1].trim() === "钩子") continue;
    rows.push({ hooks: m[1].trim(), at: Number(m[2]) });
  }
  return rows;
}

function inFenceFlags(raw, needle) {
  return scanLines(raw)
    .filter((x) => x.line.includes(needle))
    .map((x) => x.inFence);
}

function parseMinorItems(raw) {
  const re =
    /^- \[钩子: ([^\]]*)\] (.*?) — (\d{4}-\d{2}-\d{2}) · (s-[0-9a-f]{1,8})(?: · hits=(\d+))?(?: \[auto\])?\s*$/;
  const items = [];
  for (const line of String(raw == null ? "" : raw).split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    items.push({
      hooks: m[1],
      body: m[2],
      date: m[3],
      sid: m[4],
      hits: m[5] ? Number(m[5]) : 0,
      auto: /\[auto\]/.test(line),
    });
  }
  return items;
}

function locateBody(text) {
  for (const s of parseArchive(read(ARCH)).sections) {
    if (s.content.includes(text)) return { where: "archive", body: s.content, section: s };
  }
  for (const it of parseMinorItems(read(MINOR))) {
    if (it.body.includes(text)) return { where: "minor", body: it.body, item: it };
  }
  return { where: "", body: "" };
}

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

function langStats(s) {
  const text = String(s);
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const letters = (text.match(/\p{L}/gu) || []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
  return { han, letters, kana, hangul, hanRatio: han / Math.max(1, letters), kanaRatio: (kana + hangul) / Math.max(1, letters) };
}

const sha256 = crypto.createHash("sha256").update(fs.readFileSync(LIB)).digest("hex");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });

console.log("# dsh-recall 0.9.7 第二轮独立复验（会话 c0ffee11）");
console.log(`# lib=${LIB}`);
console.log(`# lib sha256=${sha256} bytes=${fs.statSync(LIB).size}`);
console.log(`# 私有目录=${PRIV}`);
console.log("");

// =====================================================================
// 一、上一轮 9 条，逐条自己构造
// =====================================================================

// 1. 旧档伪节升格 / 节号跳号（题面输入：整个文件没有围栏）
await withCase("1-legacy-canonical", async () => {
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
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "旧正文第一行，端口 4001。",
      "## §999 伪节",
      "伪节下面的内容",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed(["新记录：端口 4002，路径 D:/new.log。"]);
  const nums = sectionNums(out);
  judge("1", "旧档正文里的 ## §999 不升格，写新节后节号是 1,2", nums.join(",") === "1,2", `实际节号=${nums.join(",")}`);
  const pseudo = inFenceFlags(out, "## §999 伪节");
  judge("1b", "## §999 留在 §1 正文里并被围栏包住", pseudo.length === 1 && pseudo.every(Boolean), `出现 ${pseudo.length} 次，围栏内=${JSON.stringify(pseudo)}`);
  const rows = hookRows(out);
  judge(
    "1c",
    "钩子表只有 §1/§2，没有 §999；旧行保留",
    rows.length === 2 && rows.some((r) => r.at === 1) && rows.some((r) => r.at === 2),
    `钩子行=${JSON.stringify(rows.map((r) => `§${r.at}`))}`,
  );
  const parsed = parseArchive(out);
  judge("1d", "§1、§2 正文都在围栏里", parsed.sections.length === 2 && parsed.sections.every((s) => s.fenced), `section 数=${parsed.sections.length}，围栏=${parsed.sections.map((s) => s.fenced).join(",")}`);
});

// 1x. 同类变体：旧档节正文没有围栏，但正文里本来就有代码围栏
await withCase("1-legacy-inner-fence", async () => {
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
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "旧正文，端口 4001。",
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
  const out = feed(["新记录：端口 4002，路径 D:/new.log。"]);
  const nums = sectionNums(out);
  const pseudo = inFenceFlags(out, "## §999 伪节");
  judge(
    "1x",
    "旧档正文自带代码围栏时，伪节仍不升格、节号仍是 1,2",
    nums.join(",") === "1,2" && pseudo.length === 1 && pseudo.every(Boolean),
    `实际节号=${nums.join(",")}；## §999 在围栏外=${pseudo.some((v) => !v)}`,
  );
});

// 2. 预算连坐：首段 100KB + 20 个小段
await withCase("2-budget-huge-first", async () => {
  const blocks = ["1 " + "A".repeat(99997)];
  for (let i = 0; i < 20; i++) blocks.push(`2 B${i} ` + "B".repeat(44));
  const out = feed(blocks);
  const parsed = parseArchive(out);
  const joined = parsed.sections.map((s) => s.content).join("\n");
  const allSmall = Array.from({ length: 20 }, (_, i) => `B${i}`).every((k) => joined.includes(k));
  judge("2", "首段 100KB 后 20 个小段全写进正文", parsed.sections.length === 21 && allSmall, `节数=${parsed.sections.length}，B0..B19 都在正文=${allSmall}`);
  judge("2b", "没有凭空写「超出预算」记账节", !out.includes("本次摘要共"), `含记账节=${out.includes("本次摘要共")}`);
  const first = parsed.sections[0]?.content || "";
  judge(
    "2c",
    "首段正文按 1200 字截断，标记原文 99999 字",
    first.includes("…（原文 99999 字）") && cpLen(first) <= 1200,
    `正文 ${cpLen(first)} 字；标记=${/…（原文 (\d+) 字）/.exec(first)?.[0] || "无"}`,
  );
});

// 3. 中文真规矩只因引用一句日文被降档
await withCase("3-zh-with-jp-quote", async () => {
  const text = "规矩：以后都必须用 console.info 打日志，不要用 ctx.logger；日文界面文案「ログを出す」保持不变，路径 D:/logs。";
  feed([text]);
  const minor = read(MINOR);
  const arch = read(ARCH);
  const st = langStats(text);
  judge(
    "3",
    "中文真规矩引用一句日文，仍进 _次要规则",
    parseMinorItems(minor).some((it) => it.body.includes("console.info")) && !arch.includes("console.info"),
    `han/letters=${st.hanRatio.toFixed(3)} kana/letters=${st.kanaRatio.toFixed(3)} minor含=${minor.includes("console.info")} archive含=${arch.includes("console.info")}`,
  );
});

// 4. 中文真规矩夹英文术语
await withCase("4-zh-with-en-terms", async () => {
  const text =
    "以后都必须用 console.info 打日志，不要用 ctx.logger；Product profile mounts no console exporter for ctx.logger，所以那条诊断信息在真出事的时候也出不来，路径 D:/logs/recall.log。";
  feed([text]);
  const minor = read(MINOR);
  const arch = read(ARCH);
  const st = langStats(text);
  judge(
    "4",
    "中文真规矩夹英文术语，仍进 _次要规则",
    parseMinorItems(minor).some((it) => it.body.includes("console.info")) && !arch.includes("console.info"),
    `han/letters=${st.hanRatio.toFixed(3)}（阈值 0.2）minor含=${minor.includes("console.info")} archive含=${arch.includes("console.info")}`,
  );
});

// 5. 希腊字母 / 全角字母不算中文
await withCase("5a-greek", async () => {
  const text = "日志必须" + "αβγδ".repeat(100) + "，端口 4001。";
  feed([text]);
  const minor = read(MINOR);
  const arch = read(ARCH);
  const st = langStats(text);
  judge(
    "5a",
    "希腊字母占绝大多数时不进 _次要规则，仍进存档",
    !minor.includes("αβγδ") && arch.includes("αβγδ"),
    `han/letters=${st.hanRatio.toFixed(3)} minor含=${minor.includes("αβγδ")} archive含=${arch.includes("αβγδ")}`,
  );
});
await withCase("5b-fullwidth", async () => {
  const text = "日志必须" + "ＡＢＣＤ".repeat(100) + "，端口 4002。";
  feed([text]);
  const minor = read(MINOR);
  const arch = read(ARCH);
  const st = langStats(text);
  judge(
    "5b",
    "全角字母占绝大多数时不进 _次要规则，仍进存档",
    !minor.includes("ＡＢＣＤ") && arch.includes("ＡＢＣＤ"),
    `han/letters=${st.hanRatio.toFixed(3)} minor含=${minor.includes("ＡＢＣＤ")} archive含=${arch.includes("ＡＢＣＤ")}`,
  );
});

// 6. 截断标记撑爆 240 字上限（手工 mem_private minor）
await withCase("6-minor-240", async () => {
  const say = "必须" + "字".repeat(598); // 600 字
  const r = await minorSay(say);
  const items = parseMinorItems(read(MINOR));
  const body = items[0]?.body || "";
  judge("6", "手工 minor 600 字时正文不超过 240 字（标记算在内）", r.ok && items.length === 1 && cpLen(body) <= 240, `正文 ${cpLen(body)} 字；整条返回=${JSON.stringify(r)}`);
  judge("6b", "正文末尾标记写「原文 600 字」", /…（原文 600 字）$/.test(body), `正文尾部=${JSON.stringify(body.slice(-30))}`);
});

// 7. 切坏代理对
await withCase("7-surrogate", async () => {
  const text = "必须" + "A".repeat(1197) + "😀" + "尾".repeat(10);
  feed([text]);
  const arch = read(ARCH);
  const minor = read(MINOR);
  const all = arch + minor;
  const fffd = all.includes("\uFFFD");
  const lone = hasLoneSurrogate(all);
  judge("7", "1200 字边界切在 emoji 中间时不写 U+FFFD / 半个代理对", !fffd && !lone, `U+FFFD=${fffd} 孤立代理=${lone}`);
  const loc = locateBody("必须");
  judge(
    "7b",
    "落盘正文不超过 1200 字，且标记原文 1211 字",
    loc.where !== "" && cpLen(loc.body) <= 1200 && loc.body.includes("…（原文 1211 字）"),
    `位置=${loc.where || "无"} 正文 ${cpLen(loc.body)} 字；输入 UTF-16 长度=${text.length}`,
  );
});

// 8. 标记里的「原文 N 字」必须是输入真实长度
await withCase("8-marker-length", async () => {
  const text = "必须 D:/logs " + " ".repeat(5000) + "尾".repeat(1500); // 6511 字
  feed([text]);
  const loc = locateBody("必须 D:/logs");
  const collapsed = text.replace(/\s+/g, " ").trim().length;
  judge(
    "8",
    "截断标记写原文 6511 字，不是压缩空白后的 1511 字",
    loc.where !== "" && loc.body.includes("…（原文 6511 字）") && !loc.body.includes("原文 1511 字"),
    `位置=${loc.where || "无"}；输入 ${text.length} 字；压缩空白后 ${collapsed} 字；标记=${/…（原文 (\d+) 字）/.exec(loc.body)?.[0] || "无"}`,
  );
  judge("8b", "正文不超过 1200 字（标记算在内）", loc.where !== "" && cpLen(loc.body) <= 1200, `正文 ${cpLen(loc.body)} 字`);
});

// 9. 整条摘要静默消失
await withCase("9-all-filtered", async () => {
  const cid = "v2-all-filtered";
  const blocks = ["七字内容甲", "七字内容乙", "七字内容丙"];
  const out = feed(blocks, cid);
  const parsed = parseArchive(out);
  judge(
    "9a",
    "每段都短于 8 字时仍落一节记账，不静默消失",
    parsed.sections.length === 1 && parsed.sections[0].fenced && /切不出|短于 8 字/.test(parsed.sections[0].content) && blocks.every((b) => parsed.sections[0].content.includes(b)),
    `节数=${parsed.sections.length} 正文=${JSON.stringify(parsed.sections[0]?.content?.slice(0, 80))}`,
  );
  const seen = read(SEEN);
  judge("9b", "_已归档.json 记下了这条 id（后面重放会被去重）", seen.includes(cid), `_已归档=${seen.slice(0, 120)}`);
  const before = out;
  const again = feed(blocks, cid);
  judge("9c", "同 id 重放被跳过，不会把记账节改掉或删掉", again === before, `重放前后一致=${again === before}`);
});

// =====================================================================
// 二、上一轮 4 条 FAIL 背后的真性质
// =====================================================================

// 1.1b / 1.1c：真超预算时的记账节
await withCase("P1-accounting-real-over", async () => {
  const blocks = [];
  for (let i = 1; i <= 20; i++) blocks.push(`第${i}段：` + "资料".repeat(750));
  const out = feed(blocks);
  const parsed = parseArchive(out);
  const account = parsed.sections.find((s) => s.content.includes("本次摘要共"));
  const contentSections = parsed.sections.filter((s) => s !== account);
  const note = account?.content || "";
  const m = note.match(/共 (\d+) 段，写入 (\d+) 段；其余 (\d+) 段未写入（(\d+) 段超出 (\d+) 字节预算）/);
  judge(
    "P1a",
    "真超预算时记账节存在，且正文确实在围栏里",
    !!account && account.fenced && inFenceFlags(out, "本次摘要共").every(Boolean),
    `记账节存在=${!!account} 围栏=${account?.fenced} 出现围栏内=${JSON.stringify(inFenceFlags(out, "本次摘要共"))}`,
  );
  judge(
    "P1b",
    "记账数字与实际一致：20 段 / 写 16 / 4 段超 60000，且节数 17、正文节 16",
    !!m && m[1] === "20" && m[2] === "16" && m[3] === "4" && m[4] === "4" && m[5] === "60000" && parsed.sections.length === 17 && contentSections.length === 16,
    `记账=「${note.slice(0, 80)}」实际节数=${parsed.sections.length} 正文节=${contentSections.length}`,
  );
  const nums = parsed.sections.map((s) => s.n);
  judge("P1c", "记账节没有多生一节：节号 1..17 连续", nums.length === 17 && nums.every((n, i) => n === i + 1), `节号=${nums.join(",")}`);
  const dropped = ["第17段", "第18段", "第19段", "第20段"];
  const joined = parsed.sections.map((s) => s.content).join("\n");
  judge("P1d", "未写段（第 17..20 段）的内容没有混进正文", dropped.every((k) => !joined.includes(k)), `含未写段=${dropped.filter((k) => joined.includes(k)).join(",") || "无"}`);
  const rows = hookRows(out);
  judge("P1e", "钩子表 17 行，与 17 节一致", rows.length === 17 && rows.every((r) => r.at >= 1 && r.at <= 17), `钩子行数=${rows.length}`);
});

// 60000 / 60001 字节预算边界（aggregate，按实际写入的 flatSpan 尺寸）
await withCase("P2-budget-60000", async () => {
  const blocks = [];
  for (let i = 0; i < 50; i++) blocks.push("1 " + "A".repeat(1198)); // 每段 1200 字节，50 段合计 60000
  const out = feed(blocks);
  const parsed = parseArchive(out);
  const nums = parsed.sections.map((s) => s.n);
  judge(
    "P2a",
    "合计正好 60000 字节：50 段全写，不触发记账",
    parsed.sections.length === 50 && !out.includes("本次摘要共") && nums.every((n, i) => n === i + 1),
    `节数=${parsed.sections.length} 记账=${out.includes("本次摘要共")} 文件=${bytes(out)} 字节`,
  );
});
await withCase("P2-budget-60001", async () => {
  const blocks = [];
  for (let i = 0; i < 49; i++) blocks.push("1 " + "A".repeat(1198)); // 58800 字节
  blocks.push("2 " + "A".repeat(1197) + "é"); // 1200 字 / 1201 字节，合计 60001
  const out = feed(blocks);
  const parsed = parseArchive(out);
  const account = parsed.sections.find((s) => s.content.includes("本次摘要共"));
  const note = account?.content || "";
  const contentSections = parsed.sections.filter((s) => s !== account);
  const joined = contentSections.map((s) => s.content).join("\n");
  judge(
    "P2b",
    "合计 60001 字节：第 50 段被预算挡下，只写 49 段并记账 1 段超出",
    contentSections.length === 49 && parsed.sections.length === 50 && /共 50 段，写入 49 段；其余 1 段未写入（1 段超出 60000 字节预算）/.test(note),
    `正文节=${contentSections.length} 总节=${parsed.sections.length} 记账=「${note.slice(0, 80)}」`,
  );
  judge("P2c", "被挡下的第 50 段内容（é）没有落进正文，记账节的围栏也正常", !joined.includes("é") && !!account && account.fenced, `正文含 é=${joined.includes("é")} 记账围栏=${account?.fenced}`);
});
await withCase("P2-single-60001-raw", async () => {
  const text = "1 " + "A".repeat(59999); // 60001 字节的原段
  const out = feed([text]);
  const parsed = parseArchive(out);
  judge(
    "P2d",
    "单个 60001 字节原段按截断后 1200 字装得下，不触发预算记账",
    parsed.sections.length === 1 && !out.includes("本次摘要共") && parsed.sections[0].content.includes("…（原文 60001 字）"),
    `节数=${parsed.sections.length} 记账=${out.includes("本次摘要共")} 标记=${/…（原文 (\d+) 字）/.exec(parsed.sections[0]?.content || "")?.[0] || "无"}`,
  );
});

// 语种阈值边界：正好 0.2 / 0.19，以及假名 0.25 / 0.30
await withCase("P3-lang-ratio-020", async () => {
  const text = "日志必须" + "a".repeat(16); // 4 汉字 / 20 字母 = 0.2
  feed([text]);
  const st = langStats(text);
  const minor = read(MINOR);
  const arch = read(ARCH);
  judge("P3a", "汉字/字母正好 0.2：过线进 _次要规则（>= 语义）", minor.includes("日志必须") && !arch.includes("日志必须"), `ratio=${st.hanRatio.toFixed(4)} minor=${minor.includes("日志必须")} archive=${arch.includes("日志必须")}`);
});
await withCase("P3-lang-ratio-019", async () => {
  const text = "日志必须" + "a".repeat(17); // 4 / 21 = 0.1905
  feed([text]);
  const st = langStats(text);
  const minor = read(MINOR);
  const arch = read(ARCH);
  judge("P3b", "汉字/字母 0.1905：不过线，降档进存档", !minor.includes("日志必须") && arch.includes("日志必须"), `ratio=${st.hanRatio.toFixed(4)} minor=${minor.includes("日志必须")} archive=${arch.includes("日志必须")}`);
});
await withCase("P3-kana-025", async () => {
  const text = "日志必须" + "あ".repeat(2) + "a".repeat(2); // kana 2/8 = 0.25
  feed([text]);
  const st = langStats(text);
  const minor = read(MINOR);
  const arch = read(ARCH);
  judge("P3c", "假名/字母正好 0.25：不触发日文降档，仍进 _次要规则", minor.includes("日志必须") && !arch.includes("日志必须"), `kana=${st.kanaRatio.toFixed(4)} minor=${minor.includes("日志必须")} archive=${arch.includes("日志必须")}`);
});
await withCase("P3-kana-030", async () => {
  const text = "日志必须" + "あ".repeat(3) + "a".repeat(3); // kana 3/10 = 0.30
  feed([text]);
  const st = langStats(text);
  const minor = read(MINOR);
  const arch = read(ARCH);
  judge("P3d", "假名/字母 0.30：判为日文条目，不进 _次要规则", !minor.includes("日志必须") && arch.includes("日志必须"), `kana=${st.kanaRatio.toFixed(4)} minor=${minor.includes("日志必须")} archive=${arch.includes("日志必须")}`);
});

// =====================================================================
// 三、额外方向：行终止符、围栏、空输入、超限记账
// =====================================================================

await withCase("E1-crlf-split", async () => {
  const out = feed(["第一段端口 4001\r\n\r\n第二段端口 4002\r\n\r\n第三段端口 4003"]);
  const parsed = parseArchive(out);
  judge("E1", "CRLF 分隔的多段摘要被切成 3 段，不是一整段", parsed.sections.length === 3 && ["4001", "4002", "4003"].every((k) => out.includes(k)), `节数=${parsed.sections.length} 节号=${parsed.sections.map((s) => s.n).join(",")}`);
});
await withCase("E2-cr-split", async () => {
  const out = feed(["甲段内容足够长端口 4101\r\r乙段内容足够长端口 4102\r\r丙段内容足够长端口 4103"]);
  const parsed = parseArchive(out);
  judge("E2", "单独 \\r 分隔的多段摘要被切成 3 段", parsed.sections.length === 3, `节数=${parsed.sections.length} 节号=${parsed.sections.map((s) => s.n).join(",")}`);
});
await withCase("E3-u2028-split", async () => {
  const out = feed(["甲段内容足够长端口 4201\u2028\u2028乙段内容足够长端口 4202\u2028\u2028丙段内容足够长端口 4203"]);
  const parsed = parseArchive(out);
  judge("E3", "U+2028 分隔的多段摘要被切成 3 段", parsed.sections.length === 3, `节数=${parsed.sections.length} 节号=${parsed.sections.map((s) => s.n).join(",")}`);
});

await withCase("E4-manual-fence-crlf", async () => {
  const body =
    "第一行\r\n第二行\u2028第三行\r\n\r\n```\r\n代码\r\n```\r\n## §999 伪节\r\n| 假钩子 | §1 |\r\n尾巴内容";
  await archiveSay(body);
  await archiveSay("第二条：端口 4002，路径 D:/b。");
  const out = read(ARCH);
  const parsed = parseArchive(out);
  const nums = parsed.sections.map((s) => s.n);
  judge("E4a", "手工补记的 CRLF/U+2028/内部围栏在第二次写入后原样保留", out.includes("第一行\r\n第二行\u2028第三行") && out.includes("```\r\n代码\r\n```"), `CRLF保留=${out.includes("第一行\r\n第二行\u2028第三行")}`);
  judge("E4b", "正文里的 ## §999 与假钩子行不变成结构，节号 1,2", nums.join(",") === "1,2" && inFenceFlags(out, "## §999").every(Boolean) && !hookRows(out).some((r) => r.hooks.includes("假钩子")), `节号=${nums.join(",")} 假钩子在围栏外=${inFenceFlags(out, "## §999").some((v) => !v)} 假钩子进表=${hookRows(out).some((r) => r.hooks.includes("假钩子"))}`);
  judge("E4c", "内部 ``` 被更长围栏包住，两个节的正文都在围栏里", parsed.sections.length === 2 && parsed.sections.every((s) => s.fenced), `节数=${parsed.sections.length} 围栏=${parsed.sections.map((s) => s.fenced).join(",")}`);
});

await withCase("E5-empty", async () => {
  feed([]);
  const afterEmpty = [read(ARCH), read(MINOR), read(SEEN)].filter(Boolean).length;
  feed([""]);
  feed(["   "]);
  const afterBlank = [read(ARCH), read(MINOR), read(SEEN)].filter(Boolean).length;
  judge("E5", "空摘要 / 纯空白摘要不落任何文件，也不抛异常", afterEmpty === 0 && afterBlank === 0, `空摘要后文件数=${afterEmpty}，空白摘要后=${afterBlank}`);
});

await withCase("E6-manual-overs", async () => {
  const big = "X".repeat(204801);
  const r1 = await archiveSay(big);
  const out1 = read(ARCH);
  const r2 = await archiveSay("Y".repeat(204801));
  const out2 = read(ARCH);
  await archiveSay("正常一条：端口 4002，路径 D:/ok。");
  const out3 = read(ARCH);
  const rows = hookRows(out3);
  judge(
    "E6a",
    "手工写 204801 字节：整条拒写，文件头记账 1 条 / 204801 字节",
    /没写/.test(r1?.text || "") && /有 1 条超 204800 字节上限未写入 · 合计 204801 字节/.test(out1) && sectionNums(out1).length === 0,
    `返回=「${(r1?.text || "").slice(0, 50)}」头=${(out1.split("\n").find((l) => l.includes("超 204800")) || "").slice(0, 90)}`,
  );
  judge(
    "E6b",
    "第二次拒写：计数累加到 2 条 / 409602 字节",
    /有 2 条超 204800 字节上限未写入 · 合计 409602 字节/.test(out2),
    `头=${(out2.split("\n").find((l) => l.includes("超 204800")) || "").slice(0, 90)}`,
  );
  judge(
    "E6c",
    "拒写后再写正常一条：正文一节、记账行保留、钩子表 1 行",
    sectionNums(out3).join(",") === "1" && /有 2 条超 204800 字节上限未写入 · 合计 409602 字节/.test(out3) && rows.length === 1,
    `节号=${sectionNums(out3).join(",")} 行数=${rows.length} 头保留=${/有 2 条超 204800/.test(out3)}`,
  );
});

// 空钩子行：手工 archive 4 字且 pickHooks 为空
await withCase("E7-empty-hooks", async () => {
  const r1 = await archiveSay("必须要的");
  const out1 = read(ARCH);
  const rows1 = hookRows(out1);
  judge(
    "E7a",
    "手工 archive 挑不出钩子时，不应写出空钩子单元格（|  | §1 |），§1 应有一行可解析的钩子",
    sectionNums(out1).length === 1 && !/\|\s*\|\s*§1\s*\|/.test(out1) && rows1.length === 1 && rows1[0]?.at === 1 && (rows1[0]?.hooks || "").length > 0,
    `返回=「${(r1?.text || "").slice(0, 30)}」节数=${sectionNums(out1).length} 可解析钩子行=${rows1.length} 空钩子行=${/\|\s*\|\s*§1\s*\|/.test(out1)}`,
  );
  saveCase("E7-empty-hooks-first");
  await archiveSay("第二条：端口 4002，路径 D:/b。");
  const out2 = read(ARCH);
  const rows2 = hookRows(out2);
  judge(
    "E7b",
    "第二次写入后 §1、§2 都仍有钩子行，钩子表与 2 个节一致",
    sectionNums(out2).length === 2 && rows2.length === 2 && [1, 2].every((n) => rows2.some((r) => r.at === n && r.hooks.length > 0)),
    `节号=${sectionNums(out2).join(",")} 钩子表=${JSON.stringify(rows2.map((r) => `§${r.at}`))}`,
  );
});

// ZWJ 组合 emoji：不是 U+FFFD，但可能被切在连接处
await withCase("E8-zwj", async () => {
  const text = "必须" + "A".repeat(1184) + "👨‍👩‍👧" + "尾".repeat(10);
  feed([text]);
  const loc = locateBody("必须");
  const all = read(ARCH) + read(MINOR);
  const fullFamily = "👨‍👩‍👧";
  judge(
    "E8",
    "ZWJ 家庭 emoji 不被切在连接处（不是只看 U+FFFD）",
    loc.where !== "" && !all.includes(fullFamily) && !loc.body.includes("\u200d"),
    `完整家庭 emoji 保留=${all.includes(fullFamily)} 正文含悬挂 U+200D=${loc.body.includes("\u200d")} 正文尾部码点=${JSON.stringify(Array.from(loc.body).slice(-8))}`,
  );
});

// 部分短段与有效段并存：已知设计边界，只观察，不纳入 9 条判据
await withCase("E9-partial-short", async () => {
  const short = "端口:4001";
  const out = feed(["这是一个足够长的有效段落，端口 4002，路径 D:/x。", short]);
  const parsed = parseArchive(out);
  observe(
    "E9",
    "有效段 + 一条 7 字短段并存时，短段被静默丢弃且不记账（README 已承认的设计边界，不计入 9 条）",
    `节数=${parsed.sections.length} 短段落盘=${out.includes(short)} 记账=${out.includes("本次摘要共")}`,
  );
});

// =====================================================================
// 收尾
// =====================================================================
reset();
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log("");
console.log(`=== 判据：${pass}/${results.length} PASS，${fail} FAIL ===`);
if (failures.length) {
  console.log("FAIL 列表：");
  for (const f of failures) console.log(`- ${f.id} ${f.desc} — ${f.detail}`);
}
const summary = {
  lib: LIB,
  sha256,
  bytes: fs.statSync(LIB).size,
  me: ME,
  generated_at: new Date().toISOString(),
  total: results.length,
  pass,
  fail,
  results,
  failures,
};
fs.writeFileSync(path.join(ART, "results.json"), JSON.stringify(summary, null, 2), "utf8");
if (failures.length) {
  fs.writeFileSync(
    path.join(ART, "FAILURES.md"),
    [
      "# v2-c0ffee11 失败用例",
      "",
      `lib sha256: ${sha256}`,
      "",
      ...failures.map((f) => `## ${f.id} ${f.desc}\n\n${f.detail}\n`),
    ].join("\n"),
    "utf8",
  );
}
process.exitCode = fail ? 1 : 0;
