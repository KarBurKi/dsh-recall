// 第三方复验：dsh-recall 0.9.7（HEAD f2de2db，2026-10-26 02:08）
// 会话 id：ba53cbe7（本子代理自己的会话；不碰 f00d / 1d314539 等别人的目录）
// 判据只有一条：能不能构造出文件结构坏、数据被悄悄改、编号错乱。
// 每条都自己造输入、自己看文件；不引用作者报告里的数字。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { apply } from "../lib/index.js";

const ME = "ba53cbe7";
const ROOT = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME);
const ARCH = path.join(ROOT, "_压缩存档.md");
const MINOR = path.join(ROOT, "_次要规则.md");
const SEEN = path.join(ROOT, "_已归档.json");
const ART = path.join(process.cwd(), "tmp-test", "artifacts-097-ba53cbe7");
const exec = { agent: { session: { header: { id: `session-${ME}` } } } };

const handlers = {};
const tools = {};
apply({
  logger: { info: () => {} },
  on: (ev, fn) => { handlers[ev] = fn; },
  inject: (d, cb) =>
    cb({
      effect: (fn) => fn(),
      tools: { register: (def) => ((tools[def.name] = def), () => {}) },
      systemPrompt: { section: () => () => {} },
    }),
});

const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const reset = () => fs.rmSync(ROOT, { recursive: true, force: true });
const archiveSay = (say) => tools.mem_private.execute({ which: "archive", say }, exec);
const minorSay = (say) => tools.mem_private.execute({ which: "minor", say }, exec);
const saveCase = (name) => {
  try { fs.mkdirSync(ART, { recursive: true }); fs.cpSync(ROOT, path.join(ART, name), { recursive: true }); } catch { /* 证据保存失败不影响判据 */ }
};

