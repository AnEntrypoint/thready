import { ACPProtocol } from './core.js';

export { ACPProtocol };

/*
 * acpreact - ACP SDK for registering tools
 *
 * Basic usage:
 *   import { ACPProtocol } from 'acpreact';
 *
 * Create ACP Protocol instance:
 *   const acp = new ACPProtocol();
 *
 * Register custom tools:
 *   acp.registerTool('my_tool', 'Tool description', {
 *     type: 'object',
 *     properties: { query: { type: 'string' } },
 *     required: ['query']
 *   }, async (params) => {
 *     return { result: 'processed' };
 *   });
 *
 * Initialize protocol:
 *   const response = acp.createInitializeResponse();
 *
 * Execute tool:
 *   const result = await acp.callTool('my_tool', { query: 'test' });
 */
