// 0.9.7：指挥中心拿 0.9.6 第一次真实压缩的数据挖出的三条真问题
//   一、静默截断（body 240 字硬切，不加省略号不标截断）
//   二、只取前 8 段（实测 124 条真摘要 100% 超 8 段，中位 52 段）
//   三、英文摘要进规则层（scoreSpan 见「必须」「规矩」就 high）
// 标准照 AGENTS：能不能构造出坏状态。构造不出来才算修好。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { apply } from "../lib/index.js";

const handlers = {};
const tools = {};
let promptFn = null;
apply({
  logger: { info: () => {} },
  on: (ev, fn) => {
    handlers[ev] = fn;
  },
  inject: (d, cb) =>
    cb({
      effect: (fn) => fn(),
      tools: { register: (def) => ((tools[def.name] = def), () => {}) },
      systemPrompt: {
        section: (s) => {
          if (s.text) promptFn = s.text;
          return () => {};
        },
      },
    }),
});

const ME = "f00d0b02";
const dir = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME);
const ARCH = path.join(dir, "_压缩存档.md");
const MINOR = path.join(dir, "_次要规则.md");
const SEEN = path.join(dir, "_已归档.json");
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

let cidN = 0;
/** 投一条 compaction/summary，返回归档后的存档文本。 */
const feed = (blocks) => {
  const sess = { header: { id: `session-${ME}` } };
  handlers["session/event"](sess, {
    type: "compaction/summary",
    data: { compactionId: `test-097-${++cidN}`, summary: blocks.map((t) => ({ text: t })) },
  });
  return read(ARCH);
};

// ---- 判据1：300 字不截断，完整读回 ----
{
  reset();
  const seg = ("这是第二百四十字之后的内容，原样保留下来才对。" + "填").repeat(12).slice(0, 300);
  const txt = `端口改为 4001，路径 D:/logs/a.log。${seg}`;
  const out = feed([txt]);
  const whole = out.includes(txt.replace(/\s+/g, " ").trim());
  const marked = out.includes("…（原文 ") && out.includes(" 字）");
  judge(1, "300 字正文完整写入，不出现截断", whole, `全文在=${whole} 有截断标记=${marked}`);
  judge(1, "300 字正文不被打上截断标记", !marked, marked ? "被标了" : "没标");
}

// ---- 判据1b：超 1200 字必须标「原文 N 字」 ----
{
  reset();
  const body = "端口 4001，路径 D:/logs/b.log。" + "长".repeat(1400);
  const out = feed([body]);
  const flat = body.replace(/\s+/g, " ").trim();
  const tag = `…（原文 ${flat.length} 字）`;
  judge(1, "超 1200 字标出原文字数", out.includes(tag), `找「${tag}」→ ${out.includes(tag)}`);
  judge(
    1,
    "截断处正好停在 1200 字",
    out.includes(flat.slice(0, 1200).slice(-40)) && out.includes(tag),
    `标记=${out.includes(tag)}`,
  );
}

