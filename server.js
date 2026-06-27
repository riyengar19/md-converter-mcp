#!/usr/bin/env node
/**
 * md-converter-mcp  —  v1.0.0
 * A Node.js MCP server that converts files and URLs to Markdown.
 * Drop-in replacement for Microsoft markitdown-mcp that works on any
 * Node.js ≥ 18 install — no Python required.
 *
 * Supported: PDF · DOCX · PPTX · XLSX/XLS · PNG/JPG/WEBP/TIFF/BMP (OCR) · URLs · TXT/MD
 *
 * License: GPL-3.0
 * https://github.com/raghunath-iyengar/md-converter-mcp
 */

import { McpServer }         from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z }                 from "zod";
import fs                    from "fs";
import path                  from "path";

// ─── PDF ──────────────────────────────────────────────────────────────────────

async function convertPdf(buffer) {
  const mod = await import("pdf-parse");

  // pdf-parse v2.x exports a PDFParse class; v1.x exports a default function.
  if (typeof mod.PDFParse === "function") {
    const { PDFParse } = mod;
    const parser = new PDFParse({ data: buffer, verbosity: 0 });
    return await parser.getText();
  }

  // Fallback: v1.x default-function API
  const pdfParse = mod.default ?? mod;
  const result   = await pdfParse(buffer);
  return result.text;
}

// ─── DOCX ─────────────────────────────────────────────────────────────────────

async function convertDocx(buffer) {
  const mammoth = (await import("mammoth")).default;
  const result  = await mammoth.extractRawText({ buffer });
  return result.value;
}

// ─── PPTX ─────────────────────────────────────────────────────────────────────

async function convertPptx(buffer) {
  const AdmZip      = (await import("adm-zip")).default;
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

  return slides.join("\n\n");
}

function extractTextNodes(obj) {
  if (!obj || typeof obj !== "object") return [];
  const out = [];
  for (const [key, val] of Object.entries(obj)) {
    if (key === "a:t") {
      if (typeof val === "string")       out.push(val);
      else if (Array.isArray(val))       out.push(...val.filter(v => typeof v === "string"));
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

  return parts.join("\n");
}

// ─── Images (OCR) ─────────────────────────────────────────────────────────────

async function convertImage(buffer) {
  const { createWorker } = await import("tesseract.js");
  const worker           = await createWorker("eng");
  const { data: { text } } = await worker.recognize(buffer);
  await worker.terminate();
  return text.trim();
}

// ─── URLs ─────────────────────────────────────────────────────────────────────

async function convertUrl(url) {
  const fetch   = (await import("node-fetch")).default;
  const cheerio = await import("cheerio");

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; md-converter-mcp/1.0; +https://github.com/raghunath-iyengar/md-converter-mcp)" },
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
      const hashes = "#".repeat(parseInt(tag[1], 10));
      lines.push(`${hashes} ${text}`);
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

  return lines.join("\n");
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function convert(input) {
  if (/^https?:\/\//i.test(input)) return convertUrl(input);

  if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`);

  const buffer = fs.readFileSync(input);
  const ext    = path.extname(input).toLowerCase();

  switch (ext) {
    case ".pdf":                                        return convertPdf(buffer);
    case ".docx":                                       return convertDocx(buffer);
    case ".pptx":                                       return convertPptx(buffer);
    case ".xlsx": case ".xls":                          return convertXlsx(buffer);
    case ".png":  case ".jpg":  case ".jpeg":
    case ".webp": case ".tiff": case ".bmp":            return convertImage(buffer);
    case ".txt":  case ".md":                           return buffer.toString("utf-8");
    default:
      throw new Error(
        `Unsupported file type: "${ext}". Supported: PDF, DOCX, PPTX, XLSX/XLS, PNG, JPG, JPEG, WEBP, TIFF, BMP, TXT, MD, and HTTP/HTTPS URLs.`
      );
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    "md-converter",
  version: "1.0.0",
});

server.tool(
  "convert_to_markdown",
  "Convert a file or URL to Markdown. Supports PDF, DOCX, PPTX, XLSX/XLS, images (OCR via Tesseract), and web pages. Pass an absolute file path or an HTTP/HTTPS URL.",
  { input: z.string().describe("Absolute file path or HTTP/HTTPS URL to convert") },
  async ({ input }) => {
    try {
      const markdown = await convert(input);
      const label    = input.startsWith("http") ? input : path.basename(input);
      return {
        content: [{ type: "text", text: `# ${label}\n\n${markdown}` }],
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
