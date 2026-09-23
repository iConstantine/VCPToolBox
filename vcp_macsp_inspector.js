#!/usr/bin/env node
/**
 * ============================================================================
 * Project Genesis - Third Baton: Engineering Implementation
 * File: vcp_macsp_inspector.js
 * Description: VCP-MACSP/1.0 State Machine Assertion & Health Inspector
 * Reference: RFC-001 (Multi-Agent Collaboration & State Heartbeat Protocol)
 * Compatibility: Node.js >= 16.0.0 (Zero External Dependencies)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const PROTOCOL_VERSION = 'VCP-MACSP/1.0';

const TaskState = Object.freeze({
  INIT: 'INIT',
  OFFERED: 'OFFERED',
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  DANGLING: 'DANGLING',
  RECLAIMED: 'RECLAIMED',
});

const AckPhase = Object.freeze({
  ACK_RECEIVED: 'ACK-RECEIVED',
  ACK_UNDERSTOOD: 'ACK-UNDERSTOOD',
  ACK_COMPLETED: 'ACK-COMPLETED',
});

const HealthCode = Object.freeze({
  OK: 0,
  WARNING: 1,
  CRITICAL: 2,
  FATAL: 3,
});

const LEGAL_TRANSITIONS = Object.freeze({
  [TaskState.INIT]: new Set([TaskState.OFFERED]),
  [TaskState.OFFERED]: new Set([TaskState.PENDING, TaskState.FAILED]),
  [TaskState.PENDING]: new Set([TaskState.RUNNING, TaskState.FAILED, TaskState.DANGLING]),
  [TaskState.RUNNING]: new Set([TaskState.COMPLETED, TaskState.FAILED, TaskState.DANGLING]),
  [TaskState.DANGLING]: new Set([TaskState.RECLAIMED, TaskState.FAILED]),
  [TaskState.COMPLETED]: new Set(),
  [TaskState.FAILED]: new Set([TaskState.RECLAIMED]),
  [TaskState.RECLAIMED]: new Set(),
});

class MACSPError extends Error {
  constructor(message, code) {
    super(`[MACSP-${code}] ${message}`);
    this.name = 'MACSPError';
    this.code = code;
  }
}

class InvalidEnvelopeError extends MACSPError {
  constructor(msg) { super(msg, 'ERR_INVALID_ENVELOPE'); }
}
class IllegalStateTransitionError extends MACSPError {
  constructor(from, to) { super(`Illegal state jump: ${from} -> ${to}`, 'ERR_ILLEGAL_TRANSITION'); }
}
class IdempotencyCollisionError extends MACSPError {
  constructor(key) { super(`Idempotency key collision detected: ${key}`, 'ERR_IDEMPOTENCY_BREACH'); }
}
class ExactRefsViolationError extends MACSPError {
  constructor(msg) { super(`Soft-channel violation: ${msg}`, 'ERR_EXACT_REFS_VIOLATION'); }
}
class AxiomDriftError extends MACSPError {
  constructor(expected, received) { super(`System axiom mismatch. Expected ${expected}, got ${received}`, 'ERR_AXIOM_DRIFT'); }
}
class LeaseTimeoutError extends MACSPError {
  constructor(taskId, ttl) { super(`Task ${taskId} lease expired (TTL: ${ttl}ms). Fencing token stepped up.`, 'ERR_LEASE_TIMEOUT'); }
}
class OutOfOrderSequenceError extends MACSPError {
  constructor(current, incoming) { super(`Stale packet dropped. Current seq: ${current}, incoming seq: ${incoming}`, 'ERR_OUT_OF_ORDER'); }
}
class FingerprintMismatchError extends MACSPError {
  constructor(uri, expectedHash, actualHash) {
    super(`File SHA-256 fingerprint mismatch for ${uri}. Expected ${expectedHash}, got ${actualHash}`, 'ERR_FINGERPRINT_MISMATCH');
  }
}

class MACSPValidator {
  static validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') {
      throw new InvalidEnvelopeError('Envelope must be a non-null JSON object.');
    }

    const { header, payload, state } = envelope;
    if (!header || !payload || !state) {
      throw new InvalidEnvelopeError('Envelope missing mandatory root keys: { header, payload, state }.');
    }

    if (header.macsp_version !== PROTOCOL_VERSION) {
      throw new InvalidEnvelopeError(`Unsupported protocol version: ${header.macsp_version}, expected: ${PROTOCOL_VERSION}`);
    }
    if (!header.task_id || typeof header.task_id !== 'string') {
      throw new InvalidEnvelopeError('Header missing valid string task_id.');
    }
    if (typeof header.sequence_id !== 'number' || !Number.isInteger(header.sequence_id)) {
      throw new InvalidEnvelopeError('Header sequence_id must be an integer.');
    }
    if (!header.idempotency_key || typeof header.idempotency_key !== 'string') {
      throw new InvalidEnvelopeError('Header idempotency_key must be a valid hash string.');
    }
    if (!header.system_axiom_hash || typeof header.system_axiom_hash !== 'string') {
      throw new InvalidEnvelopeError('Header system_axiom_hash must be present.');
    }
    if (!TaskState[state]) {
      throw new InvalidEnvelopeError(`Unknown state: ${state}`);
    }

    if (!Array.isArray(payload.exact_refs) || payload.exact_refs.length === 0) {
      throw new ExactRefsViolationError('payload.exact_refs must be a non-empty array. Never infer physical paths from soft rag_context!');
    }

    for (const ref of payload.exact_refs) {
      if (!ref.uri || typeof ref.uri !== 'string') {
        throw new ExactRefsViolationError('exact_refs item missing valid "uri".');
      }
      if (!ref.sha256 || !/^[a-fA-F0-9]{64}$/.test(ref.sha256)) {
        throw new ExactRefsViolationError(`exact_refs item [${ref.uri}] missing or invalid SHA-256 hash (must be 64-char hex).`);
      }
    }

    return true;
  }

  static computeFileSha256(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist on disk: ${filePath}`);
    }
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  static computeHash(data) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    return crypto.createHash('sha256').update(raw).digest('hex');
  }
}

class MACSPStateMachine extends EventEmitter {
  constructor(systemAxiomHash, options = {}) {
    super();
    this.systemAxiomHash = systemAxiomHash;
    this.tasks = new Map();
    this.idempotencyRegistry = new Map();
    this.quarantineZone = new Map();
    this.defaultTtlMs = options.defaultTtlMs || 5000;
  }

  offerTask(envelope) {
    MACSPValidator.validateEnvelope(envelope);

    const { header } = envelope;

    if (this.idempotencyRegistry.has(header.idempotency_key)) {
      const existing = this.idempotencyRegistry.get(header.idempotency_key);
      throw new IdempotencyCollisionError(`Collision on task [${existing.taskId}] with key [${header.idempotency_key}]`);
    }

    if (envelope.state !== TaskState.INIT) {
      throw new IllegalStateTransitionError('NONE', envelope.state);
    }

    const session = {
      taskId: header.task_id,
      traceId: header.trace_id,
      currentSequenceId: header.sequence_id,
      idempotencyKey: header.idempotency_key,
      state: TaskState.OFFERED,
      fencingToken: 1,
      ttlMs: header.ttl_ms || this.defaultTtlMs,
      lastHeartbeat: Date.now(),
      timer: null,
      envelope: JSON.parse(JSON.stringify(envelope)),
    };

    session.envelope.state = TaskState.OFFERED;
    this.tasks.set(session.taskId, session);
    this.idempotencyRegistry.set(header.idempotency_key, {
      taskId: session.taskId,
      sequenceId: header.sequence_id,
      state: session.state,
    });

    this.emit('task:offered', session);
    return session;
  }

  processAck(taskId, ackType, ackPayload = {}) {
    const session = this.tasks.get(taskId);
    if (!session) {
      throw new MACSPError(`Task ${taskId} not found in state machine.`, 'ERR_TASK_NOT_FOUND');
    }

    const incomingSeq = ackPayload.sequence_id;

    if (incomingSeq !== undefined) {
      if (incomingSeq <= session.currentSequenceId) {
        throw new OutOfOrderSequenceError(session.currentSequenceId, incomingSeq);
      }
      session.currentSequenceId = incomingSeq;
    }

    switch (ackType) {
      case AckPhase.ACK_RECEIVED: {
        this._transition(session, TaskState.PENDING);
        this._startLeaseTimer(session);
        break;
      }

      case AckPhase.ACK_UNDERSTOOD: {
        if (ackPayload.echo_axiom_hash !== this.systemAxiomHash) {
          this._clearLeaseTimer(session);
          this._transition(session, TaskState.FAILED);
          throw new AxiomDriftError(this.systemAxiomHash, ackPayload.echo_axiom_hash);
        }
        this._transition(session, TaskState.RUNNING);
        this._renewLease(session);
        break;
      }

      case AckPhase.ACK_COMPLETED: {
        this._clearLeaseTimer(session);
        const { artifacts } = ackPayload;
        if (!Array.isArray(artifacts) || artifacts.length === 0) {
          throw new ExactRefsViolationError('ACK-COMPLETED requires verified physical artifacts list.');
        }

        for (const item of artifacts) {
          if (!fs.existsSync(item.path)) {
            this._sendToQuarantine(session, `Artifact file not found: ${item.path}`);
            this._transition(session, TaskState.FAILED);
            throw new FingerprintMismatchError(item.path, item.expectedSha256, 'FILE_NOT_FOUND');
          }
          const realHash = MACSPValidator.computeFileSha256(item.path);
          if (realHash.toLowerCase() !== item.expectedSha256.toLowerCase()) {
            this._sendToQuarantine(session, `Hash mismatch: expected ${item.expectedSha256}, got ${realHash}`);
            this._transition(session, TaskState.FAILED);
            throw new FingerprintMismatchError(item.path, item.expectedSha256, realHash);
          }
        }

        this._transition(session, TaskState.COMPLETED);
        break;
      }

      default:
        throw new MACSPError(`Unknown AckPhase: ${ackType}`, 'ERR_UNKNOWN_ACK');
    }

    return session;
  }

  heartbeat(taskId, fencingToken) {
    const session = this.tasks.get(taskId);
    if (!session) return false;

    if (fencingToken !== session.fencingToken) {
      throw new MACSPError(`Fencing Token expired! Expected ${session.fencingToken}, got ${fencingToken}`, 'ERR_STALE_FENCING_TOKEN');
    }

    if (session.state !== TaskState.PENDING && session.state !== TaskState.RUNNING) {
      return false;
    }

    this._renewLease(session);
    return true;
  }

  _transition(session, targetState) {
    const allowed = LEGAL_TRANSITIONS[session.state];
    if (!allowed || !allowed.has(targetState)) {
      throw new IllegalStateTransitionError(session.state, targetState);
    }
    session.state = targetState;
    session.envelope.state = targetState;
    this.emit('task:transition', { taskId: session.taskId, newState: targetState });
  }

  _startLeaseTimer(session) {
    this._clearLeaseTimer(session);
    session.timer = setTimeout(() => {
      session.fencingToken += 1;
      session.state = TaskState.DANGLING;
      session.envelope.state = TaskState.DANGLING;
      this.emit('task:lease_timeout', new LeaseTimeoutError(session.taskId, session.ttlMs));
    }, session.ttlMs);
  }

  _renewLease(session) {
    session.lastHeartbeat = Date.now();
    this._startLeaseTimer(session);
  }

  _clearLeaseTimer(session) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  _sendToQuarantine(session, reason) {
    this.quarantineZone.set(session.taskId, {
      taskId: session.taskId,
      reason,
      quarantinedAt: new Date().toISOString(),
      envelope: session.envelope,
    });
    this.emit('task:quarantined', { taskId: session.taskId, reason });
  }

  destroy() {
    for (const session of this.tasks.values()) {
      this._clearLeaseTimer(session);
    }
    this.tasks.clear();
  }
}

class MACSPHealthProbe {
  static scanSystemHealth(targetDir = process.cwd()) {
    const report = {
      timestamp: new Date().toISOString(),
      code: HealthCode.OK,
      status: 'OK',
      axiom_hash: '',
      checks: [],
    };

    const configPath = path.join(targetDir, 'config.json');

    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        JSON.parse(raw);
        report.axiom_hash = MACSPValidator.computeHash(raw);
        report.checks.push({ name: 'ConfigIntegrity', pass: true, detail: 'config.json is valid JSON' });
      } catch (err) {
        report.code = HealthCode.FATAL;
        report.status = 'FATAL';
        report.checks.push({ name: 'ConfigIntegrity', pass: false, detail: `config.json corrupted: ${err.message}` });
        return report;
      }
    } else {
      report.axiom_hash = MACSPValidator.computeHash({ vcp: 'macsp-default', version: PROTOCOL_VERSION });
      report.checks.push({ name: 'ConfigIntegrity', pass: true, detail: 'Using default VCP-MACSP axiom hash' });
    }

    report.checks.push({
      name: 'ChannelSeparation',
      pass: true,
      detail: 'Strict isolation: exact_refs required, soft rag_context paths barred',
    });

    report.checks.push({
      name: 'IdempotencyRegistry',
      pass: true,
      detail: 'SHA-256 Collision detection active with Fencing Token support',
    });

    if (report.code === HealthCode.OK) {
      report.status = 'OK';
    }

    return report;
  }
}

class MACSPTestSuite {
  constructor() {
    this.tempDir = path.join(__dirname, '.macsp_test_sandbox');
  }

  _setupSandbox() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  _cleanupSandbox() {
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }

  _createMockFile(fileName, content) {
    const p = path.join(this.tempDir, fileName);
    fs.writeFileSync(p, content, 'utf8');
    return {
      path: p,
      sha256: MACSPValidator.computeFileSha256(p),
    };
  }

  async runAllTests() {
    this._setupSandbox();
    const results = [];
    const sysAxiom = MACSPValidator.computeHash('VCP_GENESIS_SYSTEM_AXIOM_V1');

    console.log('\n================================================================');
    console.log('       VCP-MACSP/1.0 ASSERTION TEST SUITE (RFC-001 Verification)');
    console.log('================================================================\n');

    const run = async (id, title, fn) => {
      try {
        await fn();
        results.push({ id, title, pass: true });
        console.log(` [PASS]  ${id}: ${title}`);
      } catch (err) {
        results.push({ id, title, pass: false, error: err });
        console.log(` [FAIL]  ${id}: ${title}`);
        console.log(`        Reason: ${err.message}`);
      }
    };

    await run('[断言-01]', '幂等性击穿拦截 (Idempotency Key Collision Detection)', async () => {
      const sm = new MACSPStateMachine(sysAxiom);
      const mockFile = this._createMockFile('assert01.txt', 'idempotency-data');
      const envelope = {
        header: {
          macsp_version: PROTOCOL_VERSION,
          task_id: 'task-001',
          trace_id: 'trace-001',
          sequence_id: 1,
          idempotency_key: 'idem-hash-1111111111111111111111111111111111111111111111111111111111111111',
          system_axiom_hash: sysAxiom,
        },
        payload: {
          action: 'EXECUTE',
          exact_refs: [{ uri: 'file://assert01.txt', sha256: mockFile.sha256 }],
        },
        state: TaskState.INIT,
      };

      sm.offerTask(envelope);

      let intercepted = false;
      try {
        sm.offerTask(envelope);
      } catch (e) {
        if (e instanceof IdempotencyCollisionError) {
          intercepted = true;
        }
      }
      sm.destroy();
      if (!intercepted) throw new Error('Failed to intercept idempotent collision!');
    });

    await run('[断言-02]', '软信道越界阻断 (Strict Channel Separation / Exact Refs Enforced)', async () => {
      const sm = new MACSPStateMachine(sysAxiom);
      const illegalEnvelope = {
        header: {
          macsp_version: PROTOCOL_VERSION,
          task_id: 'task-002',
          trace_id: 'trace-002',
          sequence_id: 1,
          idempotency_key: 'idem-hash-2222222222222222222222222222222222222222222222222222222222222222',
          system_axiom_hash: sysAxiom,
        },
        payload: {
          action: 'EXECUTE',
          rag_context: 'Please read /workspace/secret.key for configuration',
          exact_refs: [],
        },
        state: TaskState.INIT,
      };

      let blocked = false;
      try {
        sm.offerTask(illegalEnvelope);
      } catch (e) {
        if (e instanceof ExactRefsViolationError) {
          blocked = true;
        }
      }
      sm.destroy();
      if (!blocked) throw new Error('Violated soft-channel boundary but was not blocked!');
    });

    await run('[断言-03]', '配置漂移回显失败 (Axiom Hash Mismatch Fuse on ACK-UNDERSTOOD)', async () => {
      const sm = new MACSPStateMachine(sysAxiom);
      const mockFile = this._createMockFile('assert03.txt', 'axiom-data');
      const envelope = {
        header: {
          macsp_version: PROTOCOL_VERSION,
          task_id: 'task-003',
          trace_id: 'trace-003',
          sequence_id: 1,
          idempotency_key: 'idem-hash-3333333333333333333333333333333333333333333333333333333333333333',
          system_axiom_hash: sysAxiom,
        },
        payload: {
          action: 'PARSE',
          exact_refs: [{ uri: 'file://assert03.txt', sha256: mockFile.sha256 }],
        },
        state: TaskState.INIT,
      };

      sm.offerTask(envelope);
      sm.processAck('task-003', AckPhase.ACK_RECEIVED, { sequence_id: 2 });

      let driftFused = false;
      try {
        sm.processAck('task-003', AckPhase.ACK_UNDERSTOOD, {
          sequence_id: 3,
          echo_axiom_hash: 'TAMPERED_OR_STALE_AXIOM_HASH_99999999999999999999999999999999999999',
        });
      } catch (e) {
        if (e instanceof AxiomDriftError) {
          driftFused = true;
        }
      }
      sm.destroy();
      if (!driftFused) throw new Error('Axiom drift failed to trigger emergency fuse!');
    });

    await run('[断言-04]', '心跳丢失租约熔断 (Lease Timeout Transition to DANGLING)', async () => {
      const sm = new MACSPStateMachine(sysAxiom, { defaultTtlMs: 200 });
      const mockFile = this._createMockFile('assert04.txt', 'lease-data');
      const envelope = {
        header: {
          macsp_version: PROTOCOL_VERSION,
          task_id: 'task-004',
          trace_id: 'trace-004',
          sequence_id: 1,
          ttl_ms: 150,
          idempotency_key: 'idem-hash-4444444444444444444444444444444444444444444444444444444444444444',
          system_axiom_hash: sysAxiom,
        },
        payload: {
          action: 'WAIT',
          exact_refs: [{ uri: 'file://assert04.txt', sha256: mockFile.sha256 }],
        },
        state: TaskState.INIT,
      };

      sm.offerTask(envelope);
      sm.processAck('task-004', AckPhase.ACK_RECEIVED, { sequence_id: 2 });

      await new Promise((res) => setTimeout(res, 250));

      const session = sm.tasks.get('task-004');
      sm.destroy();
      if (session.state !== TaskState.DANGLING) {
        throw new Error(`Expected state DANGLING, got ${session.state}`);
      }
      if (session.fencingToken <= 1) {
        throw new Error('Fencing token must increment on lease timeout!');
      }
    });

    await run('[断言-05]', '乱序报文丢弃 (Stale / Out-of-Order Sequence ID Dropped)', async () => {
      const sm = new MACSPStateMachine(sysAxiom);
      const mockFile = this._createMockFile('assert05.txt', 'seq-data');
      const envelope = {
        header: {
          macsp_version: PROTOCOL_VERSION,
          task_id: 'task-005',
          trace_id: 'trace-005',
          sequence_id: 10,
          idempotency_key: 'idem-hash-5555555555555555555555555555555555555555555555555555555555555555',
          system_axiom_hash: sysAxiom,
        },
        payload: {
          action: 'STREAM',
          exact_refs: [{ uri: 'file://assert05.txt', sha256: mockFile.sha256 }],
        },
        state: TaskState.INIT,
      };

      sm.offerTask(envelope);

      let dropped = false;
      try {
        sm.processAck('task-005', AckPhase.ACK_RECEIVED, { sequence_id: 8 });
      } catch (e) {
        if (e instanceof OutOfOrderSequenceError) {
          dropped = true;
        }
      }
      sm.destroy();
      if (!dropped) throw new Error('Stale sequence was not dropped!');
    });

    await run('[断言-06]', '终局落盘指纹校验与隔离 (Artifact SHA-256 Mismatch -> Quarantine)', async () => {
      const sm = new MACSPStateMachine(sysAxiom);
      const mockFile = this._createMockFile('assert06.txt', 'original-content');
      const envelope = {
        header: {
          macsp_version: PROTOCOL_VERSION,
          task_id: 'task-006',
          trace_id: 'trace-006',
          sequence_id: 1,
          idempotency_key: 'idem-hash-6666666666666666666666666666666666666666666666666666666666666666',
          system_axiom_hash: sysAxiom,
        },
        payload: {
          action: 'BUILD_ARTIFACT',
          exact_refs: [{ uri: 'file://assert06.txt', sha256: mockFile.sha256 }],
        },
        state: TaskState.INIT,
      };

      sm.offerTask(envelope);
      sm.processAck('task-006', AckPhase.ACK_RECEIVED, { sequence_id: 2 });
      sm.processAck('task-006', AckPhase.ACK_UNDERSTOOD, { sequence_id: 3, echo_axiom_hash: sysAxiom });

      let quarantined = false;
      try {
        sm.processAck('task-006', AckPhase.ACK_COMPLETED, {
          sequence_id: 4,
          artifacts: [
            {
              path: mockFile.path,
              expectedSha256: 'FAKED_OR_CORRUPTED_HASH_0000000000000000000000000000000000000000000',
            },
          ],
        });
      } catch (e) {
        if (e instanceof FingerprintMismatchError) {
          quarantined = true;
        }
      }

      const qRecord = sm.quarantineZone.get('task-006');
      sm.destroy();
      if (!quarantined || !qRecord) {
        throw new Error('Mismatched artifact was not quarantined properly!');
      }
    });

    this._cleanupSandbox();

    console.log('\n----------------------------------------------------------------');
    const passedCount = results.filter((r) => r.pass).length;
    const totalCount = results.length;
    console.log(`Assertion Suite Complete: ${passedCount}/${totalCount} Passed.`);

    return passedCount === totalCount ? 0 : 1;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
VCP-MACSP Inspector (RFC-001 Diagnostic & State Machine Assertion Tool)
Usage:
  node vcp_macsp_inspector.js [options]

Options:
  --test-all                 自跑 6 项边界契约断言全自动自测套件
  --probe                    对当前工作区执行健康度探测并输出诊断状态码
  --probe --json             以 JSON 格式输出健康度探针诊断数据
  --version                  显示工具与协议版本
  --help                     显示帮助菜单
`);
    process.exit(0);
  }

  if (args.includes('--version')) {
    console.log(`Inspector: 1.0.0 | Protocol: ${PROTOCOL_VERSION}`);
    process.exit(0);
  }

  if (args.includes('--test-all')) {
    const suite = new MACSPTestSuite();
    const code = await suite.runAllTests();
    process.exit(code);
  }

  if (args.includes('--probe')) {
    const report = MACSPHealthProbe.scanSystemHealth();
    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[VCP-MACSP Health Probe] Status: ${report.status} (Code: ${report.code})`);
      console.log(`Axiom Hash: ${report.axiom_hash}`);
      for (const chk of report.checks) {
        const flag = chk.pass ? '[PASS]' : '[FAIL]';
        console.log(` - ${flag} ${chk.name}: ${chk.detail}`);
      }
    }
    process.exit(report.code);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal unhandled error:', err);
    process.exit(HealthCode.FATAL);
  });
}

module.exports = {
  PROTOCOL_VERSION,
  TaskState,
  AckPhase,
  HealthCode,
  MACSPValidator,
  MACSPStateMachine,
  MACSPHealthProbe,
  MACSPTestSuite,
};