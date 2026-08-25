"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var import_node_os2 = require("node:os");
var import_node_path4 = require("node:path");
var import_vscode = require("vscode");

// ../../packages/sdk/client/src/api.ts
var import_node_crypto2 = require("node:crypto");
var import_node_path = require("node:path");

// ../../packages/sdk/client/src/client.ts
var import_node_child_process = require("node:child_process");

// ../../packages/sdk/protocol/src/transport.ts
var import_node_crypto = require("node:crypto");
var import_node_string_decoder = require("node:string_decoder");
var JsonRpcResponseError = class extends Error {
  /**
   * @param code - the wire error code, or `undefined` when the peer sent none.
   * @param message - the wire error message.
   * @param data - the optional structured error payload, verbatim.
   */
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "JsonRpcResponseError";
  }
};
var JsonRpcLineTransport = class {
  constructor(input, output) {
    this.input = input;
    this.output = output;
  }
  buffer = "";
  decoder = new import_node_string_decoder.StringDecoder("utf8");
  started = false;
  requestHandler;
  notificationHandler;
  pending = /* @__PURE__ */ new Map();
  /** Attach the input listeners and begin reading frames. Idempotent. */
  start() {
    if (this.started) return;
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("error", this.onInputError);
    this.input.on("end", this.onInputEnd);
  }
  /**
   * Detach listeners and reject pending requests. Safe before {@link start}.
   */
  close() {
    this.input.off("data", this.onData);
    this.input.off("error", this.onInputError);
    this.input.off("end", this.onInputEnd);
    this.failPending(new Error("JSON-RPC transport closed"));
  }
  /**
   * Install the request handler, replacing any prior handler.
   * @param handler - resolves to the response `result`; a rejection becomes a
   * `-32603` error response carrying the message.
   */
  onRequest(handler) {
    this.requestHandler = handler;
  }
  /**
   * Install the notification handler, replacing any prior handler.
   * @param handler - invoked per notification with the method and normalized
   * params object.
   */
  onNotification(handler) {
    this.notificationHandler = handler;
  }
  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @param signal - optional abandonment signal: aborting removes the pending
   * entry (no state is retained for a response that may never come) and
   * rejects with the signal's reason.
   * @returns the result; rejects per {@link JsonRpcTransportPeer.request}.
   */
  request(method, params, signal) {
    const id = `req_${(0, import_node_crypto.randomUUID)().replaceAll("-", "")}`;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve3, reject) => {
      let detach = () => {
      };
      if (signal !== void 0) {
        if (signal.aborted) {
          reject(abortError(signal.reason));
          return;
        }
        const onAbort = () => {
          this.pending.delete(id);
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detach = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }
      this.pending.set(id, {
        resolve: (value) => {
          detach();
          resolve3(value);
        },
        reject: (error) => {
          detach();
          reject(error);
        }
      });
      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(id);
        detach();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  notify(method, params) {
    this.write(params === void 0 ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }
  /**
   * Wait for prior frame write callbacks. The empty barrier emits no bytes.
   * @returns a promise that settles with the output write callback.
   */
  flush() {
    return new Promise((resolve3, reject) => {
      this.output.write("", (error) => {
        if (error) reject(error);
        else resolve3();
      });
    });
  }
  onData = (chunk) => {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drainLines();
  };
  drainLines() {
    for (; ; ) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      void this.handleLine(line);
    }
  }
  onInputError = (error) => {
    this.failPending(error);
  };
  onInputEnd = () => {
    this.buffer += this.decoder.end();
    this.drainLines();
    this.failPending(new Error("JSON-RPC input closed"));
  };
  async handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const frame = message;
    const id = frame.id;
    const method = frame.method;
    if ((typeof id === "string" || typeof id === "number") && typeof method === "string") {
      await this.handleIncomingRequest(id, method, objectParams(frame.params));
      return;
    }
    if (typeof id === "string" || typeof id === "number") {
      this.handleIncomingResponse(id, frame);
      return;
    }
    if (typeof method === "string") {
      this.notificationHandler?.(method, objectParams(frame.params));
    }
  }
  async handleIncomingRequest(id, method, params) {
    const handler = this.requestHandler;
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(method, params);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.writeError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }
  handleIncomingResponse(id, frame) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (frame.error && typeof frame.error === "object") {
      const error = frame.error;
      pending.reject(new JsonRpcResponseError(
        typeof error.code === "number" ? error.code : void 0,
        typeof error.message === "string" ? error.message : "JSON-RPC error",
        error.data
      ));
      return;
    }
    pending.resolve(frame.result);
  }
  writeError(id, code, message) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }
  write(message) {
    this.output.write(`${JSON.stringify(message)}
`);
  }
  failPending(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of pending) waiter.reject(error);
  }
};
function objectParams(params) {
  return params && typeof params === "object" && !Array.isArray(params) ? params : {};
}
function abortError(reason) {
  return reason instanceof Error ? reason : new Error(`JSON-RPC request aborted: ${String(reason)}`);
}

// ../../packages/sdk/client/src/dispose.ts
function exitsWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve3) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve3(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve3(false);
    }, ms).unref();
    child.once("exit", onExit);
  });
}
function forceTerminateWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve3, reject) => {
    let accepted = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const settle = (complete) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onExit = () => {
      settle(resolve3);
    };
    const onError = (error) => {
      settle(() => {
        reject(error);
      });
    };
    child.once("exit", onExit);
    child.once("error", onError);
    const timer = setTimeout(() => {
      const disposition = accepted ? "accepted" : "refused";
      settle(() => {
        reject(new Error(`runtime process did not exit within ${ms}ms after SIGKILL was ${disposition}`));
      });
    }, ms).unref();
    try {
      accepted = child.kill("SIGKILL");
      if (child.exitCode !== null || child.signalCode !== null) settle(resolve3);
    } catch (error) {
      settle(() => {
        reject(new Error("SIGKILL failed", { cause: error }));
      });
    }
  });
}
async function disposeRuntimeProcess(child, graces, platform = process.platform) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  if (await exitsWithin(child, graces.disposeEofGraceMs)) return;
  if (platform !== "win32") {
    child.kill("SIGTERM");
    if (await exitsWithin(child, graces.disposeGraceMs)) return;
  }
  await forceTerminateWithin(child, graces.disposeGraceMs);
}

