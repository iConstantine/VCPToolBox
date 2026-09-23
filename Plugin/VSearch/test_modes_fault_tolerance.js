const { spawn } = require('child_process');
const path = require('path');

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

async function runModeTests() {
    console.log('====================================================');
    console.log('测试 VSearch 不同模式的实际调用、回退策略与容错能力');
    console.log('====================================================');

    // 1. 测试不存在或非法 SearchMode (预期默认回退或走默认逻辑)
    console.log('\n[Case 2.1] 非法模式名测试 (如 SearchMode: "unknown_mode")...');
    const resInvalid = await runVSearchPlugin({
        SearchTopic: '测试未知模式处理',
        Keywords: 'test_keyword',
        SearchMode: 'invalid_mode_xyz'
    });
    console.log('退出码:', resInvalid.code);
    console.log('状态:', resInvalid.parsed?.status);
    console.log('结果内容片段:', resInvalid.parsed?.result?.content?.[0]?.text?.slice(0, 150) || resInvalid.parsed?.error);

    // 2. 测试 Tavily 缺失密钥的校验容错
    console.log('\n[Case 2.2] Tavily 模式测试...');
    const resTavily = await runVSearchPlugin({
        SearchTopic: 'Tavily 模式测试',
        Keywords: 'Tavily API test',
        SearchMode: 'tavily'
    });
    console.log('退出码:', resTavily.code);
    console.log('状态:', resTavily.parsed?.status);
    if (resTavily.parsed?.status === 'error') {
        console.log('捕获预期的错误提示:', resTavily.parsed.error);
    } else {
        console.log('Tavily 返回成功:', resTavily.parsed?.result?.content?.[0]?.text?.slice(0, 150));
    }

    // 3. 测试 Grounding 模式 (在 config.env 中配置了 gemini / localhost 代理)
    console.log('\n[Case 2.3] Grounding 模式快速调用测试...');
    const startGrounding = Date.now();
    const resGrounding = await runVSearchPlugin({
        SearchTopic: 'DeepSeek 发展历程',
        Keywords: 'DeepSeek R1',
        SearchMode: 'grounding',
        ShowURL: false
    });
    console.log(`Grounding 调用耗时: ${(Date.now() - startGrounding) / 1000}s`);
    console.log('退出码:', resGrounding.code);
    console.log('状态:', resGrounding.parsed?.status);
    if (resGrounding.parsed?.status === 'success') {
        const text = resGrounding.parsed.result?.content?.[0]?.text || '';
        console.log('Grounding 输出头部预览:\n', text.slice(0, 250), '...');
    } else {
        console.log('Grounding 执行结果/错误:', resGrounding.parsed?.error || resGrounding.rawStdout);
    }
}

runModeTests().catch(console.error);
