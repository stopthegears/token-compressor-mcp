# Deployment checklist

## 1. Push this repo to GitHub

```bash
git init
git add .
git commit -m "Initial token compressor MCP"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

## 2. Deploy on Manufact

1. Open Manufact Cloud.
2. Create a new MCP server project.
3. Connect the GitHub repository.
4. Set Node version to 20+.
5. Use build command: `npm install && npm run build`.
6. Use start command: `npm run start`.
7. Deploy.
8. Open `/inspector` and test tools.

## 3. Add to Claude Cowork

1. Open Claude settings.
2. Go to Connectors / Custom connectors.
3. Add the remote MCP endpoint: `https://<your-manufact-url>/mcp`.
4. Ask Claude to list available tools or compress a sample context.

## 4. First smoke test

```text
Use the token compressor MCP to compress this without saving it:
Project Alpha launch is due July 15. Sarah owns comms. Mike owns Jira planning. Priya owns security review. Decision: launch will be phased by department. Risk: Legal approval is not confirmed. Next steps: Sarah drafts comms by Friday, Mike creates the Jira epic, Priya confirms requirements.
```

## 5. Guardrails

• Use non-sensitive data only.  
• Keep in-memory storage until the security model is approved.  
• Use `clear_contexts` after testing if you saved anything.  
