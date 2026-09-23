const ToolCallParser = require("../../modules/vcpLoop/toolMarkerFuzzyMatcher");
const parser = require("../../modules/vcpLoop/toolCallParser");
const { spawn } = require("child_process");
const path = require("path");

const vsearchScript = path.resolve(__dirname, "VSearch.js");

function callVSearch(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [vsearchScript], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      try {
        resolve({ code, parsed: JSON.parse(stdout), stderr });
      } catch (e) {
        resolve({ code, raw: stdout, stderr, error: e.message });
      }
    });
    proc.on("error", reject);
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();
  });
}

async function runEndToEndAgentTest() {
  console.log("============================================================");
  console.log(
    "测试 VCP Agent 协议调用流：LLM 输出 -> 协议提取 -> 插件执行 -> 回传"
  );
  console.log("============================================================");

  // 模拟 LLM 在日常对话或研究中输出的回复文本（包含思维链和 VCP 专有工具标记）
  const llmSimulatedOutput = `
经过初步分析，关于 2026 年具身智能与人形机器人的商业化落地，我需要借助外部高精度搜索引擎收集最新的量产数据和各厂商商业订单情况。

<<<[TOOL_REQUEST]>>>
tool_name:「始」VSearch「末」,
SearchTopic:「始」2026年全球人形机器人商业化量产现状「末」,
Keywords:「始」人形机器人 量产 2026, 具身智能 工业场景 落地「末」,
SearchMode:「始」grounding「末」,
ShowURL:「始」true「末」
<<<[END_TOOL_REQUEST]>>>

请等待检索完成。
`;

  console.log("[Step 1] 解析 LLM 消息中的工具块...");
  const extracted = parser.extractNextToolBlock(llmSimulatedOutput);
  if (!extracted) {
    throw new Error("未提取到 TOOL_REQUEST 块！");
  }
  console.log("提取成功，原始块内容:");
  console.log(extracted.blockContent);

  console.log("\n[Step 2] 语法解析为标准化调用结构...");
  const parsedCall = parser.parseBlock(extracted.blockContent);
  console.log("工具名:", parsedCall.name);
  console.log("参数表:", JSON.stringify(parsedCall.args, null, 2));

  console.log("\n[Step 3] 验证与协议规范的一致性...");
  if (parsedCall.name !== "VSearch") {
    throw new Error(`预期工具名 VSearch，实际得到: ${parsedCall.name}`);
  }
  if (!parsedCall.args.SearchTopic || !parsedCall.args.Keywords) {
    throw new Error("缺少必要参数！");
  }

  console.log("\n[Step 4] 模拟 VCP 调度器触发 VSearch 插件运行...");
  const start = Date.now();
  const result = await callVSearch(parsedCall.args);
  const duration = ((Date.now() - start) / 1000).toFixed(2);
  console.log(
    `执行完毕，耗时 ${duration}s，进程状态: ${
      result.code === 0 ? "正常" : "异常"
    }`
  );

  console.log("\n[Step 5] 验证返回格式与 Agent 上下文回灌兼容性...");
  console.log("顶层 status:", result.parsed?.status);
  const content = result.parsed?.result?.content;
  const isAiFriendly = Array.isArray(content) && content[0]?.type === "text";
  console.log(
    "是否满足 VCP AI-Friendly 返回格式 (result.content):",
    isAiFriendly
  );

  if (isAiFriendly) {
    const text = content[0].text;
    console.log("返回文本总长度:", text.length, "字符");
    console.log(
      "是否包含来源 URL (ShowURL=true 验证):",
      text.includes("http") || text.includes("[参考来源]")
    );
    console.log("\n--- 最终生成的报告节选 ---");
    console.log(text.slice(0, 400) + "...\n---------------------------");
  }
}

runEndToEndAgentTest().catch(console.error);
