// chat-memory-server.js
require('dotenv').config();
const express = require('express');
const timeout = require('connect-timeout');
const fs = require('fs');
const path = require('path');
const app = express();

// 配置常量
const MODEL_NAME = process.env.MODEL_NAME;
const ARK_API_KEY = process.env.ARK_API_KEY;
const PORT = process.env.PORT || 3000;
const API_BASE_URL = process.env.API_BASE_URL;

// 短期 & 长期记忆配置
const MAX_HISTORY_LENGTH = 6;
const messageHistory = [];
const LONG_TERM_MEMORY_FILE = path.join(__dirname, 'long-term-memory.json');

// 加载长期记忆
let longTermMemory = [];
if (fs.existsSync(LONG_TERM_MEMORY_FILE)) {
  try {
    longTermMemory = JSON.parse(fs.readFileSync(LONG_TERM_MEMORY_FILE, 'utf-8'));
  } catch (err) {
    console.warn('长期记忆读取失败:', err);
  }
}

// 中间件
app.use(express.json());
app.use(timeout('30s'));
app.use((req, res, next) => {
  if (!req.timedout) next();
});

const validateChatRequest = (req, res, next) => {
  const { query } = req.body;
  if (!query?.trim()) {
    return res.status(400).json({ error: '查询内容不能为空' });
  }
  next();
};

function escapeSse(text) {
  return text.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/"/g, '\\"');
}

async function handleSseResponse(res, stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let content = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          res.write('data: {"status": "completed"}\n\n');
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.choices) {
            const delta = parsed.choices[0].delta.content;
            if (delta) {
              content += delta;
              res.write(`data: {"content": "${escapeSse(delta)}"}\n\n`);
            }
          }
        } catch (e) {
          console.error('解析响应失败:', e);
        }
      }
    }
  } catch (error) {
    throw new Error(`流处理错误: ${error.message}`);
  } finally {
    reader.releaseLock();
  }

  return content;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/chat', validateChatRequest, async (req, res) => {
  try {
    const { query } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write('data: {"status": "started"}\n\n');

    // 拼接系统提示 + 长期记忆 + 短期记忆 + 当前输入
    const recentMessages = messageHistory.slice(-MAX_HISTORY_LENGTH);
    const messages = [
      { role: 'system', content: '你是一个专业的前端导师。' },
      ...longTermMemory,
      ...recentMessages,
      { role: 'user', content: query }
    ];

    messageHistory.push({ role: 'user', content: query });

    const response = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ARK_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages,
        stream: true
      })
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const aiContent = await handleSseResponse(res, response.body);
    messageHistory.push({ role: 'assistant', content: aiContent });

    // 写入长期记忆（示例规则：若包含“记住”关键词）
    if (query.includes('记住') || aiContent.includes('我会记住')) {
      longTermMemory.push({ role: 'user', content: query });
      longTermMemory.push({ role: 'assistant', content: aiContent });
      try {
        fs.writeFileSync(LONG_TERM_MEMORY_FILE, JSON.stringify(longTermMemory, null, 2), 'utf-8');
      } catch (err) {
        console.error('写入长期记忆失败:', err);
      }
    }

    res.end();
  } catch (error) {
    console.error('调用API时出错:', error.message);
    res.write(`data: {"error": "发生错误: ${error.message}"}\n\n`);
    res.end();
  }
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`服务运行在 http://localhost:${PORT}`);
});
