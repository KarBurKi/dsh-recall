// dsh-recall 0.9.1 判据测试：假 ctx 跑 apply()，直接触发 session/event 回调
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { apply } from "../lib/index.js";

const handlers = {};
let promptFn = null;
const logs = [];
// 诊断日志走 console.info（ctx.logger 在真宿主里没有 console exporter，是哑的）
console.info = (...a) => {
  logs.push(a.join(" "));
};
const tools = {};
const fakeSctx = {
  effect: (fn) => {
    fn();
  },
  tools: {
    register: (def) => {
      tools[def.name] = def;
      return () => {};
    },
  },
  systemPrompt: {
    section: (s) => {
      if (s.text) promptFn = s.text;
      return () => {};
    },
  },
};
const ctx = {
  // 诊断日志 0.9.5 起走 console.info——ctx.logger 在真宿主里没有 console exporter，
  // 只进内存环形缓冲，谁都看不见。测试要拦 console 才测得到。
  logger: { info: (m) => logs.push(m) },
  on: (ev, fn) => {
    handlers[ev] = fn;
  },
  inject: (deps, cb) => cb(fakeSctx),
};
apply(ctx);

const ME = "abcdef12-test";
const sess = { header: { id: `session-${ME}` } };
const dir = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME.slice(0, 8));
const F = {
  minor: path.join(dir, "_次要规则.md"),
  note: path.join(dir, "_本子.md"),
  rules: path.join(dir, "_额外规则.md"),
  archive: path.join(dir, "_压缩存档.md"),
  seen: path.join(dir, "_已归档.json"),
};

const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const fire = (summary, cid, extra) => {
  handlers["session/event"](sess, {
    type: "compaction/summary",
    data: { summary: [{ type: "text", text: summary }], compactionId: cid, ...(extra || {}) },
  });
};
const lines = (f) => read(f).split("\n").filter((l) => l.startsWith("- [钩子:"));
const results = [];
const judge = (n, desc, ok, detail) => {
  results.push({ n, desc, ok });
  console.log(`${ok ? "PASS" : "FAIL"} 判据${n} ${desc}${detail ? " — " + detail : ""}`);
};

fs.rmSync(dir, { recursive: true, force: true });

// ---- 判据 1：高分进 _次要规则，行尾 hits=1 [auto] ----
fire("上下文压缩阈值定在 0.12，以后别动。", "c1");
const l1 = lines(F.minor);
judge(
  1,
  "高分进次要规则，行尾 hits=1 [auto]",
  l1.length === 1 && /· hits=1 \[auto\]$/.test(l1[0]),
  l1[0] ? l1[0].slice(-40) : "(空)",
);

// ---- 判据 2：同钩子不同说法 → 旧条消失、新条在末尾、hits=2、正文是新的 ----
fire("压缩阈值就定在 0.12 了，以后别动这个数。", "c2");
const l2 = lines(F.minor);
judge(
  2,
  "同钩子替换：只剩一条、在末尾、hits=2、正文新",
  l2.length === 1 && /· hits=2 \[auto\]$/.test(l2[0]) && l2[0].includes("这个数"),
  l2[0] ? l2[0].slice(-50) : "(空)",
);

// ---- 判据 3：不相干但撞两个词 → 不覆盖（五词钩子要三个才并） ----
fs.rmSync(F.minor, { force: true });
fire("压缩阈值必须固定在 0.12，压缩的时候不许改，以后都按这个来。", "c3a");
const before3 = lines(F.minor);
// 只撞「压缩」「时候」两个词，主题是日志排错，不是规矩
fire("日志压缩出问题的时候，先看 D:/logs 下的记录，再决定要不要调。", "c3b");
const after3 = lines(F.minor);
judge(
  3,
  "只撞两个词不覆盖",
  before3.length === 1 && after3.length === 2,
  `条目 ${before3.length} → ${after3.length}`,
);

