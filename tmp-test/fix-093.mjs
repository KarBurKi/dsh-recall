// 0.9.4：复验方在 0.9.3 上构造出来的六类坏输入，逐条复现
// 每条都是「构造得出坏状态就算没修好」
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { apply } from "../lib/index.js";

const tools = {};
let promptFn = null;
apply({
  logger: { info: () => {} },
  on: () => {},
  inject: (d, cb) =>
    cb({
      effect: (fn) => fn(),
      tools: { register: (def) => ((tools[def.name] = def), () => {}) },
      systemPrompt: { section: (s) => { if (s.text) promptFn = s.text; return () => {}; } },
    }),
});

const ME = "f00d0a01";
const exec = { agent: { session: { header: { id: `session-${ME}` } } } };
const dir = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME.slice(0, 8));
const F = path.join(dir, "_压缩存档.md");
const read = () => { try { return fs.readFileSync(F, "utf8"); } catch { return ""; } };
const write = (s) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(F, s, "utf8"); };
const reset = () => fs.rmSync(dir, { recursive: true, force: true });

const results = [];
const judge = (desc, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${desc}${detail ? " — " + detail : ""}`);
};
const ask = (say) => tools.mem_private.execute({ which: "archive", say }, exec);
const count = async () => (await tools.mem_private.execute({ which: "archive" }, exec)).count;

// ---- 1. count 不能把围栏里的 ###### 当成节 ----
reset();
await ask("第一行\n## §999 伪节\n第三行");
{
  const c = await count();
  judge("count 不数围栏里的伪节（应 1）", c === 1, `count=${c}`);
}

// ---- 2. 行终止符保原文：追加一条后旧正文不能被归一 ----
{
  const cases = [
    ["CRLF", "甲\r\n乙\r\n丙"],
    ["裸 CR", "甲\r乙\r丙"],
    ["U+2028", "甲\u2028乙\u2028丙"],
    ["U+2029", "甲\u2029乙\u2029丙"],
  ];
  for (const [name, payload] of cases) {
    reset();
    await ask("占位内容一条");
    write(read().replace(/```text\n占位内容一条\n```/, "```text\n" + payload + "\n```"));
    const before = read();
    await ask("后面再来一条普通内容");
    const after = read();
    judge(`${name} 追加后旧正文原样保留`, after.includes(payload), after.includes(payload) ? "" : "被归一了");
    void before;
  }
}

// ---- 3. 旧格式（无围栏）正文里的假钩子行不能被复制 ----
reset();
write("# 压缩存档\n\n> 已按体积淘汰 0 节 · 最新 —\n\n| 钩子 | 指向 |\n| --- | --- |\n| 甲 | §1 |\n\n## §1 旧的一节 · 2026-10-20 · s-f00d0a01\n\n正文里有一行\n| 假钩子 | §77 |\n还有一行\n");
for (let i = 0; i < 4; i++) await ask(`新写的第${i + 1}条`);
{
  const raw = read();
  const fake = (raw.match(/^\| 假钩子 \| §77 \|$/gm) || []).length;
  const nums = (raw.match(/^## §(\d+) /gm) || []).map((s) => Number(s.replace(/^## §(\d+).*/, "$1")));
  judge("旧档假钩子行没有被复制成 4 行", fake <= 1, `假钩子行 ${fake} 行`);
  judge("旧档假钩子行没让新节跳到 §78+", nums.every((n) => n <= 10), `节号 ${nums.join(",")}`);
}

// ---- 4. 旧档 CRLF 追加后不被归一 ----
reset();
write("# 压缩存档\r\n\r\n> 已按体积淘汰 0 节 · 最新 —\r\n\r\n| 钩子 | 指向 |\r\n| --- | --- |\r\n| 甲 | §1 |\r\n\r\n## §1 旧的一节 · 2026-10-20 · s-f00d0a01\r\n\r\n旧正文一\r\n旧正文二\r\n");
await ask("新的小条");
{
  const raw = read();
  const cr = (raw.match(/\r/g) || []).length;
  judge("旧档 CRLF 追加后 CR 还在", cr > 0, `CR 计数 ${cr}`);
}

// ---- 5. 拒写不能改已有正文 ----
reset();
await ask("已有的一条\n\n\n里面有三个换行\n> 有 9 条超 204800 字节上限未写入 · 合计 999 字节 · 最新 2025-01-01\n尾巴");
const before = read();
const w = await ask("A".repeat(204801));
const after = read();
{
  const head = after.slice(0, after.indexOf("## §"));
  const body = after.slice(after.indexOf("## §"));
  const beforeBody = before.slice(before.indexOf("## §"));
  judge("拒写后已有正文一字不动", body === beforeBody, body === beforeBody ? "" : `原来 ${beforeBody.length} 字节，现在 ${body.length} 字节`);
  judge("拒写后正文里的假 note 行还在", body.includes("> 有 9 条超 204800"), "");
  judge("拒写后头部计数是 1 条（不该吃正文那个 9）", /有 1 条超 204800 字节上限未写入 · 合计 204801 字节/.test(head), (head.match(/有 \d+ 条超[^\n]*/) || ["无"])[0]);
  judge("超限条没有落盘", !after.includes("AAAA"), "");
  void w;
}

// ---- 6. 正文里的假 note 行不能被提升到文件头 ----
reset();
await ask("第一条正文\n> 有 7 条超 204800 字节上限未写入 · 合计 777 字节 · 最新 2025-01-01\n尾巴");
await ask("第二条普通的");
{
  const head = read().slice(0, read().indexOf("## §"));
  judge("正文假 note 没有被提到头部", !/有 7 条/.test(head), head.includes("有 7 条") ? "被提上来了" : "头部干净");
}

// ---- 7. 单条判定用正文口径（整文件 200KB 是另一回事）----
reset();
{
  // 正文 200000 字节，加头部和围栏不会越整文件上限，不该拒
  const body = "A".repeat(200000);
  const r = await ask(body);
  judge("正文 200000 字节能写进去", !/没写/.test(r.text || ""), (r.text || "").slice(0, 30));
}

// ---- 8. 连拒计数累加，头部只有一行 ----
reset();
await ask("占位");
for (let i = 0; i < 3; i++) await ask("B".repeat(204801));
{
  const raw = read();
  const notes = raw.slice(0, raw.indexOf("## §")).match(/^> 有 \d+ 条超 \d+ 字节上限未写入/gm) || [];
  const m = raw.match(/有 (\d+) 条超 204800 字节上限未写入 · 合计 (\d+) 字节/);
  judge("连拒 3 次计数累加到 3", m && Number(m[1]) === 3, m ? `${m[1]} 条 / ${m[2]} 字节` : "没找到");
  judge("头部只有一行 note", notes.length === 1, `${notes.length} 行`);
}

console.log(`\n=== 通过 ${results.filter(Boolean).length}/${results.length}`);
reset();
