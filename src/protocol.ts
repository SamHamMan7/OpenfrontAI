import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface ZbinWireModule {
  createGameWireContext(players: ReadonlyArray<{ clientID: string }>): unknown;
  encodeClientMessage(message: unknown, context: unknown): Uint8Array;
  decodeServerMessage(bytes: Uint8Array, context: unknown): any;
}

export interface ProtocolAdapter {
  readonly mode: "json" | "zbin";
  encode(message: unknown): string | Uint8Array;
  decode(data: Buffer | ArrayBuffer | Uint8Array | string): any;
  observe(message: any): void;
}

function sourceCandidates(): string[] {
  const explicit = process.env.OPENFRONT_SOURCE;
  const cwd = process.cwd();
  return [
    explicit,
    path.resolve(cwd, "../OpenFrontIO"),
    path.resolve(cwd, "../OpenFront"),
    path.resolve(cwd, "OpenFrontIO"),
  ].filter((value): value is string => Boolean(value));
}

async function loadZbinWire(source: string): Promise<ZbinWireModule> {
  const file = path.resolve(source, "src/core/ZbinWire.ts");
  if (!existsSync(file)) {
    throw new Error(`ZbinWire.ts not found under ${source}`);
  }
  return (await import(pathToFileURL(file).href)) as ZbinWireModule;
}

function asUint8Array(data: Buffer | ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

class JsonProtocol implements ProtocolAdapter {
  readonly mode = "json" as const;

  encode(message: unknown): string {
    return JSON.stringify(message);
  }

  decode(data: Buffer | ArrayBuffer | Uint8Array | string): any {
    const text = typeof data === "string" ? data : new TextDecoder().decode(asUint8Array(data));
    return JSON.parse(text);
  }

  observe(_message: any): void {}
}

class ZbinProtocol implements ProtocolAdapter {
  readonly mode = "zbin" as const;
  private context: unknown = undefined;

  constructor(private readonly wire: ZbinWireModule) {}

  encode(message: unknown): Uint8Array {
    return this.wire.encodeClientMessage(message, this.context);
  }

  decode(data: Buffer | ArrayBuffer | Uint8Array | string): any {
    return this.wire.decodeServerMessage(asUint8Array(data), this.context);
  }

  observe(message: any): void {
    if (message?.type !== "start") return;
    const players = message?.gameStartInfo?.players;
    if (!Array.isArray(players)) return;
    this.context = this.wire.createGameWireContext(players);
  }
}

export async function createProtocolAdapter(): Promise<ProtocolAdapter> {
  const forced = (process.env.OPENFRONT_PROTOCOL ?? "auto").toLowerCase();
  if (forced === "json") return new JsonProtocol();

  for (const source of sourceCandidates()) {
    try {
      const wire = await loadZbinWire(source);
      console.log(`[WIRE] Using zbin from ${path.resolve(source)}`);
      return new ZbinProtocol(wire);
    } catch (error) {
      if (process.env.OPENFRONT_SOURCE === source && forced === "zbin") throw error;
    }
  }

  if (forced === "zbin") {
    throw new Error(
      "OPENFRONT_PROTOCOL=zbin requires OPENFRONT_SOURCE to point at the exact OpenFrontIO checkout running the server",
    );
  }

  console.log("[WIRE] No OpenFront source checkout found; using legacy JSON protocol");
  return new JsonProtocol();
}
