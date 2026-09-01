import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const serverName = process.argv[2] || 'fixture';
if (serverName === 'fail') process.exit(17);

const server = new Server(
  { name: serverName, version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      resources: { subscribe: true },
      prompts: {},
      completions: {},
      logging: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, request => request.params?.cursor
  ? {
      tools: [{ name: `${serverName}_unique`, description: `${serverName} unique`, inputSchema: { type: 'object' } }],
    }
  : {
      tools: [{ name: 'echo', description: `${serverName} echo`, inputSchema: { type: 'object' } }],
      nextCursor: 'second-page',
    });

server.setRequestHandler(CallToolRequestSchema, request => ({
  content: [{
    type: 'text',
    text: `${serverName}:${request.params.name}:${JSON.stringify(request.params.arguments ?? {})}:meta=${JSON.stringify(request.params._meta ?? {})}:session=${process.env.BOTMUX_SESSION_ID || ''}:token=${process.env.PRIVATE_MCP_TOKEN || ''}:frozen=${process.env.FROZEN_SESSION_ENV || ''}:owner=${process.env.BOTMUX_OWNER_OPEN_ID || ''}:legacyOwner=${process.env.__OWNER_OPEN_ID || ''}`,
  }],
}));

server.setRequestHandler(ListPromptsRequestSchema, () => ({
  prompts: [{ name: 'welcome', description: `${serverName} welcome` }],
}));

server.setRequestHandler(GetPromptRequestSchema, request => ({
  description: `${serverName}:${request.params.name}`,
  messages: [{ role: 'user', content: { type: 'text', text: `${serverName} prompt` } }],
}));

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [{ uri: 'demo://shared', name: `${serverName} shared` }],
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
  resourceTemplates: [{ uriTemplate: 'demo://item/{id}', name: `${serverName} item` }],
}));

server.setRequestHandler(ReadResourceRequestSchema, request => ({
  contents: [{ uri: request.params.uri, text: `${serverName}:${request.params.uri}` }],
}));

server.setRequestHandler(SubscribeRequestSchema, () => ({}));
server.setRequestHandler(UnsubscribeRequestSchema, () => ({}));
server.setRequestHandler(SetLevelRequestSchema, () => ({}));
server.setRequestHandler(CompleteRequestSchema, request => ({
  completion: { values: [`${serverName}:${request.params.argument.value}`] },
}));

await server.connect(new StdioServerTransport());
