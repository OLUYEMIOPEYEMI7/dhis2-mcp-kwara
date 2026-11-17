import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerDhis2Tools } from './tools/index.js';
import { registerGenericDhis2Tools } from './tools/generic.js';

const app = express();
app.use(express.json());

/**
 * Auth: a single shared-secret key, checked on every /mcp request.
 * This is intentionally simple (not full OAuth) because this server has
 * exactly one intended user. Set MCP_SHARED_KEY in your hosting platform's
 * environment variables to a long random string, then configure the same
 * value as a header when adding this as a custom connector in Claude
 * (Settings > Connectors > Add custom connector > Advanced settings >
 * Headers helper). Anyone without that header gets rejected before any
 * DHIS2 call is made.
 */
function checkAuth(req: express.Request, res: express.Response): boolean {
  const expected = process.env.MCP_SHARED_KEY;
  if (!expected) {
    // Fail closed: if the operator forgot to set a key, refuse all requests
    // rather than silently running with no auth.
    res.status(500).json({ error: 'Server misconfigured: MCP_SHARED_KEY is not set.' });
    return false;
  }
  const provided = req.header('X-MCP-Key') || req.query.key;
  if (provided !== expected) {
    res.status(401).json({ error: 'Unauthorized: missing or incorrect key (X-MCP-Key header or ?key= query param).' });
    return false;
  }
  return true;
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'dhis2-mcp-kwara',
    version: '1.1.0'
  });
  registerDhis2Tools(server);
  registerGenericDhis2Tools(server);
  return server;
}

app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;

  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error handling MCP request.' });
    }
  }
});

// Simple health check for the hosting platform / manual verification.
// Deliberately does not require auth or touch DHIS2, so it can't leak data.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'dhis2-mcp-kwara' });
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(`dhis2-mcp-kwara listening on port ${port} (POST /mcp, GET /health)`);
});
