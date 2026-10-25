// v4 独立复验：按 v4-expected.md 里自己写的期望值跑插件，先不看作者用例。
// 只读 lib/index.js，自己造输入、自己断言。会话 id 全用 8 位十六进制，跑完清干净。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../lib/index.js";

const PRIV = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private");
const HOME = os.homedir();

// ---------- 会话与目录 ----------
const SIDS = [
  "e1a00001", "e1b00002", "e1c00003", "e2a00004", "e3a00005", "e3b00006",
  "e4a00007", "e4b00008", "e4c00009", "e5a0000a", "e5b0000b",
  "e6a0000c", "e6b0000d", "e7a0000e", "e7b0000f", "e7c00010",
  "f1a00010", "f2a00011", "f3a00012", "f4a00013",
];

function assertSafeSid(sid) {
  if (!/^[0-9a-f]{8}$/.test(sid)) throw new Error("bad sid " + sid);
  if (fs.existsSync(path.join(PRIV, sid))) throw new Error("目录已存在，拒绝覆盖：" + path.join(PRIV, sid));
}
for (const s of SIDS) assertSafeSid(s);

const dirOf = (sid) => path.join(PRIV, sid);
const fileOf = (sid, name) => path.join(dirOf(sid), name);

function cleanAll() {
  for (const sid of SIDS) {
    const d = dirOf(sid);
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}
cleanAll();

// ---------- 驱动插件 ----------
const handlers = {};
apply({
  on(ev, fn) { handlers[ev] = fn; },
  inject() { /* 只测压缩归档，工具/注入不挂 */ },
});
const onEvent = handlers["session/event"];
if (typeof onEvent !== "function") throw new Error("没挂上 session/event");

const fire = (sid, cid, text, extra = {}) => {
  const session = { header: { id: sid, cwd: "C:/tmp/v4-workspace" } };
  const data = { compactionId: cid, summary: [{ type: "text", text }], ...extra };
  onEvent(session, { type: "compaction/summary", data });
};

// ---------- 我自己的解析器（不是抄插件，按 v4-expected.md §2 的不变量写） ----------
const EOL = /\r\n|[\r\n\u2028\u2029]/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** 逐行 + 围栏配对；没闭合的围栏不算围栏（整段按结构行处理）。 */
function scanLines(text) {
  const rows = [];
  const re = /[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "") break;
    rows.push({ line: m[0].replace(/\r\n$|[\r\n\u2028\u2029]$/, ""), start: m.index });
  }
  const paired = new Set();
  let open = -1;
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i].line.match(FENCE);
    if (!f) continue;
    if (open < 0) { open = i; continue; }
    const o = rows[open].line.match(FENCE)[1];
    if (f[1][0] === o[0] && f[1].length >= o.length) {
      for (let k = open; k <= i; k++) paired.add(k);
      open = -1;
    }
  }
  return rows.map((r, i) => ({ ...r, inFence: paired.has(i) }));
}

const SEC_RE = /^## §(\d+) (.+) · (\d{4}-\d{2}-\d{2}) · (s-\S+)$/;

