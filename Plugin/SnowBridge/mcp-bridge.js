#!/usr/bin/env node
// @ts-check

/**
 * SnowBridge MCP Bridge — standalone stdio MCP server
 *
 * Bridges Snow CLI (or any MCP client) to VCPToolBox plugins via the
 * standard MCP protocol (JSON-RPC 2.0 over newline-delimited stdio).
 *
 * ── Snow CLI configuration ──────────────────────────────────────────────
 * In ~/.snow/settings.json, add to mcpServers:
 *
 *   "vcp-tools": {
 *     "type": "stdio",
 *     "command": "node",
 *     "args": ["D:/VCPToolBox-Official/Plugin/SnowBridge/mcp-bridge.js"],
 *     "enabled": true
 *   }
 *
 * ── Environment variables ───────────────────────────────────────────────
 *   VCP_BASE_DIR   — (optional) root of the VCPToolBox installation.
 *                    Defaults to two directories up from this file.
 *   MCP_BRIDGE_DEBUG — (optional) "true" to enable verbose stderr logging.
 * ────────────────────────────────────────────────────────────────────────
 */

"use strict";

const readline = require("readline");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// CRITICAL: Redirect console.log to stderr so PluginManager output does not
// corrupt the JSON-RPC stdout channel.
// ---------------------------------------------------------------------------
const originalConsoleLog = console.log;
console.log = (...args) => {
  process.stderr.write(
    args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n"
  );
};
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  process.stderr.write(
    args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n"
  );
};

// ---------------------------------------------------------------------------
// Resolve project base directory
// ---------------------------------------------------------------------------
const BRIDGE_DIR = __dirname; // Plugin/SnowBridge/
const DEFAULT_BASE_DIR = path.resolve(BRIDGE_DIR, "..", ".."); // VCPToolBox root

const BASE_DIR = process.env.VCP_BASE_DIR
  ? path.resolve(process.env.VCP_BASE_DIR)
  : DEFAULT_BASE_DIR;

const DEBUG = (process.env.MCP_BRIDGE_DEBUG || "").toLowerCase() === "true";

// ---------------------------------------------------------------------------
// Logging helper — writes to stderr only (never to stdout)
// ---------------------------------------------------------------------------
function log(...args) {
  if (DEBUG) {
    process.stderr.write("[MCP-Bridge] " + args.join(" ") + "\n");
  }
}

function logError(...args) {
  process.stderr.write("[MCP-Bridge ERROR] " + args.join(" ") + "\n");
}