// ---- 判据1d：CRLF 和 U+2028 也要能切段 ----
// `\n{2,}` 在 `\r\n\r\n` 上匹配不到（中间夹了 `\r`），U+2028 更是没有 `\n`。
// 切不开 → 整条摘要变成巨型段 → 被正文上限一截，等于把后面全丢了。
{
  const one = "端口 4001，路径 D:/logs/a.log 已确认。";
  const two = "端口 4002，路径 D:/logs/b.log 已确认。";
  const three = "端口 4003，路径 D:/logs/c.log 已确认。";
  for (const [name, text] of [
    ["CRLF 空行", `${one}\r\n\r\n${two}\r\n\r\n${three}`],
    ["U+2028", `${one}\u2028\u2028${two}\u2028\u2028${three}`],
  ]) {
    reset();
    const out = feed([text]);
    const secs = (out.match(/^## §\d+ /gm) || []).length;
    judge(1, `${name} 分段的摘要切成 3 段（不是 1 段）`, secs === 3, `文件里 ${secs} 节`);
  }
}

// ---- 判据2：英文为主、含「必须」「规矩」的摘要不进 _次要规则 ----
{
  reset();
  // 一整段英文，含「必须」「规矩」（会命中 RULE_PATTERNS 判 high）、也含路径和数字。
  // 中文占比 2/(2+约120) 远低于 0.3 → 应降档进存档。
  const en =
    "The rule section said we 必须 keep the format and the 规矩 part was clear at D:/logs;" +
    " then the agent renamed the file, bumped it to version 4001, and pushed. The tests passed afterwards.";
  feed([en]);
  const minor = read(MINOR);
  const arch = read(ARCH);
  judge(2, "英文为主的摘要不进 _次要规则", !minor.includes("rule section"), minor ? "进了" : "_次要规则 都没建");
  judge(2, "英文为主的摘要仍进 _压缩存档（降档不是丢）", arch.includes("rule section said"), `存档 ${arch.length} 字`);
  judge(2, "英文条目确实被判 high 过（否则这条判据测了个寂寞）", !minor.includes("rule section") && arch.length > 0, `high 被降档`);
}

// ---- 判据2b：中文为主、中英混写的真规矩仍要进 _次要规则 ----
{
  reset();
  const zh = "以后都必须用 console.info 打日志，不要用 ctx.logger——它在产品 profile 下不落盘，真出事时信息出不来。";
  feed([zh]);
  const minor = read(MINOR);
  judge(2, "中文为主的真规矩仍进 _次要规则", minor.includes("console.info"), minor ? "没进" : "_次要规则 没建");
}

// ---- 判据2c：日文/韩文也算「非中文」，不许进规则层 ----
// 日文里汉字多、假名不是拉丁字母，只看 han 和 latin 的话纯日文比例能到 1.0，
// 也就是「非中文」被当成「中文」放进规则层。韩文没汉字，反而不受影响。
{
  reset();
  // 真实形态：日文摘要里**引用了**中文规则原文（和英文那条同一个道理）。
  // 这样才命中 RULE_PATTERNS 判 high，才走得到 zhMostly 这一步。
  const ja =
    "セッションの要約：ルールに「必须用 console.info」「规矩」と書いてあった。" +
    "ファイルは D:/logs に圧縮され、版は 4001。確認済み、報告待ち。";
  feed([ja]);
  const minor = read(MINOR);
  const arch = read(ARCH);
  judge(2, "日文为主的摘要不进 _次要规则", !minor.includes("要約"), minor ? "进了（假名不算中文，汉字占比被算成 1.0）" : "没进");
  judge(2, "日文为主的摘要仍进 _压缩存档（降档不是丢）", arch.includes("要約"), `存档 ${arch.length} 字`);
}

// ---- 判据3：段数超预算要记账「共 N 段写入 N 段」 ----
{
  reset();
  // 20 段，每段 ~1500 字 → 远超 60000 字节预算
  const blocks = [];
  for (let i = 1; i <= 20; i++) {
    blocks.push(`第 ${i} 段：端口 ${4000 + i}，路径 D:/logs/seg${i}.log。` + "内容".repeat(740));
  }
  const out = feed(blocks);
  const m = out.match(/本次摘要共 (\d+) 段，写入 (\d+) 段；其余 (\d+) 段未写入（(\d+) 段超出 (\d+) 字节预算/);
  judge(3, "存档里有一句「共 N 段写入 N 段」的记账", !!m, m ? `「${m[0].slice(0, 46)}…」` : "没有这句");
  if (m) {
    judge(3, "记账里的总段数是 20", Number(m[1]) === 20, `共 ${m[1]} 段`);
    judge(3, "写入段 + 未写段 = 总段数", Number(m[2]) + Number(m[3]) === Number(m[1]), `${m[2]} + ${m[3]} = ${Number(m[2]) + Number(m[3])}`);
    judge(3, "确实只写了一部分（不是全写还乱记账）", Number(m[3]) > 0, `未写 ${m[3]} 段`);
    judge(3, "写入段数是真的写进文件的，不是预算内段数", Number(m[2]) + 1 === (out.match(/^## §\d+ /gm) || []).length, `记账说 ${m[2]} 段 + 记账 1 节 = ${Number(m[2]) + 1}，文件里 ${(out.match(/^## §\d+ /gm) || []).length} 节`);
  }
}

// ---- 判据3c：预算内的段全被判 low 时，记账不许说「写入前 N 段」 ----
// picked.length 只代表「预算装得下」，不代表真写进去了。用它当写入段数就是撒谎。
// 注意 low 的判定是「无命中 且 长度 ≤ 200」，所以 low 段天然装得下、超不了预算——
// 构造不出「超预算的同时全 low」，能构造的是「picked 全是 low、一段都没写」。
{
  reset();
  const blocks = [];
  // 20 段：无规则词、无数字、无路径、长度 30 < 200 → 恒为 low，全被跳过
  for (let i = 1; i <= 20; i++) blocks.push("这是一段没有信息量的叙述，讲了些不痛不痒的事情，没有任何关键落点。".slice(0, 30));
  const out = feed(blocks);
  const m = out.match(/本次摘要共 (\d+) 段，写入 (\d+) 段；其余 (\d+) 段未写入（(\d+) 段无信息量/);
  judge(3, "全是 low 时记账说写入 0 段（许不许撒谎）", m ? Number(m[2]) === 0 : false, m ? `记账说写入 ${m[2]} 段` : "没写记账");
  judge(3, "全是 low 时总段数仍对（20）", m ? Number(m[1]) === 20 : false, m ? `共 ${m[1]} 段` : "没写记账");
  judge(3, "全是 low 时文件里只有记账那一节", (out.match(/^## §\d+ /gm) || []).length === 1, `文件里 ${(out.match(/^## §\d+ /gm) || []).length} 节`);
}

// ---- 判据3b：段数在预算内时全写，不许出现记账节 ----
{
  reset();
  const blocks = [];
  for (let i = 1; i <= 20; i++) blocks.push(`第 ${i} 段：端口 ${4000 + i}，路径 D:/logs/seg${i}.log。`);
  const out = feed(blocks);
  const wrote = (out.match(/^## §\d+ /gm) || []).length;
  judge(3, "20 个小段全写进去（20 节）", wrote === 20, `写了 ${wrote} 节`);
  judge(3, "预算够时不写记账节", !out.includes("摘要未写全"), out.includes("摘要未写全") ? "多写了记账节" : "干净");
}

// ---- 判据4：旧行为不许改坏——围栏、钩子表、节号仍对 ----
{
  reset();
  feed(["端口 4001，路径 D:/logs。", "编码 UTF-8，日志在 D:/logs。", "代理 127.0.0.1:10081。"]);
  const out = read(ARCH);
  const nums = [...out.matchAll(/^## §(\d+) /gm)].map((m) => Number(m[1]));
  judge(4, "节号连续从 §1 起", nums.length === 3 && nums[0] === 1 && nums[1] === 2 && nums[2] === 3, `节号 ${nums.join(",")}`);
  judge(4, "正文都在围栏里", (out.match(/```text/g) || []).length === 3, `围栏 ${(out.match(/```text/g) || []).length} 个`);
  judge(4, "钩子表行数 = 节数", (out.match(/^\| .+ \| §\d+ \|$/gm) || []).length === 3, `表行 ${(out.match(/^\| .+ \| §\d+ \|$/gm) || []).length}`);
}

const pass = results.filter(Boolean).length;
console.log(`\n=== 通过 ${pass}/${results.length}`);
if (pass !== results.length) {
  console.log(`FAIL 数：${results.length - pass}`);
  process.exitCode = 1;
}
reset();