// ---- 判据 4：次档进 _压缩存档，_本子 一个字节不变 ----
fs.writeFileSync(F.note, "人手写的本子内容。\n", "utf8");
const noteBefore = fs.readFileSync(F.note);
const archiveBefore = read(F.archive).length;
fire("上次踩过一个坑：session-1d314539 的日志路径会变，注意 D:/logs 下面。", "c4");
const noteAfter = fs.readFileSync(F.note);
const archiveAfter = read(F.archive);
judge(
  4,
  "次档进压缩存档，本子不变",
  noteBefore.equals(noteAfter) && archiveAfter.length > archiveBefore && /^## §1 /m.test(archiveAfter),
  `本子 ${noteBefore.length}B → ${noteAfter.length}B，存档 ${archiveBefore}B → ${archiveAfter.length}B`,
);

// ---- 判据 5：31 条同 hits → 删时间最早的那条（不是最后写的） ----
fs.rmSync(F.minor, { force: true });
const R31 = [
  "端口必须是 4001。", "日志目录必须是 D:/logs。", "文件编码一律 UTF-8。", "代理必须走 127.0.0.1:10081。",
  "证书必须六十天一换。", "缓存上限必须是 512MB。", "队列深度必须卡在 200。", "批次大小必须定 50。",
  "重试次数最多只能三次。", "超时阈值必须是 15000 毫秒。", "并发不许超过八路。", "锁粒度必须按会话分。",
  "事务只能包写入段。", "索引必须建在时间列。", "分片数必须固定十六。", "副本数必须保持两份。",
  "备份必须每天凌晨跑。", "回滚窗口必须是两小时。", "灰度只能先放百分之五。", "开关默认必须全关。",
  "权限只给最小集。", "审计必须保留九十天。", "限流必须是每秒一百次。", "熔断阈值必须一半失败。",
  "降级必须返回旧快照。", "监控必须每五秒采一次。", "告警只能推主人手机。", "巡检必须每周一早上跑。",
  "演练必须每季度一次。", "复盘只能写一条结论。", "例会必须取消。", "接口必须走 HTTPS。",
  "密码不许写进日志。", "配置文件只能是 JSON。", "构建产物必须放 dist。", "提交信息必须写版本号。",
];
R31.forEach((t, i) => fire(t, `c5-${i}`));
const l5 = lines(F.minor);
const allHits1 = l5.every((l) => /hits=\d+ \[auto\]$/.test(l));
judge(
  5,
  "31 条同 hits 停在 30，删的是最早那条",
  l5.length === 30 && !l5.some((l) => l.includes("端口必须是 4001")) && allHits1,
  `条目 ${l5.length}，最老（端口）还在=${l5.some((l) => l.includes("端口必须是 4001"))}`,
);

