#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");

const DEFAULT_ENDPOINT = "https://api.anysearch.com/mcp";
const TIMEOUT_DEFAULT_MS = 30000;
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 120000;
const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 10;
const BATCH_MAX = 5;
const DOMAINS_MAX = 5;
const RETRIES_DEFAULT = 5;

// Official AnySearch domains. Flow: pick the matching domain, call get_sub_domains(domain)
// to learn its sub_domains + required params, then run a vertical `search`.
const DOMAINS = [
  "general", "resource", "social_media", "finance", "academic", "legal",
  "health", "business", "security", "ip", "code", "energy",
  "environment", "agriculture", "travel", "film", "gaming",
];
const DOMAIN_SET = new Set(DOMAINS);

// 请求命令 -> JSON-RPC 工具名（仅大小写/连字符归一，不做旧名兼容）。
const COMMANDS = new Set(["search", "get_sub_domains", "batch_search", "extract"]);

process.stdin.setEncoding("utf8");
if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding("utf8");

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

// VCP convention: surface errors through the JSON payload on stdout and exit 0
// (the host reads stdout; a non-zero exit would be treated as a crash).
function fail(message) {
  emit({ status: "error", error: `AnySearch Error: ${message}` });
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input.replace(/^﻿/, "")));
  });
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) fail("stdin 未收到输入。");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    fail("stdin 不是合法的 JSON。");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("输入必须是 JSON 对象。");
  }
  return payload;
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeCommand(payload) {
  const raw = firstString(payload, ["command", "action", "tool", "mode"]);
  if (raw) {
    const command = raw.toLowerCase().replace(/-/g, "_").trim();
    if (!COMMANDS.has(command)) {
      fail("无效命令。可用命令：search、get_sub_domains、batch_search、extract。");
    }
    return command;
  }
  // command 省略时按参数推断：有 queries 即批量，有 url（且无 query）即提取，否则搜索。
  if (payload.queries !== undefined || payload.query_items !== undefined) return "batch_search";
  const hasQuery = !!firstString(payload, ["query", "q", "text", "Query"]);
  if (!hasQuery && firstString(payload, ["url", "URL", "link"])) return "extract";
  return "search";
}

function parseMaxResults(source) {
  const value = source.max_results ?? source.maxResults;
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) fail("max_results 必须是整数。");
  return Math.max(MAX_RESULTS_MIN, Math.min(MAX_RESULTS_MAX, parsed));
}

// 子领域参数：首选纯文本 k=v,k2=v2（空值写 k=）；也接受对象 / JSON 对象字符串。
function parseSubDomainParams(source) {
  const value = source.params ?? source.sub_domain_params ?? source.subDomainParams ?? source.sdp;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch (_) { /* fall through to the error below */ }
    } else if (trimmed.includes("=")) {
      const result = {};
      for (const pair of trimmed.split(",")) {
        const item = pair.trim();
        if (!item) continue;
        const eq = item.indexOf("=");
        if (eq <= 0) fail(`sub_domain_params 文本格式应为 k=v,k2=v2（空值写 k=），收到："${item}"。`);
        result[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
      }
      return result;
    }
  }
  fail("sub_domain_params 应为 k=v,k2=v2 文本（空值写 k=），或 JSON 对象。");
}

function parseDomainList(value) {
  if (value === undefined || value === null || value === "") return [];
  let list = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed);
      list = Array.isArray(parsed) ? parsed : trimmed.split(",");
    } catch (_) {
      list = trimmed.split(",");
    }
  }
  if (!Array.isArray(list)) list = [list];
  return list.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function assertDomain(domain) {
  if (!DOMAIN_SET.has(domain)) {
    fail(`无效领域 "${domain}"。可用领域：${DOMAINS.join(", ")}。`);
  }
  return domain;
}

