const { spawn } = require('child_process');
const path = require('path');

const vsearchScript = path.resolve(__dirname, 'VSearch.js');

function callVSearch(payload, timeoutMs = 120000) {
    return new Promise((resolve) => {
        const proc = spawn('node', [vsearchScript], {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe']
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
    console.log('========================================================================');
    console.log('Agent 调研场景压测：Grounding vs Tavily 在单关键词 vs 3并发关键词的性能表现');
    console.log('========================================================================\n');

    const topic = '2026年全固态电池量产与装车进展';
    const singleKw = '全固态电池 2026 量产';
    const multiKw = '全固态电池 2026 量产, 宁德时代 固态电池 进展, 丰田 硫化物 固态电池 计划';

    const testCases = [
        { mode: 'grounding', name: 'Grounding (单关键词)', keywords: singleKw, count: 1 },
        { mode: 'grounding', name: 'Grounding (3关键词并发)', keywords: multiKw, count: 3 },
        { mode: 'tavily', name: 'Tavily (单关键词)', keywords: singleKw, count: 1 },
        { mode: 'tavily', name: 'Tavily (3关键词检索+综合研报)', keywords: multiKw, count: 3 }
    ];

    const results = [];

    for (const tc of testCases) {
        console.log(`>>> 正在压测: ${tc.name} ...`);
        const res = await callVSearch({
            SearchTopic: topic,
            Keywords: tc.keywords,
            SearchMode: tc.mode,
            ShowURL: true
        }, 120000);

        if (res.parsed?.status === 'success') {
            const text = res.parsed.result?.content?.[0]?.text || '';
            const sec = (res.duration / 1000).toFixed(2);
            const chars = text.length;
            const speed = Math.round(chars / (res.duration / 1000));
            console.log(`  ✓ 完成 | 耗时: ${sec}s | 返回字数: ${chars} 字符 | 产出速率: ~${speed} 字/秒\n`);
            results.push({
                '测试用例': tc.name,
                '模式': tc.mode,
                '关键词数': tc.count,
                '总耗时(秒)': sec,
                '平均单词耗时(秒)': (sec / tc.count).toFixed(2),
                '返回字符数': chars,
                '产出速率(字/秒)': speed
            });
        } else {
            console.log(`  ✗ 失败:`, res.parsed?.error || res.error || res.raw?.slice(0, 100));
        }
    }

    console.log('\n========================================================================');
    console.log('压测对比矩阵：');
    console.log('========================================================================');
    console.table(results);
}

runPerformanceBench().catch(console.error);