// ---- 判据 6：hits 0 的和 hits 5 的，超限先删 hits 0 的（哪怕更晚写） ----
fs.rmSync(F.minor, { force: true });
// 先写 5 条，其中第 1 条反复投递 5 次把 hits 抬到 5
const seed = ["甲项参数必须定在 11。", "乙项参数必须定在 12。", "丙项参数必须定在 13。", "丁项参数必须定在 14。", "戊项参数必须定在 15。"];
seed.forEach((t, i) => fire(t, `c6-seed-${i}`));
for (let k = 0; k < 5; k++) fire("甲项参数必须定在 11。", `c6-bump-${k}`);
const bumped = lines(F.minor).find((l) => l.includes("甲项")) || "";
// 再补 27 条到 32 条，让淘汰启动。每条都写长一点、主题岔开，免得被「同一条」规则并掉
const MORE = [
  "网关超时必须卡在 3000 毫秒，网关这块以后都听这个数。",
  "图片走 CDN 域名，图片地址不要再写本地绝对路径。",
  "数据库连接池最大 20，数据库这块谁都不许自己改。",
  "前端构建产物只放 dist，构建这块以后都照这个走。",
  "日志轮转按天切，日志这块的原则是不许留超过七天。",
  "证书过期前三十天自动续，证书这块以后都按这个来。",
  "队列积压超过一千就告警，队列这块的原则是不许闷着。",
  "缓存穿透加空值兜底，缓存这块以后都照这个办。",
  "分片键用会话号，分片这块的原则是不许用时间。",
  "慢查询超过两百毫秒记一条，慢查询这块以后都按这个来。",
  "备份异地存一份，备份这块的原则是不许只放本地。",
  "回滚脚本每次发版前跑一遍，回滚这块以后都照这个办。",
  "灰度先放百分之五观察一小时，灰度这块不许一次放全量。",
  "开关默认关闭，开关这块的原则是上线才打开。",
  "最小权限原则，权限这块谁都不许多给。",
  "审计日志保留九十天，审计这块以后都按这个来。",
  "接口限流每秒一百次，限流这块的原则是不许放开。",
  "熔断一半失败就跳闸，熔断这块以后都照这个办。",
  "降级返回上一版快照，降级这块不许返回空数据。",
  "监控每五秒采一次，监控这块以后都按这个来。",
  "告警只推主人手机，告警这块的原则是不许群发。",
  "巡检每周一早上跑一遍，巡检这块以后都照这个办。",
  "演练每季度一次，演练这块不许省掉。",
  "复盘只写一条结论，复盘这块以后都按这个来。",
  "提交信息写版本号，提交这块的原则是不许空着。",
  "注释写中文，注释这块以后都照这个办。",
  "配置文件只认 JSON，配置这块不许再引入 YAML。",
];
MORE.forEach((m, i) => fire(m, `c6-more-${i}`));
const l6 = lines(F.minor);
const jiaStill = l6.some((l) => l.includes("甲项"));
const lowestGone = !l6.some((l) => l.includes("乙项参数必须定在 12"));
judge(
  6,
  "淘汰按 hits：hits=5 的留下，hits=0 里最早的被删",
  /hits=6/.test(bumped) && jiaStill && lowestGone,
  `甲条 hits=${(bumped.match(/hits=(\d+)/) || [])[1]}，乙项还在=${!lowestGone}，总条数 ${l6.length}`,
);

// ---- 判据 7：同 compactionId 只写一次；缺失时指纹兜底也去重 ----
fs.rmSync(F.minor, { force: true });
fs.rmSync(F.seen, { force: true });
fire("同一条摘要：压缩参数必须定在 99。", "c7");
fire("同一条摘要：压缩参数必须定在 99。", "c7");
const one7 = lines(F.minor).length;
// 没有 compactionId，只有 shadowedSeqs → 指纹兜底
fs.rmSync(F.minor, { force: true });
const noId = { summary: [{ type: "text", text: "指纹测试：缓存上限必须是 256MB。" }], shadowedSeqs: [11, 12, 13] };
handlers["session/event"](sess, { type: "compaction/summary", data: noId });
handlers["session/event"](sess, { type: "compaction/summary", data: { ...noId } });
const one7b = lines(F.minor).length;
const seenHasFp = /fp-11-13-3/.test(read(F.seen));
judge(
  7,
  "同名 compactionId 与指纹兜底都去重",
  one7 === 1 && one7b === 1 && seenHasFp,
  `带 id ${one7} 条，无 id 指纹 ${one7b} 条，游标记下指纹=${seenHasFp}`,
);

