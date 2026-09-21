/*
 * Real-mode (MinerU + real LLM) driver for PaperReader.
 * Processes a single PDF end-to-end: ingest -> read -> report artifact paths.
 *
 * Usage: node scripts/run_real_read.js "<absolute-pdf-path>" [document_id]
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const pluginRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.join(pluginRoot, "workspace-rs");

const pdfPath = process.argv[2];
const documentId = process.argv[3] || `real-${Date.now()}`;
const mode = process.argv[4] || "auto";

if (!pdfPath) {
  console.error('Usage: node scripts/run_real_read.js "<absolute-pdf-path>" [document_id] [mode]');
  process.exit(1);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const env = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// Real mode: plugin config first, then root API creds layered on top.
const env = {
  ...loadDotEnv(path.join(pluginRoot, "config.env")),
  ...loadDotEnv(path.join(repoRoot, "config.env")),
  PAPERREADER_WORKSPACE_ROOT: workspaceRoot,
};
delete env.PAPERREADER_FORCE_DETERMINISTIC;
delete env.PaperReaderRecursiveCritic;

function makeEnvelope(command, payload) {
  return {
    protocol_version: "1.0",
    command,
    request_id: `real-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    client: { name: "vcp-real-run", version: "0.2.0", capabilities: ["accepted-response", "workspace-artifacts", "streaming-ready"] },
    workspace: { root: workspaceRoot },
    execution: { mode: "sync", timeout_ms: 3600000, priority: "normal", feature_flags: [] },
    payload,
  };
}

function execViaDirect(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(pluginRoot, "bin", "paperreader-cli.exe"), [], {
      cwd: pluginRoot,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("direct invoke timed out after 90 min"));
    }, 90 * 60 * 1000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch (e) {
        return reject(new Error(`non-JSON stdout. exit=${code}, stderr=${stderr.slice(0, 500)}, stdout=${trimmed.slice(0, 300)}`));
      }
      if (!parsed || parsed.status !== "success") {
        const err = (parsed && parsed.error) || stderr.trim() || `exit=${code}`;
        return reject(new Error(`invoke failed: ${err}`));
      }
      resolve(parsed.result);
    });
    child.stdin.write(`${JSON.stringify(input)}\n`);
    child.stdin.end();
  });
}

function log(step, obj) {
  console.log(`\n===== ${step} =====`);
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

async function main() {
  const t0 = Date.now();
  log("env", {
    model: env.PaperReaderModel,
    mineru_model: env.MINERU_MODEL_VERSION,
    api_url_set: Boolean(env.API_URL),
    api_key_set: Boolean(env.API_Key || env.API_KEY),
    deterministic_removed: !("PAPERREADER_FORCE_DETERMINISTIC" in env),
    workspace: workspaceRoot,
    document_id: documentId,
  });

  // Runtime capability check: must NOT be deterministic-llm-fallback in real mode.
  const runtime = await execViaDirect(makeEnvelope("describe_runtime", {}));
  const caps = runtime?.data?.capabilities || [];
  log("describe_runtime", { status: runtime.status, capabilities: caps });
  if (caps.includes("deterministic-llm-fallback") || caps.includes("pdf-parse-fallback")) {
    throw new Error(`Real mode not active. capabilities=${caps.join(",")}`);
  }

  // Step 1: ingest (MinerU real parse) — idempotent: skip if artifacts already exist
  const normalizedPath = path.join(workspaceRoot, "documents", documentId, "normalized_document.json");
  if (fs.existsSync(normalizedPath)) {
    log("ingest_source", {
      status: "skipped (already ingested)",
      document_id: documentId,
      reused_artifact: normalizedPath,
    });
  } else {
    const ingest = await execViaDirect(makeEnvelope("ingest_source", {
      source_path: pdfPath,
      source_type: "pdf",
      document_id: documentId,
      document_name: path.basename(pdfPath, path.extname(pdfPath)),
    }));
    log("ingest_source", {
      status: ingest.status,
      document_id: ingest.data?.document_id,
      segment_count: ingest.data?.segment_count,
      artifact_refs: ingest.data?.artifact_refs,
      duration_s: ((Date.now() - t0) / 1000).toFixed(1),
    });
  }

  // Step 2: read (real LLM)
  const read = await execViaDirect(makeEnvelope("read_document", {
    document_id: documentId,
    mode: mode,
    goal: "完整梳理这份运维集成文档：1) 文档整体结构与章节脉络；2) 涉及的系统/组件与集成关系；3) 关键运维流程、操作步骤与注意事项；4) 重要接口、配置、参数等技术细节；5) 遗留问题、风险点与后续计划。输出带证据引用的结构化总结。",
  }));
  log("read_document", {
    status: read.status,
    reading_state: read.data?.reading_state_ref,
    global_map: read.data?.global_map_ref,
    final_report: read.data?.final_report_ref,
    refs: read.data?.artifact_refs,
    duration_s: ((Date.now() - t0) / 1000).toFixed(1),
  });

  // Step 3: locate report artifacts on disk
  const readingDir = path.join(workspaceRoot, "documents", documentId, "reading");
  const candidates = ["final_report.latest.md", "global_map.latest.md", "audit_report.json"];
  const found = {};
  for (const name of candidates) {
    const p = path.join(readingDir, name);
    if (fs.existsSync(p)) found[name] = { path: p, size: fs.statSync(p).size };
  }
  log("artifacts_on_disk", found);
  log("summary", { ok: true, document_id: documentId, total_duration_s: ((Date.now() - t0) / 1000).toFixed(1) });
}

main().catch((e) => {
  console.error(`\n[real-run] FAILED: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exit(1);
});
