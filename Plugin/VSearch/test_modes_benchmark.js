const { spawn } = require('child_process');
const path = require('path');

const vsearchScript = path.resolve(__dirname, 'VSearch.js');

function callVSearch(payload, timeoutMs = 90000) {
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
            resolve({ status: 'timeout', duration: timeoutMs, error: `调用超过 ${timeoutMs / 1000}s 超时中断` });
        }, timeoutMs);

        const start = Date.now();

        proc.stdout.on('data', data => { stdout += data.toString(); });
        proc.stderr.on('data', data => { stderr += data.toString(); });

        proc.on('close', code => {
            if (timedOut) return;
            clearTimeout(timer);
            const duration = Date.now() - start;
            try {
                const parsed = JSON.parse(stdout);
                resolve({ status: 'ok', code, duration, parsed, stderr });
            } catch (err) {
                resolve({ status: 'parse_error', code, duration, rawStdout: stdout, stderr, error: err.message });
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

async function testAllModes() {
    const topic = '2026年商业航天与可重复使用火箭进展';
    const keywords = 'SpaceX Starship 2026, 中国可重复使用火箭';
    const modes = ['grounding', 'grok', 'tavily', 'kimisearch'];

    console.log('====================================================');
    console.log(`[Agent 调研视角] 搜索模式全量探测：${topic}`);
    console.log('====================================================\n');

    const results = [];

    for (const mode of modes) {
        console.log(`>>> 正在测试模式: [${mode}] ...`);
        const res = await callVSearch({
            SearchTopic: topic,
            Keywords: keywords,
            SearchMode: mode,
            ShowURL: true
        }, 60000);

        const summary = {
            mode,
            durationSec: (res.duration / 1000).toFixed(2),
            exitCode: res.code,
            pluginStatus: res.parsed?.status || res.status,
            charCount: 0,
            hasRealData: false,
            fallbackNotice: false,
            sample: ''
        };

        if (res.parsed?.status === 'success') {
            const text = res.parsed.result?.content?.[0]?.text || '';
            summary.charCount = text.length;
            summary.hasRealData = text.includes('202') || text.includes('火箭') || text.includes('SpaceX');
            summary.fallbackNotice = text.includes('401') || text.includes('未经整合') || text.includes('未完成的 Grounding');
            summary.sample = text.slice(0, 180).replace(/\n/g, ' ');
            console.log(`  ✓ 成功返回 | 耗时: ${summary.durationSec}s | 文本量: ${summary.charCount} 字符`);
            if (summary.fallbackNotice) {
                console.log(`  ⚠️ 包含兜底/降级标记 (注意查看是真实搜索还是模型推演)`);
            }
            console.log(`  摘要预览: ${summary.sample}...`);
        } else {
            console.log(`  ✗ 失败/异常 | 耗时: ${summary.durationSec}s | 错误信息: ${res.parsed?.error || res.error || res.rawStdout?.slice(0, 100)}`);
        }
        console.log('----------------------------------------------------');
        results.push(summary);
    }

    console.log('\n====================================================');
    console.log('探测结果矩阵汇总:');
    console.log('====================================================');
    console.table(results.map(r => ({
        '模式 (Mode)': r.mode,
        '耗时 (秒)': r.durationSec,
        '插件状态': r.pluginStatus,
        '输出字符数': r.charCount,
        '真实联网/兜底推演': r.fallbackNotice ? '降级/模型推演' : (r.charCount > 0 ? '真实联网搜索' : '无数据')
    })));
}

testAllModes().catch(console.error);
