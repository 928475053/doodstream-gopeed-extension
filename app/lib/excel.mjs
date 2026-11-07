import { execFileSync } from "node:child_process";

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

function parseCells(rowXml) {
  const cells = {};
  const cellRe = /<x:c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/x:c>)/g;
  let match;
  while ((match = cellRe.exec(rowXml))) {
    const ref = /r="([A-Z]+)\d+"/.exec(match[1]);
    if (!ref) continue;
    const inner = match[2] || "";
    const value = /<x:v[^>]*>([\s\S]*?)<\/x:v>/.exec(inner);
    if (value) {
      cells[ref[1]] = decodeXml(value[1]);
    } else {
      const inline = /<x:is>[\s\S]*?<x:t[^>]*>([\s\S]*?)<\/x:t>/.exec(inner);
      cells[ref[1]] = inline ? decodeXml(inline[1]) : "";
    }
  }
  return cells;
}

export function parseExcel(filePath) {
  let xml;
  try {
    xml = execFileSync("unzip", ["-p", filePath, "xl/worksheets/sheet1.xml"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      "读取 Excel 失败（需要 unzip 命令）: " + (err.message || String(err))
    );
  }

  const rows = xml.match(/<x:row[^>]*>[\s\S]*?<\/x:row>/g) || [];
  const items = [];
  const seen = new Set();

  for (let index = 3; index < rows.length; index++) {
    const cells = parseCells(rows[index]);
    const dood = (cells.D || "").trim();
    if (!dood) continue;
    const name = (cells.B || "").trim();
    const status = (cells.C || "").trim();
    if (status !== "ACTIVE") continue;
    const match = name.match(/^(\d+)\s*[|｜]\s*(.+)$/);
    const libId = match ? Number(match[1]) : null;
    const title = match ? match[2].trim() : name;
    const key = libId ? String(libId) : (cells.A || "").trim() + ":" + index;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      key,
      vid: (cells.A || "").trim(),
      libId,
      name,
      title,
      status,
      dood,
    });
  }

  items.sort((a, b) => {
    if (a.libId === null && b.libId === null) return b.name.localeCompare(a.name);
    if (a.libId === null) return 1;
    if (b.libId === null) return -1;
    return b.libId - a.libId;
  });

  return items;
}