// ../../packages/sdk/client/src/client.ts
var STDERR_TAIL_LIMIT = 400;
var STREAM_SETTLE_MS = 100;
var TransportClosedError = class extends Error {
  /** @param message - the failure description, including any stderr tail. */
  constructor(message) {
    super(message);
    this.name = "TransportClosedError";
  }
};
var RequestTimeoutError = class extends Error {
  /** @param message - which method timed out. */
  constructor(message) {
    super(message);
    this.name = "RequestTimeoutError";
  }
};
var SdkProtocolError = class extends Error {
  /** @param message - the protocol violation description. */
  constructor(message) {
    super(message);
    this.name = "SdkProtocolError";
  }
};
var NotificationSubscriptionImpl = class {
  constructor(state, unsubscribe) {
    this.state = state;
    this.unsubscribe = unsubscribe;
  }
  /**
   * Await the next matching notification.
   * @returns the notification; after the runtime died, drains what was
   * already delivered and then rejects; after {@link close}, rejects
   * immediately (the queue is dropped).
   */
  next() {
    const queued = this.state.queue.shift();
    if (queued !== void 0) return Promise.resolve(queued);
    if (this.state.failure !== void 0) return Promise.reject(this.state.failure);
    return new Promise((resolve3, reject) => {
      this.state.waiters.push({ resolve: resolve3, reject });
    });
  }
  /**
   * Drain one already-delivered notification without waiting.
   * @returns the next queued notification, or `undefined` when none is queued.
   */
  tryNext() {
    return this.state.queue.shift();
  }
  /** Detach from the client; queued items drop and pending waiters reject. */
  close() {
    this.unsubscribe();
    this.state.queue.length = 0;
    this.fail(new TransportClosedError("notification subscription closed"));
  }
  /**
   * Reject pending and future waits (delivery stops; the first failure wins).
   * Already-queued notifications remain drainable via {@link next}/{@link tryNext}.
   * @param error - the terminal failure delivered to waiters.
   */
  fail(error) {
    this.state.failure ??= error;
    for (const waiter of this.state.waiters.splice(0)) waiter.reject(this.state.failure);
  }
  /**
   * Deliver one notification to a waiter or the queue when the filter
   * matches. A throwing filter fails only THIS subscription (detached, the
   * throw becomes its terminal error) — it never disturbs sibling
   * subscriptions or the transport's read loop, mirroring the Python client.
   * @param notification - the wire notification to deliver.
   */
  push(notification) {
    let matches;
    try {
      matches = this.state.filter === void 0 || this.state.filter(notification);
    } catch (error) {
      this.unsubscribe();
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!matches) return;
    const waiter = this.state.waiters.shift();
    if (waiter !== void 0) waiter.resolve(notification);
    else this.state.queue.push(notification);
  }
  /**
   * Iterate notifications until the subscription or runtime closes (the
   * terminating rejection propagates).
   * @returns an async iterator over {@link next} results.
   */
  async *[Symbol.asyncIterator]() {
    for (; ; ) yield await this.next();
  }
};
var HarnessClient = class {
  /** @param options - launch spec, complete child environment, and timeouts. */
  constructor(options) {
    this.options = options;
  }
  child;
  transport;
  stderrTail = [];
  subscriptions = /* @__PURE__ */ new Map();
  sessionParents = /* @__PURE__ */ new Map();
  subscriptionSerial = 0;
  exitCode;
  spawnError;
  streamsSettled = Promise.resolve();
  closeTask;
  /**
   * Spawn the runtime subprocess and start reading frames. Idempotent while
   * the process is live; rejects reuse after {@link close}.
   */
  start() {
    if (this.closeTask !== void 0) throw new TransportClosedError("DeepSeek Harness runtime client is closed");
    if (this.child !== void 0) return;
    const child = (0, import_node_child_process.spawn)(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.once("error", (error) => {
      this.spawnError = error;
      this.transport?.close();
      this.failSubscriptions(this.closedError("DeepSeek Harness runtime failed to start"));
    });
    child.stdin.on("error", () => {
    });
    let stderrBuffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      const newline = stderrBuffer.lastIndexOf("\n");
      if (newline >= 0) {
        this.appendStderr(stderrBuffer.slice(0, newline).split("\n"));
        stderrBuffer = stderrBuffer.slice(newline + 1);
      }
    });
    let signalStreamsSettled;
    this.streamsSettled = new Promise((resolve3) => {
      signalStreamsSettled = resolve3;
    });
    const settled = { stderr: false, exited: false };
    const maybeSettle = () => {
      if (settled.stderr && settled.exited) signalStreamsSettled();
    };
    child.stderr.once("close", () => {
      if (stderrBuffer.length > 0) this.appendStderr([stderrBuffer]);
      settled.stderr = true;
      maybeSettle();
    });
    child.once("exit", (code) => {
      this.exitCode = code;
      settled.exited = true;
      maybeSettle();
      this.failSubscriptions(this.closedError("DeepSeek Harness runtime exited"));
    });
    child.once("close", () => {
      this.transport?.close();
    });
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    transport.onNotification((method, params) => {
      this.dispatchNotification({ method, params });
    });
    transport.start();
    this.transport = transport;
  }
  /**
   * Perform the process-wide handshake.
   * @param params - workspace cwd plus the provider/model route.
   * @returns the runtime's wire identity.
   */
  async initialize(params) {
    const result = await this.request("initialize", { ...params });
    if (!isRecord(result) || !isRecord(result.serverInfo) || typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string") {
      throw new SdkProtocolError(`initialize returned no server identity: ${JSON.stringify(result)}`);
    }
    return { serverInfo: { name: result.serverInfo.name, version: result.serverInfo.version } };
  }
  /**
   * Queue one prompt and return its durable inbox identity.
   * @param sessionId - target session; an unknown id creates it.
   * @param contentBlocks - the user message, sent verbatim.
   * @returns the queued message id.
   */
  async prompt(sessionId, contentBlocks) {
    const params = { sessionId, contentBlocks };
    const result = await this.request("session/prompt", { ...params });
    if (!isRecord(result) || typeof result.messageId !== "string") {
      throw new SdkProtocolError(`session/prompt returned no message id: ${JSON.stringify(result)}`);
    }
    return result.messageId;
  }
  /**
   * Send one JSON-RPC request and await its result.
   * @param method - the wire method name.
   * @param params - the params object; omitted params send `{}`.
   * @param timeoutMs - per-call override of {@link HarnessClientOptions.requestTimeoutMs}.
   * @returns the raw result; rejects with {@link JsonRpcResponseError} on a
   * protocol error response, {@link RequestTimeoutError} on timeout, and
   * {@link TransportClosedError} when the runtime is gone.
   */
  async request(method, params, timeoutMs) {
    this.start();
    if (this.exitCode !== void 0 || this.spawnError !== void 0) {
      await this.settleStreams();
      throw this.closedError("DeepSeek Harness runtime is not running");
    }
    const transport = this.transport;
    if (transport === void 0) throw new TransportClosedError("DeepSeek Harness runtime is not running");
    const timeout = timeoutMs ?? this.options.requestTimeoutMs;
    try {
      if (timeout === void 0) return await transport.request(method, params ?? {});
      const abandon = new AbortController();
      const timer = setTimeout(() => {
        abandon.abort(new RequestTimeoutError(`${method} timed out after ${timeout}ms waiting for the DeepSeek Harness runtime`));
      }, timeout);
      try {
        return await transport.request(method, params ?? {}, abandon.signal);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof JsonRpcResponseError || error instanceof RequestTimeoutError) throw error;
      await this.settleStreams();
      throw this.closedError(errorMessage(error));
    }
  }
  /**
   * Subscribe to server notifications.
   * @param filter - optional predicate; omitted means every notification.
   * @returns the subscription handle; close it to stop delivery. After
   * {@link close} or runtime death the handle is born failed — there is no
   * producer left, so `next()` rejects instead of waiting forever.
   */
  subscribe(filter) {
    const id = String(this.subscriptionSerial++);
    const state = { queue: [], waiters: [], filter, failure: void 0 };
    const subscription = new NotificationSubscriptionImpl(state, () => {
      this.subscriptions.delete(id);
    });
    if (this.closeTask !== void 0 || this.exitCode !== void 0 || this.spawnError !== void 0) {
      subscription.fail(this.closedError("DeepSeek Harness runtime closed"));
      return subscription;
    }
    this.subscriptions.set(id, subscription);
    return subscription;
  }
  /**
   * Subscribe to one session and the descendants discovered from
   * `subagent.started` lineage edges (the runtime notifies for every session
   * in its context; scoping is client-side, mirroring the Python SDK).
   * @param sessionId - the root session id.
   * @returns the filtered subscription handle.
   */
  subscribeSessionTree(sessionId) {
    return this.subscribe((notification) => {
      const params = notification.params;
      if (notification.method === "subagent.started" || notification.method === "subagent.finished") {
        const parentId = params.parentSessionId;
        if (typeof parentId === "string" && this.isDescendantOf(parentId, sessionId)) return true;
        return params.childSessionId === sessionId;
      }
      const relatedId = params.sessionId;
      return typeof relatedId === "string" && this.isDescendantOf(relatedId, sessionId);
    });
  }
  /**
   * Shut the runtime down and reap it: a best-effort protocol `shutdown`
   * bounded by `shutdownTimeoutMs`, then the shared stdin-EOF → SIGTERM →
   * SIGKILL ladder until the process actually exited. Idempotent.
   * @returns settlement of the complete teardown.
   */
  close() {
    this.closeTask ??= this.performClose();
    return this.closeTask;
  }
  async performClose() {
    const child = this.child;
    if (child === void 0) return;
    try {
      await this.request("shutdown", void 0, this.options.shutdownTimeoutMs ?? 1e3);
    } catch (error) {
      this.appendStderr([`shutdown request failed: ${errorMessage(error)}`]);
    }
    await disposeRuntimeProcess(child, {
      disposeEofGraceMs: this.options.disposeEofGraceMs ?? 6e3,
      disposeGraceMs: this.options.disposeGraceMs ?? 3e3
    });
    this.transport?.close();
    this.failSubscriptions(this.closedError("DeepSeek Harness runtime closed"));
  }
  dispatchNotification(notification) {
    this.recordSessionRelationship(notification);
    for (const subscription of this.subscriptions.values()) subscription.push(notification);
  }
  recordSessionRelationship(notification) {
    if (notification.method !== "subagent.started") return;
    const parentId = notification.params.parentSessionId;
    const childId = notification.params.childSessionId;
    if (typeof parentId === "string" && parentId !== "" && typeof childId === "string" && childId !== "" && parentId !== childId) {
      this.sessionParents.set(childId, parentId);
    }
  }
  isDescendantOf(sessionId, rootSessionId) {
    const visited = /* @__PURE__ */ new Set();
    let current = sessionId;
    while (!visited.has(current)) {
      if (current === rootSessionId) return true;
      visited.add(current);
      const parent = this.sessionParents.get(current);
      if (parent === void 0) return false;
      current = parent;
    }
    return false;
  }
  failSubscriptions(error) {
    for (const subscription of this.subscriptions.values()) subscription.fail(error);
  }
  appendStderr(lines) {
    const kept = lines.filter((line) => line.length > 0);
    this.stderrTail.push(...kept);
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT);
    }
  }
  settleStreams() {
    return Promise.race([
      this.streamsSettled,
      new Promise((resolve3) => {
        setTimeout(resolve3, STREAM_SETTLE_MS);
      })
    ]);
  }
  closedError(reason) {
    const parts = [reason];
    if (this.spawnError !== void 0) parts.push(`spawn error: ${this.spawnError.message}`);
    if (this.exitCode !== void 0) parts.push(`exit code: ${String(this.exitCode)}`);
    if (this.stderrTail.length > 0) parts.push(`stderr tail:
${this.stderrTail.join("\n")}`);
    return new TransportClosedError(parts.join("\n"));
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ../../packages/sdk/client/src/api.ts
var DeepSeekHarness = class {
  clientInstance;
  launch;
  cwd;
  provider;
  model;
  maxTokens;
  initialized;
  closed = false;
  /** @param options - runtime launch spec plus the session route (cwd/provider/model). */
  constructor(options) {
    this.launch = options.launch;
    this.clientInstance = new HarnessClient(options.launch);
    this.cwd = (0, import_node_path.resolve)(options.cwd ?? options.launch.cwd ?? process.cwd());
    this.provider = options.provider ?? "deepseek-official";
    this.model = options.model ?? "deepseek-v4-flash";
    this.maxTokens = options.maxTokens;
  }
  /**
   * The underlying JSON-RPC client (exposed for low-level access). A failed
   * handshake reaps its runtime and swaps in a fresh instance, so do not
   * cache this across a failed {@link start}.
   * @returns the client currently owning the runtime subprocess.
   */
  get client() {
    return this.clientInstance;
  }
  /**
   * Start the subprocess and perform the `initialize` handshake once. On
   * failure the runtime is reaped and a fresh client replaces it
   * (`HarnessClient.close` is permanent), so a later call retries with a new
   * subprocess — unless {@link close} already ended this harness.
   * @returns settlement of the (memoized) handshake.
   */
  start() {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start();
        await this.clientInstance.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.maxTokens === void 0 ? {} : { maxTokens: this.maxTokens }
        });
      } catch (error) {
        this.initialized = void 0;
        await this.clientInstance.close();
        if (!this.closed) this.clientInstance = new HarnessClient(this.launch);
        throw error;
      }
    })();
    return this.initialized;
  }
  /**
   * Open a session handle (no wire traffic; the runtime creates the session
   * on its first prompt).
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @returns the session handle.
   */
  session(sessionId) {
    return new HarnessSession(this, sessionId ?? `session-${(0, import_node_crypto2.randomUUID)().replaceAll("-", "")}`);
  }
  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the owned activity interval.
   */
  run(input, options) {
    return this.session(options?.sessionId).run(input, options);
  }
  /**
   * Shut down and reap the runtime subprocess. Idempotent and terminal —
   * a closed harness no longer retries a failed handshake.
   * @returns settlement of the complete teardown.
   */
  close() {
    this.closed = true;
    return this.clientInstance.close();
  }
  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose]() {
    return this.close();
  }
};
var HarnessSession = class {
  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   */
  constructor(harness, id) {
    this.harness = harness;
    this.id = id;
  }
  /**
   * Queue one prompt, then observe the whole session through its next idle.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval; rejects on transport loss, timeout,
   * or a protocol error.
   */
  async run(input, options) {
    await this.harness.start();
    const client = this.harness.client;
    const contentBlocks = normalizeInput(input);
    const events = [];
    const notifications = [];
    const subscription = client.subscribeSessionTree(this.id);
    const collect = (notification) => {
      if (notification.method === "session.event" && notification.params.sessionId === this.id) {
        const event = validatedSessionEvent(notification.params.event);
        notifications.push(notification);
        options?.onNotification?.(notification);
        events.push(event);
        return;
      }
      notifications.push(notification);
      options?.onNotification?.(notification);
    };
    try {
      const messageId = await client.prompt(this.id, contentBlocks);
      let received = false;
      while (true) {
        const notification = await subscription.next();
        if (!received) {
          if (notification.method !== "session.event" || notification.params.sessionId !== this.id || !isInboxReceipt(notification.params.event, messageId)) continue;
          received = true;
        }
        collect(notification);
        if (notification.method === "session.status" && notification.params.sessionId === this.id && notification.params.status === "idle") break;
      }
    } finally {
      subscription.close();
    }
    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      events,
      notifications
    };
  }
};
function normalizeInput(input) {
  return typeof input === "string" ? [{ type: "text", text: input }] : input;
}
function validatedSessionEvent(value) {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`);
  }
  if (value.type === "assistant/message") {
    const message = isRecord(value.data) ? value.data.message : void 0;
    const content = isRecord(message) ? message.content : void 0;
    if (!Array.isArray(content) || !content.every((block) => isRecord(block) && typeof block.type === "string")) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`);
    }
  }
  return value;
}
function isInboxReceipt(value, messageId) {
  if (!isRecord(value) || value.type !== "agent/inbox/spliced" || !isRecord(value.data)) return false;
  const inserted = value.data.inserted;
  return Array.isArray(inserted) && inserted.some((message) => isRecord(message) && message.id === messageId);
}
function finalResponse(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    return event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  return "";
}