function parseArchive(raw) {
  const rows = scanLines(raw);
  let firstSec = rows.findIndex((r) => !r.inFence && /^## §\d+ /.test(r.line));
  const headerEnd = firstSec < 0 ? rows.length : firstSec;
  const hooks = [];
  for (let i = 0; i < headerEnd; i++) {
    if (rows[i].inFence) continue;
    if (/^## §\d+ /.test(rows[i].line)) break;
    const m = rows[i].line.match(/^\| ([^|]+) \| §(\d+) \|$/);
    if (m) hooks.push({ hooks: m[1].trim(), at: Number(m[2]) });
  }
  const secs = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].inFence) continue;
    const m = rows[i].line.match(SEC_RE);
    if (!m) continue;
    secs.push({ at: Number(m[1]), title: m[2], date: m[3], sid: m[4], start: rows[i].start, lineIdx: i });
  }
  for (let k = 0; k < secs.length; k++) {
    const from = rows[secs[k].lineIdx].start + rows[secs[k].lineIdx].line.length;
    const to = k + 1 < secs.length ? secs[k + 1].start : raw.length;
    const piece = raw.slice(from, to);
    const pl = scanLines(piece);
    let fi = -1, ci = -1;
    for (let i = 0; i < pl.length; i++) if (pl[i].line.match(FENCE)) { fi = i; break; }
    if (fi >= 0) {
      const flen = pl[fi].line.match(FENCE)[1].length;
      for (let i = fi + 1; i < pl.length; i++) {
        const f = pl[i].line.match(/^\s*(`{3,})\s*$/);
        if (f && f[1].length >= flen) { ci = i; break; }
      }
    }
    secs[k].fenced = ci > fi && fi >= 0;
    secs[k].body = secs[k].fenced ? pl.slice(fi + 1, ci).map((r) => r.line).join("\n") : "";
  }
  return { hooks, sections: secs };
}

// ---------- 断言 ----------
let pass = 0, fail = 0;
const results = [];
function check(id, desc, cond, detail = "") {
  if (cond) { pass++; results.push(`PASS ${id} ${desc}`); }
  else { fail++; results.push(`FAIL ${id} ${desc}${detail ? " —— " + detail : ""}`); }
}
const read = (sid, name) => { try { return fs.readFileSync(fileOf(sid, name), "utf8"); } catch { return null; } };
const writeFileFor = (sid, name, text) => {
  fs.mkdirSync(dirOf(sid), { recursive: true });
  fs.writeFileSync(fileOf(sid, name), text, "utf8");
};
const archiveOf = (sid) => read(sid, "_压缩存档.md");
const seenOf = (sid) => {
  const raw = read(sid, "_已归档.json");
  try { return JSON.parse(raw); } catch { return raw; }
};

// ================= E1 正文截断 =================
{
  const sid = "e1a00001";
  const mark = "…（原文 2000 字）";
  const body = "甲".repeat(1188) + mark;
  fire(sid, "v4-e1", "甲".repeat(2000));
  const raw = archiveOf(sid) || "";
  const p = parseArchive(raw);
  check("E1.1", "2000 字正文截到 1200 码点、1188 个甲 + 标记", p.sections.length === 1 && p.sections[0].body === body,
    `sections=${p.sections.length} bodyLen=${Array.from(p.sections[0]?.body || "").length} tail=${JSON.stringify((p.sections[0]?.body || "").slice(-20))}`);
  check("E1.2", "标记精确为「…（原文 2000 字）」且总长 1200 码点", p.sections[0]?.body.endsWith(mark) && Array.from(p.sections[0].body).length === 1200,
    `len=${Array.from(p.sections[0]?.body || "").length}`);
  check("E1.3", "正文 UTF-8 字节数 3588", Buffer.byteLength(p.sections[0]?.body || "", "utf8") === 3588,
    `bytes=${Buffer.byteLength(p.sections[0]?.body || "", "utf8")}`);
  check("E1.4", "节号 §1、标题「长段落」、钩子表 1 行", p.sections[0]?.at === 1 && p.sections[0]?.title === "长段落" && p.hooks.length === 1 && p.hooks[0].at === 1,
    `at=${p.sections[0]?.at} title=${p.sections[0]?.title} hooks=${JSON.stringify(p.hooks)}`);
  check("E1.5", "不产生记账节（只有 1 节）", p.sections.length === 1);
  check("E1.6", "写成功后 _已归档.json 记上 cid", JSON.stringify(seenOf(sid)) === JSON.stringify(["v4-e1"]),
    `seen=${JSON.stringify(seenOf(sid))}`);
}

// ================= E1b 1200/1201 边界 =================
{
  const sid = "e1b00002";
  fire(sid, "v4-e1b-1200", "甲".repeat(1200));
  fire(sid, "v4-e1b-1201", "甲".repeat(1201));
  const p = parseArchive(archiveOf(sid) || "");
  check("E1b.1", "正好 1200 字：原样写入、无标记", p.sections[0]?.body === "甲".repeat(1200),
    `len=${Array.from(p.sections[0]?.body || "").length} tail=${JSON.stringify((p.sections[0]?.body || "").slice(-14))}`);
  check("E1b.2", "1201 字：1188 甲 + 「…（原文 1201 字）」", p.sections[1]?.body === "甲".repeat(1188) + "…（原文 1201 字）",
    `len=${Array.from(p.sections[1]?.body || "").length} tail=${JSON.stringify((p.sections[1]?.body || "").slice(-16))}`);
  check("E1b.3", "两节、钩子两行、节号 1,2", p.sections.length === 2 && p.hooks.length === 2 && p.sections.map((s) => s.at).join(",") === "1,2");
}

// ================= E1c 原文长度 vs 压缩空白后长度 =================
{
  const sid = "e1c00003";
  fire(sid, "v4-e1c", "甲".repeat(500) + " " + "甲".repeat(800));
  const p = parseArchive(archiveOf(sid) || "");
  check("E1c.1", "原文 1301 字：标记写 1301，不写压缩后的 1300", (p.sections[0]?.body || "").endsWith("…（原文 1301 字）"),
    `tail=${JSON.stringify((p.sections[0]?.body || "").slice(-20))}`);
}

// ================= E2 切不出有效段 =================
{
  const sid = "e2a00004";
  fire(sid, "v4-e2", "好的。确认。");
  const raw = archiveOf(sid) || "";
  const p = parseArchive(raw);
  const want = "本次摘要 6 字，切不出有信息量的段（每段都短于 8 字），没有写入任何内容。原文：好的。确认。";
  check("E2.1", "切不出段：落一节记账，不静默、不拒写", p.sections.length === 1, `sections=${p.sections.length}`);
  check("E2.2", "记账节标题「摘要未写全」、钩子四词、§1", p.sections[0]?.title === "摘要未写全" && p.hooks[0]?.hooks === "摘要,未写全,短段,切不出" && p.sections[0]?.at === 1,
    `title=${p.sections[0]?.title} hooks=${JSON.stringify(p.hooks)}`);
  check("E2.3", "记账正文逐字一致", p.sections[0]?.body === want, `actual=${JSON.stringify(p.sections[0]?.body)}`);
  check("E2.4", "记账写成功后才记 cid", JSON.stringify(seenOf(sid)) === JSON.stringify(["v4-e2"]), `seen=${JSON.stringify(seenOf(sid))}`);
}

// ================= E3 段数超预算 =================
{
  const sid = "e3a00005";
  const one = "甲".repeat(2000);
  const text = Array(17).fill(one).join("\n\n");
  check("E3.0", "夹具摘要长度 34032 字（前置自检）", text.length === 34032, `len=${text.length}`);
  fire(sid, "v4-e3", text);
  const p = parseArchive(archiveOf(sid) || "");
  const want = "本次摘要共 17 段，写入 16 段；其余 1 段未写入（1 段超出 60000 字节预算）（摘要原文 34032 字）。这是截断不是全文，别把它当完整摘要读。";
  check("E3.1", "17 段里 16 段装得下、记账节是第 17 节", p.sections.length === 17 && p.sections[16]?.title === "摘要未写全",
    `sections=${p.sections.length} lastTitle=${p.sections.at(-1)?.title}`);
  check("E3.2", "记账正文逐字一致（含「共 17 段，写入 16 段」「1 段超出 60000 字节预算」「原文 34032 字」）", p.sections[16]?.body === want,
    `actual=${JSON.stringify(p.sections[16]?.body)}`);
  check("E3.3", "§1..§16 每节正文都是 1200 码点 / 3588 字节", p.sections.slice(0, 16).every((s) => Array.from(s.body).length === 1200 && Buffer.byteLength(s.body, "utf8") === 3588),
    `lens=${p.sections.slice(0, 16).map((s) => Array.from(s.body).length).join(",")}`);
  check("E3.4", "钩子表 17 行、节号 §1..§17 连续", p.hooks.length === 17 && p.hooks.map((h) => h.at).join(",") === Array.from({ length: 17 }, (_, i) => i + 1).join(","),
    `hooks=${p.hooks.length} ats=${p.hooks.map((h) => h.at).join(",")}`);
}

// ================= E3b 首段超大时预算按截断后尺寸算 =================
{
  const sid = "e3b00006";
  const big = "甲".repeat(100000); // 300KB 原文，截断后 3588 字节
  const text = big + "\n\n" + "注意 端口 8080 不要写错";
  fire(sid, "v4-e3b", text);
  const p = parseArchive(archiveOf(sid) || "");
  check("E3b.1", "首段 100KB + 小段：两段都写入，不出「超出预算」记账", p.sections.length === 2 && p.sections.every((s) => s.title !== "摘要未写全"),
    `sections=${p.sections.length} titles=${p.sections.map((s) => s.title).join("|")}`);
}

// ================= E4 语种判定 =================
{
  const sid = "e4a00007";
  fire(sid, "v4-e4a", "The agent must 必须 restart the host after patching. This sentence is mostly English and describes an event, not a rule for future turns.");
  check("E4a.1", "英文为主 + 引用「必须」：进 _压缩存档，_次要规则 不存在", archiveOf(sid) !== null && read(sid, "_次要规则.md") === null,
    `archive=${archiveOf(sid) !== null} minor=${read(sid, "_次要规则.md") !== null}`);
  const pa = parseArchive(archiveOf(sid) || "");
  check("E4a.2", "存档里 1 节、标题为档位命中名「硬规矩词」", pa.sections.length === 1 && pa.sections[0].title === "硬规矩词",
    `secs=${pa.sections.length} title=${pa.sections[0]?.title}`);
}
{
  const sid = "e4b00008";
  const zh = "以后都必须用 console.info 打日志，不要用 ctx.logger，否则真出事时一个字都看不到。";
  fire(sid, "v4-e4b", zh);
  const minor = read(sid, "_次要规则.md") || "";
  const re = /^- \[钩子: [^\]]*\] 以后都必须用 console\.info 打日志，不要用 ctx\.logger，否则真出事时一个字都看不到。 — 2026-10-26 · s-e4b00008 · hits=1 \[auto\]$/m;
  check("E4b.1", "中文为主夹英文术语：进 _次要规则，不进 _压缩存档", read(sid, "_压缩存档.md") === null && minor.length > 0,
    `archive=${read(sid, "_压缩存档.md") !== null} minor=${JSON.stringify(minor.slice(0, 80))}`);
  check("E4b.2", "次要规则行：hits=1 [auto]、日期、会话号", re.test(minor), `minor=${JSON.stringify(minor)}`);
}
{
  const sid = "e4c00009";
  fire(sid, "v4-e4c", "必须。セッションの要約では前回の作業と確認内容をまとめてください。これは日本語の摘要です。");
  check("E4c.1", "日文为主（假名占 0.595）：降档到 _压缩存档，不进 _次要规则", archiveOf(sid) !== null && read(sid, "_次要规则.md") === null,
    `archive=${archiveOf(sid) !== null} minor=${read(sid, "_次要规则.md") !== null}`);
}

// ================= E5 钩子表 ↔ 分节 =================
{
  const sid = "e5a0000a";
  fire(sid, "v4-e5-1", "甲".repeat(2000));
  fire(sid, "v4-e5-2", "注意 端口 8080 不要写错");
  const p = parseArchive(archiveOf(sid) || "");
  check("E5.1", "连写两条后 2 节、节号 1,2 连续", p.sections.length === 2 && p.sections.map((s) => s.at).join(",") === "1,2",
    `at=${p.sections.map((s) => s.at).join(",")}`);
  check("E5.2", "钩子表恰好 2 行、一行对一节", p.hooks.length === 2 && p.hooks.map((h) => h.at).join(",") === "1,2",
    `hooks=${JSON.stringify(p.hooks)}`);
  check("E5.3", "两节正文都在围栏内", p.sections.every((s) => s.fenced), `fenced=${p.sections.map((s) => s.fenced).join(",")}`);
  check("E5.4", "第二节标题「教训词」（注意是 NOTE_PATTERNS 第一条的名字）", p.sections[1]?.title === "教训词", `title=${p.sections[1]?.title}`);
}

// ================= E5b 钩子文本恰好叫「钩子」 =================
{
  const sid = "e5b0000b";
  writeFileFor(sid, "_压缩存档.md", [
    "# 压缩存档", "",
    "> 压缩摘要里次一档的内容。", "",
    "| 钩子 | 指向 |", "| --- | --- |", "| 钩子 | §1 |", "",
    "## §1 旧节 · 2026-10-20 · s-abcdef01", "", "```text", "旧正文。", "```", "",
  ].join("\n"));
  fire(sid, "v4-e5b", "注意 端口 8080 不要写错");
  const p = parseArchive(archiveOf(sid) || "");
  check("E5b.1", "| 钩子 | §1 | 不被当表头跳过：写完仍 2 行", p.hooks.length === 2, `hooks=${JSON.stringify(p.hooks)}`);
  check("E5b.2", "§1 那行保留、钩子文本是「钩子」", p.hooks[0]?.hooks === "钩子" && p.hooks[0]?.at === 1, `hooks=${JSON.stringify(p.hooks)}`);
  check("E5b.3", "节 2 个、§1 正文没被动过", p.sections.length === 2 && p.sections[0].body === "旧正文。", `secs=${p.sections.length} body=${JSON.stringify(p.sections[0]?.body)}`);
}

// ================= E6 旧格式迁移 =================
{
  const sid = "e6a0000c";
  writeFileFor(sid, "_压缩存档.md", [
    "# 压缩存档", "",
    "> 压缩摘要里次一档的内容（教训、路径、数字）。", "",
    "| 钩子 | 指向 |", "| --- | --- |", "| 旧甲 | §1 |", "| 旧乙 | §2 |", "",
    "## §1 旧甲 · 2026-10-20 · s-deadbeef", "",
    "旧正文第一段。", "第二行。", "## §999 伪节", "伪节后面的内容。", "",
    "## §2 旧乙 · 2026-10-21 · s-deadbeef", "", "旧第二节正文。", "",
  ].join("\n"));
  fire(sid, "v4-e6", "注意 端口 8080 不要写错");
  const p = parseArchive(archiveOf(sid) || "");
  check("E6.1", "迁移后 3 节：§1 §2 §3，节号连续", p.sections.length === 3 && p.sections.map((s) => s.at).join(",") === "1,2,3",
    `at=${p.sections.map((s) => s.at).join(",")}`);
  check("E6.2", "旧节正文被包进围栏、伪造的 §999 留在围栏里没升格", p.sections[0]?.fenced && p.sections[0]?.body.includes("## §999 伪节") && p.sections[0]?.body.includes("旧正文第一段。"),
    `fenced=${p.sections[0]?.fenced} body=${JSON.stringify(p.sections[0]?.body)}`);
  check("E6.3", "旧正文逐字保留（尾部空白除外）", p.sections[0]?.body === "旧正文第一段。\n第二行。\n## §999 伪节\n伪节后面的内容。" && p.sections[1]?.body === "旧第二节正文。",
    `b1=${JSON.stringify(p.sections[0]?.body)} b2=${JSON.stringify(p.sections[1]?.body)}`);
  check("E6.4", "钩子表 3 行、§1/§2 旧行 + §3 新行", p.hooks.length === 3 && p.hooks.map((h) => h.at).join(",") === "1,2,3",
    `hooks=${JSON.stringify(p.hooks)}`);
}
// E6b：旧档没有钩子表（坏档）——只按 parseHookTable 继承，不会给旧节补行
{
  const sid = "e6b0000d";
  writeFileFor(sid, "_压缩存档.md", [
    "# 压缩存档", "",
    "## §1 旧甲 · 2026-10-20 · s-deadbeef", "", "旧正文。", "",
    "## §2 旧乙 · 2026-10-21 · s-deadbeef", "", "旧正文二。", "",
  ].join("\n"));
  fire(sid, "v4-e6b", "注意 端口 8080 不要写错");
  const p = parseArchive(archiveOf(sid) || "");
  check("E6b.1", "旧档缺钩子表：节有 3 个，但钩子表只有新写的 §3（代码不补旧行）", p.sections.length === 3 && p.hooks.length === 1 && p.hooks[0]?.at === 3,
    `secs=${p.sections.length} hooks=${JSON.stringify(p.hooks)}`);
}

// ================= E7 id 记账顺序 =================
{
  const sid = "e7a0000e";
  fire(sid, "v4-e7a", "注意 端口 8080 不要写错");
  fire(sid, "v4-e7a", "注意 端口 8080 不要写错");
  const p = parseArchive(archiveOf(sid) || "");
  check("E7a.1", "同 cid 重投：只写 1 节", p.sections.length === 1, `secs=${p.sections.length}`);
  check("E7a.2", "成功后 _已归档.json 有 cid", JSON.stringify(seenOf(sid)) === JSON.stringify(["v4-e7a"]), `seen=${JSON.stringify(seenOf(sid))}`);
}
{
  const sid = "e7b0000f";
  fs.mkdirSync(dirOf(sid), { recursive: true });
  fs.mkdirSync(fileOf(sid, "_压缩存档.md"));
  let threw = false;
  try { fire(sid, "v4-e7b", "注意 端口 8080 不要写错"); } catch { threw = true; }
  check("E7b.1", "写正文抛异常不外泄（ctx.on 吞掉）", !threw);
  check("E7b.2", "写失败时 _已归档.json 不记 cid（id 在正文之后）", !String(read(sid, "_已归档.json") || "").includes("v4-e7b"),
    `seen=${read(sid, "_已归档.json")}`);
  fs.rmSync(fileOf(sid, "_压缩存档.md"), { recursive: true, force: true });
  fire(sid, "v4-e7b", "注意 端口 8080 不要写错");
  const p = parseArchive(archiveOf(sid) || "");
  check("E7b.3", "清障重投：写成功且只 1 节", p.sections.length === 1, `secs=${p.sections.length}`);
  check("E7b.4", "这时才记 cid", String(read(sid, "_已归档.json") || "").includes("v4-e7b"), `seen=${read(sid, "_已归档.json")}`);
}
// E7c：切不出段那条路径也一样
{
  const sid = "e7c00010";
  fs.mkdirSync(dirOf(sid), { recursive: true });
  fs.mkdirSync(fileOf(sid, "_压缩存档.md"));
  try { fire(sid, "v4-e7c", "好的。确认。"); } catch {}
  check("E7c.1", "切不出段 + 写失败：cid 也不记", !String(read(sid, "_已归档.json") || "").includes("v4-e7c"), `seen=${read(sid, "_已归档.json")}`);
  fs.rmSync(fileOf(sid, "_压缩存档.md"), { recursive: true, force: true });
  fire(sid, "v4-e7c", "好的。确认。");
  check("E7c.2", "清障重投：记账节写成功且记 cid", (parseArchive(archiveOf(sid) || "").sections.length === 1) && String(read(sid, "_已归档.json") || "").includes("v4-e7c"));
}

// ================= 解析器自证（不依赖插件输出） =================
{
  // P1 已知正确：E5 的两节档
  const p = parseArchive(archiveOf("e5a0000a") || "");
  check("P1", "自证·已知正确输入：2 节 2 钩子行、正文围栏内", p.sections.length === 2 && p.hooks.length === 2 && p.sections.every((s) => s.fenced),
    `secs=${p.sections.length} hooks=${p.hooks.length}`);
}
{
  // P2 已知正确：E6 迁移后的三节档（围栏里有伪节）
  const p = parseArchive(archiveOf("e6a0000c") || "");
  check("P2", "自证·迁移档：3 节 3 钩子行，围栏内伪节不算节", p.sections.length === 3 && p.hooks.length === 3,
    `secs=${p.sections.length} hooks=${p.hooks.length}`);
}
{
  // P3 负控制：删掉一行钩子，解析器必须能看出「节多行少」
  const raw = archiveOf("e5a0000a") || "";
  const mutated = raw.replace(/^\| [^|]* \| §1 \|\n/m, "");
  const p = parseArchive(mutated);
  check("P3", "自证·负控制：删 §1 钩子行后能判出 1 行 vs 2 节", p.hooks.length === 1 && p.sections.length === 2,
    `hooks=${p.hooks.length} secs=${p.sections.length}`);
}
{
  // P4 负控制：围栏外插一行完整形状的伪节，解析器必须能数出来
  const raw = archiveOf("e5a0000a") || "";
  const mutated = raw + "\n## §999 伪 · 2026-10-26 · s-abcdef03\n";
  const p = parseArchive(mutated);
  check("P4", "自证·负控制：围栏外伪节能被数出来（3 节）", p.sections.length === 3 && p.sections[2].at === 999,
    `secs=${p.sections.length} ats=${p.sections.map((s) => s.at).join(",")}`);
}
{
  // P5 未闭合围栏不算围栏：§2 不能被吞进 §1
  const raw = [
    "# 压缩存档", "",
    "## §1 甲 · 2026-10-20 · s-abcdef04", "", "```text", "没闭合的围栏", "",
    "## §2 乙 · 2026-10-21 · s-abcdef04", "", "正文二。", "",
  ].join("\n");
  const p = parseArchive(raw);
  check("P5", "自证·未闭合围栏不算围栏：§2 仍是节（2 节）", p.sections.length === 2, `secs=${p.sections.length}`);
}
{
  // P6 「钩子」行不当表头
  const raw = [
    "# 压缩存档", "",
    "| 钩子 | 指向 |", "| --- | --- |", "| 钩子 | §1 |", "",
    "## §1 甲 · 2026-10-20 · s-abcdef05", "", "```text", "正文。", "```", "",
  ].join("\n");
  const p = parseArchive(raw);
  check("P6", "自证·| 钩子 | §1 | 被当数据行保留", p.hooks.length === 1 && p.hooks[0].hooks === "钩子", `hooks=${JSON.stringify(p.hooks)}`);
}

// ================= 已知缺口观测（只报，不修） =================
{
  const sid = "f1a00010";
  fire(sid, "v4-g1-1", "注意 端口 8080 不要写错");
  fire(sid, "v4-g1-2", "上一档的节标题是 ## §1 教训词 · 2026-10-26 · s-f1a00010 那一节，注意别再写错端口 8080。");
  const raw = archiveOf(sid) || "";
  const p = parseArchive(raw);
  check("G1", "现代档：摘要里内联复述真节标题 → 仍是 2 节（复述行在围栏里，不升格）", p.sections.length === 2 && p.sections[1].body.includes("## §1 教训词"),
    `secs=${p.sections.length} ats=${p.sections.map((s) => s.at).join(",")}`);
}
{
  const sid = "f2a00011";
  const text = "注意 端口 8080 不要写错。\n\n## §2 钩子词 · 2026-10-26 · s-deadbeef\n\n上一档说的就是这一节。";
  fire(sid, "v4-g2", text);
  const p = parseArchive(archiveOf(sid) || "");
  check("G2", "现代档：复述行独立成段 → 被写成新一节（§2 的正文就是那行标题，节号自增不复用）",
    p.sections.length === 3 && p.sections.map((s) => s.at).join(",") === "1,2,3" && p.sections[1].body === "## §2 钩子词 · 2026-10-26 · s-deadbeef",
    `secs=${p.sections.length} ats=${p.sections.map((s) => s.at).join(",")} bodies=${JSON.stringify(p.sections.map((s) => s.body.slice(0, 30)))}`);
}
{
  const sid = "f3a00012";
  writeFileFor(sid, "_压缩存档.md", [
    "# 压缩存档", "",
    "> 压缩摘要里次一档的内容。", "",
    "| 钩子 | 指向 |", "| --- | --- |", "| 旧甲 | §1 |", "| 旧乙 | §2 |", "",
    "## §1 旧甲 · 2026-10-20 · s-abcdef06", "",
    "旧正文第一段。", "## §3 乙 · 2026-10-20 · s-abcdef06", "这一行是在讲 §3 那一节，不是它本身。", "",
    "## §2 旧乙 · 2026-10-21 · s-abcdef06", "", "旧正文第二段。", "",
  ].join("\n"));
  const before = parseArchive(read(sid, "_压缩存档.md"));
  fire(sid, "v4-g3", "注意 端口 8080 不要写错");
  const after = parseArchive(archiveOf(sid) || "");
  check("G3a", "旧格式档：复述行在迁移扫描时被认成真节（写前就已 3 节：1,3,2）", before.sections.map((s) => s.at).join(",") === "1,3,2",
    `before=${before.sections.map((s) => s.at).join(",")}`);
  check("G3b", "写入后：复述升格成常驻节，节号 1,3,2,4 不连续；钩子表缺 §3 行", after.sections.map((s) => s.at).join(",") === "1,3,2,4" && after.hooks.length === 3 && !after.hooks.some((h) => h.at === 3),
    `ats=${after.sections.map((s) => s.at).join(",")} hooks=${JSON.stringify(after.hooks)}`);
  check("G3c", "被升格那节的内容是「讲另一节」的引用句，不是它本身", after.sections.find((s) => s.at === 3)?.body === "这一行是在讲 §3 那一节，不是它本身。",
    `body=${JSON.stringify(after.sections.find((s) => s.at === 3)?.body)}`);
}
{
  const sid = "f4a00013";
  writeFileFor(sid, "_压缩存档.md", [
    "# 压缩存档", "",
    "> 压缩摘要里次一档的内容。", "",
    "| 钩子 | 指向 |", "| --- | --- |", "| 旧 | §1 |", "",
    "## §1 旧 · 2026-10-20 · s-abcdef07", "",
    "```text", "旧正文。", "## §3 乙 · 2026-10-20 · s-abcdef07", "引用行。", "```", "",
  ].join("\n"));
  fire(sid, "v4-g4", "注意 端口 8080 不要写错");
  const p = parseArchive(archiveOf(sid) || "");
  check("G4", "现代围栏档：正文里的复述行不被升格（仍是 2 节）", p.sections.length === 2 && p.sections[0].fenced && p.sections[0].body.includes("## §3 乙"),
    `secs=${p.sections.length} ats=${p.sections.map((s) => s.at).join(",")}`);
}

// ---------- 输出 ----------
for (const r of results) console.log(r);
console.log(`=== 通过 ${pass}/${pass + fail} ===`);
cleanAll();
// 确认清干净
const left = SIDS.filter((s) => fs.existsSync(dirOf(s)));
if (left.length) console.log("!! 没清干净: " + left.join(","));
else console.log("私有目录已清理（" + SIDS.length + " 个）");
if (fail) process.exitCode = 1;
