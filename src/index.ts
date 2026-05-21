import axios from 'axios';
import dotenv from 'dotenv';
import { tavily } from '@tavily/core';
import * as readline from 'readline';

// 加载环境变量
dotenv.config();

// ======================== 1. 工具函数定义 ========================
/**
 * 查询指定城市的实时天气（调用 wttr.in API）
 * @param city 城市名称
 * @returns 格式化的天气信息
 */
async function getWeather(city: string): Promise<string> {
  try {
    const url = `https://wttr.in/${city}?format=j1`;
    const response = await axios.get(url);
    const data = response.data;

    // 解析天气数据
    const currentCondition = data.current_condition[0];
    const weatherDesc = currentCondition.weatherDesc[0].value;
    const tempC = currentCondition.temp_C;

    return `${city}当前天气:${weatherDesc}，气温${tempC}摄氏度`;
  } catch (e: any) {
    if (axios.isAxiosError(e)) {
      return `错误:查询天气时遇到网络问题 - ${e.message}`;
    } else {
      return `错误:解析天气数据失败，可能是城市名称无效 - ${e.message}`;
    }
  }
}

/**
 * 根据城市和天气推荐旅游景点（调用 Tavily API）
 * @param city 城市名称
 * @param weather 天气信息
 * @returns 格式化的景点推荐信息
 */
async function getAttraction(city: string, weather: string): Promise<string> {
  // 验证 Tavily API Key
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return '错误:未配置 TAVILY_API_KEY 环境变量。';
  }

  try {
    // 初始化 Tavily 客户端
    const client = tavily({ apiKey });
    // 构造搜索查询
    const query = `${city} 在${weather}天气下最值得去的旅游景点推荐及理由`;

    // 调用 Tavily API
    const response = await client.search(query, {
      searchDepth: 'basic',
      includeAnswer: true,
    });

    // 优先返回总结性回答
    if (response.answer) {
      return response.answer;
    }

    // 无总结则格式化原始结果
    const formattedResults = response.results?.map(
      (result) => `${result.title}: ${result.content}`
    ) || [];

    if (formattedResults.length === 0) {
      return '抱歉，没有找到相关的旅游景点推荐。';
    }

    return `根据搜索，为您找到以下信息:\n${formattedResults.join('\n')}`;
  } catch (e: any) {
    return `错误:执行Tavily搜索时出现问题 - ${e.message}`;
  }
}

// 工具映射表（供主循环调用）
const availableTools = {
  get_weather: getWeather,
  get_attraction: getAttraction,
};

// ======================== 2. DeepSeek 客户端封装 ========================
/**
 * 兼容 OpenAI 格式的 DeepSeek 客户端
 */
class DeepSeekClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(model: string = 'deepseek-chat') {
    this.apiKey = process.env.DEEPSEEK_API_KEY || '';
    this.baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    this.model = model;

    // 验证密钥
    if (!this.apiKey) {
      throw new Error('请配置 DEEPSEEK_API_KEY 环境变量');
    }
  }

  /**
   * 调用 DeepSeek API 生成响应
   * @param prompt 用户提示词
   * @param systemPrompt 系统提示词
   * @returns LLM 生成的文本
   */
  async generate(prompt: string, systemPrompt: string): Promise<string> {
    try {
      console.log('正在调用大语言模型...');
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          stream: false,
          temperature: 0.1, // 低随机性，保证输出稳定
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
        }
      );

      const answer = response.data.choices[0].message.content;
      console.log('大语言模型响应成功。');
      return answer;
    } catch (e: any) {
      console.error(`调用 DeepSeek API 时发生错误: ${e.message}`);
      return '错误:调用语言模型服务时出错。';
    }
  }
}

