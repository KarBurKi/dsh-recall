import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const SRC = path.resolve(process.env.FIX_SRC || "lib/index.js");
const { apply } = await import(pathToFileURL(SRC).href);
const handlers = {}; const tools = {};
apply({ logger: { info: () => {} }, on: (ev, fn) => (handlers[ev] = fn),
  inject: (d, cb) => cb({ effect: (fn) => fn(), tools: { register: (def) => ((tools[def.name] = def), () => {}) }, systemPrompt: { section: () => () => {} } }) });
const ME = "f00d0b02";
const dir = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME);
const ARCH = path.join(dir, "_压缩存档.md");
fs.rmSync(dir, { recursive: true, force: true });
let n = 0;
const feed = (blocks) => {
  handlers["session/event"]({ header: { id: `session-${ME}` } }, { type: "compaction/summary", data: { compactionId: `rd-${++n}`, summary: blocks.map((t) => ({ text: t })) } });
  return fs.readFileSync(ARCH, "utf8");
};
const sections = (out) => { const r = []; let fence = "";
  for (const line of out.split("\n")) { const m = line.match(/^(`{3,})/);
    if (m) { if (!fence) fence = m[1]; else if (m[1].length >= fence.length) fence = ""; continue; }
    if (fence) continue;
    const s = line.match(/^## §(\d+) /); if (s) r.push(Number(s[1])); } return r; };
const inFence = (out, needle) => { let fence = "";
  for (const line of out.split("\n")) { const m = line.match(/^(`{3,})/);
    if (m) { if (!fence) fence = m[1]; else if (m[1].length >= fence.length) fence = ""; if (line.includes(needle)) return fence !== ""; continue; }
    if (line.includes(needle)) return fence !== ""; } return "（没有这一行）"; };
const dump = (label, out, needle) => {
  console.log(`\n### ${label}`);
  console.log("节号:", sections(out).join(","), "| 复述行存在:", out.includes(needle), "| 复述行在围栏内:", inFence(out, needle));
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  if (i >= 0) console.log("上下文:\n" + lines.slice(Math.max(0, i - 4), i + 3).map((l) => "  | " + l.slice(0, 70)).join("\n"));
};
const REC = "## §1 第一段 · 2026-10-26 · s-aaaa1111";
// M1 现代档内联复述
fs.rmSync(dir, { recursive: true, force: true });
feed(["第一段普通摘要，端口 4001。"]);
dump("M1 现代档内联复述", feed([`上面说的 ${REC} 那个节，端口 4002。`]), REC);
// M2 现代档独立成段复述
fs.rmSync(dir, { recursive: true, force: true });
feed(["第一段普通摘要，端口 4001。"]);
dump("M2 现代档复述行独立成段", feed([`引言一行。\n\n${REC}\n\n后面还有内容。`]), REC);
// M3 旧档无围栏 + 复述标题
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(ARCH, ["# 压缩存档", "", "> 已按体积淘汰 0 节 · 最新 —", "", "| 钩子 | 指向 |", "|---|---|", "", "## §1 旧节 · 2026-10-20 · s-old", "", "旧正文第一行，端口 4001。", REC, "伪节下面的内容", ""].join("\n"), "utf8");
dump("M3 旧档无围栏迁移", feed(["新摘要，端口 4002，路径 D:/new.log 新加的一条够长了。"]), REC);
