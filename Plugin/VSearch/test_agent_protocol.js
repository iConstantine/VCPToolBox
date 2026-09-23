const { spawn } = require('child_process');
const path = require('path');
const ToolCallParser = require('../../modules/vcpLoop/toolCallParser');

const vsearchScript = path.resolve(__dirname, 'VSearch.js');

function runVSearchPlugin(payload) {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', [vsearchScript], {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', data => { stdout += data.toString(); });
        proc.stderr.on('data', data => { stderr += data.toString(); });

        proc.on('close', code => {
            try {
                const parsed = JSON.parse(stdout);
                resolve({ code, parsed, stderr });
            } catch (err) {
                resolve({ code, rawStdout: stdout, stderr, parseError: err.message });
            }
        });

        proc.on('error', err => reject(err));

        proc.stdin.write(JSON.stringify(payload));
        proc.stdin.end();
    });
}

async function testSuite() {
    console.log('========================================');
    console.log('1. VSearch 边界与异常参数测试 (stdio 契约)');
    console.log('========================================');

    // Case 1.1 缺少参数
    console.log('\n[Case 1.1] 缺少参数测试 (缺少 Keywords)...');
    const res1 = await runVSearchPlugin({ SearchTopic: "AI 最新进展" });
    console.log('响应状态:', res1.parsed?.status);
    console.log('错误信息:', res1.parsed?.error);

    // Case 1.2 空关键词
    console.log('\n[Case 1.2] 空关键词测试 (Keywords 仅含分隔符)...');
    const res2 = await runVSearchPlugin({ SearchTopic: "AI 最新进展", Keywords: " , , \n" });
    console.log('响应状态:', res2.parsed?.status);
    console.log('错误信息:', res2.parsed?.error);

    console.log('\n========================================');
    console.log('2. Agent 协议层解析与转换测试 (ToolCallParser)');
    console.log('========================================');

    const agentPromptChunk = `
在这里我需要搜索一些前沿进展以回答用户的问题。
<<<[TOOL_REQUEST]>>>
tool_name:「始」VSearch「末」,
SearchTopic:「始」量子计算 2026 最新进展「末」,
Keywords:「始」Quantum computing 2026, 量子纠错突破「末」,
SearchMode:「始」kimisearch「末」,
ShowURL:「始」false「末」
<<<[END_TOOL_REQUEST]>>>
请耐心等待我的搜索结果。
`;

    const extractedBlock = ToolCallParser.extractNextToolBlock(agentPromptChunk);
    console.log('提取到的工具块:', !!extractedBlock);
    if (extractedBlock) {
        const parsedToolCall = ToolCallParser.parseBlock(extractedBlock.blockContent);
        console.log('解析的工具名称:', parsedToolCall.name);
        console.log('解析的参数字典:', JSON.stringify(parsedToolCall.args, null, 2));

        console.log('\n========================================');
        console.log('3. 将 Agent 协议解析结果接入 VSearch 执行');
        console.log('========================================');
        console.log('正在调用 VSearch (模式: kimisearch，带超时保护)...');
        const start = Date.now();
        const execRes = await runVSearchPlugin(parsedToolCall.args);
        console.log(`调用耗时: ${(Date.now() - start) / 1000}s`);
        console.log('插件进程退出码:', execRes.code);
        console.log('响应状态:', execRes.parsed?.status);
        if (execRes.parsed?.status === 'success') {
            console.log('AI Friendly content 结构类型:', Array.isArray(execRes.parsed.result?.content));
            const reportSnippet = execRes.parsed.result?.content?.[0]?.text?.substring(0, 300) || '';
            console.log('检索摘要片段:\n', reportSnippet, '...');
        } else {
            console.log('执行结果:', execRes.parsed || execRes.rawStdout);
        }
    }
}

testSuite().catch(console.error);
