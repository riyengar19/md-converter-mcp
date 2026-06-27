# md-converter-mcp

A Node.js MCP server that converts files and URLs to Markdown — exposes a single `convert_to_markdown` tool that any MCP-compatible AI client (Claude Desktop, Cursor, VS Code, etc.) can call directly.

**Requires Node.js ≥ 18. No Python. No Docker.**

---

## Why this exists

Microsoft's [`markitdown-mcp`](https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp) is a great idea but fails to install on Python 3.13+ due to unresolved wheel conflicts in its dependency tree (`youtube-transcript-api` and others). If you hit errors like:

```
ERROR: Could not find a version that satisfies the requirement ...
```

…this is a pure Node.js drop-in that does the same job without touching Python at all.

---

## What it does

Converts any of these inputs into clean Markdown text that the AI can read:

| Input | How |
|---|---|
| PDF | `pdf-parse` — text extraction, no rendering |
| DOCX | `mammoth` |
| PPTX | `adm-zip` + `fast-xml-parser` (slide XML → text) |
| XLSX / XLS | `xlsx` (sheet → Markdown table) |
| PNG, JPG, JPEG, WEBP, TIFF, BMP | `tesseract.js` OCR |
| HTTP/HTTPS URL | `node-fetch` + `cheerio` (HTML → structured Markdown) |
| TXT / MD | Raw file read |

### Token savings vs. direct file upload

When you drop a PDF directly into Claude, each page is rendered as an image and processed through the vision layer at ~1,500 tokens/page. This MCP extracts plain text on your machine before anything crosses the API boundary.

| Document | Pages | MCP tokens | Direct upload tokens | Reduction |
|---|---|---|---|---|
| HCLTech Portal Guide (presentation PDF) | 12 | 1,399 | 19,399 | 93% |
| India Stock Advisor User Guide | 16 | 6,309 | 30,309 | 79% |
| Reddit post (web-to-PDF) | 6 | 1,593 | 10,593 | 85% |
| LifeLabs blood-work report | 3 | ~680 | ~5,200 | 87% |

---

## Installation

**Prerequisites:** [Node.js 18+](https://nodejs.org/) (LTS recommended)

```bash
# 1. Clone the repo
git clone https://github.com/raghunath-iyengar/md-converter-mcp.git
cd md-converter-mcp

# 2. Install dependencies
npm install
```

That's it. No build step, no compile step.

### Verify it works

```bash
node server.js
```

You should see the process start and wait (it listens on stdio for MCP messages). Press Ctrl+C to exit.

---

## Connect to Claude Desktop

Open your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the `md-converter` block inside `mcpServers`:

```json
{
  "mcpServers": {
    "md-converter": {
      "command": "node",
      "args": ["/absolute/path/to/md-converter-mcp/server.js"]
    }
  }
}
```

Replace `/absolute/path/to/md-converter-mcp/server.js` with the actual path on your machine.

**macOS example:**
```json
"args": ["/Users/yourname/md-converter-mcp/server.js"]
```

**Windows example:**
```json
"args": ["C:\\Users\\yourname\\md-converter-mcp\\server.js"]
```

Restart Claude Desktop. You should see `md-converter` appear in the MCP tools list.

---

## Connect to other MCP clients

Any client that supports the MCP stdio transport works. The server command is always:

```
node /path/to/server.js
```

### Cursor / VS Code (`.cursor/mcp.json` or `mcp.json`)

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

## Usage

Once connected, tell Claude (or any MCP client) to use the tool:

> "Use convert_to_markdown to read `/Users/yourname/Documents/report.pdf`"

Or just drop a file reference in your message — Claude will call the tool automatically when it needs to read a supported file type.

**URL example:**
> "Summarise https://example.com/article using convert_to_markdown"

---

## Troubleshooting

**`node: command not found`**
Node.js is not in PATH. Use the full path to the node binary in your config:
```json
"command": "/usr/local/bin/node"
```
Find it with `which node` (macOS/Linux) or `where node` (Windows).

**`Error: File not found`**
The MCP server runs as a subprocess — it does not inherit your shell's working directory. Always pass **absolute paths**, not relative ones.

**`pdf-parse` warning about test files**
Safe to ignore. It's a known cosmetic warning in pdf-parse v1.x that does not affect output.

**Tesseract OCR is slow on first run**
`tesseract.js` downloads language data on first use and caches it. Subsequent calls are fast.

**Claude Desktop shows MCP connection error**
Check the config JSON for syntax errors (trailing commas are invalid JSON). Validate with `node -e "JSON.parse(require('fs').readFileSync('claude_desktop_config.json','utf8'))"`.

---

## Supported Node versions

| Node version | Status |
|---|---|
| 18.x LTS | ✅ Tested |
| 20.x LTS | ✅ Tested |
| 22.x LTS | ✅ Tested |
| 16.x | ⚠️ May work, not supported |

---

## Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server + stdio transport |
| `pdf-parse` | PDF text extraction |
| `mammoth` | DOCX → plain text |
| `adm-zip` + `fast-xml-parser` | PPTX slide XML extraction |
| `xlsx` | Excel → Markdown tables |
| `tesseract.js` | OCR for images |
| `node-fetch` | HTTP fetching for URLs |
| `cheerio` | HTML → structured Markdown |
| `zod` | Input validation |

---

## License

GPL-3.0 — see [LICENSE](LICENSE).