// ---------------------------------------------------------------------------
// Config loading (config.env in the same directory)
// ---------------------------------------------------------------------------
function loadConfig() {
  const configPath = path.join(BRIDGE_DIR, "config.env");
  const config = {};

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      // Skip comments and empty lines
      if (!line || line.startsWith("#")) continue;
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;
      const key = line.substring(0, eqIndex).trim();
      let value = line.substring(eqIndex + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      config[key] = value;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      logError("Failed to read config.env:", err.message);
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// CSV splitting (reuses the same logic as SnowBridge)
// ---------------------------------------------------------------------------
function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// PluginManager loader
// ---------------------------------------------------------------------------
let pluginManager = null;

async function loadPluginManager() {
  try {
    const dotenv = require("dotenv");
    // dotenv is used by Plugin.js; ensure it's available
    void dotenv;
  } catch (_e) {
    logError(
      "dotenv module not found — plugins with config.env may not load correctly"
    );
  }

  const pluginPath = path.join(BASE_DIR, "Plugin.js");
  log("Loading PluginManager from:", pluginPath);

  pluginManager = require(pluginPath);

  // If the module exports the PluginManager class but not a singleton,
  // we need to handle that. The actual file exports `module.exports = pluginManager`
  // which is already a constructed instance.
  if (!pluginManager || typeof pluginManager.loadPlugins !== "function") {
    throw new Error("Plugin.js did not export a valid PluginManager instance");
  }

  // Load all plugins
  log("Loading plugins...");
  await pluginManager.loadPlugins();
  log(`Loaded ${pluginManager.plugins.size} plugins`);
}

// ---------------------------------------------------------------------------
// Tool filtering (mirrors SnowBridge logic)
// ---------------------------------------------------------------------------
function getExcludedTools(config) {
  return new Set(splitCsv(config.Excluded_Tools));
}

function getAllowedTools(config) {
  return new Set(splitCsv(config.Allowed_Tools));
}

function getExcludedDisplayKeywords(config) {
  return splitCsv(config.Excluded_Display_Keywords).map((keyword) =>
    keyword.replace(/^["']|["']]$/g, "")
  );
}

function isToolAllowed(pluginName, config) {
  const allowed = getAllowedTools(config);
  if (allowed.size === 0) return true;
  return allowed.has(pluginName);
}

// ---------------------------------------------------------------------------
// Build MCP tool list from VCP plugins
// ---------------------------------------------------------------------------
function buildMCPTools(config) {
  if (!pluginManager) return [];

  const excludedTools = getExcludedTools(config);
  const excludedKeywords = getExcludedDisplayKeywords(config);
  const tools = [];

  for (const [pluginName, plugin] of pluginManager.plugins.entries()) {
    // Skip excluded tools
    if (excludedTools.has(pluginName)) continue;

    // Skip if not in allowed list
    if (!isToolAllowed(pluginName, config)) continue;

    // Skip distributed plugins — they need WebSocketServer which we don't have
    if (plugin.isDistributed) continue;

    // Skip by display name keyword
    if (
      plugin.displayName &&
      excludedKeywords.some((keyword) => plugin.displayName.includes(keyword))
    ) {
      continue;
    }

    // Must have invocationCommands
    const commands = plugin.capabilities?.invocationCommands;
    if (!Array.isArray(commands) || commands.length === 0) continue;

    for (const cmd of commands) {
      const commandName = cmd.commandIdentifier || cmd.command || null;
      if (!commandName) continue;

      const toolName = `${pluginName}__${commandName}`;
      const description =
        cmd.description ||
        `${plugin.displayName || pluginName} — ${commandName}`;

      // Build inputSchema from the command parameters
      const inputSchema = buildInputSchema(cmd, pluginName);

      tools.push({
        name: toolName,
        description: cleanDescription(description),
        inputSchema,
      });
    }
  }

  return tools;
}

/**
 * Clean up description text — remove VCP-specific formatting artifacts.
 */
function cleanDescription(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Build a JSON-Schema inputSchema for a VCP invocation command.
 *
 * The tool name already encodes the command (pluginName__commandIdentifier),
 * so we auto-inject `command` as a constant and expose any other parameters
 * described in the command.
 */
function buildInputSchema(cmd, pluginName) {
  const properties = {};
  const required = [];

  // The command is auto-filled by the bridge, but we include it in the
  // schema so the MCP client can see it. Mark as constant.
  properties.command = {
    type: "string",
    const: cmd.command || "",
    description: `Auto-filled command for ${pluginName}.`,
  };

  // Parse parameters from the command definition if available
  const params = cmd.parameters;
  if (Array.isArray(params)) {
    for (const param of params) {
      if (!param || !param.name) continue;
      const schema = {
        type: param.type || "string",
        description: param.description || "",
      };
      if (param.required) {
        required.push(param.name);
      }
      properties[param.name] = schema;
    }
  }

  // If no formal parameters array, try to extract from description
  // (many VCP plugins describe params in their description text rather
  // than in a structured parameters array)
  if (!Array.isArray(params) || params.length === 0) {
    extractParamsFromDescription(cmd.description || "", properties, required);
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Best-effort parameter extraction from description text.
 * Looks for patterns like "- paramName (type): description"
 * or "paramName (required): description".
 */
function extractParamsFromDescription(description, properties, required) {
  // Match patterns like:
  //   - provider / source (字符串, 必需): ...
  //   - symbol (string): ...
  //   - params (JSON字符串, 可选): ...
  const paramRegex =
    /^[\s]*[-*•]\s+(\w[\w/]*)\s*(?:\/\s*\w[\w/]*)?\s*\([^)]*\)\s*[:：]/gm;
  let match;
  while ((match = paramRegex.exec(description)) !== null) {
    const paramName = match[1];
    if (paramName === "command" || properties[paramName]) continue;

    const lineText = match[0];
    const isRequired = /必需|required/i.test(lineText);

    properties[paramName] = {
      type: "string",
      description: `Parameter for this command.`,
    };
    if (isRequired) {
      required.push(paramName);
    }
  }

  // Also try to extract from the "调用格式" examples by looking for
  // key:「始」value「末」 patterns
  // Only match identifiers that start with a letter and are at least 2 chars
  const exampleParamRegex = /([a-zA-Z_]\w{1,30})[:：「始」]/g;
  const exampleBlock = description;
  let exMatch;
  const seen = new Set(Object.keys(properties));
  while ((exMatch = exampleParamRegex.exec(exampleBlock)) !== null) {
    const pName = exMatch[1];
    if (
      ["tool_name", "command", "TOOL_REQUEST", "END_TOOL_REQUEST"].includes(
        pName
      )
    )
      continue;
    if (seen.has(pName)) continue;
    seen.add(pName);
    // Don't add to required — these are from examples
    properties[pName] = {
      type: "string",
      description: `Parameter (extracted from command documentation).`,
    };
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC 2.0 message handling
// ---------------------------------------------------------------------------
let config = {};
let toolCache = null;
let initialized = false;
let nextId = 1;

function makeResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function makeError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return JSON.stringify({ jsonrpc: "2.0", id, error: err });
}

/**
 * Parse a tool name like "DigitalOracle__FetchMarketData" into plugin and command parts.
 */
function parseToolName(mcpToolName) {
  const sepIndex = mcpToolName.indexOf("__");
  if (sepIndex === -1) {
    return { pluginName: mcpToolName, commandName: null };
  }
  return {
    pluginName: mcpToolName.substring(0, sepIndex),
    commandName: mcpToolName.substring(sepIndex + 2),
  };
}

/**
 * Handle a single JSON-RPC request and return the response string.
 */
async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — we don't need to respond
  if (id === undefined && method) {
    if (method === "notifications/initialized") {
      log("Client initialized notification received");
      initialized = true;
    } else if (method === "notifications/cancelled") {
      log("Cancellation notification received:", JSON.stringify(params));
    }
    return null; // No response for notifications
  }

  try {
    switch (method) {
      case "initialize":
        return handleInitialize(id, params);
      case "ping":
        return makeResponse(id, {});
      case "tools/list":
        return handleToolsList(id);
      case "tools/call":
        return await handleToolsCall(id, params);
      default:
        return makeError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    logError("Unhandled error in handleMessage:", err);
    return makeError(id, -32603, "Internal error", err.message);
  }
}

function handleInitialize(id, params) {
  log("Initialize request from client:", JSON.stringify(params?.clientInfo));
  initialized = true;

  return makeResponse(id, {
    protocolVersion: "2025-03-26",
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: {
      name: "SnowBridge-MCP",
      version: "2.1.0",
    },
  });
}

function handleToolsList(id) {
  if (!toolCache) {
    toolCache = buildMCPTools(config);
  }
  log(`Returning ${toolCache.length} tools`);
  return makeResponse(id, { tools: toolCache });
}

async function handleToolsCall(id, params) {
  const toolName = params?.name;
  const arguments_ = params?.arguments || {};

  if (!toolName) {
    return makeError(id, -32602, "Missing tool name in tools/call params");
  }

  log(`Tool call: ${toolName}`, JSON.stringify(arguments_).substring(0, 200));

  const { pluginName, commandName } = parseToolName(toolName);

  // Verify the plugin exists
  if (!pluginManager || !pluginManager.plugins.has(pluginName)) {
    return makeResponse(id, {
      content: [
        {
          type: "text",
          text: `Error: Plugin "${pluginName}" not found. Available plugins can be listed via tools/list.`,
        },
      ],
      isError: true,
    });
  }

  // Build the args for processToolCall
  // The command field must be set to the original command name
  const toolArgs = { ...arguments_ };
  if (commandName) {
    // Find the original command from the invocationCommands
    const plugin = pluginManager.plugins.get(pluginName);
    const commands = plugin?.capabilities?.invocationCommands || [];
    const matchedCmd = commands.find(
      (c) => c.commandIdentifier === commandName || c.command === commandName
    );
    if (matchedCmd && matchedCmd.command) {
      toolArgs.command = matchedCmd.command;
    }
  }

  try {
    const result = await pluginManager.processToolCall(pluginName, toolArgs);

    let resultText;
    if (result === undefined || result === null) {
      resultText = "Tool executed successfully (no output).";
    } else if (typeof result === "string") {
      resultText = result;
    } else {
      resultText = JSON.stringify(result, null, 2);
    }

    return makeResponse(id, {
      content: [
        {
          type: "text",
          text: resultText,
        },
      ],
    });
  } catch (err) {
    logError(`Tool call error for ${toolName}:`, err.message);

    let errorText;
    try {
      const parsed = JSON.parse(err.message);
      errorText = JSON.stringify(parsed, null, 2);
    } catch (_e) {
      errorText = err.message || "Unknown error during tool execution";
    }

    return makeResponse(id, {
      content: [
        {
          type: "text",
          text: errorText,
        },
      ],
      isError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Main — start the stdio MCP server
// ---------------------------------------------------------------------------
async function main() {
  log("Starting MCP Bridge...");
  log("Base directory:", BASE_DIR);
  log("Bridge directory:", BRIDGE_DIR);

  // Load configuration
  config = loadConfig();
  log("Config loaded:", Object.keys(config).join(", "));

  // Load PluginManager
  await loadPluginManager();

  // Pre-build the tool cache
  toolCache = buildMCPTools(config);
  log(`Built tool cache with ${toolCache.length} tools`);

  // Set up readline interface for stdin
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (_e) {
      logError("Failed to parse JSON-RPC message:", trimmed.substring(0, 200));
      // Send parse error (no id available)
      const errorResp = makeError(null, -32700, "Parse error");
      process.stdout.write(errorResp + "\n");
      return;
    }

    try {
      const response = await handleMessage(msg);
      if (response !== null) {
        process.stdout.write(response + "\n");
      }
    } catch (err) {
      logError("Error handling message:", err);
      const errorResp = makeError(msg.id || null, -32603, "Internal error");
      process.stdout.write(errorResp + "\n");
    }
  });

  rl.on("close", () => {
    log("stdin closed, shutting down...");
    process.exit(0);
  });

  // Handle graceful shutdown
  const shutdown = (signal) => {
    log(`Received ${signal}, shutting down gracefully...`);
    rl.close();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log("MCP Bridge ready — waiting for JSON-RPC messages on stdin");
}

// Run main
main().catch((err) => {
  logError("Fatal error during startup:", err);
  process.exit(1);
});