// ======================== 3. 系统提示词定义 ========================
const AGENT_SYSTEM_PROMPT = `
你是一个智能旅行助手。你的任务是分析用户的请求，并使用可用工具一步步地解决问题。

# 可用工具:
- get_weather(city: str): 查询指定城市的实时天气。
- get_attraction(city: str, weather: str): 根据城市和天气搜索推荐的旅游景点。

# 输出格式要求:
你的每次回复必须严格遵循以下格式，包含一对Thought和Action：

Thought: [你的思考过程和下一步计划]
Action: [你要执行的具体行动]

Action的格式必须是以下之一:
1. 调用工具: function_name(arg_name="arg_value")
2. 结束任务: Finish[最终答案]

# 重要提示:
- 每次只输出一对Thought-Action
- Action必须在同一行，不要换行
- 当收集到足够信息可以回答用户问题时，必须使用 Action: Finish[最终答案] 格式结束

请开始吧!
`.trim();

// ======================== 4. 主执行循环 ========================
/**
 * 智能助手主循环
 * @param userPrompt 用户输入的请求
 */
async function runAgent(userPrompt: string) {
  // 初始化 DeepSeek 客户端
  const llm = new DeepSeekClient();

  // 初始化对话历史（Prompt History）
  const promptHistory: string[] = [`用户请求: ${userPrompt}`];
  console.log(`用户输入: ${userPrompt}\n${'-'.repeat(48)}`);

  // 最大循环次数（防止无限循环）
  const maxIterations = 5;

  for (let i = 0; i < maxIterations; i++) {
    console.log(`\n--- 循环 ${i + 1} ---\n`);

    // 拼接完整 Prompt
    const fullPrompt = promptHistory.join('\n');

    // 调用 LLM 生成响应
    const llmOutput = await llm.generate(fullPrompt, AGENT_SYSTEM_PROMPT);
    console.log(`模型输出:\n${llmOutput}\n`);

    // 1. 提取 Thought-Action 对（清理多余内容）
    const thoughtActionMatch = llmOutput.match(/Thought: (.+?)\nAction: (.+)/s);
    if (!thoughtActionMatch) {
      console.log('未解析到合法的 Thought-Action 对，结束循环');
      break;
    }
    const [_, thought, action] = thoughtActionMatch;

    // 2. 解析 Action
    let observation = '';
    if (action.startsWith('Finish[')) {
      // 结束任务：提取最终答案
      const finalAnswer = action.replace(/Finish\[(.+)\]/, '$1').trim();
      console.log(`任务完成，最终答案: ${finalAnswer}`);
      break;
    } else {
      // 尝试解析工具调用：兼容「调用工具: func(args)」和「func(args)」两种格式
      // 先移除可能的「调用工具:」前缀
      const cleanAction = action.replace(/^调用工具:\s*/, '').trim();
      const toolCallMatch = cleanAction.match(/^(\w+)\((.+)\)$/);
      if (!toolCallMatch) {
        observation = '错误:工具调用格式不合法，请使用 function_name(arg="value") 或 Finish[答案] 格式';
      } else {
        const [, toolName, argsStr] = toolCallMatch;
        // 解析参数（如 city="北京" → { city: "北京" }）
        const args: Record<string, string> = {};
        argsStr.split(',').forEach((arg) => {
          const [key, value] = arg.trim().split('=');
          if (key && value) {
            args[key] = value.replace(/"/g, ''); // 去除引号
          }
        });

        // 调用工具
        if (availableTools[toolName as keyof typeof availableTools]) {
          const toolFunc = availableTools[toolName as keyof typeof availableTools];
          // @ts-ignore 动态传参（简化处理，生产环境可做更严格的类型校验）
          observation = await toolFunc(...Object.values(args));
        } else {
          observation = `错误:未定义的工具 ${toolName}`;
        }
      }
    }

    // 3. 记录 Observation 到对话历史
    const observationStr = `Observation: ${observation}`;
    console.log(`${observationStr}\n${'-'.repeat(48)}`);
    promptHistory.push(llmOutput, observationStr);
  }
}

// ======================== 5. 执行案例 ========================
// 启动交互（或直接传入固定prompt）
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('请输入你的旅行请求: ', async (userInput) => {
  await runAgent(userInput || '你好，请帮我查询一下今天北京的天气，然后根据天气推荐一个合适的旅游景点。');
  rl.close();
});
