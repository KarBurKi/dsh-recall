// 0.9.7 复验回归：第三方复验（session ba53cbe7，2026-10-26）构造出的 9 条坏状态。
// 每一条都是「它构造得出来、原代码挡不住」的输入，现在逐条钉住——构造不出来了才算修好。
// 这份和 fix-097.mjs 分开：那份是指挥中心的三条判据，这份是复验挑出来的洞。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
// FIX_SRC 指到另一份 lib/index.js 时跑那份（用来证明「换了旧实现这条断言会红」）。
// 不指就跑工作区当前实现。
const SRC = process.env.FIX_SRC ? path.resolve(process.env.FIX_SRC) : path.resolve("lib/index.js");
const { apply } = await import(pathToFileURL(SRC).href);

const handlers = {};
const tools = {};
apply({
  logger: { info: () => {} },
  on: (ev, fn) => {
    handlers[ev] = fn;
  },
  inject: (d, cb) =>
    cb({
      effect: (fn) => fn(),
      tools: { register: (def) => ((tools[def.name] = def), () => {}) },
      systemPrompt: { section: () => () => {} },
    }),
});

const ME = "f00d0b02";
const dir = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME);
const ARCH = path.join(dir, "_压缩存档.md");
const MINOR = path.join(dir, "_次要规则.md");
const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const reset = () => fs.rmSync(dir, { recursive: true, force: true });

