const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const anysearchScript = path.resolve(__dirname, 'AnySearch.js');
const envConfig = dotenv.parse(fs.readFileSync(path.resolve(__dirname, 'config.env'), 'utf8'));

async function testSingle(query) {
    const start = Date.now();
    const proc = spawn('node', [anysearchScript], {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...envConfig }
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    
    return new Promise((resolve) => {
        proc.on('close', code => {
            const duration = ((Date.now() - start) / 1000).toFixed(2);
            resolve({ duration, stdout, stderr, code });
        });
        proc.stdin.write(JSON.stringify({ query, max_results: 3 }));
        proc.stdin.end();
    });
}

async function run() {
    console.log('测试 3 次连续检索：');
    for (let i = 1; i <= 3; i++) {
        console.log(`\n--- 第 ${i} 次调用 ---`);
        const res = await testSingle('北京天气 2026');
        console.log(`耗时: ${res.duration}s`);
        try {
            const data = JSON.parse(res.stdout);
            console.log('状态:', data.status);
            console.log('内容片段:', data.result?.content?.[0]?.text?.slice(0, 150).replace(/\n/g, ' '));
        } catch (e) {
            console.log('原始输出:', res.stdout);
        }
    }
}

run();
