const { spawn } = require('child_process');
const path = require('path');

const urlFetchScript = path.resolve(__dirname, 'UrlFetch.js');

function runUrlFetch(payload, timeoutMs = 60000) {
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
            resolve({ status: 'timeout', duration: timeoutMs, error: '调用超时' });
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

async function runEndToEndVerification() {
    console.log('====================================================================');
    console.log('UrlFetch 修复后端到端全模式复测（Agent 实际使用视角）');
    console.log('====================================================================\n');

    const testSites = [
        { name: 'GitHub 仓库主页', url: 'https://github.com/nodejs/node', mode: 'text' },
        { name: '国内科技新闻 (36Kr)', url: 'https://www.36kr.com', mode: 'text' },
        { name: '长截图快照模式 (snapshot)', url: 'https://example.com', mode: 'snapshot' },
        { name: '下载保存为 Markdown (download)', url: 'https://example.com', mode: 'download', knowledgeFolder: '网页收藏' }
    ];

    const results = [];

    for (const site of testSites) {
        console.log(`>>> 正在测试: ${site.name} (${site.url}, mode: ${site.mode})...`);
        const res = await runUrlFetch(site, 60000);
        const sec = (res.duration / 1000).toFixed(2);

        let success = false;
        let summary = '';
        let length = 0;

        if (res.parsed?.status === 'success') {
            success = true;
            if (site.mode === 'snapshot') {
                const base64Str = res.parsed.result?.image_base64 || '';
                length = base64Str.length;
                summary = `成功生成长截图 (Base64 字符数: ${length})`;
            } else if (site.mode === 'download') {
                const text = res.parsed.result?.content?.[0]?.text || '';
                summary = text.slice(0, 100).replace(/\n/g, ' ');
                length = text.length;
            } else {
                const text = res.parsed.result?.content?.[0]?.text || '';
                length = text.length;
                summary = text.slice(0, 100).replace(/\n/g, ' ');
            }
            console.log(`  ✓ 成功 | 耗时: ${sec}s | 产出: ${summary}\n`);
        } else {
            summary = res.parsed?.error || res.raw || res.error || '失败';
            console.log(`  ✗ 失败 | 耗时: ${sec}s | 报错: ${summary}\n`);
        }

        results.push({
            '测试项': site.name,
            '模式': site.mode,
            '耗时(秒)': sec,
            '状态': success ? '成功' : '失败',
            '返回体特征': summary.slice(0, 45)
        });
    }

    console.log('\n====================================================================');
    console.log('修复后实测矩阵汇总：');
    console.log('====================================================================');
    console.table(results);
}

runEndToEndVerification().catch(console.error);
