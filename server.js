#!/usr/bin/env node
/**
 * md-converter-mcp  —  v1.1.0
 * Node.js MCP server: converts files/URLs → Markdown.
 * Auto-logs token savings to conversions.jsonl on each call.
 * Dashboard: http://localhost:3847
 *
 * Supported: PDF · DOCX · PPTX · XLSX/XLS · PNG/JPG/WEBP/TIFF/BMP (OCR) · URLs · TXT/MD
 *
 * License: GPL-3.0
 * https://github.com/raghunath-iyengar/md-converter-mcp
 */

import { McpServer }            from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z }                    from "zod";
import fs                       from "fs";
import path                     from "path";
import http                     from "http";
import { fileURLToPath }        from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Local database (JSONL append-log) ───────────────────────────────────────
// Each line is a JSON record of one conversion + its token savings.
// Read by the /api/stats endpoint that powers the dashboard.

const LOG_PATH = path.join(__dirname, "conversions.jsonl");

function logConversion(record) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    fs.appendFileSync(LOG_PATH, line, "utf-8");
  } catch {
    // Non-fatal — MCP tool still returns the markdown even if logging fails.
  }
}

function loadRecords() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs.readFileSync(LOG_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ─── Token estimation ─────────────────────────────────────────────────────────
// Vision overhead: Anthropic publishes ~1,500 tokens per PDF page when a file
// is uploaded directly (rendered as images). The MCP eliminates this entirely
// by extracting plain text before it reaches the API.

const VISION_PER_PAGE = 1500;

function estimateTokens(text) {
  // chars ÷ 4 is the standard approximation for Claude's tokenizer.
  return Math.max(1, Math.round(text.length / 4));
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

async function convertPdf(buffer) {
  const mod = await import("pdf-parse");

  // pdf-parse v2.x exports a PDFParse class; v1.x exports a default function.
  if (typeof mod.PDFParse === "function") {
    const { PDFParse } = mod;
    const parser = new PDFParse({ data: buffer, verbosity: 0 });
    const text   = await parser.getText();
    const pages  = parser.numpages || Math.max(1, Math.round(text.length / 3000));
    return { markdown: text, pages };
  }

  // Fallback: v1.x default-function API
  const pdfParse = mod.default ?? mod;
  const data     = await pdfParse(buffer);
  return { markdown: data.text, pages: data.numpages || 1 };
}

// ─── DOCX ─────────────────────────────────────────────────────────────────────

async function convertDocx(buffer) {
  const mammoth = (await import("mammoth")).default;
  const result  = await mammoth.extractRawText({ buffer });
  const words   = result.value.split(/\s+/).filter(Boolean).length;
  const pages   = Math.max(1, Math.round(words / 400));   // ~400 words/page
  return { markdown: result.value, pages };
}

// ─── PPTX ─────────────────────────────────────────────────────────────────────

async function convertPptx(buffer) {
  const AdmZip        = (await import("adm-zip")).default;
  const { XMLParser } = await import("fast-xml-parser");

  const zip          = new AdmZip(buffer);
  const slideEntries = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const num = e => parseInt(e.entryName.match(/(\d+)/)[1], 10);
      return num(a) - num(b);
    });

  const parser = new XMLParser({ ignoreAttributes: false });
  const slides = [];

  for (const entry of slideEntries) {
    const xml    = entry.getData().toString("utf-8");
    const parsed = parser.parse(xml);
    const texts  = extractTextNodes(parsed);
    if (texts.length) slides.push(texts.join(" "));
  }

  return { markdown: slides.join("\n\n"), pages: Math.max(1, slideEntries.length) };
}

function extractTextNodes(obj) {
  if (!obj || typeof obj !== "object") return [];
  const out = [];
  for (const [key, val] of Object.entries(obj)) {
    if (key === "a:t") {
      if (typeof val === "string")   out.push(val);
      else if (Array.isArray(val))   out.push(...val.filter(v => typeof v === "string"));
    } else {
      out.push(...extractTextNodes(Array.isArray(val) ? Object.assign({}, val) : val));
    }
  }
  return out;
}

// ─── XLSX / XLS ───────────────────────────────────────────────────────────────

