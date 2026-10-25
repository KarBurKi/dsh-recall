// 演示：作者 4.2 / E8 的夹具在「旧代码」和「新代码」下产生完全相同的正文，
// 所以它压根没走到当年修复的那条分支；换成切点对准的输入才分得开。
const isGlue = (c) => c === "\u200d" || c === "\ufe0e" || c === "\ufe0f" || /[\u{1F1E6}-\u{1F1FF}]/u.test(c || "") || /\p{M}/u.test(c || "");
function oldFlat(span, max) { // 0.9.6：按码点切，但不后退
  const raw = String(span);
  const chars = Array.from(raw.replace(/\s+/g, " ").trim());
  if (chars.length <= max) return chars.join("");
  const mark = `…（原文 ${raw.length} 字）`;
  return chars.slice(0, max - Array.from(mark).length).join("") + mark;
}
function oldFlat096(span, max) { // 0.9.5：直接 slice（UTF-16）
  const raw = String(span);
  const s = raw.replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const mark = `…（原文 ${raw.length} 字）`;
  return s.slice(0, max - mark.length) + mark;
}
const run = (label, text) => {
  const a = oldFlat096(text, 1200), b = oldFlat(text, 1200);
  const onDisk = (x) => Buffer.from(x, "utf8").toString("utf8");
  console.log(label, {
    旧096同新: a === b,
    旧096落盘含UFFFD: onDisk(a).includes("\uFFFD"),
    旧097同新: b === oldFlat(text, 1200),
    旧097尾: JSON.stringify(b.slice(-12)),
    "E8可见悬挂ZWJ": /\u200d(?!\p{Emoji})/u.test(onDisk(b)) || onDisk(b).includes("\u200d…"),
  });
};
run("作者4.2", "必须" + "A".repeat(1197) + "😀" + "尾".repeat(10));
run("作者E8", "必须 D:/logs 端口 4001 " + "A".repeat(1180) + "👨\u200d👩\u200d👧" + "尾".repeat(20));
run("4.2切点对准", "必须" + "A".repeat(1185) + "😀" + "尾".repeat(20));
run("E8切点对准", "必须 D:/logs 端口 4001 " + "A".repeat(1165) + "👨\u200d👩\u200d👧" + "尾".repeat(20));
