const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const anysearchScript = path.resolve(__dirname, 'AnySearch.js');
const envConfig = dotenv.parse(fs.readFileSync(path.resolve(__dirname, 'config.env'), 'utf8'));

function callAnySearch(payload, timeoutMs = 45000) {
    return new Promise((resolve) => {
        const proc = spawn('node', [anysearchScript], {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...envConfig }
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill();
            resolve({ status: 'timeout', duration: timeoutMs, error: '执行超时' });
        }, timeoutMs);

        const start = Date.now();
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());

        proc.on('close', code => {
            if (timedOut) return;
            clearTimeout(timer);
            const duration = Date.now() - start;
            try {
                resolve({ status: 'ok', code, duration, parsed: JSON.parse(stdout), stderr });
            } catch (err) {
                resolve({ status: 'error', code, duration, raw: stdout, stderr, error: err.message });
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

async function runPerformanceBench() {
    console.log('========================================================================================');
    console.log('AnySearch 性能基准实测：单词检索 vs 多词批量 vs 垂直子域查询的响应时延与产出速率');
    console.log('========================================================================================\n');

    const testCases = [
        { name: '单次通用检索 (max_results: 3)', payload: { query: '2026年全球生成式AI产业趋势', max_results: 3 } },
        { name: '单次通用检索 (max_results: 8)', payload: { query: '2026年全球生成式AI产业趋势', max_results: 8 } },
        { name: '批量并行 3 查询 (queries)', payload: { queries: 'LLM 架构创新 2026|Agentic AI 工作流|端侧轻量化大模型', max_results: 3 } },
        { name: '垂直领域检索 (finance.news)', payload: { query: 'Nvidia 财报分析', sub_domain: 'finance.news', params: 'type=general', max_results: 3 } },
        { name: '垂直领域检索 (code.doc)', payload: { query: 'React 19 Server Components', sub_domain: 'code.doc', params: 'library=react', max_results: 3 } }
    ];

    const results = [];

    for (const tc of testCases) {
        console.log(`>>> 正在压测: ${tc.name} ...`);
        const res = await callAnySearch(tc.payload, 40000);
        const sec = (res.duration / 1000).toFixed(2);
        
        let chars = 0;
        let success = false;
        let detail = '';

        if (res.parsed?.status === 'success') {
            const text = res.parsed.result?.content?.[0]?.text || '';
            chars = text.length;
            success = !text.includes('搜索失败') && chars > 50;
            detail = success ? `${chars} 字符 (正常)` : text.slice(0, 80).replace(/\n/g, ' ');
        } else {
            detail = res.parsed?.error || res.error || '执行异常';
        }

        const rate = (success && sec > 0) ? Math.round(chars / sec) : 0;
        console.log(`  结果: ${success ? '✓ 成功' : '⚠️ 异常/部分失败'} | 耗时: ${sec}s | 返回: ${detail}`);
        
        results.push({
            '测试场景': tc.name,
            '耗时(秒)': sec,
            '状态': success ? '成功' : '失败/降级',
            '文本量(字符)': chars,
            '产出速率(字/秒)': rate,
            '网络/服务说明': success ? '极速直出' : detail.slice(0, 35)
        });
    }

    console.log('\n========================================================================================');
    console.log('AnySearch 性能实测数据矩阵汇总：');
    console.log('========================================================================================');
    console.table(results);
}

runPerformanceBench().catch(console.error);