const results = [];
const judge = (n, desc, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} 判据${n} ${desc}${detail ? " — " + detail : ""}`);
};

/** 节号列表：只算围栏外的 `## §N `（围栏里的伪节不算结构）。 */
const sections = (out) => {
  const out2 = [];
  let fence = "";
  for (const line of out.split("\n")) {
    const m = line.match(/^(`{3,})/);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1].length >= fence.length) fence = "";
      continue;
    }
    if (fence) continue;
    const sec = line.match(/^## §(\d+) /);
    if (sec) out2.push(Number(sec[1]));
  }
  return out2;
};

/** 一行是否落在围栏里（简单扫一遍围栏开关）。 */
const inFence = (out, needle) => {
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
};

let cidN = 0;
const feed = (blocks) => {
  handlers["session/event"]({ header: { id: `session-${ME}` } }, {
    type: "compaction/summary",
    data: { compactionId: `v097-${++cidN}`, summary: blocks.map((t) => ({ text: t })) },
  });
  return read(ARCH);
};

const archiveSay = (say) =>
  tools.mem_private.execute(
    { which: "archive", say },
    { agent: { session: { header: { id: `session-${ME}` } } } },
  );

// =====================================================================
// 1.3  旧格式（无围栏）存档正文里的 `## §999` 不能被当成真节
// =====================================================================
{
  reset();
  fs.mkdirSync(dir, { recursive: true });
  // 旧档：整个文件没有一个围栏，§1 正文里藏着伪节
  fs.writeFileSync(
    ARCH,
    [
      "# 压缩存档",
      "",
      "> 已按体积淘汰 0 节 · 最新 —",
      "",
      "| 钩子 | 指向 |",
      "|---|---|",
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
  const out = feed(["端口 4002，路径 D:/new.log 新加的一条够长了。"]);
  const nums = sections(out);
  judge("1.3", "旧档伪节不被升格、新节号是 §2 不是 §1000", nums.join(",") === "1,2", `节号=${nums.join(",")}`);
  judge("1.3b", "伪节被包进围栏，不再算结构", inFence(out, "## §999 伪节"), `在围栏内=${inFence(out, "## §999 伪节")}`);
}

// =====================================================================
// 1.1b / 1.1c  记账节：正文在围栏里，且不多生一节
//   注：复验原输入（首段 100KB + 20 个小段）在 2.3 修好后**不再触发记账**
//   （那些段全装得下），所以换一个真超预算的输入。
// =====================================================================
{
  reset();
  const blocks = [];
  for (let i = 1; i <= 20; i++) blocks.push(`第 ${i} 段：端口 ${4000 + i}。` + "内容".repeat(740));
  const out = feed(blocks);
  const note = (out.match(/^本次摘要共[^\n]*/m) || [""])[0];
  judge("1.1b", "记账正文是围栏内正文，不是结构", inFence(out, "本次摘要共"), `在围栏内=${inFence(out, "本次摘要共")}：${note.slice(0, 48)}`);
  const secs = sections(out);
  judge("1.1c", "记账节没有多生一节（节号连续）", secs.every((n, i) => n === i + 1), `节号=${secs.join(",")}`);
}

// =====================================================================
// 2.3  首段 100KB 时，后面的小段不能被「预算」连坐丢掉
// =====================================================================
{
  reset();
  const blocks = ["1 " + "A".repeat(99997)];
  for (let i = 0; i < 20; i++) blocks.push(`2 B${i} ` + "B".repeat(44));
  const out = feed(blocks);
  const secs = sections(out);
  judge("2.3", "首段 100KB 时后 20 个小段仍然写进去", secs.length === 21, `写了 ${secs.length} 节（期望 21）`);
  judge("2.3b", "20 个小段都真进了文件", ["B0", "B19"].every((k) => out.includes(k)), `B0=${out.includes("B0")} B19=${out.includes("B19")}`);
  judge("2.3c", "没有写出超 200KB 的单节", Buffer.byteLength(out, "utf8") < 200 * 1024, `文件 ${Buffer.byteLength(out, "utf8")} 字节`);
}

// =====================================================================
// 3.2 / 3.3 / 3.4  语种判定的三个反例
// =====================================================================
{
  // 3.2 中文真规矩，只引用了日文界面文案
  reset();
  feed([
    "规矩：以后都必须用 console.info 打日志，不要用 ctx.logger；日文界面文案「ログを出す」保持不变，路径 D:/logs。",
  ]);
  judge("3.2", "中文真规矩只因引用一句日文就被降档，不该发生", read(MINOR).includes("console.info"), `规则层 ${read(MINOR).length} 字`);

  // 3.3 中文真规矩夹英文术语（汉字 23 / 拉丁 72 = 0.242）
  reset();
  feed([
    "以后都必须用 console.info 打日志，不要用 ctx.logger；Product profile mounts no console exporter for ctx.logger，所以那条诊断信息在真出事的时候也出不来，路径 D:/logs/recall.log。",
  ]);
  judge("3.3", "中文真规矩夹英文术语（比例 0.242）仍进规则层", read(MINOR).includes("console.info"), `规则层 ${read(MINOR).length} 字`);

  // 3.4 希腊字母 / 全角字母不算中文
  reset();
  feed(["日志必须" + "αβγδ".repeat(100) + "，端口 4001。"]);
  judge("3.4", "希腊字母占绝大多数时不进规则层", !read(MINOR).includes("αβγδ"), read(MINOR) ? "进了" : "没进");
  reset();
  feed(["日志必须" + "ＡＢＣＤ".repeat(100) + "，端口 4002。"]);
  judge("3.4b", "全角字母占绝大多数时不进规则层", !read(MINOR).includes("ＡＢＣＤ"), read(MINOR) ? "进了" : "没进");
}

// =====================================================================
// 4.1 / 4.2 / 4.3  flatSpan 的三个坑
// =====================================================================
{
  // 4.1 手工 minor 的 240 字上限不能被截断标记撑爆
  reset();
  archiveSay("");
  tools.mem_private.execute(
    { which: "minor", say: "必须" + "字".repeat(598) + "，端口 4001。" },
    { agent: { session: { header: { id: `session-${ME}` } } } },
  );
  const minor = read(MINOR);
  const lines = minor.split("\n").filter((l) => l.trim());
  const line = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  // 240 是**正文**上限，整行还带 `- [钩子: ...] ` 前缀和 ` — 日期 · 会话 · hits` 尾巴。
  // 正文在**中间**：`] ` 之后、` — ` 之前。第四轮复验抓到这条原来量错对象——
  // 用 `lastIndexOf(" — ")` 取的是尾巴（日期/会话号/hits，32 字），正文 240 字它量不到，
  // 正文涨到 3000 字这条也照样绿（假 PASS）。
  const head = line.indexOf("] ");
  const tail = line.indexOf(" — ");
  const body240 = head >= 0 && tail > head ? line.slice(head + 2, tail) : "";
  judge("4.1", "手工 minor 的正文不超过 240 字（标记算在上限里）", !line || (body240.length > 0 && body240.length <= 240), `正文 ${body240.length} 字，整行 ${line.length} 字`);
  // 反向钉住：正文里塞进超长内容时必须**被截断**（否则上面那条只是「量到了 0 字」也能过）
  const over240 = body240.includes("…（原文");
  judge("4.1-b", "超 240 字的正文真的被截断并留标记", body240.length > 0 && over240, `正文含截断标记=${over240}`);

  // 4.2 emoji 不能被切出半个代理对
  reset();
  // 切点是 1200 - 12（标记「…（原文 N 字）」）= 1188 码点。emoji 必须落在**切点两侧**，
  // 不然整颗被丢掉，新旧代码输出逐字节相同，这条就空转了（第四轮复验实测：
  // 原来放码点 1199，旧 0.9.6 实现和新实现跑出来完全一样）。
  // 现在放在 1187（「必须」2 + A×1185），旧实现按 UTF-16 会切出孤立高代理 → 落盘 U+FFFD。
  feed(["必须" + "A".repeat(1185) + "😀" + "尾".repeat(20)]);
  const out = read(ARCH);
  judge("4.2", "切在 emoji 边界时文件里没有替换字符 U+FFFD", !out.includes("\uFFFD"), `含 U+FFFD=${out.includes("\uFFFD")}`);

  // 4.3 「原文 N 字」的 N 要等于输入长度，不是空白压缩后的长度
  reset();
  // 压缩空白后仍要超过 1200 字才会截断；带路径才有钩子、才写得进去
  // 「必须」判 high，这条会进 _次要规则（不是存档），所以读规则层
  const body = "必须 D:/logs " + " ".repeat(5000) + "尾".repeat(1500);
  feed([body]);
  const mark = (read(MINOR).match(/…（原文 (\d+) 字）/) || [])[1];
  judge("4.3", "标记里的原文字数等于输入长度（不是空白压缩后的）", Number(mark) === body.length, `标记写「原文 ${mark} 字」，输入 ${body.length} 字`);
}

// =====================================================================
// 第二轮复验（session 0cca3840）挑出的 3 条
// =====================================================================

// 1x 旧档正文自带代码围栏时，伪节仍然不能升格
//   「整个文件没围栏」不是旧格式的判据——旧档正文里完全可能自带代码块围栏。
{
  reset();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    ARCH,
    [
      "# 压缩存档",
      "",
      "## §1 旧节 · 2026-10-20 · s-old",
      "",
      "旧正文，端口 4001。",
      "```js",
      "console.log(1);",
      "```",
      "## §999 伪节",
      "伪节下面的内容",
      "",
    ].join("\n"),
    "utf8",
  );
  const out = feed(["端口 4002，路径 D:/new.log 新加的一条够长了。"]);
  const nums = sections(out);
  judge("1x", "旧档正文自带围栏时伪节仍不升格、新节号是 §2", nums.join(",") === "1,2", `节号=${nums.join(",")}`);
  // 原断言是 `!inFence(...) || indexOf(§999) > indexOf(§1)`——第二项永真（伪节在 §1 正文里，
  // 位置必然在 §1 后面），整个 OR 于是永真；三种世界（正常 / 升格 / 字符串不存在）都 PASS。
  // 而且第一项和描述是反的。改成只问一个问题：伪节那一行**在不在围栏里**。
  // 在围栏里 = 被当成正文了，正确；在围栏外 = 升格成真节了，错误。
  judge("1x-b", "§999 伪节那行被并进了 §1 的围栏正文（不是留在围栏外）", inFence(out, "## §999 伪节") === true && out.includes("## §999 伪节"), `在围栏内=${inFence(out, "## §999 伪节")}，字符串存在=${out.includes("## §999 伪节")}`);
}

// E7a/E7b 手工 archive 挑不出钩子时不能写空单元格
{
  reset();
  const sess = { agent: { session: { header: { id: `session-${ME}` } } } };
  tools.mem_private.execute({ which: "archive", say: "必须要的" }, sess); // 4 字，挑不出钩子
  let out = read(ARCH);
  judge("E7a", "挑不出钩子时不留空钩子单元格", !/\|\s*\| §\d+ \|/.test(out), `空单元格=${/\|\s*\| §\d+ \|/.test(out)}`);
  judge("E7a-b", "§1 有一行可解析的钩子", /^\| [^|]+ \| §\d+ \|$/m.test(out), `钩子行=${(out.match(/^\| [^|]+ \| §\d+ \|$/gm) || []).length}`);
  tools.mem_private.execute({ which: "archive", say: "端口 4003，路径 D:/b.log 第二条够长了。" }, sess);
  out = read(ARCH);
  const rows = (out.match(/^\| [^|]+ \| §\d+ \|$/gm) || []).filter((l) => !l.includes("|---"));
  // 不能只数行数：两行都指向 §1 也能过。要核对指向。
  const ats = rows.map((l) => Number((l.match(/§(\d+) \|$/) || [])[1])).sort();
  judge("E7b", "第二次写入后两节各有钩子行、且指向各自的节号", rows.length === 2 && ats.join(",") === "1,2", `钩子行=${rows.length}，指向=${ats.join(",")}，节号=${sections(out).join(",")}`);
}

// E8 ZWJ 家庭 emoji 不能被切在连接处
{
  reset();
  // 切点 1188（1200 - 12 码点标记）。家庭 emoji 第一个码点必须落在切点上：
  // 「必须 D:/logs 端口 4001 」19 字 + A×1165 = 1184，emoji 从 1184 到 1188 跨切点。
  // 原来 A×1180（emoji 在 1199）整组被丢，输出里连 U+200D 都没有，两条断言恒为假。
  feed(["必须 D:/logs 端口 4001 " + "A".repeat(1165) + "👨\u200d👩\u200d👧" + "尾".repeat(20)]);
  const out = read(ARCH);
  judge("E8", "切点不留下悬挂的 U+200D", !/\u200d(?!\p{Emoji})/u.test(out) && !out.includes("\u200d…"), `含悬挂 ZWJ=${out.includes("\u200d…")}`);
  judge("E8-b", "也没有 U+FFFD 替换字符", !out.includes("\uFFFD"), `含替换字符=${out.includes("\uFFFD")}`);
}

// =====================================================================
// 2.2 / 3.5：第一轮那两条「假设过时」要按**新语义**钉住，不能就不管了
// =====================================================================

// 2.2 段预算的边界。0.9.7 之后预算按**截断后**尺寸算，单段最多 1200 字（约 3600 字节），
// 所以「一个 60001 字节的段」已经不可能触发预算——要触发得靠段数多。
// 边界改成测**总字节**：16 段 × 1200 字 ≈ 57600 装得下，17 段 ≈ 61200 装不下第 17 段。
{
  const mk = (n) => {
    const out = [];
    for (let i = 1; i <= n; i++) out.push(`第 ${i} 段，端口 ${4000 + i}。` + "内容".repeat(740));
    return out;
  };
  reset();
  feed(mk(16));
  const out16 = read(ARCH);
  judge("2.2", "16 段（约 57600 字节）装得下，全写不记账", sections(out16).length === 16 && !/本次摘要共/.test(out16), `节数=${sections(out16).length} 记账=${/本次摘要共/.test(out16)}`);

  reset();
  feed(mk(17));
  const out17 = read(ARCH);
  const note = (out17.match(/^本次摘要共[^\n]*/m) || [""])[0];
  judge("2.2b", "17 段（约 61200 字节）装不下第 17 段，并记账说清", sections(out17).length === 17 && /本次摘要共 17 段/.test(out17), `节数=${sections(out17).length}（16 正文 + 1 记账）记账=「${note.slice(0, 40)}」`);
}

// 3.5 语种阈值 0.2 的边界（>= 语义），以及假名比例 0.25 的边界
{
  reset();
  // 4 个汉字 / (4 汉字 + 16 拉丁) = 0.2000，正好过线
  feed(["必须规矩" + "a".repeat(16) + " 4001。"]); // 4 汉字 / (4+16) = 0.2000
  judge("3.5", "汉字/字母正好 0.2 时进 _次要规则（>= 语义）", read(MINOR).includes("必须规矩"), `规则层 ${read(MINOR).length} 字`);

  reset();
  // 4 / (4 + 17) = 0.1905，不过线
  feed(["必须规矩" + "a".repeat(17) + " 4002。"]); // 4 汉字 / (4+17) = 0.1905
  judge("3.5b", "汉字/字母 0.1905 时降档进存档", !read(MINOR).includes("必须规矩") && read(ARCH).includes("必须规矩"), `规则层=${read(MINOR).length} 存档=${read(ARCH).length}`);

  // 假名比例边界：中文 + 假名，汉字多但假名占到 1/4
  reset();
  feed(["以后都必须用 console.info 打日志，不要用 ctx.logger，路径 D:/logs 端口 4001，界面文案「" + "あ".repeat(25) + "」保持不变。"]);
  judge("3.5c", "假名占比超过四分之一时判日文条目、不进规则层", !read(MINOR).includes("console.info"), `规则层=${read(MINOR).length}`);
}

// B5 钩子文本恰好叫「钩子」时，钩子行不能被当表头吃掉
//   第三轮复验报了这条 FAIL，但它自己的 hookRows() 里同样有一句
//   `if (m[1].trim() === "钩子") continue`——它测的是自己的 bug。
//   这里用一份独立实现的解析（不跳过任何行）来验真伪。
{
  reset();
  const sess = { agent: { session: { header: { id: `session-${ME}` } } } };
  tools.mem_private.execute({ which: "archive", say: "钩子了钩子了" }, sess);
  const out = read(ARCH);
  const rows = out
    .split("\n")
    .filter((l) => !/^## §\d+ /.test(l))
    .map((l) => l.match(/^\| ([^|]+) \| §(\d+) \|$/))
    .filter(Boolean)
    .map((m) => ({ hooks: m[1].trim(), at: Number(m[2]) }))
    .filter((r) => r.hooks !== "指向"); // 只跳过真表头
  judge("B5", "钩子文本是「钩子」时仍能读回（不被当表头）", rows.length === 1 && rows[0].at === 1 && rows[0].hooks === "钩子", `解析到=${JSON.stringify(rows)}`);
  judge("B5-b", "文件里确实写了 | 钩子 | §1 |", /^\| 钩子 \| §1 \|$/m.test(out), `原文含=${/^\| 钩子 \| §1 \|$/m.test(out)}`);

  tools.mem_private.execute({ which: "archive", say: "第二条：端口 4002，路径 D:/b。" }, sess);
  const out2 = read(ARCH);
  const nums = sections(out2);
  const rows2 = out2
    .split("\n")
    .filter((l) => !/^## §\d+ /.test(l))
    .map((l) => l.match(/^\| ([^|]+) \| §(\d+) \|$/))
    .filter(Boolean)
    .map((m) => ({ hooks: m[1].trim(), at: Number(m[2]) }))
    .filter((r) => r.hooks !== "指向");
  const ats2 = rows2.map((r) => r.at).sort();
  judge("B5-b2", "第二次写入后两节各有钩子行、且指向各自的节号", nums.length === 2 && rows2.length === 2 && ats2.join(",") === "1,2", `节号=${nums.join(",")} 钩子行=${JSON.stringify(rows2)}`);
}

// =====================================================================
// 5.2  整条切不出有效段时，不能静默消失
// =====================================================================
{
  reset();
  const out = feed(["七字内容甲", "七字内容乙", "七字内容丙"]);
  // 只证「文件非空」不够：只写一个文件头也能过。要证**落了一节**。
  judge("5.2", "每段都短于 8 字时仍落一节记账，不静默消失", sections(out).length === 1 && out.includes("切不出"), `节数=${sections(out).length}，含「切不出」=${out.includes("切不出")}`);
  judge("5.2b", "记账里说了切不出有效段", /切不出|短于 8 字/.test(out), `含说明=${/切不出|短于 8 字/.test(out)}`);
}

reset();
const pass = results.filter(Boolean).length;
console.log(`\n=== 通过 ${pass}/${results.length}`);
if (pass !== results.length) {
  console.log(`FAIL 数：${results.length - pass}`);
  process.exitCode = 1;
}
