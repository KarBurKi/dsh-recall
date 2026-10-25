import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const SRC = path.resolve(process.env.FIX_SRC);
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
  handlers["session/event"]({ header: { id: `session-${ME}` } }, { type: "compaction/summary", data: { compactionId: `probe-${++n}`, summary: blocks.map((t) => ({ text: t })) } });
  return fs.readFileSync(ARCH, "utf8");
};
const show = (out, label) => {
  const z = out.indexOf("\u200d");
  console.log(`--- ${label}`);
  console.log("含U+FFFD:", out.includes("\uFFFD"), "| 含ZWJ:", z >= 0, "| 长度:", out.length);
  if (z >= 0) {
    const seg = out.slice(Math.max(0, z - 6), z + 8);
    console.log("首个ZWJ上下文:", JSON.stringify(seg), "码点:", Array.from(seg).map((c) => c.codePointAt(0).toString(16)).join(","));
  }
  const tail = out.slice(-120);
  console.log("尾部:", JSON.stringify(tail));
};
// E8 输入（与用例一致）
const outE8 = feed(["必须 D:/logs 端口 4001 " + "A".repeat(1165) + "👨\u200d👩\u200d👧" + "尾".repeat(20)]);
show(outE8, "E8 输入");
fs.rmSync(dir, { recursive: true, force: true });
// 4.2 输入（与用例一致）
const out42 = feed(["必须" + "A".repeat(1185) + "😀" + "尾".repeat(20)]);
show(out42, "4.2 输入");
console.log("E8 断言第一项(有悬挂ZWJ):", /\u200d(?!\p{Emoji})/u.test(outE8), "| 第二项(含ZWJ+省略号):", outE8.includes("\u200d…"));