// search 与 batch_search 查询项共用的选项解析。
// domain 可省略：自动取 sub_domain 的「域.」前缀；显式给出且与前缀矛盾时报错。
function buildSearchOptions(source) {
  const options = {};
  const subDomain = firstString(source, ["sub_domain", "subDomain", "subdomain"]);
  let domain = firstString(source, ["domain", "Domain"]).toLowerCase();
  if (subDomain) {
    const prefix = subDomain.split(".")[0].toLowerCase();
    if (domain && domain !== prefix) {
      fail(`domain "${domain}" 与 sub_domain 前缀 "${prefix}" 不一致；domain 可直接省略。`);
    }
    domain = prefix;
  }
  if (domain) options.domain = assertDomain(domain);
  if (subDomain) options.sub_domain = subDomain;

  const subDomainParams = parseSubDomainParams(source);
  if (subDomainParams) options.sub_domain_params = subDomainParams;

  const maxResults = parseMaxResults(source);
  if (maxResults !== undefined) options.max_results = maxResults;

  return options;
}

function buildSearchArguments(payload) {
  const query = firstString(payload, ["query", "q", "text", "Query"]);
  if (!query) fail("search 缺少必填参数 query。");
  return { query, ...buildSearchOptions(payload) };
}

function buildGetSubDomainsArguments(payload) {
  const domains = parseDomainList(payload.domains);
  if (domains.length > 0) {
    if (domains.length > DOMAINS_MAX) fail(`domains 最多 ${DOMAINS_MAX} 个领域。`);
    domains.forEach(assertDomain);
    return { domains };
  }
  const domain = firstString(payload, ["domain", "Domain"]).toLowerCase();
  if (!domain) fail("get_sub_domains 需要 domain 或 domains 参数。");
  return { domain: assertDomain(domain) };
}

function buildBatchItem(item, shared) {
  const source = typeof item === "string" ? { query: item } : item;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("batch_search 的查询项必须是字符串或对象。");
  }
  const query = firstString(source, ["query", "q", "text", "Query"]);
  if (!query) fail("batch_search 的每个查询项都需要 query。");
  // Top-level (shared) options apply to every item; per-item fields override them.
  return { ...shared, query, ...buildSearchOptions(source) };
}

function buildBatchSearchArguments(payload) {
  const raw = payload.queries ?? payload.query_items;
  if (raw === undefined || raw === null || raw === "") {
    fail("batch_search 缺少必填参数 queries。");
  }
  let items = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try {
      items = JSON.parse(trimmed);
    } catch (_) {
      items = trimmed.split("|").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(items)) items = [items];
  if (items.length < 1 || items.length > BATCH_MAX) {
    fail(`batch_search 需要 1-${BATCH_MAX} 个查询。`);
  }
  const shared = buildSearchOptions(payload);
  return { queries: items.map((item) => buildBatchItem(item, shared)) };
}

