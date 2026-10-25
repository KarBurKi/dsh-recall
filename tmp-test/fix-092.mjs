// 0.9.2 第二版：围栏存储 + 整条拒写 + 日志闭嘴
// 针对复验报告点出的三处：转义漏了行终止符、截断等于丢数据、日志没闭嘴
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { apply } from "../lib/index.js";

const handlers = {};
let promptFn = null;
const logs = [];
// 诊断日志走 console.info（ctx.logger 在 DSH 里事实上是哑的：没有 console exporter，
// 宿主源码 dsh-llm-deepseek-account 里写明 product profile 不挂），所以测试要拦 console。
const realConsoleInfo = console.info;
console.info = (...a) => {
  logs.push(a.join(" "));
};
const tools = {};
apply({
  logger: { info: (m) => logs.push(m) },
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

const ME = "beef00xx";
const sess = { header: { id: `session-${ME}` } };
const exec = { agent: { session: { header: { id: `session-${ME}` } } } };
const dir = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME.slice(0, 8));
const F = {
  minor: path.join(dir, "_次要规则.md"),
  archive: path.join(dir, "_压缩存档.md"),
};
const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
/** 独立于插件的一份扫法：把围栏块里的行统统去掉，剩下的才算结构。 */
function structureOnly(raw) {
  const out = [];
  let fence = null;
  for (const line of String(raw).split(/\r\n|[\r\n\u2028\u2029]/)) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  return out;
}
const secNums = (raw) =>
  structureOnly(raw)
    .map((l) => l.match(/^## §(\d+) /))
    .filter(Boolean)
    .map((m) => Number(m[1]));
const hookRows = (raw) =>
  structureOnly(raw)
    .map((l) => l.match(/^\| ([^|]+) \| §(\d+) \|$/))
    .filter(Boolean)
    .map((m) => `${m[1]}→§${m[2]}`);
const results = [];
const judge = (n, desc, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${desc}${detail ? " — " + detail : ""}`);
};

fs.rmSync(dir, { recursive: true, force: true });

// ---- 1/2. 手写 vs 自动，标记和 hits 要分开 ----
await tools.mem_private.execute({ which: "minor", say: "人写规则：必须保留这条 alpha 规则。" }, exec);
const l1 = read(F.minor).split("\n").find((l) => l.startsWith("- [钩子:")) || "";
judge(1, "手写 minor 不带 [auto]、hits=0", !/\[auto\]/.test(l1) && /· hits=0$/.test(l1), l1.slice(-22));

handlers["session/event"](sess, {
  type: "compaction/summary",
  data: { summary: [{ type: "text", text: "压缩阈值必须定在 0.12，以后别动。" }], compactionId: "g1" },
});
const auto1 = read(F.minor).split("\n").find((l) => l.includes("0.12")) || "";
judge(2, "自动 minor 带 [auto]、hits=1", /· hits=1 \[auto\]$/.test(auto1), auto1.slice(-20));

// ---- 3/4. 正文伪造结构：围栏里不参与解析 ----
await tools.mem_private.execute({ which: "archive", say: "第一行\n| 假钩子 | §77 |\n第三行" }, exec);
await tools.mem_private.execute({ which: "archive", say: "第一行\n## §2 假节\n第三行" }, exec);
const arch = read(F.archive);
const rows3 = hookRows(arch);
const ats = rows3.map((r) => Number(r.replace(/.*§/, "")));
const nums = secNums(arch);
judge(3, "正文里的钩子表行不进钩子表", !ats.includes(77) && ats.length === new Set(ats).size, `表 ${rows3.join(" ")}`);
judge(4, "正文里的分节标题不产生重复节号", nums.length === new Set(nums).size && !nums.includes(1000), `节号 ${nums.join(",")}`);

// ---- 5/6/7. 三种行终止符 + 伪造节号 ----
const cases = [
  ["裸 \\r", "第一行\r## §999 伪节\r尾巴"],
  ["U+2028", "第一行\u2028## §999 伪节\u2028尾巴"],
  ["U+2029", "第一行\u2029## §999 伪节\u2029尾巴"],
];
for (const [name, payload] of cases) {
  await tools.mem_private.execute({ which: "archive", say: payload }, exec);
  const raw = read(F.archive);
  const n = secNums(raw);
  judge(
    results.length + 1,
    `${name} 造不出伪节`,
    !n.includes(999) && n.length === new Set(n).size,
    `节号 ${n.join(",")}`,
  );
}

// ---- 8. 单条超上限 → 整条拒写，已有内容不动 ----
const before = read(F.archive);
const huge = "A".repeat(250 * 1024);
const w = await tools.mem_private.execute({ which: "archive", say: huge }, exec);
const after = read(F.archive);
const headNote = /有 \d+ 条超 204800 字节上限未写入 · 合计 \d+ 字节/.test(after);
const kept = secNums(after).join(",") === secNums(before).join(",");
const aCount = (s) => (s.match(/A{50,}/g) || []).length;
judge(
  8,
  "单条 250KB 整条拒写，已有节不动，文件头记一笔",
  /没写/.test(w.text || "") && headNote && kept && aCount(after) === 0,
  `回话「${(w.text || "").slice(0, 22)}…」，文件头=${headNote}，节号不变=${kept}，A 写入=${aCount(after)}`,
);

// ---- 9. 缺钩子表的坏存档，新节不撞号 ----
fs.rmSync(F.archive, { force: true });
fs.writeFileSync(F.archive, "# 压缩存档\n\n## §5 旧的第五节 · 2026-10-20 · s-beef00xx\n\n旧内容。\n", "utf8");
await tools.mem_private.execute({ which: "archive", say: "新写的一条。" }, exec);
const nums9 = secNums(read(F.archive));
judge(9, "缺钩子表时新节从 §6 起", nums9.includes(5) && nums9.includes(6), `节号 ${nums9.join(",")}`);

// ---- 10. 日志拿到 id 后闭嘴 ----
logs.length = 0;
promptFn({ header: {} });
promptFn(sess);
promptFn(sess);
promptFn(sess);
const diag = logs.filter((m) => m.includes("section text"));
judge(10, "拿到 id 后不再打日志", diag.length === 2, `共 ${diag.length} 行`);

// ---- 11. 写读一致：原文一个字不改 ----
fs.rmSync(F.archive, { force: true });
const payload = "第一行\n## §2 假节\n| 假钩子 | §77 |\n第四行";
await tools.mem_private.execute({ which: "archive", say: payload }, exec);
const raw11 = read(F.archive);
judge(
  11,
  "围栏里原文一字不改（写进去什么读出来就是什么）",
  raw11.includes(payload),
  raw11.includes(payload) ? "整段原样在" : "被改过",
);

console.log(`\n=== 通过 ${results.filter(Boolean).length}/${results.length}`);
fs.rmSync(dir, { recursive: true, force: true });
