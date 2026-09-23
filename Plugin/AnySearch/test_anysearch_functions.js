const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

const anysearchScript = path.resolve(__dirname, "AnySearch.js");
const envConfig = dotenv.parse(
  fs.readFileSync(path.resolve(__dirname, "config.env"), "utf8")
);

function callAnySearch(payload, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const proc = spawn("node", [anysearchScript], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...envConfig },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolve({ status: "timeout", duration: timeoutMs, error: "执行超时" });
    }, timeoutMs);

    const start = Date.now();
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      const duration = Date.now() - start;
      try {
        const parsed = JSON.parse(stdout);
        resolve({ status: "ok", code, duration, parsed, stderr });
      } catch (err) {
        resolve({
          status: "error",
          code,
          duration,
          raw: stdout,
          stderr,
          error: err.message,
        });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: "spawn_error", error: err.message });
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

async function testAllFunctions() {
  console.log(
    "================================================================"
  );
  console.log("AnySearch 插件核心功能全量验证 (从 Agent 调用视角)");
  console.log(
    "================================================================\n"
  );

  // 1. 边界测试：缺少输入与空输入
  console.log(">>> [Case 1] 参数校验与边界防御测试 (缺少 query/url)...");
  const b1 = await callAnySearch({});
  console.log("  状态:", b1.parsed?.status, "| 错误返回:", b1.parsed?.error);

  // 2. 通用实时搜索 (General Search)
  console.log(
    '\n>>> [Case 2] 通用实时搜索 (query: "2026年诺贝尔物理学奖预测")...'
  );
  const s1 = await callAnySearch({
    query: "2026年诺贝尔物理学奖预测",
    max_results: 3,
  });
  console.log(
    "  耗时:",
    (s1.duration / 1000).toFixed(2),
    "s | 状态:",
    s1.parsed?.status
  );
  if (s1.parsed?.status === "success") {
    const text = s1.parsed.result?.content?.[0]?.text || "";
    console.log("  有效返回长度:", text.length, "字符");
    console.log(
      "  内容摘要:\n",
      text.slice(0, 200).replace(/\n/g, " "),
      "...\n"
    );
  } else {
    console.log("  返回失败:", s1.parsed?.error || s1.raw);
  }

  // 3. 垂直领域搜索 (Vertical Search: finance.news 或 code.doc)
  console.log(
    '>>> [Case 3] 垂直领域搜索 (sub_domain: "code.doc", library: "react")...'
  );
  const s2 = await callAnySearch({
    query: "React 19 useActionState hooks usage",
    sub_domain: "code.doc",
    params: "library=react",
    max_results: 3,
  });
  console.log(
    "  耗时:",
    (s2.duration / 1000).toFixed(2),
    "s | 状态:",
    s2.parsed?.status
  );
  if (s2.parsed?.status === "success") {
    const text = s2.parsed.result?.content?.[0]?.text || "";
    console.log("  有效返回长度:", text.length, "字符");
    console.log(
      "  内容摘要:\n",
      text.slice(0, 200).replace(/\n/g, " "),
      "...\n"
    );
  } else {
    console.log("  返回失败:", s2.parsed?.error || s2.raw);
  }

  // 4. 批量并行搜索 (Batch Search)
  console.log(">>> [Case 4] 批量并行搜索 (queries: 3 条由 | 隔开)...");
  const s3 = await callAnySearch({
    queries: "CUDA 13 release notes|Rust 2024 edition|PyTorch 2.6 features",
    max_results: 2,
  });
  console.log(
    "  耗时:",
    (s3.duration / 1000).toFixed(2),
    "s | 状态:",
    s3.parsed?.status
  );
  if (s3.parsed?.status === "success") {
    const text = s3.parsed.result?.content?.[0]?.text || "";
    console.log("  有效返回长度:", text.length, "字符");
    console.log(
      "  内容摘要:\n",
      text.slice(0, 200).replace(/\n/g, " "),
      "...\n"
    );
  } else {
    console.log("  返回失败:", s3.parsed?.error || s3.raw);
  }

  // 5. 自由路线编排 (Route Orchestration)
  console.log(">>> [Case 5] 自由路线编排测试 (query1 + query2 跨子域)...");
  const s4 = await callAnySearch({
    query1: "Nvidia Blackwell B200 规格参数",
    sub_domain1: "general",
    query2: "Nvidia stock price 2026",
    sub_domain2: "finance.news",
    params2: "type=general",
    max_results: 2,
  });
  console.log(
    "  耗时:",
    (s4.duration / 1000).toFixed(2),
    "s | 状态:",
    s4.parsed?.status
  );
  if (s4.parsed?.status === "success") {
    const text = s4.parsed.result?.content?.[0]?.text || "";
    console.log("  有效返回长度:", text.length, "字符");
    console.log(
      "  内容摘要:\n",
      text.slice(0, 200).replace(/\n/g, " "),
      "...\n"
    );
  } else {
    console.log("  返回失败:", s4.parsed?.error || s4.raw);
  }

  // 6. 网页正文提取 (Extract)
  console.log('>>> [Case 6] 网页正文提取测试 (url: "https://example.com")...');
  const s5 = await callAnySearch({
    url: "https://example.com",
  });
  console.log(
    "  耗时:",
    (s5.duration / 1000).toFixed(2),
    "s | 状态:",
    s5.parsed?.status
  );
  if (s5.parsed?.status === "success") {
    const text = s5.parsed.result?.content?.[0]?.text || "";
    console.log("  提取正文长度:", text.length, "字符");
    console.log(
      "  正文片段:\n",
      text.slice(0, 200).replace(/\n/g, " "),
      "...\n"
    );
  } else {
    console.log("  返回失败:", s5.parsed?.error || s5.raw);
  }
}

testAllFunctions().catch(console.error);
