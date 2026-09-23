const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const urlFetchScript = path.resolve(__dirname, 'UrlFetch.js');

function runUrlFetch(payload, timeoutMs = 45000) {
    return new Promise((resolve) => {
        const proc = spawn('node', [urlFetchScript], {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill();
            resolve({ status: 'timeout', duration: timeoutMs, error: '调用超时中断' });
        }, timeoutMs);

        const start = Date.now();
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());

        proc.on('close', code => {
            if (timedOut) return;
            clearTimeout(timer);
            const duration = Date.now() - start;
            try {
                const parsed = JSON.parse(stdout);
                resolve({ status: 'ok', code, duration, parsed, stderr });
            } catch (err) {
                resolve({ status: 'parse_error', code, duration, raw: stdout, stderr, error: err.message });
            }
        });

        proc.on('error', err => {
            clearTimeout(timer);
            resolve({ status: 'spawn_error', error: err.message });
        });

        proc.stdin.write(JSON.stringify(payload));
        proc.stdin.end();
    });
}

async function testUrlFetchModes() {
    console.log('========================================================================');
    console.log('UrlFetch 模式探测与异常诊断测试');
    console.log('========================================================================\n');

    // 1. 本地 file:/// 读取测试 (最简单、纯离线，排查插件入口与依赖初始化是否有问题)
    console.log('>>> [Case 1] 本地 file:/// 文本协议测试...');
    const dummyPath = path.resolve(__dirname, 'test_dummy.txt');
    fs.writeFileSync(dummyPath, 'Hello UrlFetch Local Test 2026');
    const resFile = await runUrlFetch({ url: `file:///${dummyPath.replace(/\\/g, '/')}` }, 15000);
    console.log('  耗时:', (resFile.duration / 1000).toFixed(2), 's | 状态:', resFile.parsed?.status || resFile.status);
    console.log('  返回片段:', JSON.stringify(resFile.parsed?.result || resFile.parsed?.error || resFile.error));

    // 2. Jina 模式测试 (http://example.com)
    console.log('\n>>> [Case 2] Jina 模式测试 (mode: "jina", url: "https://example.com")...');
    const resJina = await runUrlFetch({ url: 'https://example.com', mode: 'jina' }, 25000);
    console.log('  耗时:', (resJina.duration / 1000).toFixed(2), 's | 状态:', resJina.parsed?.status || resJina.status);
    console.log('  返回内容预览:', (resJina.parsed?.result?.content?.[0]?.text || resJina.parsed?.error || resJina.error || '').slice(0, 150));

    // 3. 默认 text 模式测试 (http://example.com，走直接 fetch 或 Puppeteer)
    console.log('\n>>> [Case 3] 默认 text 模式测试 (mode: "text", url: "https://example.com")...');
    const resText = await runUrlFetch({ url: 'https://example.com', mode: 'text' }, 35000);
    console.log('  耗时:', (resText.duration / 1000).toFixed(2), 's | 状态:', resText.parsed?.status || resText.status);
    if (resText.parsed?.status === 'success') {
        console.log('  成功抓取，字数:', resText.parsed?.result?.content?.[0]?.text?.length);
    } else {
        console.log('  报错详情:', resText.parsed?.error || resText.parsed?.result?.content?.[0]?.text || resText.raw || resText.error);
        if (resText.stderr) console.log('  stderr:', resText.stderr.slice(0, 200));
    }

    // 4. 常见真实网站测试 (比如国内常见易报高风控的网站，或外网被墙网站)
    console.log('\n>>> [Case 4] 国内主流资讯网站 (如 36kr)...');
    const res36kr = await runUrlFetch({ url: 'https://www.36kr.com', mode: 'text' }, 35000);
    console.log('  耗时:', (res36kr.duration / 1000).toFixed(2), 's | 状态:', res36kr.parsed?.status || res36kr.status);
    if (res36kr.parsed?.status === 'success') {
        console.log('  成功抓取，字数:', res36kr.parsed?.result?.content?.[0]?.text?.length);
    } else {
        console.log('  报错详情:', res36kr.parsed?.error || res36kr.parsed?.result?.content?.[0]?.text || res36kr.raw || res36kr.error);
        if (res36kr.stderr) console.log('  stderr:', res36kr.stderr.slice(0, 200));
    }
}

testUrlFetchModes().catch(console.error);