async function convertXlsx(buffer) {
  const XLSX     = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const parts    = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (!rows.length) continue;

    parts.push(`## ${sheetName}\n`);
    const maxCols = Math.max(...rows.map(r => r.length));
    const header  = (rows[0] || []).map(c => String(c));

    parts.push("| " + header.join(" | ") + " |");
    parts.push("| " + header.map(() => "---").join(" | ") + " |");

    for (const row of rows.slice(1)) {
      const cells = Array.from({ length: maxCols }, (_, i) => String(row[i] ?? ""));
      parts.push("| " + cells.join(" | ") + " |");
    }
  }

  // Treat each sheet as a "page" for the savings estimate.
  return { markdown: parts.join("\n"), pages: Math.max(1, workbook.SheetNames.length) };
}

// ─── Images (OCR) ─────────────────────────────────────────────────────────────

async function convertImage(buffer) {
  const { createWorker } = await import("tesseract.js");
  const worker           = await createWorker("eng");
  const { data: { text } } = await worker.recognize(buffer);
  await worker.terminate();
  return { markdown: text.trim(), pages: 1 };
}

// ─── URLs ─────────────────────────────────────────────────────────────────────

async function convertUrl(url) {
  const fetch   = (await import("node-fetch")).default;
  const cheerio = await import("cheerio");

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; md-converter-mcp/1.1; +https://github.com/raghunath-iyengar/md-converter-mcp)" },
    redirect: "follow",
    timeout:  15000,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

  const html = await res.text();
  const $    = cheerio.load(html);

  // Strip navigation noise
  $("script, style, nav, header, footer, aside, iframe, [role=navigation], [role=banner], [role=complementary]").remove();

  const title = $("title").text().trim();
  const lines = [];

  if (title) lines.push(`# ${title}\n`);

  $("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th").each((_, el) => {
    const tag  = el.tagName.toLowerCase();
    const text = $(el).text().trim().replace(/\s+/g, " ");
    if (!text) return;

    if (tag.startsWith("h")) {
      lines.push(`${"#".repeat(parseInt(tag[1], 10))} ${text}`);
    } else if (tag === "li") {
      lines.push(`- ${text}`);
    } else if (tag === "pre") {
      lines.push("```\n" + text + "\n```");
    } else if (tag === "blockquote") {
      lines.push(`> ${text}`);
    } else {
      lines.push(text);
    }
  });

  const markdown = lines.join("\n");
  const words    = markdown.split(/\s+/).filter(Boolean).length;
  return { markdown, pages: Math.max(1, Math.round(words / 400)) };
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function convert(input) {
  if (/^https?:\/\//i.test(input)) {
    const result = await convertUrl(input);
    return { ...result, filename: input, file_type: "url" };
  }

  if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`);

  const buffer = fs.readFileSync(input);
  const ext    = path.extname(input).toLowerCase();
  let result;

  switch (ext) {
    case ".pdf":
      result = await convertPdf(buffer);
      break;
    case ".docx":
      result = await convertDocx(buffer);
      break;
    case ".pptx":
      result = await convertPptx(buffer);
      break;
    case ".xlsx":
    case ".xls":
      result = await convertXlsx(buffer);
      break;
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".webp":
    case ".tiff":
    case ".bmp":
      result = await convertImage(buffer);
      break;
    case ".txt":
    case ".md": {
      const text = buffer.toString("utf-8");
      result = { markdown: text, pages: Math.max(1, Math.round(text.length / 2000)) };
      break;
    }
    default:
      throw new Error(
        `Unsupported file type: "${ext}". Supported: PDF, DOCX, PPTX, XLSX/XLS, PNG, JPG, JPEG, WEBP, TIFF, BMP, TXT, MD, and HTTP/HTTPS URLs.`
      );
  }

  return { ...result, filename: path.basename(input), file_type: ext.replace(".", "") };
}

// ─── Stats aggregator ─────────────────────────────────────────────────────────

function buildStats() {
  const records = loadRecords();

  const summary = {
    total_conversions: records.length,
    total_saved:       records.reduce((s, r) => s + (r.saved_tokens  || 0), 0),
    total_mcp:         records.reduce((s, r) => s + (r.mcp_tokens    || 0), 0),
    total_direct:      records.reduce((s, r) => s + (r.direct_tokens || 0), 0),
    avg_reduction:     records.length
      ? parseFloat((records.reduce((s, r) => s + (r.reduction_pct || 0), 0) / records.length).toFixed(1))
      : 0,
  };

  // Savings by file type
  const typeMap = {};
  for (const r of records) {
    const t = r.file_type || "unknown";
    if (!typeMap[t]) typeMap[t] = { file_type: t, conversions: 0, total_saved: 0 };
    typeMap[t].conversions++;
    typeMap[t].total_saved += (r.saved_tokens || 0);
  }
  const by_type = Object.values(typeMap).sort((a, b) => b.total_saved - a.total_saved);

  // Most recent 20
  const recent = records.slice(-20).reverse();

  // Daily totals + cumulative savings over time
  const dayMap = {};
  for (const r of records) {
    const day = (r.ts || "").slice(0, 10) || "unknown";
    if (!dayMap[day]) dayMap[day] = 0;
    dayMap[day] += (r.saved_tokens || 0);
  }
  let cumulative = 0;
  const over_time = Object.keys(dayMap).sort().map(date => {
    cumulative += dayMap[date];
    return { date, daily_saved: dayMap[date], cumulative_saved: cumulative };
  });

  return { summary, by_type, recent, over_time };
}

// ─── Dashboard HTTP server ────────────────────────────────────────────────────

const DASHBOARD_PORT = 3847;
const DASHBOARD_HTML = path.join(__dirname, "dashboard.html");

const dashServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  if (req.method === "GET" && req.url === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    try {
      res.end(JSON.stringify(buildStats()));
    } catch (err) {
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard.html")) {
    if (fs.existsSync(DASHBOARD_HTML)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(DASHBOARD_HTML, "utf-8"));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("dashboard.html not found — ensure it is in the same directory as server.js.");
    }
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

dashServer.listen(DASHBOARD_PORT, "127.0.0.1", () => {
  process.stderr.write(`[md-converter] Dashboard → http://localhost:${DASHBOARD_PORT}\n`);
});

