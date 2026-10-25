import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { pathToFileURL } from "node:url";
const { apply } = await import(pathToFileURL(path.resolve("lib/index.js")).href);
const handlers = {}; const tools = {};
apply({ logger: { info: () => {} }, on: (ev, fn) => (handlers[ev] = fn),
  inject: (d, cb) => cb({ effect: (fn) => fn(), tools: { register: (def) => ((tools[def.name] = def), () => {}) }, systemPrompt: { section: () => () => {} } }) });
const ME = "f00d0b02";
const dir = path.join(os.homedir(), ".dsh", "[TheLifeofFish]", "private", ME);
const ARCH = path.join(dir, "_压缩存档.md");
fs.rmSync(dir, { recursive: true, force: true });
let n = 0;
const feed = (blocks) => { handlers["session/event"]({ header: { id: `session-${ME}` } }, { type: "compaction/summary", data: { compactionId: `m2b-${++n}`, summary: blocks.map((t) => ({ text: t })) } }); return fs.readFileSync(ARCH, "utf8"); };
feed(["第一段普通摘要，端口 4001。"]);
const REC = "## §1 第一段 · 2026-10-26 · s-aaaa1111";
const out = feed([`这是引言第一段，内容够长有十几个字了，端口 4003。\n\n${REC}\n\n这是结尾段，也够长了有十几个字，端口 4004。`]);
console.log(out);