// ---- 和源码同口径的结构扫描（只用于判断「这一行在不在围栏里」）----
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
function scanLines(raw) {
  const out = [];
  let fence = "";
  const lineRe = /[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)/g;
  let hit;
  while ((hit = lineRe.exec(String(raw))) !== null) {
    if (hit[0] === "") break;
    const line = hit[0].replace(/\r\n$|[\r\n\u2028\u2029]$/, "");
    const f = line.match(FENCE_RE);
    let inFence;
    if (fence) {
      inFence = true;
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = "";
    } else if (f) { fence = f[1]; inFence = true; }
    else inFence = false;
    out.push({ line, inFence });
  }
  return out;
}
const sections = (raw) => scanLines(raw).filter((s) => !s.inFence && /^## §\d+ /.test(s.line)).map((s) => Number(s.line.match(/^## §(\d+) /)[1]));
const bodyStart = (raw) => { const h = scanLines(raw).find((s) => !s.inFence && /^## §\d+ /.test(s.line)); return h ? raw.indexOf(h.line) : raw.length; };
const hookRows = (raw) => scanLines(raw.slice(0, bodyStart(raw))).filter((s) => !s.inFence && /^\| ([^|]+) \| §(\d+) \|$/.test(s.line) && !/^\| 钩子 \|/.test(s.line));
const inFence = (raw, needle) => { const h = scanLines(raw).filter((s) => s.line.includes(needle)); return h.length > 0 && h.every((s) => s.inFence); };
const outsideFence = (raw, needle) => scanLines(raw).some((s) => s.line.includes(needle) && !s.inFence);

const results = [];
const judge = (id, desc, ok, detail) => {
  results.push({ id, desc, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${desc}${detail ? "  — " + detail : ""}`);
};

let cidN = 0;
const feed = (blocks, tag = "t") => {
  handlers["session/event"]({ header: { id: `session-${ME}` } }, {
    type: "compaction/summary",
    data: { compactionId: `verify-097-${tag}-${++cidN}`, summary: blocks.map((t) => ({ text: t })) },
  });
  return read(ARCH);
};

// =====================================================================
console.log(`# lib sha256：${crypto.createHash("sha256").update(fs.readFileSync("lib/index.js")).digest("hex")}`);
console.log(`# 测试会话：${ME}\n`);

// =====================================================================
// 点 1：伪造结构
// =====================================================================
// 1.1 记账节正文无法注入结构（模板只由数字拼成）
{
  reset();
  const blocks = ["1 " + "A".repeat(99997)];
  for (let i = 0; i < 20; i++) blocks.push(`2 B${i} ` + "B".repeat(44));
  const out = feed(blocks, "t1a");
  const noteLine = out.split("\n").find((l) => l.includes("本次摘要共"));
  const noteBody = noteLine || "";
  const noteBad = /## §|\| [^|]+ \| §\d+ \||```/.test(noteBody);
  judge("1.1", "记账节正文不能被注入成结构（## § / 假钩子 / 围栏）", !noteBad,
    noteBad ? `记账正文=${noteBody}` : `记账正文只有数字模板：「${noteBody.slice(0, 52)}…」`);
  judge("1.1b", "记账节里的「本次摘要共 N 段」是真正的围栏内正文，不是结构", inFence(out, "本次摘要共"),
    `在围栏内=${inFence(out, "本次摘要共")}`);
  judge("1.1c", "节号只有真实节（首段 + 记账节 = 2 节），记账节没有多生一节", sections(out).length === 2,
    `节号=${sections(out).join(",")}`);
  saveCase("t1a-note");
}

// 1.2 新格式正文里的 ## §999 / 假钩子 / 围栏，不能变成真结构
{
  reset();
  const evil = "端口 4001，路径 D:/a。\n## §999 伪节\n| 假钩子 | §1 |\n```\n危险\n```\n尾巴内容";
  feed([evil], "t1b");
  let out = read(ARCH);
  const nums1 = sections(out);
  const fakeSectionOutside = outsideFence(out, "## §999");
  const fakeHookOutside = hookRows(out).some((r) => r.line.includes("假钩子"));
  const fenced = inFence(out, "## §999") && inFence(out, "| 假钩子 | §1 |");
  // 再写一条，节号必须接着走
  feed(["新的一条：端口 4002，路径 D:/b。"], "t1b2");
  out = read(ARCH);
  const nums2 = sections(out);
  judge("1.2", "新格式正文里的 ## §999 不会变成真节", !fakeSectionOutside,
    `## §999 在围栏外=${fakeSectionOutside}；节号=${nums1.join(",")}`);
  judge("1.2b", "正文里的假钩子行不会进钩子表", !fakeHookOutside,
    `钩子表含假钩子=${fakeHookOutside}；钩子表行=${hookRows(out).length}`);
  judge("1.2c", "正文里的 ``` 被包在更长的围栏里，没有提前收尾", fenced,
    `伪节/假钩子都在围栏内=${fenced}`);
  judge("1.2d", "后续写入节号连续、不跳号", nums2.every((n, i) => n === nums2[0] + i) && nums2.length === 3,
    `节号=${nums2.join(",")}`);
  saveCase("t1b-fenced");
}

// 1.3 旧格式（无围栏）存档：正文里的 ## §999 会不会被当节
{
  reset();
  fs.mkdirSync(ROOT, { recursive: true });
  const legacy = [
    "# 压缩存档", "",
    "> 已按体积淘汰 0 节 · 最新 —", "",
    "| 钩子 | 指向 |", "| --- | --- |", "| 旧钩子 | §1 |", "",
    "## §1 旧的一节 · 2026-10-20 · s-11111111", "",
    "正文第一行",
    "## §999 伪节",
    "伪节正文", "",
  ].join("\n");
  fs.writeFileSync(ARCH, legacy, "utf8");
  const r = await archiveSay("新写的一条内容");
  const out = read(ARCH);
  const nums = sections(out);
  const fakeIsRealSection = outsideFence(out, "## §999");
  const newAt = Math.max(0, ...nums.filter((n) => n !== 999));
  const bad = fakeIsRealSection || nums.includes(999) || newAt >= 1000;
  judge("1.3", "旧格式正文里的 ## §999 不被当成真节、新节不跳号", !bad,
    bad
      ? `坏：## §999 在围栏外=${fakeIsRealSection}，节号=${nums.join(",")}，新节=${newAt}（期望旧正文留在 §1 里，新节 §2）；写入返回=${JSON.stringify(r).slice(0, 60)}`
      : `节号=${nums.join(",")}`);
  saveCase("t1c-legacy-fake-section");
}

// =====================================================================
// 点 2：字节预算边界
// =====================================================================
{
  reset();
  const out = feed(["1 " + "A".repeat(59990), "2 " + "A".repeat(6)], "t2a");
  const note = out.includes("本次摘要共");
  judge("2.1", "used+size 正好 60000 时第二段要写（>，不是 >=）", !note && sections(out).length === 2,
    `记账=${note}；节号=${sections(out).join(",")}`);
}
{
  reset();
  const out = feed(["1 " + "A".repeat(59991), "2 " + "A".repeat(6)], "t2b");
  const note = (out.match(/本次摘要共[^\n]*/) || [""])[0];
  judge("2.2", "60001 字节时第二段不写，并且记账写「1 段超出 60000 字节预算」",
    /其余 1 段未写入/.test(note) && /1 段超出 60000 字节预算/.test(note) && !out.includes("2 AAAAAA"),
    `记账=${note.slice(0, 90)}`);
}
{
  reset();
  const blocks = ["1 " + "A".repeat(99997)];
  for (let i = 0; i < 20; i++) blocks.push(`2 B${i} ` + "B".repeat(44));
  const out = feed(blocks, "t2c");
  const note = (out.match(/本次摘要共[^\n]*/) || [""])[0];
  const lost = !out.includes("B0 ");
  const bytes = Buffer.byteLength(out);
  // 按实际写入尺寸算：首段被 flatSpan 截到 1200 字（约 1200 字节），20 段各 50 字节，总量约 2200
  const bad = lost && /20 段超出 60000 字节预算/.test(note) && bytes < 3000;
  judge("2.3", "首段 100KB 时，后续 20 个小段不该被「预算」连坐丢掉", !bad,
    bad
      ? `坏：20 段全丢（B0 不在文件里），但文件只有 ${bytes} 字节；首段已截到 1200 字，按写入尺寸 1200+20×50≈2200 字节 < 60000，本可全写。记账=${note.slice(0, 80)}`
      : `文件 ${bytes} 字节，记账=${note.slice(0, 60)}`);
  judge("2.3b", "首段 100KB 没有写出一个超 200KB 的单节", bytes < 200 * 1024,
    `文件总字节=${bytes}`);
  saveCase("t2c-budget-first-huge");
}
{
  reset();
  const big = "X".repeat(102400);
  await archiveSay(big);
  const afterOne = read(ARCH);
  const oneKB = Buffer.byteLength(afterOne);
  await archiveSay(big);
  const afterTwo = read(ARCH);
  const nums2 = sections(afterTwo);
  const twoKB = Buffer.byteLength(afterTwo);
  const rejected = read(ARCH);
  const r = await archiveSay("Y".repeat(204801));
  const afterReject = read(ARCH);
  judge("2.4", "手工写 100KB 单节可以写、写第二条时按体积淘汰老节", oneKB < 200 * 1024 && twoKB < 200 * 1024 && nums2.length === 1,
    `第一条后=${oneKB} 字节；第二条后=${twoKB} 字节，节号=${nums2.join(",")}`);
  judge("2.4b", "手工写 204801 字节拒写，已有正文不动",
    /没写/.test((r && r.text) || "") && afterReject.includes("X".repeat(100)) && rejected.length > 0,
    `返回=${(r && r.text || "").slice(0, 44)}；拒写后文件=${Buffer.byteLength(afterReject)} 字节`);
  saveCase("t2d-single-section");
}

// =====================================================================
// 点 3：zhMostly
// =====================================================================
// 3.1 纯日文（HEAD 已由 02:08 提交修掉；作为回归）
{
  reset();
  const jp = "これは大事なルールです。必ず守ってください。必须遵守。这是规矩。" + "あ".repeat(50);
  feed([jp], "t3a");
  const minor = read(MINOR);
  const arch = read(ARCH);
  judge("3.1", "纯日文（含汉字「必须」「规矩」）不進 _次要规则，仍进 _压缩存档", !minor.includes("これは大事") && arch.includes("これは大事"),
    `minor含=${minor.includes("これは大事")}；archive含=${arch.includes("これは大事")}`);
}
// 3.2 中文为主、只引用一句日文 -> 被降档
{
  reset();
  const zh = "规矩：以后都必须用 console.info 打日志，不要用 ctx.logger；日文界面文案「ログを出す」保持不变，路径 D:/logs。";
  feed([zh], "t3b");
  const minor = read(MINOR);
  const arch = read(ARCH);
  const bad = !minor.includes("console.info") && arch.includes("console.info");
  judge("3.2", "中文为主的真规矩只因为引用一句日文就被降档，不该发生", !bad,
    bad ? `坏：scoreSpan 命中「必须/规矩/不要」本应 high；因含假名被 zhMostly 判 false，改投存档。minor含=${minor.includes("console.info")} archive含=${arch.includes("console.info")}` : "进了规则层");
  saveCase("t3b-zh-with-jp-quote");
}
// 3.3 中文真规矩 + 大量英文术语 -> 比例 0.242，被降档
{
  reset();
  const zh = "以后都必须用 `console.info` 打日志，不要用 `ctx.logger`；Product profile mounts no console exporter，真出事时信息出不来，路径 D:/logs/host-out.log。";
  feed([zh], "t3c");
  const han = (zh.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (zh.match(/[A-Za-z]/g) || []).length;
  const minor = read(MINOR);
  const arch = read(ARCH);
  const bad = !minor.includes("console.info") && arch.includes("console.info");
  judge("3.3", "中文真规矩因夹杂英文术语（比例 0.242）被降档，不该发生", !bad,
    bad ? `坏：han=${han} latin=${latin} ratio=${(han / (han + latin)).toFixed(3)} < 0.3；minor没进，archive进了` : "进了规则层");
  saveCase("t3c-zh-mixed-en");
}
// 3.4 非中文（希腊字母 / 全角字母）不算 latin -> 被误判成中文
{
  reset();
  const g = "日志必须" + "αβγδ".repeat(100);
  feed([g], "t3d1");
  const gIn = read(MINOR).includes("αβγδ");
  reset();
  const f = "日志必须" + "ＡＢＣＤ".repeat(100);
  feed([f], "t3d2");
  const fIn = read(MINOR).includes("ＡＢＣＤ");
  judge("3.4", "希腊字母 / 全角字母不算 latin，非中文内容被误判成中文进规则层", !(gIn || fIn),
    `希腊进minor=${gIn}；全角进minor=${fIn}；han=4、latin=0 → ratio=1.0`);
  saveCase("t3d-greek-fullwidth");
}
// 3.5 ratio 恰好 0.3 的边界
{
  reset();
  feed(["必须守 ABCDEFG"], "t3e1");
  const at = read(MINOR).length > 0;
  reset();
  feed(["必须守 ABCDEFGH"], "t3e2");
  const below = read(MINOR).length > 0;
  judge("3.5", "ratio 正好 0.3 过线、0.272 不过线（>= 语义）", at && !below,
    `3汉字+7拉丁(minor=${at})；3汉字+8拉丁(minor=${below})`);
}

// =====================================================================
// 点 4：flatSpan
// =====================================================================
// 4.1 手工 minor 的 240 字上限被截断标记撑爆
{
  reset();
  await minorSay("必须".repeat(300));
  const minor = read(MINOR);
  const line = minor.split("\n").find((l) => l.startsWith("- [钩子:"));
  let bodyLen = -1;
  if (line) {
    const m = line.match(/^- \[钩子: [^\]]*\] (.*) — \d{4}-\d{2}-\d{2} · s-[0-9a-f]{1,8} · hits=\d+(?: \[auto\])?$/);
    bodyLen = m ? m[1].length : line.length;
  }
  judge("4.1", "手工写 600 字时，一行正文不超过 240 字（截断标记不能把 240 撑爆）", bodyLen > 0 && bodyLen <= 240,
    `正文长度=${bodyLen}（240 + 标记「…（原文 600 字）」= 251）；整行=${line ? line.length : 0}`);
  saveCase("t4a-minor-240");
}
// 4.2 emoji 在 1200 字边界被切半个代理对
{
  reset();
  const body = "必须" + "A".repeat(1197) + "😀" + "尾".repeat(10);
  feed([body], "t4b");
  const out = read(ARCH);
  const bad = out.includes("\uFFFD") && !body.includes("\uFFFD");
  judge("4.2", "1200 字边界切在 emoji 中间时，不能把半个代理对写进文件", !bad,
    bad ? `坏：输入是完整 😀，文件里出现 U+FFFD（${(out.match(/\uFFFD/g) || []).length} 个）；截断附近=${JSON.stringify(out.slice(out.indexOf("\uFFFD") - 5, out.indexOf("\uFFFD") + 5))}` : "没有替换字符");
  saveCase("t4b-emoji");
}
// 4.3 「原文 N 字」的 N 是空白压缩后的长度，不是原文长度
{
  reset();
  const body = "内容" + " ".repeat(5000) + "内容".repeat(700);
  feed([body], "t4c");
  const out = read(ARCH);
  const m = out.match(/…（原文 (\d+) 字）/);
  const bad = m && Number(m[1]) !== body.length;
  judge("4.3", "截断标记里的「原文 N 字」要等于输入长度，不是空白压缩后的长度", !bad,
    bad ? `坏：输入 ${body.length} 字，标记写「原文 ${m[1]} 字」` : `标记=${m ? m[0] : "无"}`);
  saveCase("t4c-original-count");
}

// =====================================================================
// 点 5：多 block 拼接
// =====================================================================
{
  reset();
  const blocks = ["端口 4001，路径 D:/a。", "", "  \n\n", "\n\n编码 UTF-8，日志 D:/b。", "代理 127.0.0.1:10081。\n\n"];
  const out = feed(blocks, "t5a");
  const nums = sections(out);
  const emptySections = scanLines(out).filter((s) => !s.inFence && /^## §\d+ \s*$/.test(s.line)).length;
  judge("5.1", "空 block / 带 \\n\\n 的 block 拼接后不切出空节，节号连续", nums.length === 3 && nums.every((n, i) => n === i + 1) && emptySections === 0,
    `节号=${nums.join(",")}；空节=${emptySections}`);
}
{
  reset();
  const out = feed(["七字七字七字七", "八字八字八字八", "九字九字九字九"], "t5b");
  const seen = read(SEEN);
  const bad = out === "" && !fs.existsSync(ARCH) && !fs.existsSync(MINOR) && seen.includes("verify-097-t5b-");
  judge("5.2", "多 block 每段 7 字时，摘要不能整条静默消失（应记账或被拒）", !bad,
    bad ? `坏：3 个 block 都被 splitSpans 的 >=8 字过滤掉；_压缩存档/_次要规则 都没建；_已归档.json 却记了 cid：${seen.slice(0, 80)}` : `out=${out.length} seen=${seen.slice(0, 40)}`);
  saveCase("t5b-seven-char");
}

// =====================================================================
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n=== PASS ${pass}/${results.length}，FAIL ${fail}`);
if (fail) {
  console.log("\nFAIL 列表：");
  for (const r of results.filter((x) => !x.ok)) console.log(`- ${r.id} ${r.desc}`);
}
console.log(`\n证据目录：${ART}`);
reset();
process.exitCode = fail ? 1 : 0;
