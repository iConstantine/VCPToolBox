const { getJson } = require("serpapi");

// 完美对齐接口契约：接收 parameters 对象
async function search(parameters, apiKey) {
    // 提取查询词，兼容多种参数名
    const { q, query, text } = parameters;
    const searchQuery = q || query || text;

    if (!searchQuery) {
        return { success: false, error: "Missing search query parameter." };
    }

    const searchParams = {
        engine: "bing",
        q: searchQuery,
        api_key: apiKey,
    };

    return new Promise((resolve) => {
        // 铁壁防御1：25秒内部超时熔断
        const timeoutId = setTimeout(() => {
            resolve({ 
                success: false, 
                error: "SerpApi Request Timeout: 内部网络请求超时，已触发爱弥斯的专属安全熔断机制！(请检查代理网络)" 
            });
        }, 25000);

        // 铁壁防御2：同步错误捕获，彻底杜绝 UnhandledPromiseRejection 导致进程崩溃
        try {
            getJson(searchParams, (json) => {
                clearTimeout(timeoutId); 
                
                if (json.error) {
                    resolve({ success: false, error: `SerpApi Error: ${json.error}` });
                } else {
                    let formattedResult = "";
                    if (json.organic_results && json.organic_results.length > 0) {
                        formattedResult = json.organic_results.map(result => {
                            return `Title: ${result.title}\nLink: ${result.link}\nSnippet: ${result.snippet}\n`;
                        }).join('\n');
                    } else {
                        formattedResult = "No results found.";
                    }
                    resolve({ success: true, data: formattedResult });
                }
            });
        } catch (err) {
            clearTimeout(timeoutId);
            resolve({ success: false, error: `SerpApi Sync Crash Prevented: ${err.message}` });
        }
    });
}

// 完美导出
module.exports = { search };