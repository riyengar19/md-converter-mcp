# md-converter-mcp — Community Guide

**A Node.js MCP server that converts files and URLs to Markdown, for use with Claude Desktop, Cursor, and any other MCP-compatible AI client.**

If you came here because `markitdown-mcp` won't install on your machine — you're in the right place. But this tool stands on its own: it's a general-purpose file-to-Markdown bridge that works on any machine with Node.js 18+, no Python required.

---

## The problem this solves

When you drop a PDF (or Word doc, or spreadsheet) directly into an AI chat window, the file usually gets rendered as images — one image per page. The AI then processes those images through its vision layer. That costs tokens, a lot of them.

Anthropic's published rate for PDF vision processing is **~1,500 tokens per page**. A 12-page document you upload directly costs ~18,000 tokens just for the page renders — before the AI has read a single word of actual content.

This MCP server takes a different approach: it extracts the text from the file **on your machine**, before anything crosses the API. What gets sent to the AI is plain Markdown text — no images, no vision overhead.

### Real numbers (measured, not estimated)

| Document | Pages | Tokens via MCP | Tokens via direct upload | Savings |
|---|---|---|---|---|
| Presentation PDF (HCLTech Portal Guide) | 12 | 1,399 | 19,399 | **93%** |
| Dense technical doc (India Stock Advisor Guide) | 16 | 6,309 | 30,309 | **79%** |
| Web page saved as PDF (Reddit post) | 6 | 1,593 | 10,593 | **85%** |
| Medical report (LifeLabs, 3-page) | 3 | ~680 | ~5,200 | **87%** |

The savings are largest for documents with lots of whitespace and sparse layout (presentations, reports with margins) because vision overhead is fixed at 1,500 tokens/page regardless of how little text is on the page.

---

## What it can convert

| Format | Notes |
|---|---|
| **PDF** | Text extraction. Fast, works on any PDF with selectable text. |
| **DOCX** | Word documents. Extracts all body text. |
| **PPTX** | PowerPoint. Extracts all text from every slide in order. |
| **XLSX / XLS** | Excel workbooks. Each sheet becomes a Markdown table. |
| **PNG, JPG, JPEG, WEBP, TIFF, BMP** | OCR via Tesseract. Slower, but works on scanned documents. |
| **HTTP/HTTPS URLs** | Fetches the page, strips navigation chrome, returns structured Markdown. |
| **TXT / MD** | Raw read — useful for passing large text files without copy-paste. |

---

## Requirements

- **Node.js 18 or newer** — that's it.
- No Python. No Docker. No virtual environments. No `pip install` that may or may not work.

Check your Node version: `node --version`

If you don't have Node.js, download the LTS release from [nodejs.org](https://nodejs.org). The installer takes 2 minutes.

---

## Install

```bash
git clone https://github.com/raghunath-iyengar/md-converter-mcp.git
cd md-converter-mcp
npm install
```

`npm install` downloads all dependencies into a local `node_modules/` folder. Nothing is installed globally. Nothing touches your system Python.

---

## Connect to Claude Desktop

1. Find your Claude Desktop config file:
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

2. Open it in any text editor and add this block inside `"mcpServers"`:

```json
"md-converter": {
  "command": "node",
  "args": ["/Users/yourname/md-converter-mcp/server.js"]
}
```

Use the **full absolute path** to `server.js` on your machine. On Windows use double backslashes: `"C:\\Users\\yourname\\md-converter-mcp\\server.js"`.

3. Save the file and **restart Claude Desktop**.

4. You should see `md-converter` appear in the MCP tools list (hammer icon or settings).

### Full config example (if you're starting fresh)

```json
{
  "mcpServers": {
    "md-converter": {
      "command": "node",
      "args": ["/Users/yourname/md-converter-mcp/server.js"]
    }
  }
}
```

---

## Using it in Claude

Once connected, you can ask Claude to read any file by path or any URL:

**Read a PDF:**
> "Read the file at `/Users/me/Documents/annual-report.pdf` and summarise it."

**Read a Word doc:**
> "Convert `/Users/me/Downloads/contract.docx` to Markdown so you can review it."

