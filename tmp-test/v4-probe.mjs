// v4 探针：只算数、只演示作者断言里的量错对象/空断言，不判插件对错。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../lib/index.js";

const tools = {};
apply({
  logger: { info: () => {} },
  on: () => {},
  inject: (d, cb) => cb({
    effect: (fn) => fn(),
    tools: { register: (def) => ((tools[def.name] = def), () => {}) },
    systemPrompt: { section: () => () => {} },
  }),
});

const P = (...a) => console.log(...a);
const han = (s) => (s.match(/[\u3400-\u9fff]/g) || []).length;
const letters = (s) => (s.match(/\p{L}/gu) || []).length;
const kana = (s) => (s.match(/[\u3040-\u30ff]/g) || []).length;
const hangul = (s) => (s.match(/[\uac00-\ud7af]/g) || []).length;
const ratio = (s) => {
  const L = letters(s);
  return { han: han(s), kana: kana(s), hangul: hangul(s), letters: L, hanRatio: +(han(s) / L).toFixed(4), kanaRatio: +((kana(s) + hangul(s)) / L).toFixed(4) };
};

P("=== 1. 语种计数（作者注释里的数字对不对） ===");
const t32 = "规矩：以后都必须用 console.info 打日志，不要用 ctx.logger；日文界面文案「ログを出す」保持不变，路径 D:/logs。";
const t33 = "以后都必须用 console.info 打日志，不要用 ctx.logger；Product profile mounts no console exporter for ctx.logger，所以那条诊断信息在真出事的时候也出不来，路径 D:/logs/recall.log。";
const t34 = "日志必须" + "αβγδ".repeat(100) + "，端口 4001。";
const t34b = "日志必须" + "ＡＢＣＤ".repeat(100) + "，端口 4002。";
const t35 = "必须规矩" + "a".repeat(16) + " 4001。";
const t35b = "必须规矩" + "a".repeat(17) + " 4002。";
const t35c = "以后都必须用 console.info 打日志，不要用 ctx.logger，路径 D:/logs 端口 4001，界面文案「" + "あ".repeat(25) + "」保持不变。";
for (const [k, v] of Object.entries({ "3.2": t32, "3.3": t33, "3.4": t34, "3.4b": t34b, "3.5": t35, "3.5b": t35b, "3.5c": t35c })) {
  const r = ratio(v);
  P(k, JSON.stringify(r), "进规则层?", r.hanRatio >= 0.2 && r.kanaRatio <= 0.25);
}
P("3.3 作者注释说「23 个汉字 72 个拉丁 = 0.242」，上面实际是：", JSON.stringify(ratio(t33)));

P("");
P("=== 2. flatSpan 切点位置（4.2 / E8 的 emoji 是不是真的在切点上） ===");
const markLen = (n) => Array.from(`…（原文 ${n} 字）`).length;
function cutInfo(label, text) {
  const rawLen = text.length;
  const cps = Array.from(text);
  const mark = `…（原文 ${rawLen} 字）`;
  const keep = 1200 - Array.from(mark).length;
  const emojiAt = cps.findIndex((c) => c === "😀" || c === "👨" || /\u200d/.test(c));
  P(label, { rawLen, codePoints: cps.length, markLen: Array.from(mark).length, keep, emojiAt, 切到emoji: emojiAt >= 0 && emojiAt < keep, 切在emoji后一位: emojiAt === keep });
  P("   body 尾部:", JSON.stringify(cps.slice(keep - 6, keep).join("")), "+", JSON.stringify(cps.slice(keep, keep + 4).join("")));
}
cutInfo("4.2", "必须" + "A".repeat(1197) + "😀" + "尾".repeat(10));
cutInfo("E8", "必须 D:/logs 端口 4001 " + "A".repeat(1180) + "👨\u200d👩\u200d👧" + "尾".repeat(20));