dashServer.on("error", err => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `[md-converter] Port ${DASHBOARD_PORT} already in use — dashboard unavailable, MCP still works.\n`
    );
  }
});

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    "md-converter",
  version: "1.1.0",
});

server.tool(
  "convert_to_markdown",
  "Convert a file or URL to Markdown. Supports PDF, DOCX, PPTX, XLSX/XLS, images (OCR via Tesseract), and web pages. Automatically logs token savings to a local database — view the dashboard at http://localhost:3847. Pass an absolute file path or an HTTP/HTTPS URL.",
  { input: z.string().describe("Absolute file path or HTTP/HTTPS URL to convert") },
  async ({ input }) => {
    try {
      const { markdown, pages, filename, file_type } = await convert(input);

      // Token savings calculation
      const mcp_tokens    = estimateTokens(markdown);
      const direct_tokens = mcp_tokens + VISION_PER_PAGE * pages;
      const saved_tokens  = VISION_PER_PAGE * pages;
      const reduction_pct = parseFloat((saved_tokens / direct_tokens * 100).toFixed(1));

      logConversion({ filename, file_type, pages, mcp_tokens, direct_tokens, saved_tokens, reduction_pct });

      const label = /^https?:\/\//i.test(input) ? input : path.basename(input);

      // Savings summary appended to every response
      const banner = [
        "",
        "---",
        `**Token savings (this call):** MCP ${mcp_tokens.toLocaleString()} tokens vs. direct-upload estimate ${direct_tokens.toLocaleString()} tokens — **saved ${saved_tokens.toLocaleString()} tokens (${reduction_pct}% reduction)** across ${pages} page${pages !== 1 ? "s" : ""}.`,
        `*Cumulative savings → http://localhost:${DASHBOARD_PORT}*`,
      ].join("\n");

      return {
        content: [{ type: "text", text: `# ${label}\n\n${markdown}\n${banner}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error converting "${input}": ${err.message}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
