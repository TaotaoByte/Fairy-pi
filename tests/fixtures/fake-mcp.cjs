'use strict';
/**
 * 测试用的假 MCP 服务器：只回固定的 JSON-RPC 响应，用来把代理的转发、状态发布、
 * 抓帧与命令处理都验证到真实进程层面（不依赖任何真实 MCP 实现）。
 */

const readline = require('node:readline');

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '1.0.0' } },
    });
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          { name: 'shot', description: 'fake screenshot', inputSchema: { type: 'object', properties: {} } },
          { name: 'ping', description: 'fake ping', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    });
    return;
  }

  const name = message.method === 'tools/call' ? message.params?.name : undefined;
  if (name === 'shot') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          { type: 'image', data: Buffer.from('JPEGDATA').toString('base64'), mimeType: 'image/jpeg' },
          {
            type: 'text',
            text: JSON.stringify({ url: 'https://example.com/page', title: '示例页' }),
          },
        ],
      },
    });
    return;
  }
  if (name === 'boom') {
    send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'failed' }] } });
    return;
  }
  if (name === 'bye') {
    // 让测试能主动结束「目标进程」：代理应当据此收场并清理。
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'bye' }] } });
    setTimeout(() => process.exit(0), 30);
    return;
  }
  if (name === 'echo-args') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: JSON.stringify(message.params?.arguments ?? {}) }] },
    });
    return;
  }

  send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } });
});