P("");
P("=== 3. 4.1 的 len 量的是哪一段 ===");
const ME = "f00d0b02";
const dir = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME);
if (fs.existsSync(dir)) throw new Error("f00d0b02 已存在，停手");
const minorFile = path.join(dir, "_次要规则.md");
const sess = { agent: { session: { header: { id: `session-${ME}` } } } };
tools.mem_private.execute({ which: "minor", say: "必须" + "字".repeat(598) + "，端口 4001。" }, sess);
const line = fs.readFileSync(minorFile, "utf8").split("\n").filter((l) => l.trim()).reduce((a, b) => (b.length > a.length ? b : a), "");
const k = line.lastIndexOf(" — ");
P("整行长度:", line.length);
P("k(lastIndexOf(\" — \")):", k);
P("line.slice(k+3):", JSON.stringify(line.slice(k + 3)), "长度:", line.slice(k + 3).length);
P("真正正文长度: 459? 用正则量：", (line.match(/^- \[钩子: [^\]]*\] ([\s\S]*?) — \d{4}-\d{2}-\d{2} · s-/) || [])[1]?.length);
P("行首 40 字:", JSON.stringify(line.slice(0, 40)));
P("行尾 60 字:", JSON.stringify(line.slice(-60)));
// 演示：把正文换成 3000 字，作者公式仍 ≤240
const fake = "- [钩子: 字字,4001,端口] " + "字".repeat(3000) + " — 2026-10-26 · s-f00d0b02 · hits=0";
const k2 = fake.lastIndexOf(" — ");
P("伪造 3000 字正文后，作者公式 len =", fake.slice(k2 + 3).length, "（仍然 ≤240）");

P("");
P("=== 4. 1x-b 是恒真式：把 §999 伪造成真节（模拟 bug）后它照样 PASS ===");
const outOk = [
  "## §1 旧节 · 2026-10-20 · s-old", "", "```text", "旧正文。", "## §999 伪节", "伪节下面的内容", "```", "",
  "## §2 新节 · 2026-10-26 · s-f00d0b02", "", "```text", "新。", "```",
].join("\n");
const outBug = [
  "## §1 旧节 · 2026-10-20 · s-old", "", "```text", "旧正文。", "```", "",
  "## §999 伪节", "伪节下面的内容", "",
  "## §2 新节 · 2026-10-26 · s-f00d0b02", "", "```text", "新。", "```",
].join("\n");
function inFence(out, needle) {
  let fence = false;
  for (const line of out.split("\n")) {
    const m = line.match(/^(`{3,})/);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1].length >= fence.length) fence = "";
      if (line.includes(needle)) return fence !== "";
      continue;
    }
    if (line.includes(needle)) return fence !== "";
  }
  return false;
}
const judge1xb = (out) => !inFence(out, "## §999 伪节") || out.indexOf("## §999") > out.indexOf("## §1");
P("正常输出（伪节在围栏里）1x-b =", judge1xb(outOk), "inFence=", inFence(outOk, "## §999 伪节"));
P("bug 输出（伪节被升格到围栏外）1x-b =", judge1xb(outBug), "inFence=", inFence(outBug, "## §999 伪节"));
P("字符串完全不存在的输出 1x-b =", judge1xb("## §1 a · 2026-10-20 · s-old\n"), "inFence=", inFence("## §1 a · 2026-10-20 · s-old\n", "## §999 伪节"));

P("");
P("=== 5. 作者的钩子行读取器不跳围栏：正文里一行假表行会被算成钩子 ===");
const withFakeRow = [
  "| 钩子 | 指向 |", "| --- | --- |", "| 真 | §1 |", "",
  "## §1 甲 · 2026-10-20 · s-abc", "", "```text", "| 假 | §2 |", "```", "",
].join("\n");
const rows = withFakeRow.split("\n").filter((l) => !/^## §\d+ /.test(l)).map((l) => l.match(/^\| ([^|]+) \| §(\d+) \|$/)).filter(Boolean).map((m) => ({ hooks: m[1].trim(), at: Number(m[2]) })).filter((r) => r.hooks !== "指向");
P("作者解析器读到:", JSON.stringify(rows), "（真表 1 行，凭空多出 §2）");

P("");
P("=== 6. 作者 sections() 只认 LF 分割 ===");
const crlf = "## §1 甲 · 2026-10-20 · s-abc\r\n\r\n```text\r\n正文\r\n```\r\n";
const secs = [];
{
  let fence = "";
  for (const line of crlf.split("\n")) {
    const m = line.match(/^(`{3,})/);
    if (m) { if (!fence) fence = m[1]; else if (m[1].length >= fence.length) fence = ""; continue; }
    if (fence) continue;
    const sec = line.match(/^## §(\d+) /);
    if (sec) secs.push(Number(sec[1]));
  }
}
P("CRLF 档里作者 sections() 读到:", JSON.stringify(secs), "（插件自己的 scanLines 认 CRLF）");

fs.rmSync(dir, { recursive: true, force: true });
P("");
P("探针私有目录已清理:", !fs.existsSync(dir));