function buildExtractArguments(payload) {
  const url = firstString(payload, ["url", "URL", "link"]);
  if (!url) fail("extract 缺少必填参数 url。");
  if (!/^https?:\/\//i.test(url)) fail("url 必须以 http:// 或 https:// 开头。");
  return { url };
}

const ARGUMENT_BUILDERS = {
  search: buildSearchArguments,
  get_sub_domains: buildGetSubDomainsArguments,
  batch_search: buildBatchSearchArguments,
  extract: buildExtractArguments,
};

function pickApiKey() {
  const keys = (process.env.ANYSEARCH_API_KEY || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0) return "";
  return keys[Math.floor(Math.random() * keys.length)];
}

function getTimeoutMs() {
  const parsed = Number.parseInt(process.env.ANYSEARCH_TIMEOUT_MS || "", 10);
  if (Number.isNaN(parsed)) return TIMEOUT_DEFAULT_MS;
  return Math.max(TIMEOUT_MIN_MS, Math.min(TIMEOUT_MAX_MS, parsed));
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" ||
    hostname === "::1" || hostname === "[::1]";
}

// Production endpoints must be HTTPS so the Bearer key is never sent in cleartext.
// Plain HTTP is allowed only for loopback (local mock / proxy), where it never
// touches the network.
function resolveTransport(url) {
  if (url.protocol === "https:") return https;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return http;
  fail("ANYSEARCH_ENDPOINT 必须是 https:// 地址（http:// 仅允许 127.0.0.1）。");
}

// ═══════════════════════════════════════════════════════════════
// 代理池支持（HTTP CONNECT + SOCKS5 隧道）+ 轮换重试机制
// ═══════════════════════════════════════════════════════════════

/**
 * 解析单个代理 URL。
 * 支持 http://host:port (HTTP CONNECT) 和 socks5://host:port (SOCKS5)。
 * 无协议前缀时默认 http。
 * @returns {{type:"http"|"socks5",host:string,port:number}}
 */
function parseProxyUrl(str) {
  let url;
  try {
    if (!/^[a-z]+:\/\//i.test(str)) str = "http://" + str;
    url = new URL(str);
  } catch (_) {
    fail(`ANYSEARCH_PROXY 中 "${str}" 不是合法 URL。`);
  }
  const type = url.protocol === "socks5:" ? "socks5" : "http";
  const host = url.hostname;
  if (!host) fail(`ANYSEARCH_PROXY 中 "${str}" 缺少 hostname。`);
  const port = parseInt(url.port, 10) || (type === "socks5" ? 1080 : 80);
  return { type, host, port };
}

/**
 * 解析 ANYSEARCH_PROXY 环境变量为代理池。
 * 支持逗号分隔多个代理地址，实现故障转移和负载轮换。
 * @returns {Array<{type:string,host:string,port:number}>}
 */
function getProxyPool() {
  const proxyStr = (process.env.ANYSEARCH_PROXY || "").trim();
  if (!proxyStr) return [];
  return proxyStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseProxyUrl);
}

/**
 * 公共 JSON-RPC 响应解析（直连与代理路径共用）。
 */
function parseJsonRpcResponse(raw, statusCode) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error(`API 返回了非 JSON 响应：${raw.slice(0, 500)}`);
  }
  if (statusCode >= 400) {
    throw new Error(`HTTP ${statusCode}: ${JSON.stringify(data)}`);
  }
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  const result = data.result || {};
  const content = Array.isArray(result.content) ? result.content : [];
  const textItem = content.find((item) => item && item.type === "text");
  return textItem ? textItem.text : JSON.stringify(result, null, 2);
}

/**
 * 构建 JSON-RPC 请求 body + headers（直连与代理共用）。
 */
function buildRequestPayload(toolName, args) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
  const apiKey = pickApiKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { body, headers };
}

/**
 * 解码 HTTP chunked transfer encoding。
 */
function dechunk(body) {
  let result = "";
  let pos = 0;
  while (pos < body.length) {
    const lineEnd = body.indexOf("\r\n", pos);
    if (lineEnd < 0) break;
    const sizeHex = body.slice(pos, lineEnd).trim();
    const size = parseInt(sizeHex, 16);
    if (isNaN(size) || size === 0) break;
    pos = lineEnd + 2;
    result += body.slice(pos, pos + size);
    pos += size + 2;
  }
  return result || body;
}

/**
 * 建立 HTTP CONNECT 隧道。
 * @returns {Promise<{sock:net.Socket}>}
 */
