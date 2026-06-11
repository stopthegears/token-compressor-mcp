# Token Compressor MCP

Remote MCP server for Claude / Claude Cowork that compresses long context, stores compact reusable summaries, retrieves relevant context by title/tag/query, estimates token savings, and deletes stored records.

## Tools

• `compress_context` — compress pasted text without saving it  
• `save_context` — save raw text and a compressed summary  
• `retrieve_context` — retrieve saved compressed context by query, tag, title, or ID  
• `list_contexts` — list saved records  
• `context_stats` — show estimated savings  
• `delete_context` — delete one record  
• `clear_contexts` — delete all records  

## Local setup

```bash
npm install
npm run dev
```

Local endpoints after start:

• MCP endpoint: `http://localhost:3000/mcp`  
• Inspector: `http://localhost:3000/inspector`  

## Manufact deployment

Manufact / mcp-use projects support `npm run dev`, `npm run build`, `npm run start`, and `npm run deploy`. The mcp-use docs say local servers expose `/mcp` for MCP clients and `/inspector` for testing.

Recommended cloud settings:

```text
Node version: 20+
Build command: npm install && npm run build
Start command: npm run start
MCP endpoint: https://<your-manufact-url>/mcp
Inspector: https://<your-manufact-url>/inspector
```

## Claude Cowork usage

After deployment, add the remote MCP URL as a Claude custom connector.

Test prompts:

```text
Use the token compressor MCP to compress this context without saving it:
[paste non-sensitive text]
```

```text
Use the token compressor MCP to save this as "Test Context" with tags test, sample:
[paste non-sensitive text]
```

```text
Retrieve the compressed context for Test Context.
```

## Privacy note

This starter uses in-memory storage. Saved records disappear when the process restarts. That is intentional for a safer first version. Do not store confidential company data in a personal/free cloud server unless approved.