// ---- 判据 8：mem_private(which:"archive") 读得到；不传 which 仍是 secret ----
const exec = { agent: { session: { header: { id: `session-${ME}`, cwd: "D:/tmp-recall-091" } } } };
fs.writeFileSync(F.archive, "# 压缩存档\n\n## §1 手工补记 · 2026-10-26 · s-abcdef12\n\n存档里的一条内容。\n", "utf8");
const gotArchive = await tools.mem_private.execute({ which: "archive" }, exec);
fs.writeFileSync(F.note, "本子内容 ABC。\n", "utf8");
const gotDefault = await tools.mem_private.execute({}, exec);
judge(
  8,
  "which:archive 读得到，不传 which 仍是 secret",
  String(gotArchive.text || "").includes("存档里的一条内容") && String(gotDefault.text || "").includes("本子内容 ABC"),
  `archive.count=${gotArchive.count}，默认读到本子=${String(gotDefault.text || "").includes("本子内容 ABC")}`,
);

// ---- 判据 9：诊断日志出现、id 对得上；两层都空时返回空 ----
fs.writeFileSync(F.rules, "本会话人设：欧鲸鲸。\n", "utf8");
const prompt = promptFn ? promptFn(sess) : "";
const logOk = logs.some((m) => m.includes("section text") && m.includes("取到id=abcdef12-test"));
fs.rmSync(F.rules, { force: true });
fs.rmSync(F.minor, { force: true });
const promptEmpty = promptFn ? promptFn(sess) : "";
judge(
  9,
  "诊断日志出现且 id 对得上；两层空时返回空",
  logOk && prompt.includes("冲突时从上往下") && promptEmpty === "",
  `日志「${logs[0] ? logs[0].slice(0, 60) : "(无)"}」，空场景返回「${promptEmpty}」`,
);

// ---- 判据 10：7 个工具都在，mem_save → mem_find 走通 ----
const NAMES7 = ["mem_save", "mem_find", "mem_forget", "mem_brief", "mem_source", "mem_wall", "mem_private"];
const got = Object.keys(tools).sort();
const saved = await tools.mem_save.execute(
  { text: "回归测试：0.9.1 四本书。", keywords: "回归,四本书", scope: "tmp-regress-091" },
  exec,
);
const found = await tools.mem_find.execute({ query: "四本书", scope: "tmp-regress-091", k: 3 }, exec);
judge(
  10,
  "7 个工具都在，mem_save → mem_find 走通",
  NAMES7.every((n) => got.includes(n)) && saved.ok === true && JSON.stringify(found).includes("四本书"),
  got.join(","),
);

// ---- 附加：体积保险丝 200KB ----
fs.rmSync(F.archive, { force: true });
// 手工往存档里塞 30 个约 10KB 的节，看会不会触顶并从最老的删
const big = "这一节内容很长，用来撑大压缩存档的体积，测保险丝会不会按节从最老开始删。".repeat(160);
for (let i = 0; i < 30; i++) {
  await tools.mem_private.execute({ which: "archive", say: `第${i}节：${big}` }, exec);
}
const arch = read(F.archive);
const archBytes = Buffer.byteLength(arch, "utf8");
const secCount = (arch.match(/^## §\d+ /gm) || []).length;
const headLine = (arch.match(/^> 已按体积淘汰 (\d+) 节 · 最新 (.+)$/m) || []).slice(1);
console.log(
  `INFO 体积保险丝：${archBytes} 字节（限 ${200 * 1024}），剩 ${secCount} 节，文件头「已按体积淘汰 ${headLine[0] || 0} 节 · 最新 ${headLine[1] || "—"}」`,
);
console.log(`INFO 最老的 §1 还在=${/^## §1 /m.test(arch)}，钩子表行数=${(arch.match(/^\| [^|]+ \| §\d+ \|$/gm) || []).length}`);

console.log("\n=== 通过 " + results.filter((r) => r.ok).length + "/" + results.length);
fs.rmSync(dir, { recursive: true, force: true });
try {
  fs.rmSync(path.join(os.homedir(), ".dsh", "recall", "tmp-regress-091.jsonl"), { force: true });
  fs.rmSync(path.join(os.homedir(), ".dsh", "recall", "tmp-regress-091.md"), { force: true });
} catch {}
