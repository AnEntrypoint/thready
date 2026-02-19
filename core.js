import { spawn } from 'child_process';
import { EventEmitter } from 'events';

class ACPProtocol extends EventEmitter {
  constructor(instruction) {
    super();
    this.messageId = 0;
    this.instruction = instruction;
    this.toolWhitelist = new Set();
    this.toolSchemas = {};
    this.toolDescriptions = {};
    this.toolCallLog = [];
    this.rejectedCallLog = [];
    this.tools = {};
    this.cliProcess = null;
    this.pendingRequests = new Map();
    this.buffer = '';
    this.initialized = false;
    this.sessionId = null;
  }

  generateRequestId() {
    return ++this.messageId;
  }

  createJsonRpcRequest(method, params) {
    return { jsonrpc: "2.0", id: this.generateRequestId(), method, params };
  }

  createJsonRpcResponse(id, result) {
    return { jsonrpc: "2.0", id, result };
  }

  createJsonRpcError(id, error) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: error } };
  }

  registerTool(name, description, inputSchema, handler) {
    this.toolWhitelist.add(name);
    this.tools[name] = handler;
    this.toolSchemas[name] = inputSchema;
    this.toolDescriptions[name] = description;
    return { name, description, inputSchema };
  }

  getToolsList() {
    return Array.from(this.toolWhitelist).map(toolName => ({
      name: toolName,
      description: this.toolDescriptions[toolName],
      inputSchema: this.toolSchemas[toolName],
    }));
  }

  validateToolCall(toolName) {
    if (!this.toolWhitelist.has(toolName)) {
      const availableTools = Array.from(this.toolWhitelist);
      const error = `Tool not available. Available: ${availableTools.join(', ')}`;
      this.rejectedCallLog.push({
        timestamp: new Date().toISOString(),
        attemptedTool: toolName,
        reason: 'Not in whitelist',
        availableTools,
      });
      return { allowed: false, error };
    }
    return { allowed: true };
  }

  async callTool(toolName, params) {
    const validation = this.validateToolCall(toolName);
    if (!validation.allowed) {
      throw new Error(validation.error);
    }

    this.toolCallLog.push({
      timestamp: new Date().toISOString(),
      toolName,
      params,
      status: 'executing',
    });

    if (this.tools[toolName]) {
      const result = await this.tools[toolName](params);
      const lastLog = this.toolCallLog[this.toolCallLog.length - 1];
      lastLog.status = 'completed';
      lastLog.result = result;
      return result;
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  async start(cli = 'kilo') {
    if (this.cliProcess) return this.sessionId;

    return new Promise((resolve, reject) => {
      this.cliProcess = spawn('script', ['-q', '-c', `${cli} acp`, '/dev/null'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'dumb' },
      });

      this.cliProcess.stdout.on('data', (data) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.cliProcess.stderr.on('data', (data) => {
        this.emit('stderr', data.toString());
      });

      this.cliProcess.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });

      this.cliProcess.on('close', (code) => {
        this.emit('close', code);
        this.cliProcess = null;
        this.initialized = false;
        this.sessionId = null;
      });

      const timeout = setTimeout(() => {
        reject(new Error('ACP initialization timeout'));
      }, 30000);

      this.once('ready', () => {
        clearTimeout(timeout);
        resolve(this.sessionId);
      });

      setTimeout(() => this.createSession(), 500);
    });
  }

  processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleMessage(trimmed);
    }
  }

  handleMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.method === 'initialize') {
      this.send(this.createInitializeResponse(msg.id));
      this.initialized = true;
    } else if (msg.id !== undefined && msg.result !== undefined) {
      const resolver = this.pendingRequests.get(msg.id);
      if (resolver) {
        this.pendingRequests.delete(msg.id);
        resolver(msg.result);
      }
      if (msg.id === 1 && msg.result?.sessionId) {
        this.sessionId = msg.result.sessionId;
        this.emit('ready');
      }
    } else if (msg.id !== undefined && msg.error !== undefined) {
      const resolver = this.pendingRequests.get(msg.id);
      if (resolver) {
        this.pendingRequests.delete(msg.id);
        resolver({ error: msg.error });
      }
    } else if (msg.method?.startsWith('tools/')) {
      const toolName = msg.method.replace('tools/', '');
      this.handleToolCall(msg.id, toolName, msg.params);
    } else if (msg.method === 'session/update') {
      this.emit('update', msg.params);
    }
  }

  async handleToolCall(id, toolName, params) {
    try {
      const result = await this.callTool(toolName, params);
      this.send(this.createJsonRpcResponse(id, result));
    } catch (e) {
      this.send(this.createJsonRpcError(id, e.message));
    }
  }

  send(msg) {
    if (this.cliProcess && this.cliProcess.stdin.writable) {
      this.cliProcess.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  createInitializeResponse(id) {
    const result = {
      protocolVersion: 1,
      capabilities: { tools: this.getToolsList() },
      serverInfo: { name: 'acpreact', version: '1.0.0' },
    };

    if (this.instruction) {
      result.instruction = this.instruction;
    }

    return { jsonrpc: "2.0", id, result };
  }

  createSession() {
    this.send({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: process.cwd(),
        mcpServers: [],
      },
    });
  }

  getToolsDescription() {
    const tools = this.getToolsList();
    if (tools.length === 0) return '';
    
    return '\n\nAvailable tools:\n' + tools.map(t => 
      `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.inputSchema)}`
    ).join('\n');
  }

  async sendPrompt(content) {
    if (!this.sessionId) {
      throw new Error('No session. Call start() first.');
    }

    const reqId = this.generateRequestId();
    const promptWithTools = this.instruction 
      ? `${this.instruction}${this.getToolsDescription()}\n\nUser message: ${content}`
      : content;

    return new Promise((resolve) => {
      this.pendingRequests.set(reqId, resolve);
      this.send({
        jsonrpc: "2.0",
        id: reqId,
        method: "session/prompt",
        params: {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: promptWithTools }],
        },
      });

      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          resolve({ timeout: true });
        }
      }, 120000);
    });
  }

  async process(text, options = {}) {
    const cli = options.cli || 'kilo';

    if (!this.cliProcess) {
      await this.start(cli);
    }

    const result = await this.sendPrompt(text);

    return {
      text,
      result,
      toolCalls: this.toolCallLog.slice(-10),
      logs: this.toolCallLog,
    };
  }

  stop() {
    if (this.cliProcess) {
      this.cliProcess.kill();
      this.cliProcess = null;
    }
    this.initialized = false;
    this.sessionId = null;
  }
}

export { ACPProtocol };
