import { EventEmitter } from "events";
import { WebSocket } from "ws";
import { SessionConfig, SessionState, StreamEvent } from "./session";
import { Host, HostInfo, HostSessionHandle } from "./host";

export class RemoteSessionProxy extends EventEmitter implements HostSessionHandle {
  sessionId: string | null = null;
  private _isRunning = false;
  private _state: SessionState;
  private resolveRun: (() => void) | null = null;
  private rejectRun: ((err: Error) => void) | null = null;

  constructor(
    readonly agentId: string,
    private host: RemoteHost,
    config: SessionConfig,
  ) {
    super();
    this._state = {
      sessionId: null,
      config,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 0,
        duration_ms: 0,
      },
    };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  async send(message: string): Promise<void> {
    if (this._isRunning) throw new Error("Session is busy");
    if (!this.host.connected) throw new Error("Host is disconnected");
    this._isRunning = true;
    this.host.sendToRunner({ type: "send_message", agentId: this.agentId, message });
    return new Promise<void>((resolve, reject) => {
      this.resolveRun = resolve;
      this.rejectRun = reject;
    });
  }

  abort(): void {
    if (this.host.connected) {
      this.host.sendToRunner({ type: "abort_session", agentId: this.agentId });
    }
  }

  getState(): SessionState {
    return { ...this._state, sessionId: this.sessionId };
  }

  injectEvent(event: StreamEvent): void {
    this.emit("event", event);
  }

  onSessionDone(status: "ok" | "error", error?: string): void {
    this._isRunning = false;
    this._state.usage.turns++;
    if (status === "ok") {
      this.resolveRun?.();
    } else {
      this.rejectRun?.(new Error(error ?? "Remote session error"));
    }
    this.resolveRun = null;
    this.rejectRun = null;
  }

  onSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this._state.sessionId = sessionId;
  }

  onStateUpdate(state: SessionState): void {
    this._state = state;
    this.sessionId = state.sessionId;
  }

  onDisconnect(): void {
    if (this._isRunning) {
      this._isRunning = false;
      this.rejectRun?.(new Error("Host disconnected"));
      this.resolveRun = null;
      this.rejectRun = null;
    }
  }
}

export class RemoteHost implements Host {
  readonly id: string;
  readonly label: string;
  readonly type = "remote" as const;
  readonly token: string;
  private ws: WebSocket | null = null;
  private proxies = new Map<string, RemoteSessionProxy>();
  private onStateChange?: () => void;

  constructor(id: string, label: string, token: string, onStateChange?: () => void) {
    this.id = id;
    this.label = label;
    this.token = token;
    this.onStateChange = onStateChange;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }

  attach(ws: WebSocket): void {
    if (this.ws && this.ws !== ws) {
      this.ws.close(1000, "replaced");
    }
    this.ws = ws;

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleRunnerMessage(msg);
      } catch {
        // ignore malformed
      }
    });

    ws.on("close", () => {
      if (this.ws === ws) {
        this.ws = null;
        for (const proxy of this.proxies.values()) {
          proxy.onDisconnect();
        }
        this.onStateChange?.();
      }
    });

    this.onStateChange?.();
  }

  detach(): void {
    this.ws?.close(1000, "detached");
    this.ws = null;
  }

  sendToRunner(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  createSession(agentId: string, config: SessionConfig): HostSessionHandle {
    const proxy = new RemoteSessionProxy(agentId, this, config);
    this.proxies.set(agentId, proxy);
    this.sendToRunner({ type: "create_session", agentId, config });
    return proxy;
  }

  destroySession(agentId: string): void {
    const proxy = this.proxies.get(agentId);
    if (proxy) {
      proxy.onDisconnect();
      this.proxies.delete(agentId);
      this.sendToRunner({ type: "destroy_session", agentId });
    }
  }

  restoreSession(agentId: string, state: SessionState): HostSessionHandle {
    const proxy = new RemoteSessionProxy(agentId, this, state.config);
    proxy.onSessionId(state.sessionId ?? "");
    proxy.onStateUpdate(state);
    this.proxies.set(agentId, proxy);
    if (this.connected) {
      this.sendToRunner({
        type: "create_session",
        agentId,
        config: state.config,
        resumeState: state,
      });
    }
    return proxy;
  }

  private handleRunnerMessage(msg: Record<string, unknown>): void {
    const agentId = msg.agentId as string | undefined;

    switch (msg.type) {
      case "session_created": {
        const proxy = agentId ? this.proxies.get(agentId) : undefined;
        if (proxy && msg.sessionId) {
          proxy.onSessionId(msg.sessionId as string);
        }
        break;
      }
      case "session_event": {
        const proxy = agentId ? this.proxies.get(agentId) : undefined;
        if (proxy && msg.event) {
          proxy.injectEvent(msg.event as StreamEvent);
        }
        break;
      }
      case "session_done": {
        const proxy = agentId ? this.proxies.get(agentId) : undefined;
        if (proxy) {
          proxy.onSessionDone(msg.status as "ok" | "error", msg.error as string | undefined);
        }
        break;
      }
      case "session_state": {
        const proxy = agentId ? this.proxies.get(agentId) : undefined;
        if (proxy && msg.state) {
          proxy.onStateUpdate(msg.state as SessionState);
        }
        break;
      }
    }
  }
}