// src/chat-view.ts
var import_node_crypto3 = require("node:crypto");
var ChatViewProvider = class {
  constructor(context, delegate) {
    this.context = context;
    this.delegate = delegate;
  }
  static viewType = "dsh.chatView";
  view;
  currentSessionId;
  /** The session id currently shown in the panel. */
  get activeSessionId() {
    return this.currentSessionId;
  }
  /** Set the session shown in the panel and push it to the webview. */
  async setActiveSession(id) {
    this.currentSessionId = id;
    await this.post({ type: "sessions", sessions: this.delegate.listSessions() });
  }
  /** Push a host message to the webview when it exists. */
  async post(message) {
    await this.view?.webview.postMessage(message);
  }
  resolveWebviewView(webviewView, _context, _token) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
    this.delegate.onDidChangeSessions(() => {
      void this.post({ type: "sessions", sessions: this.delegate.listSessions() });
    });
    this.delegate.onDidChangePresets(() => {
      const { presets, activeId } = this.delegate.listPresets();
      void this.post({ type: "presets", presets, activePresetId: activeId });
    });
  }
  async handleMessage(message) {
    switch (message.type) {
      case "ready": {
        const { presets, activeId } = this.delegate.listPresets();
        if (this.currentSessionId === void 0) {
          this.currentSessionId = await this.delegate.newSession();
        }
        await this.post({
          type: "ready",
          activePresetId: activeId,
          presets,
          sessions: this.delegate.listSessions()
        });
        return;
      }
      case "send": {
        this.currentSessionId = message.sessionId;
        await this.delegate.send(message.sessionId, message.text);
        return;
      }
      case "newSession": {
        this.currentSessionId = await this.delegate.newSession();
        return;
      }
      case "selectSession": {
        this.currentSessionId = message.sessionId;
        await this.delegate.selectSession(message.sessionId);
        return;
      }
      case "stop":
        await this.delegate.stop(message.sessionId);
        return;
      case "openFile":
        await this.delegate.openFile(message.path);
        return;
      case "selectPreset":
        await this.delegate.selectPreset(message.id);
        return;
      case "addPreset":
        await this.delegate.addPreset({ ...message.preset, id: message.preset.id || (0, import_node_crypto3.randomUUID)() });
        return;
      case "deletePreset":
        await this.delegate.deletePreset(message.id);
        return;
    }
  }
  html(webview) {
    const nonce = (0, import_node_crypto3.randomUUID)().replaceAll("-", "");
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>DeepSeek Harness</title>
<style>${CHAT_CSS}</style>
</head>
<body>
  <div id="session-bar" class="session-bar"></div>
  <div id="messages" class="messages"></div>
  <div class="composer">
    <textarea id="input" rows="2" placeholder="Send a message\u2026 (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="composer-row">
      <select id="preset" title="API preset"></select>
      <button id="add-preset" title="Add API preset">+</button>
      <button id="send" class="primary">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">${CHAT_SCRIPT}</script>
</body>
</html>`;
  }
};
var CHAT_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
.session-bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.session-bar select { flex: 1; min-width: 0; }
.messages { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.msg { padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; }
.msg.user { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-panel-border); }
.msg.assistant { background: transparent; }
.msg.tool { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.msg.tool summary { cursor: pointer; }
.msg.tool .body { margin-top: 4px; white-space: pre-wrap; }
.msg.error { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
.msg.subagent { color: var(--vscode-descriptionForeground); font-style: italic; }
.composer { border-top: 1px solid var(--vscode-panel-border); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.composer textarea {
  width: 100%; resize: vertical; min-height: 40px; max-height: 160px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px;
  font-family: inherit; font-size: inherit;
}
.composer-row { display: flex; gap: 6px; align-items: center; }
.composer-row select { flex: 1; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 3px; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:disabled { opacity: 0.5; cursor: default; }
a.file-link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
`;
var CHAT_SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const presetEl = document.getElementById('preset');
  const sessionBar = document.getElementById('session-bar');
  let currentSessionId = undefined;
  let sessions = [];
  let presets = [];
  let activePresetId = undefined;
  let running = false;
  const assistantNodes = new Map();
  const toolNodes = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollToEnd() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function appendUserMessage(text) {
    messagesEl.appendChild(el('div', 'msg user', text));
    scrollToEnd();
  }

  function assistantNode(sessionId) {
    let node = assistantNodes.get(sessionId);
    if (!node) {
      node = el('div', 'msg assistant');
      messagesEl.appendChild(node);
      assistantNodes.set(sessionId, node);
    }
    return node;
  }

  function renderSessions() {
    sessionBar.innerHTML = '';
    const select = document.createElement('select');
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.title;
      if (s.id === currentSessionId) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => vscode.postMessage({ type: 'selectSession', sessionId: select.value }));
    sessionBar.appendChild(select);
    const add = el('button', undefined, '+');
    add.title = 'New session';
    add.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    sessionBar.appendChild(add);
  }

  function renderPresets() {
    presetEl.innerHTML = '';
    if (presets.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No preset configured';
      presetEl.appendChild(opt);
      return;
    }
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + ' \u2014 ' + p.model;
      if (p.id === activePresetId) opt.selected = true;
      presetEl.appendChild(opt);
    }
  }

  function linkifyPaths(text) {
    const node = document.createElement('span');
    const re = /(?:[A-Za-z]:[\\\\/])?[\\w./\\\\-]+/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      node.appendChild(document.createTextNode(text.slice(last, m.index)));
      const link = el('a', 'file-link', m[0]);
      link.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: m[0] }));
      node.appendChild(link);
      last = m.index + m[0].length;
    }
    node.appendChild(document.createTextNode(text.slice(last)));
    return node;
  }

  function setRunning(value) {
    running = value;
    sendBtn.textContent = value ? 'Stop' : 'Send';
    sendBtn.className = value ? '' : 'primary';
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || !currentSessionId) return;
    if (running) { vscode.postMessage({ type: 'stop', sessionId: currentSessionId }); return; }
    appendUserMessage(text);
    assistantNodes.delete(currentSessionId);
    inputEl.value = '';
    setRunning(true);
    vscode.postMessage({ type: 'send', sessionId: currentSessionId, text });
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  presetEl.addEventListener('change', () => vscode.postMessage({ type: 'selectPreset', id: presetEl.value }));
  document.getElementById('add-preset').addEventListener('click', () => {
    const name = prompt('Preset name'); if (name === null) return;
    const apiKey = prompt('API key (ARK_API_KEY)'); if (apiKey === null) return;
    const baseURL = prompt('Base URL (ARK_BASE_URL)'); if (baseURL === null) return;
    const model = prompt('Model (ARK_MODEL_PRO)'); if (model === null) return;
    vscode.postMessage({ type: 'addPreset', preset: { id: '', name, apiKey, baseURL, model } });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'ready':
        presets = msg.presets; activePresetId = msg.activePresetId; sessions = msg.sessions;
        currentSessionId = sessions.length ? sessions[sessions.length - 1].id : undefined;
        renderPresets(); renderSessions(); break;
      case 'presets':
        presets = msg.presets; activePresetId = msg.activePresetId; renderPresets(); break;
      case 'sessions':
        sessions = msg.sessions;
        if (!currentSessionId && sessions.length) currentSessionId = sessions[sessions.length - 1].id;
        renderSessions(); break;
      case 'assistantText':
        assistantNode(msg.sessionId).appendChild(document.createTextNode(msg.text));
        scrollToEnd(); break;
      case 'assistantMessage':
        assistantNode(msg.sessionId).appendChild(document.createTextNode('\\n'));
        break;
      case 'toolCall': {
        const details = el('details', 'msg tool');
        const summary = el('summary', undefined, '\\u25B8 ' + msg.call.name);
        details.appendChild(summary);
        const body = el('div', 'body');
        try { body.textContent = JSON.stringify(JSON.parse(msg.call.arguments), null, 2); }
        catch { body.textContent = msg.call.arguments; }
        details.appendChild(body);
        messagesEl.appendChild(details);
        toolNodes.set(msg.call.callId, details);
        scrollToEnd(); break;
      }
      case 'toolResult': {
        const node = toolNodes.get(msg.callId);
        if (node) node.querySelector('summary').textContent = '\\u25BE ' + (node.querySelector('summary').textContent.replace(/^[\\u25B8\\u25BE]\\s*/, '')) + (msg.error ? ' \\u2716' : ' \\u2713');
        break;
      }
      case 'subagent': {
        messagesEl.appendChild(el('div', 'msg subagent',
          (msg.finished ? 'Subagent finished: ' : 'Subagent started: ') + msg.childSessionId + (msg.status ? ' (' + msg.status + ')' : '')));
        scrollToEnd(); break;
      }
      case 'status':
        if (msg.sessionId === currentSessionId) setRunning(msg.running);
        break;
      case 'error': {
        const node = el('div', 'msg error');
        node.appendChild(linkifyPaths(msg.message));
        messagesEl.appendChild(node); scrollToEnd();
        setRunning(false); break;
      }
      case 'runtimeState':
        if (msg.state === 'error') {
          messagesEl.appendChild(el('div', 'msg error', 'Runtime error: ' + (msg.detail || msg.state)));
        } break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
`;

// src/harness-controller.ts
var import_node_crypto4 = require("node:crypto");
var import_node_events = require("node:events");
var HarnessController = class {
  constructor(cwd, resolver, maxTokens, harnessFactory) {
    this.cwd = cwd;
    this.resolver = resolver;
    this.maxTokens = maxTokens;
    this.harnessFactory = harnessFactory;
  }
  harness;
  state = "stopped";
  stateDetail;
  emitter = new import_node_events.EventEmitter();
  sessions = /* @__PURE__ */ new Map();
  activePreset;
  subscription;
  pumpStarted = false;
  /** Subscribe to controller state transitions. */
  onState(listener) {
    this.emitter.on("state", listener);
    return { dispose: () => this.emitter.off("state", listener) };
  }
  /** Subscribe to every wire notification after it has been routed. */
  onNotification(listener) {
    this.emitter.on("notification", listener);
    return { dispose: () => this.emitter.off("notification", listener) };
  }
  /** Subscribe to session-list or title changes. */
  onSessions(listener) {
    this.emitter.on("sessions", listener);
    return { dispose: () => this.emitter.off("sessions", listener) };
  }
  /** Subscribe to per-session running-state transitions. */
  onStatus(listener) {
    this.emitter.on("status", listener);
    return { dispose: () => this.emitter.off("status", listener) };
  }
  /** Current lifecycle state of the owned subprocess. */
  get runtimeState() {
    return this.state;
  }
  /** Ids of every session opened in this controller, in creation order. */
  get sessionIds() {
    return [...this.sessions.keys()];
  }
  /** The session id most recently interacted with. */
  latestSessionId() {
    let latest;
    for (const id of this.sessions.keys()) latest = id;
    return latest;
  }
  /**
   * Switch the active preset. When the provider or model changes the running
   * subprocess is torn down and re-created on the next prompt so the JSON-RPC
   * `initialize` handshake carries the new route.
   * @returns `true` when a restart is pending.
   */
  async setActivePreset(preset) {
    const previous = this.activePreset;
    this.activePreset = preset;
    if (previous === void 0 || preset === void 0 || previous.model !== preset.model || previous.baseURL !== preset.baseURL || previous.apiKey !== preset.apiKey) {
      await this.stopProcess();
      return true;
    }
    return false;
  }
  /** Create a new named session and return its id (no wire traffic until the first prompt). */
  createSession() {
    const id = `vscode-${(0, import_node_crypto4.randomUUID)().replaceAll("-", "")}`;
    this.sessions.set(id, { title: "New chat", running: false });
    this.emitter.emit("sessions", this.sessionSummaries());
    return id;
  }
  /** @returns whether a session exists by id. */
  hasSession(id) {
    return this.sessions.has(id);
  }
  /** Display title for a session. */
  titleOf(id) {
    return this.sessions.get(id)?.title ?? id;
  }
  /** Whether the session currently has a turn in flight. */
  isRunning(id) {
    return this.sessions.get(id)?.running ?? false;
  }
  /**
   * Send one prompt and settle when the agent next goes idle. Streaming
   * notifications are emitted as they arrive. Rejects when no preset is
   * selected, the transport fails, or the turn is stopped.
   */
  async prompt(id, text, onEvent) {
    const record = this.sessions.get(id);
    if (record === void 0) throw new Error(`unknown session: ${id}`);
    if (this.activePreset === void 0) throw new Error("select an API preset before sending a message");
    if (record.running) throw new Error(`session already running: ${id}`);
    record.running = true;
    this.emitter.emit("status", { sessionId: id, running: true });
    try {
      const harness = await this.ensureStarted();
      const session = harness.session(id);
      let toolCallCount = 0;
      const result = await session.run([{ type: "text", text }], {
        onNotification: (notification) => {
          this.routeNotification(id, notification, onEvent, () => {
            toolCallCount += 1;
            if (toolCallCount === 1) record.title = text.slice(0, 60);
          });
        }
      });
      if (result.finalResponse.trim().length > 0 && toolCallCount === 0) {
        record.title = text.slice(0, 60);
      }
      this.emitter.emit("sessions", this.sessionSummaries());
    } finally {
      record.running = false;
      this.emitter.emit("status", { sessionId: id, running: false });
    }
  }
  /** Abandon the in-flight turn by terminating the runtime (the wire has no cancel). */
  async stop(id) {
    if (!this.isRunning(id)) return;
    await this.stopProcess();
  }
  /** Dispose the runtime and all session tracking. */
  async dispose() {
    await this.stopProcess();
    this.sessions.clear();
  }
  async ensureStarted() {
    if (this.harness !== void 0) return this.harness;
    const preset = this.activePreset;
    if (preset === void 0) throw new Error("no active API preset");
    this.setState("starting");
    try {
      const launch = await this.resolver.resolve(this.cwd);
      const harness = this.harnessFactory(launch, preset, this.maxTokens);
      this.harness = harness;
      this.attachSubscription(harness);
      await harness.start();
      this.setState("running");
      return harness;
    } catch (error) {
      this.harness = void 0;
      this.setState("error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  attachSubscription(harness) {
    if (this.pumpStarted) return;
    this.pumpStarted = true;
    void (async () => {
      const subscription = harness.client.subscribe();
      this.subscription = subscription;
      try {
        for await (const notification of subscription) {
          this.emitter.emit("notification", notification);
        }
      } catch (error) {
        if (this.harness === harness) {
          this.setState("error", error instanceof Error ? error.message : String(error));
        }
      }
    })();
  }
  routeNotification(rootId, notification, sink, onToolCall) {
    if (notification.method === "session.event" && notification.params.sessionId === rootId) {
      const envelope = notification.params.event;
      if (envelope === void 0) return;
      if (envelope.type === "assistant/chunk") {
        const chunk = envelope.data?.chunk;
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
          sink.onAssistantText(chunk.text);
        }
        return;
      }
      if (envelope.type === "tool/call" && typeof envelope.data?.name === "string") {
        const view = {
          callId: idToString(envelope.data.callId),
          name: envelope.data.name,
          arguments: typeof envelope.data.arguments === "string" ? envelope.data.arguments : ""
        };
        onToolCall();
        sink.onToolCall(view);
        return;
      }
      if (envelope.type === "tool/result") {
        sink.onToolResult(
          idToString(envelope.data?.message?.toolCallId),
          envelope.data?.error
        );
        return;
      }
      if (envelope.type === "assistant/message") {
        sink.onAssistantMessage();
      }
      return;
    }
    if (notification.method === "subagent.started") {
      const params = notification.params;
      if (params.parentSessionId === rootId && typeof params.childSessionId === "string") {
        sink.onSubagent(params.childSessionId, false);
      }
      return;
    }
    if (notification.method === "subagent.finished") {
      const params = notification.params;
      if (params.parentSessionId === rootId && typeof params.childSessionId === "string") {
        sink.onSubagent(params.childSessionId, true, params.status);
      }
    }
  }
  async stopProcess() {
    const harness = this.harness;
    const subscription = this.subscription;
    this.harness = void 0;
    this.subscription = void 0;
    this.pumpStarted = false;
    subscription?.close();
    for (const [id, record] of this.sessions) {
      if (record.running) {
        record.running = false;
        this.emitter.emit("status", { sessionId: id, running: false });
      }
    }
    if (harness !== void 0) {
      this.setState("stopped");
      await harness.close();
    } else {
      this.setState("stopped");
    }
  }
  setState(state, detail) {
    this.state = state;
    this.stateDetail = state === "error" ? detail : void 0;
    this.emitter.emit("state", state, this.stateDetail);
  }
  sessionSummaries() {
    return [...this.sessions.entries()].map(([id, record]) => ({ id, title: record.title }));
  }
};
function idToString(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint" ? String(value) : typeof value === "object" && value !== null && "id" in value ? idToString(value.id) : "";
}

// src/preset-store.ts
var import_node_crypto5 = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");
var import_node_events2 = require("node:events");
var FIELD_API_KEY = "ARK_API_KEY";
var FIELD_BASE_URL = "ARK_BASE_URL";
var FIELD_MODEL = "ARK_MODEL_PRO";
var ApiPresetStore = class {
  path;
  emitter = new import_node_events2.EventEmitter();
  presets = [];
  activeId;
  /**
   * @param libraryPath - override the file location (defaults to the ainovel path under the user home).
   */
  constructor(libraryPath = defaultLibraryPath()) {
    this.path = libraryPath;
    this.reload();
    this.emitter.emit("change");
  }
  /** Subscribe to preset-library changes (add/update/remove/select/reload). */
  onDidChange(listener) {
    this.emitter.on("change", listener);
    return { dispose: () => this.emitter.off("change", listener) };
  }
  /** Absolute path to the backing `api_library.json`. */
  get file() {
    return this.path;
  }
  /** Snapshot of every stored preset, including its credential fields. */
  list() {
    return this.presets;
  }
  /** The active preset (the file's `current_text_id`, else the first), or `undefined`. */
  get active() {
    if (this.activeId !== void 0) {
      const found = this.presets.find((preset) => preset.id === this.activeId);
      if (found !== void 0) return found;
    }
    return this.presets[0];
  }
  /** Reload presets from disk (e.g. after an external edit). */
  reload() {
    const data = readLibrary(this.path);
    this.presets = (data.text_presets ?? []).filter(isTextPreset).map(toApiPreset);
    const current = data.current_text_id;
    this.activeId = typeof current === "string" && current.length > 0 ? current : void 0;
  }
  /** Add a preset, minting a short id when the caller omitted one. Returns the stored preset. */
  add(input) {
    const id = input.id && input.id.length > 0 ? input.id : (0, import_node_crypto5.randomUUID)().replaceAll("-", "").slice(0, 8);
    const preset = {
      id,
      name: input.name.trim() || "\u672A\u547D\u540D\u9884\u8BBE",
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      model: input.model
    };
    const data = readLibrary(this.path);
    const presets = [...data.text_presets ?? [], toTextPreset(preset)];
    writeLibrary(this.path, { ...data, text_presets: presets, current_text_id: data.current_text_id ?? id });
    this.reload();
    this.emitter.emit("change");
    return preset;
  }
  /** Replace an existing preset's fields by id. Returns false when not found. */
  update(id, patch) {
    const data = readLibrary(this.path);
    const presets = data.text_presets ?? [];
    const index = presets.findIndex((entry) => isTextPreset(entry) && entry.id === id);
    if (index === -1) return false;
    const existing = toApiPreset(presets[index]);
    const updated = {
      id,
      name: patch.name !== void 0 ? patch.name.trim() || existing.name : existing.name,
      apiKey: patch.apiKey !== void 0 ? patch.apiKey : existing.apiKey,
      baseURL: patch.baseURL !== void 0 ? patch.baseURL : existing.baseURL,
      model: patch.model !== void 0 ? patch.model : existing.model
    };
    presets[index] = toTextPreset(updated);
    writeLibrary(this.path, { ...data, text_presets: presets });
    this.reload();
    this.emitter.emit("change");
    return true;
  }
  /** Remove a preset by id, clearing the active selection when it matched. */
  remove(id) {
    const data = readLibrary(this.path);
    const presets = (data.text_presets ?? []).filter((entry) => !isTextPreset(entry) || entry.id !== id);
    const current = data.current_text_id === id ? null : data.current_text_id;
    writeLibrary(this.path, { ...data, text_presets: presets, current_text_id: current });
    this.reload();
    this.emitter.emit("change");
  }
  /** Select a preset by id; the selection persists to `current_text_id`. */
  setActive(id) {
    if (!this.presets.some((preset) => preset.id === id)) throw new Error(`unknown preset: ${id}`);
    const data = readLibrary(this.path);
    writeLibrary(this.path, { ...data, current_text_id: id });
    this.reload();
    this.emitter.emit("change");
  }
};
function defaultLibraryPath() {
  return (0, import_node_path2.join)((0, import_node_os.homedir)(), ".claude", "ainovel-write", "api_library.json");
}
function readLibrary(path) {
  if (!(0, import_node_fs.existsSync)(path)) return {};
  try {
    const parsed = JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
    return isRecord2(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function writeLibrary(path, data) {
  (0, import_node_fs.mkdirSync)((0, import_node_path2.dirname)(path), { recursive: true });
  (0, import_node_fs.writeFileSync)(path, `${JSON.stringify(data, null, 2)}
`, "utf8");
}
function toApiPreset(entry) {
  const fields = isRecord2(entry.fields) ? entry.fields : {};
  return {
    id: entry.id,
    name: typeof entry.name === "string" ? entry.name : "\u672A\u547D\u540D\u9884\u8BBE",
    apiKey: stringField(fields[FIELD_API_KEY]),
    baseURL: stringField(fields[FIELD_BASE_URL]),
    model: stringField(fields[FIELD_MODEL])
  };
}
function toTextPreset(preset) {
  const fields = {};
  if (preset.apiKey.length > 0) fields[FIELD_API_KEY] = preset.apiKey;
  if (preset.baseURL.length > 0) fields[FIELD_BASE_URL] = preset.baseURL;
  if (preset.model.length > 0) fields[FIELD_MODEL] = preset.model;
  return { id: preset.id, name: preset.name, fields };
}
function stringField(value) {
  return typeof value === "string" ? value.trim() : "";
}
function isTextPreset(value) {
  return isRecord2(value) && typeof value.id === "string";
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}

// src/runtime-resolver.ts
var import_node_fs2 = require("node:fs");
var import_node_module = require("node:module");
var import_node_path3 = require("node:path");
var CONFIG_BASENAME = "cordis.yml";
var RUNTIME_PACKAGE = "@deepseek-ai/dsh-sdk-jsonrpc-demo";
var NodeRuntimeResolver = class {
  /**
   * @param extensionRoot - directory containing the built extension (its `runtime/cordis.yml` and node_modules).
   * @param runtimeCommand - optional override for the executable.
   * @param runtimeArgs - extra args inserted before the config path.
   */
  constructor(extensionRoot, runtimeCommand, runtimeArgs) {
    this.extensionRoot = extensionRoot;
    this.runtimeCommand = runtimeCommand;
    this.runtimeArgs = runtimeArgs;
    this.nodeRequire = (0, import_node_module.createRequire)((0, import_node_path3.join)(extensionRoot, "package.json"));
  }
  nodeRequire;
  resolve(cwd) {
    const configPath = (0, import_node_path3.join)(this.extensionRoot, "runtime", CONFIG_BASENAME);
    if (!(0, import_node_fs2.existsSync)(configPath)) {
      throw new Error(`runtime config not found: ${configPath}`);
    }
    if (this.runtimeCommand.trim().length > 0) {
      return {
        command: this.runtimeCommand,
        args: [...this.runtimeArgs, configPath],
        cwd,
        env: { ...process.env }
      };
    }
    const binPath = this.resolveBinEntry();
    return {
      command: process.execPath,
      args: [binPath, ...this.runtimeArgs, configPath],
      cwd,
      env: { ...process.env }
    };
  }
  /**
   * Locate the runtime bin entry. The package's `exports["./bin"]` points at
   * `lib/bin.js`; resolving it yields an absolute filesystem path that the
   * current Node executable can run directly without relying on a `.bin` shim.
   */
  resolveBinEntry() {
    try {
      const pkgJson = this.nodeRequire.resolve(`${RUNTIME_PACKAGE}/package.json`);
      const binPath = (0, import_node_path3.join)((0, import_node_path3.dirname)(pkgJson), "lib", "bin.js");
      if ((0, import_node_fs2.existsSync)(binPath)) return binPath;
      return this.nodeRequire.resolve(`${RUNTIME_PACKAGE}/bin`);
    } catch (error) {
      throw new Error([
        `could not resolve ${RUNTIME_PACKAGE} bin from ${this.extensionRoot}`,
        error instanceof Error ? error.message : String(error)
      ].join("\n"));
    }
  }
};

// src/extension.ts
var DSH_FOLDER = ".dsh-vscode";
var ARK_PROVIDER = "openai";
function activate(context) {
  const cwd = workspaceCwd();
  const maxTokens = maxTokensSetting();
  const store = new ApiPresetStore();
  const controller = new HarnessController(
    cwd,
    new NodeRuntimeResolver(
      context.extensionPath,
      import_vscode.workspace.getConfiguration("dsh-vscode").get("runtimeCommand", ""),
      import_vscode.workspace.getConfiguration("dsh-vscode").get("runtimeArgs", [])
    ),
    maxTokens,
    (launch, preset, tokens) => createHarness(launch, preset, tokens, cwd)
  );
  if (store.active !== void 0) {
    void controller.setActivePreset(store.active);
  }
  const provider = new ChatViewProvider(context, {
    listPresets: () => ({ presets: [...store.list()], activeId: store.active?.id }),
    listSessions: () => summaries(controller),
    onDidChangeSessions: (listener) => controller.onSessions(listener),
    onDidChangePresets: (listener) => store.onDidChange(listener),
    send: (id, text) => sendPrompt(store, controller, provider, id, text),
    stop: (id) => controller.stop(id),
    openFile: (path) => openFile(path),
    selectPreset: (id) => selectPreset(store, controller, id),
    addPreset: (preset) => {
      store.add(preset);
    },
    deletePreset: (id) => {
      store.remove(id);
    },
    newSession: async () => {
      const id = controller.createSession();
      await provider.setActiveSession(id);
      return id;
    },
    selectSession: (id) => provider.setActiveSession(id)
  });
  context.subscriptions.push(
    import_vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    controller.onState((state, detail) => {
      void provider.post(detail === void 0 ? { type: "runtimeState", state } : { type: "runtimeState", state, detail });
      setRunningContext(state === "running");
    }),
    controller.onStatus((event) => {
      void provider.post(event.running ? { type: "status", sessionId: event.sessionId, running: true } : { type: "status", sessionId: event.sessionId, running: false });
    }),
    import_vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.fsPath === store.file) {
        store.reload();
        if (store.active !== void 0) void controller.setActivePreset(store.active);
      }
    }),
    import_vscode.commands.registerCommand("dsh.newSession", async () => {
      const id = controller.createSession();
      await provider.setActiveSession(id);
    }),
    import_vscode.commands.registerCommand("dsh.stop", async () => {
      const id = provider.activeSessionId;
      if (id !== void 0) await controller.stop(id);
    }),
    import_vscode.commands.registerCommand("dsh.selectPreset", async () => {
      const picked = await pickPreset(store);
      if (picked !== void 0) await selectPreset(store, controller, picked);
    }),
    import_vscode.commands.registerCommand("dsh.addPreset", async () => {
      const preset = await promptPreset();
      if (preset !== void 0) store.add(preset);
    })
  );
}
async function selectPreset(store, controller, id) {
  store.setActive(id);
  await controller.setActivePreset(store.active);
}
async function pickPreset(store) {
  const items = store.list().map((preset) => ({
    label: preset.name,
    description: preset.model,
    detail: preset.baseURL,
    id: preset.id
  }));
  const picked = await import_vscode.window.showQuickPick(items, { placeHolder: "Select API preset" });
  return picked?.id;
}
async function promptPreset() {
  const name = await import_vscode.window.showInputBox({ prompt: "Preset name", placeHolder: "doubao" });
  if (name === void 0) return void 0;
  const apiKey = await import_vscode.window.showInputBox({ prompt: "API key (ARK_API_KEY)", password: true });
  if (apiKey === void 0) return void 0;
  const baseURL = await import_vscode.window.showInputBox({ prompt: "Base URL (ARK_BASE_URL)", placeHolder: "https://ark.cn-beijing.volces.com/api/coding/v3" });
  if (baseURL === void 0) return void 0;
  const model = await import_vscode.window.showInputBox({ prompt: "Model (ARK_MODEL_PRO)", placeHolder: "doubao-seed-evolving" });
  if (model === void 0) return void 0;
  return { name, apiKey, baseURL, model };
}
async function sendPrompt(store, controller, provider, id, text) {
  if (store.active === void 0) {
    await provider.post({ type: "error", sessionId: id, message: "No API preset configured. Add one first." });
    return;
  }
  try {
    await controller.prompt(id, text, {
      onAssistantText: (chunk) => void provider.post({ type: "assistantText", sessionId: id, text: chunk }),
      onAssistantMessage: () => void provider.post({ type: "event", sessionId: id, event: { type: "assistant/message" } }),
      onToolCall: (call) => void provider.post({ type: "toolCall", sessionId: id, call }),
      onToolResult: (callId, error) => void provider.post({ type: "toolResult", sessionId: id, callId, ...error ? { error } : {} }),
      onSubagent: (childId, finished, status) => void provider.post({
        type: "subagent",
        parentSessionId: id,
        childSessionId: childId,
        finished,
        ...status ? { status } : {}
      })
    });
  } catch (error) {
    await provider.post({
      type: "error",
      sessionId: id,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
function createHarness(launch, preset, maxTokens, cwd) {
  const env = { ...launch.env };
  if (preset.apiKey.length > 0) env.ARK_API_KEY = preset.apiKey;
  if (preset.baseURL.length > 0) env.ARK_BASE_URL = preset.baseURL;
  if (preset.model.length > 0) env.ARK_MODEL_PRO = preset.model;
  env.OPENAI_API_KEY = preset.apiKey;
  env.OPENAI_BASE_URL = preset.baseURL;
  env.DSH_CWD = cwd;
  env.DSH_SESSION_ROOT = (0, import_node_path4.join)((0, import_node_os2.tmpdir)(), DSH_FOLDER, "sessions");
  return new DeepSeekHarness({
    launch: { command: launch.command, args: launch.args, cwd: launch.cwd, env },
    cwd,
    provider: ARK_PROVIDER,
    model: preset.model,
    ...maxTokens === void 0 ? {} : { maxTokens }
  });
}
function summaries(controller) {
  return controller.sessionIds.map((id) => ({ id, title: controller.titleOf(id) }));
}
function workspaceCwd() {
  const folder = import_vscode.workspace.workspaceFolders?.[0];
  return folder ? (0, import_node_path4.resolve)(folder.uri.fsPath) : process.cwd();
}
function maxTokensSetting() {
  const value = import_vscode.workspace.getConfiguration("dsh-vscode").get("maxTokens", null);
  return value === null || value <= 0 ? void 0 : value;
}
async function openFile(path) {
  const resolved = (0, import_node_path4.resolve)(path);
  try {
    const document = await import_vscode.workspace.openTextDocument(import_vscode.Uri.file(resolved));
    await import_vscode.window.showTextDocument(document, import_vscode.ViewColumn.One);
  } catch {
    void import_vscode.window.showWarningMessage(`Cannot open ${path}`);
  }
}
function setRunningContext(running) {
  void import_vscode.commands.executeCommand("setContext", "dsh.running", running);
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
module.exports.activate = activate; module.exports.deactivate = deactivate;
//# sourceMappingURL=extension.cjs.map
