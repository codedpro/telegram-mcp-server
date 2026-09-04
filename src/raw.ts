import bigInt from "big-integer";
import { Api, type TelegramClient } from "teleproto";
import definitions from "teleproto/tl/generated/api-definitions.js";
import type { ArgConfig, Definition } from "teleproto/tl/generated/api-definitions.js";
import { toPlain } from "./format.js";

const upperFirst = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function fullName(def: Definition): string {
  return def.namespace ? `${def.namespace}.${def.name}` : def.name;
}

export function findDefinition(name: string, kind: "function" | "constructor"): Definition {
  const parts = name.trim().split(".");
  const short = upperFirst(parts.pop() ?? "");
  const namespace = parts.join(".") || undefined;
  const wantFunction = kind === "function";
  const match = definitions.find(
    (def) => def.isFunction === wantFunction && def.name === short && (def.namespace ?? undefined) === namespace,
  );
  if (!match) {
    const near = definitions
      .filter((def) => def.isFunction === wantFunction && def.name.toLowerCase().includes(short.toLowerCase()))
      .slice(0, 8)
      .map(fullName);
    throw new Error(
      `Unknown MTProto ${kind} "${name}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Use telegram_search_methods to look it up.`,
    );
  }
  return match;
}

function apiClass(def: Definition): new (args: Record<string, unknown>) => Api.AnyRequest {
  const root = Api as unknown as Record<string, unknown>;
  const scope = def.namespace ? (root[def.namespace] as Record<string, unknown>) : root;
  const cls = scope?.[def.name];
  if (typeof cls !== "function") throw new Error(`Library has no class for ${fullName(def)}.`);
  return cls as new (args: Record<string, unknown>) => Api.AnyRequest;
}

function convertScalar(value: unknown, type: string, path: string): unknown {
  switch (type) {
    case "long":
    case "int128":
    case "int256":
      if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") {
        return bigInt(String(value));
      }
      throw new Error(`${path}: expected a number or numeric string for TL type ${type}.`);
    case "int":
    case "double":
    case "date":
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
      throw new Error(`${path}: expected a number for TL type ${type}.`);
    case "string":
      return String(value);
    case "bytes":
      if (typeof value === "string") return Buffer.from(value, "base64");
      if (value && typeof value === "object" && "base64" in value) {
        return Buffer.from(String((value as { base64: unknown }).base64), "base64");
      }
      throw new Error(`${path}: expected a base64 string for TL type bytes.`);
    case "Bool":
    case "true":
      return Boolean(value);
    default:
      return convertObject(value, type, path);
  }
}

function convertObject(value: unknown, type: string, path: string): unknown {
  // Strings and numbers are left for the library's resolver (peers, ids, "me").
  if (typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item, i) => convertObject(item, type, `${path}[${i}]`));
  if (value && typeof value === "object") {
    const { _: ctor, ...rest } = value as Record<string, unknown>;
    if (typeof ctor !== "string") {
      throw new Error(
        `${path}: nested TL objects need a "_" key naming the constructor, e.g. {"_": "InputPeerChannel", "channelId": "...", "accessHash": "..."}. Expected type ${type}.`,
      );
    }
    const def = findDefinition(ctor, "constructor");
    return new (apiClass(def))(convertArgs(def, rest, `${path}.`));
  }
  throw new Error(`${path}: cannot convert ${JSON.stringify(value)} to TL type ${type}.`);
}

function convertArgs(def: Definition, params: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = Object.entries(def.argsConfig).filter(([, cfg]) => !cfg.flagIndicator);
  for (const [key, value] of Object.entries(params)) {
    const cfg = def.argsConfig[key];
    if (!cfg || cfg.flagIndicator) {
      throw new Error(
        `Unknown parameter "${prefix}${key}" for ${fullName(def)}. Valid parameters: ${known.map(([k]) => k).join(", ") || "(none)"}.`,
      );
    }
    if (value === null || value === undefined) continue;
    const path = `${prefix}${key}`;
    if (cfg.isVector) {
      if (!Array.isArray(value)) throw new Error(`${path}: expected an array (Vector<${cfg.type}>).`);
      out[key] = value.map((item, i) => convertScalar(item, cfg.type, `${path}[${i}]`));
    } else {
      out[key] = convertScalar(value, cfg.type, path);
    }
  }
  return out;
}

export function describeType(cfg: ArgConfig): string {
  return cfg.isVector ? `Vector<${cfg.type}>` : cfg.type;
}

export function describeMethod(name: string) {
  const def = findDefinition(name, "function");
  const params = Object.entries(def.argsConfig)
    .filter(([, cfg]) => !cfg.flagIndicator)
    .map(([key, cfg]) => ({
      name: key,
      type: describeType(cfg),
      optional: cfg.isFlag,
      note:
        cfg.type === "true"
          ? "boolean flag"
          : /^Input(Peer|User|Channel)$/.test(cfg.type)
            ? 'accepts "@username", a numeric id, or "me"'
            : cfg.type === "long"
              ? "number or numeric string"
              : cfg.type === "bytes"
                ? "base64 string"
                : undefined,
    }));
  return { method: fullName(def), result: def.result, params };
}

export function searchMethods(query: string, limit: number) {
  const q = query.toLowerCase();
  return definitions
    .filter((def) => def.isFunction && fullName(def).toLowerCase().includes(q))
    .slice(0, limit)
    .map((def) => ({ method: fullName(def), result: def.result }));
}

export async function invokeRaw(client: TelegramClient, method: string, params: Record<string, unknown>) {
  const def = findDefinition(method, "function");
  const request = new (apiClass(def))(convertArgs(def, params));
  const result = await client.invoke(request);
  return toPlain(result);
}
