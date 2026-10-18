// Remote MCP server (Streamable HTTP, stateless) at /mcp.
// Auth: Bearer token — a ShalaSign API key (sf_live_…) or an OAuth access token
// (sf_at_…) issued by oauth.js. Unauthenticated requests get a 401 with the
// resource-metadata pointer the MCP authorization spec expects, so claude.ai
// connectors discover the OAuth flow automatically.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOOLS } from './tools.js';
import { currentUser } from './auth.js';
import { appUrl } from './mailer.js';

function buildServer(ctx, user) {
  const server = new McpServer({ name: 'shalasign', version: '1.0.0' }, {
    instructions: `ShalaSign e-signature for ${user.name} <${user.email}>${user.org ? ` (workspace: ${user.org.name})` : ''}. Use the tools to list and inspect documents, send templates or new PDFs for signature, remind or void, and read status. Always ask the user before void_document. Links in results open in the ShalaSign web app.`,
  });
  for (const t of TOOLS) {
    server.registerTool(t.name, { title: t.name.replace(/_/g, ' '), description: t.description, inputSchema: t.schema }, async (args) => {
      try {
        const result = await t.run(ctx, args ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
      }
    });
  }
  return server;
}

export function registerMcpRoutes(app) {
  const unauthorized = (res) => {
    res.set('WWW-Authenticate', `Bearer realm="ShalaSign", resource_metadata="${appUrl()}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: send a ShalaSign API key or OAuth token as Bearer' }, id: null });
  };

  app.post('/mcp', async (req, res) => {
    const user = currentUser(req);
    if (!user) return unauthorized(res);
    const ctx = { headers: { authorization: req.headers.authorization } };
    const server = buildServer(ctx, { ...user, org: user.org_id ? { name: (await import('./db.js')).getOrg(user.org_id)?.name } : null });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp]', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  // Stateless server: no SSE stream to resume and no sessions to delete.
  app.get('/mcp', (req, res) => { if (!currentUser(req)) return unauthorized(res); res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }); });
  app.delete('/mcp', (req, res) => { if (!currentUser(req)) return unauthorized(res); res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }); });
}