function establishHttpConnect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    sock.setTimeout(15000);
    let buf = "";

    sock.on("connect", () => {
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n\r\n`
      );
    });

    sock.on("data", function onConnectData(d) {
      buf += d.toString("binary");
      if (!buf.includes("\r\n\r\n")) return;
      sock.removeListener("data", onConnectData);

      const firstLine = buf.split("\r\n")[0];
      if (!firstLine.includes("200")) {
        sock.destroy();
        reject(new Error(`HTTP 代理 CONNECT 失败: ${firstLine.trim()}`));
        return;
      }
      // TLS 握手由 tls.connect 从底层 socket 自动读取，无需手动注入残留数据
      resolve({ sock });
    });

    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error("HTTP 代理连接超时。"));
    });
    sock.on("error", (e) => reject(e));
  });
}

// SOCKS5 错误码映射（RFC 1928 §6）
const SOCKS5_ERRORS = {
  1: "一般性失败",
  2: "规则不允许连接",
  3: "网络不可达",
  4: "主机不可达",
  5: "连接被拒绝",
  6: "TTL 过期",
  7: "不支持的 CONNECT 命令",
  8: "不支持的地址类型",
};

/**
 * 建立 SOCKS5 隧道（RFC 1928）。
 * 仅支持无认证模式（0x00），不支持用户名/密码认证。
 * @returns {Promise<{sock:net.Socket}>}
 */
function establishSocks5(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    sock.setTimeout(15000);
    let phase = "negotiate"; // negotiate → connect → done

    sock.on("connect", () => {
      // SOCKS5 版本协商：版本 5，1 种认证方法，无认证 (0x00)
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    sock.on("data", function onData(d) {
      if (phase === "negotiate") {
        if (d.length < 2 || d[0] !== 0x05) {
          sock.destroy();
          reject(new Error("SOCKS5 协商失败：代理返回了无效响应。"));
          return;
        }
        if (d[1] !== 0x00) {
          sock.destroy();
          reject(new Error(`SOCKS5 代理要求认证（方法 0x${d[1].toString(16)}），暂不支持。`));
          return;
        }
        phase = "connect";
        // 发送 CONNECT 请求（域名类型 0x03）
        const hostBuf = Buffer.from(targetHost, "ascii");
        const req = Buffer.alloc(7 + hostBuf.length);
        req[0] = 0x05; // SOCKS 版本
        req[1] = 0x01; // CONNECT 命令
        req[2] = 0x00; // 保留
        req[3] = 0x03; // 地址类型：域名
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(targetPort, 5 + hostBuf.length);
        sock.write(req);
        return;
      }

      if (phase === "connect") {
        if (d.length < 4 || d[0] !== 0x05) {
          sock.destroy();
          reject(new Error("SOCKS5 CONNECT 响应无效。"));
          return;
        }
        if (d[1] !== 0x00) {
          sock.destroy();
          const desc = SOCKS5_ERRORS[d[1]] || `错误码 ${d[1]}`;
          reject(new Error(`SOCKS5 CONNECT 失败: ${desc}。`));
          return;
        }
        phase = "done";
        sock.removeListener("data", onData);
        resolve({ sock });
        return;
      }
    });

    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error("SOCKS5 代理连接超时。"));
    });
    sock.on("error", (e) => reject(e));
  });
}

/**
 * 在已建立的隧道上执行 TLS 握手 + HTTP POST 请求。
 * HTTP CONNECT 和 SOCKS5 共用此函数。
 */
function callViaTunnel(toolName, args, tunnelResult, targetUrl) {
  const { body, headers } = buildRequestPayload(toolName, args);
  const targetHost = targetUrl.hostname;
  const targetPort = targetUrl.port || 443;
  const targetPath = `${targetUrl.pathname}${targetUrl.search}`;
  const timeoutMs = getTimeoutMs();

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const { sock } = tunnelResult;

    const tlsSock = tls.connect(
      { socket: sock, servername: targetHost, rejectUnauthorized: true },
      () => {
        const httpReq =
          `POST ${targetPath} HTTP/1.1\r\n` +
          `Host: ${targetHost}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          (headers.Authorization ? `Authorization: ${headers.Authorization}\r\n` : "") +
          `Connection: close\r\n\r\n` +
          body;
        tlsSock.write(httpReq);
      }
    );

    let resp = "";
    tlsSock.setEncoding("utf8");
    tlsSock.on("data", (chunk) => { resp += chunk; });
    tlsSock.on("end", () => {
      const sep = resp.indexOf("\r\n\r\n");
      if (sep < 0) {
        done(reject, new Error("代理路径返回的 HTTP 响应格式异常。"));
        return;
      }
      const headerBlock = resp.slice(0, sep);
      const statusLine = headerBlock.split("\r\n")[0];
      const statusCode = parseInt(statusLine.split(" ")[1], 10) || 0;
      let respBody = resp.slice(sep + 4);
      if (/transfer-encoding:\s*chunked/i.test(headerBlock)) {
        respBody = dechunk(respBody);
      }
      try { done(resolve, parseJsonRpcResponse(respBody, statusCode)); }
      catch (e) { done(reject, e); }
    });
    tlsSock.on("error", (e) => done(reject, e));
    tlsSock.setTimeout(timeoutMs, () => {
      tlsSock.destroy();
      done(reject, new Error("API 请求超时。"));
    });
  });
}

/**
 * 直连请求（不走代理）。
 */