**Read a spreadsheet:**
> "Use convert_to_markdown on `/Users/me/data.xlsx` and tell me what's in it."

**Fetch a web page:**
> "Convert `https://example.com/blog/article` to Markdown."

Claude will call the `convert_to_markdown` tool automatically. The file path must be an absolute path that the server process can reach — the server runs as a subprocess, so it doesn't know your shell's current directory.

---

## Connect to other AI clients

Any client that supports MCP over stdio works. The command is always `node` and the argument is the full path to `server.js`.

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json` in your project):
```json
{
  "mcpServers": {
    "md-converter": {
      "command": "node",
      "args": ["/path/to/md-converter-mcp/server.js"]
    }
  }
}
```

**VS Code** (with an MCP extension that reads `mcp.json`):
```json
{
  "mcpServers": {
    "md-converter": {
      "command": "node",
      "args": ["/path/to/md-converter-mcp/server.js"]
    }
  }
}
```

---

## Common issues

**`node: command not found` in Claude Desktop**
Claude Desktop may not inherit your shell's PATH. Use the full binary path:
```json
"command": "/usr/local/bin/node"
```
Find it on macOS/Linux: `which node`. On Windows: `where node`.

**`Error: File not found`**
You passed a relative path. Always use absolute paths — the server doesn't know your working directory.

**PDF converts but text looks scrambled**
The PDF was scanned (image-based). Enable OCR: rename the file with a `.jpg` or `.png` extension, or — better — ask Claude to treat it as an image. True OCR on PDFs is on the roadmap.

**`pdf-parse` prints a warning about test files on startup**
This is a known cosmetic issue in pdf-parse v1.x. It doesn't affect output and can be safely ignored.

**Tesseract is slow on the first image**
`tesseract.js` downloads English language data on first use and caches it locally. Subsequent runs are fast.

**Claude Desktop shows a JSON parse error / MCP won't connect**
Your config file has a syntax error. Common culprits: trailing commas, missing closing brace. Validate it:
```bash
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

---

## How it compares to markitdown-mcp

| | `markitdown-mcp` | `md-converter-mcp` |
|---|---|---|
| Language | Python | Node.js |
| Works on Python 3.13+ | ❌ (wheel conflicts) | N/A |
| Works on Node 18+ | N/A | ✅ |
| Docker required | Optional | No |
| PDF support | ✅ | ✅ |
| DOCX support | ✅ | ✅ |
| PPTX support | ✅ | ✅ |
| XLSX support | ✅ | ✅ |
| Image OCR | ✅ | ✅ |
| URL fetching | ✅ | ✅ |
| YouTube transcripts | ✅ | ❌ |
| Install complexity | High (Python env, pip, often breaks) | Low (`npm install`, done) |

The one thing `markitdown-mcp` does that this doesn't is YouTube transcripts. Everything else is covered.

---

## Under the hood

The server uses the MCP SDK's `McpServer` + `StdioServerTransport` pattern — the same pattern as most community MCP servers. It runs as a subprocess that Claude Desktop manages; you don't need to start it manually.

Each converter is a thin wrapper around a well-maintained npm package:
- `pdf-parse` for PDFs (handles both v1.x function API and v2.x class API)
- `mammoth` for DOCX
- `adm-zip` + `fast-xml-parser` for PPTX (PPTX is just a ZIP of XML files)
- `xlsx` for spreadsheets
- `tesseract.js` for OCR
- `node-fetch` + `cheerio` for web pages

No native binaries, no build tools, no compilation. `npm install` pulls pure JS or pre-built WASM packages.

---

## Contributing

Pull requests welcome. If you add a new file format, follow the pattern in `server.js`: one `async function convertXxx(buffer)` that returns a Markdown string, registered in the `switch` block inside `convert()`.

Open an issue first for anything that changes the tool's interface or adds a new npm dependency.

---

## License

GPL-3.0. Free to use, fork, and modify. If you redistribute a modified version, the same license applies.

Repo: https://github.com/raghunath-iyengar/md-converter-mcp
