import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { pathToFileURL } from "node:url";
const SRC = path.resolve("lib/index.js");
const { apply } = await import(pathToFileURL(SRC).href);
const handlers = {}; const tools = {};
apply({ logger: { info: () => {} }, on: (ev, fn) => (handlers[ev] = fn),
  inject: (d, cb) => cb({ effect: (fn) => fn(), tools: { register: (def) => ((tools[def.name] = def), () => {}) }, systemPrompt: { section: () => () => {} } }) });
const ME = "f00d0b02";
const dir = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME);
const ARCH = path.join(dir, "_压缩存档.md");
fs.rmSync(dir, { recursive: true, force: true });
let n = 0;
const feed = (blocks) => { handlers["session/event"]({ header: { id: `session-${ME}` } }, { type: "compaction/summary", data: { compactionId: `m2-${++n}`, summary: blocks.map((t) => ({ text: t })) } }); return fs.readFileSync(ARCH, "utf8"); };
feed(["第一段普通摘要，端口 4001。"]);
const REC = "## §1 第一段 · 2026-10-26 · s-aaaa1111";
const out = feed([`引言一行。\n\n${REC}\n\n后面还有内容。`]);
console.log(out);