function callAnySearchDirect(toolName, args) {
  const endpoint = (process.env.ANYSEARCH_ENDPOINT || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    fail("ANYSEARCH_ENDPOINT 不是合法 URL。");
  }
  const transport = resolveTransport(url);
  const { body, headers } = buildRequestPayload(toolName, args);
  const timeoutMs = getTimeoutMs();

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try { resolve(parseJsonRpcResponse(data, res.statusCode || 0)); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("API 请求超时。"));
    });
    req.write(body);
    req.end();
  });
}

/**
 * 通过指定代理发送请求（HTTP CONNECT 或 SOCKS5）。
 */
async function callAnySearchViaProxy(toolName, args, proxy) {
  const endpoint = (process.env.ANYSEARCH_ENDPOINT || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  let targetUrl;
  try {
    targetUrl = new URL(endpoint);
  } catch (_) {
    fail("ANYSEARCH_ENDPOINT 不是合法 URL。");
  }
  if (targetUrl.protocol !== "https:") {
    fail("使用代理时 ANYSEARCH_ENDPOINT 必须是 https:// 地址。");
  }

  const targetHost = targetUrl.hostname;
  const targetPort = targetUrl.port || 443;

  // 根据代理类型建立隧道
  const tunnelResult = proxy.type === "socks5"
    ? await establishSocks5(proxy, targetHost, targetPort)
    : await establishHttpConnect(proxy, targetHost, targetPort);

  return callViaTunnel(toolName, args, tunnelResult, targetUrl);
}

/**
 * Dispatcher：根据代理配置 + 当前尝试次数选择请求路径。
 * 每次重试轮换到代理池中的下一个代理。
 */
function callAnySearch(toolName, args, proxyPool, attempt) {
  if (!proxyPool) proxyPool = getProxyPool();

  // loopback endpoint 强制直连
  const endpoint = (process.env.ANYSEARCH_ENDPOINT || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  try {
    const url = new URL(endpoint);
    if (url.protocol === "http:" && isLoopback(url.hostname)) {
      return callAnySearchDirect(toolName, args);
    }
  } catch (_) { /* endpoint 格式错误由 Direct 路径报 */ }

  if (proxyPool.length === 0) return callAnySearchDirect(toolName, args);

  // 轮换代理：attempt 从 1 开始，按代理池长度取模
  const proxy = proxyPool[(attempt - 1) % proxyPool.length];
  return callAnySearchViaProxy(toolName, args, proxy);
}

/**
 * 重试包装：仅对网络层错误重试（超时、连接重置、TLS 失败等）。
 * 业务错误（HTTP 4xx、API error）不重试。
 * 每次重试自动轮换到代理池中的下一个代理。
 */
function callAnySearchWithRetry(toolName, args) {
  const maxRetries = parseInt(process.env.ANYSEARCH_MAX_RETRIES || "", 10) || RETRIES_DEFAULT;
  const proxyPool = getProxyPool();

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      callAnySearch(toolName, args, proxyPool, attempt).then(resolve).catch((error) => {
        const msg = error.message || String(error);
        const isNetworkError = /超时|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|代理.*失败|代理.*超时|TLS|disconnected|SOCKS5|CONNECT 失败|响应格式异常/i.test(msg);
        if (!isNetworkError || attempt >= maxRetries) {
          reject(error);
          return;
        }
        const nextProxy = proxyPool.length > 0
          ? proxyPool[attempt % proxyPool.length]
          : null;
        if (nextProxy) {
          process.stderr.write(`[AnySearch] 第 ${attempt}/${maxRetries} 次尝试失败（${msg.slice(0, 80)}），切换到代理 ${nextProxy.type}://${nextProxy.host}:${nextProxy.port}\n`);
        }
        tryOnce();
      });
    };
    tryOnce();
  });
}

async function main() {
  try {
    const payload = parsePayload(await readStdin());
    const command = normalizeCommand(payload);
    const args = ARGUMENT_BUILDERS[command](payload);
    const content = await callAnySearchWithRetry(command, args);
    const text = typeof content === "string" && content.trim()
      ? content.trim()
      : "AnySearch API 未返回可读文本内容。";
    // 富内容形态：server 的 _formatResult 会直接取 text，AI 收到干净 Markdown，
    // 不会被包进 original_plugin_output 的 JSON 转义串。
    emit({ status: "success", result: { content: [{ type: "text", text }] } });
  } catch (error) {
    fail(error.message || String(error));
  }
}

main();
