import dns from "node:dns/promises";
import net from "node:net";
import { agentCardSchema, responseEnvelopeSchema } from "./schemas.js";
import {
  containsHiddenAdministrativeNarration,
  countWords,
  digestJson,
  extractQuotedSegments,
  hasUnmarkedExactQuotationSection,
  sha256,
  verifyResponseEnvelopeSignature,
} from "./crypto.js";
import type { AgentCard, AgentRef, AgentTransport, InvocationEnvelope, ResponseEnvelope } from "./types.js";

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a === 0;
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return isPrivateIpv4(address);
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return true;
}

export async function validateRemoteUrl(rawUrl: string, allowPrivateOrigins: boolean): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.username || url.password) throw new Error("Remote Suminar URLs must not contain credentials");
  if (url.protocol !== "https:" && !(allowPrivateOrigins && url.protocol === "http:")) {
    throw new Error("Remote Suminar origins require HTTPS");
  }
  const results = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!results.length) throw new Error("Remote origin did not resolve");
  if (!allowPrivateOrigins && results.some((result) => isPrivateAddress(result.address))) {
    throw new Error("Loopback, private, and link-local remote origins are blocked");
  }
  return url;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) throw new Error("Remote response exceeds the size limit");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Remote response exceeds the size limit");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function safeFetch(
  rawUrl: string,
  allowPrivateOrigins: boolean,
  init: RequestInit,
  maxBytes: number,
): Promise<{ url: URL; body: string }> {
  let current = await validateRemoteUrl(rawUrl, allowPrivateOrigins);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Remote origin exceeded redirect policy");
      current = await validateRemoteUrl(new URL(location, current).toString(), allowPrivateOrigins);
      continue;
    }
    if (!response.ok) throw new Error(`Remote origin returned HTTP ${response.status}`);
    return { url: current, body: await readLimitedBody(response, maxBytes) };
  }
  throw new Error("Remote origin exceeded redirect policy");
}

export interface AgentCardPreview {
  card: AgentCard;
  manifestUrl: string;
  manifestDigest: string;
  firstContactWarning: string;
}

export function materialAgentCardDigest(card: AgentCard): string {
  return digestJson({
    agentId: card.agentId,
    origin: card.origin,
    operator: card.operator,
    sourceIdentity: card.sourceIdentity,
    capabilities: card.capabilities,
    contextPolicy: card.contextPolicy,
    memoryAndRetention: card.memoryAndRetention,
    endpoint: card.endpoint,
    publicKey: card.publicKey,
  });
}

export class FederationClient {
  constructor(private readonly allowPrivateOrigins = false) {}

  async previewAgentCard(manifestUrl: string): Promise<AgentCardPreview> {
    const result = await safeFetch(manifestUrl, this.allowPrivateOrigins, { method: "GET" }, MAX_MANIFEST_BYTES);
    const parsed = agentCardSchema.parse(JSON.parse(result.body)) as AgentCard;
    const manifestOrigin = result.url.origin;
    const cardOrigin = new URL(parsed.origin).origin;
    const endpointOrigin = new URL(parsed.endpoint).origin;
    if (manifestOrigin !== cardOrigin || endpointOrigin !== cardOrigin) {
      throw new Error("Agent card origin, manifest origin, and invocation endpoint must match");
    }
    return {
      card: parsed,
      manifestUrl: result.url.toString(),
      manifestDigest: digestJson(parsed),
      firstContactWarning: `This is the first interaction with ${cardOrigin}. Suminar verifies origin and message integrity, not scholarly accuracy.`,
    };
  }

  async invoke(card: AgentCard, envelope: InvocationEnvelope): Promise<ResponseEnvelope> {
    const result = await safeFetch(card.endpoint, this.allowPrivateOrigins, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    }, MAX_RESPONSE_BYTES);
    if (result.url.origin !== new URL(card.origin).origin) throw new Error("Invocation redirected to a different origin");
    const response = responseEnvelopeSchema.parse(JSON.parse(result.body)) as ResponseEnvelope;
    validateResponseEnvelope(response, card, envelope);
    return response;
  }
}

export function validateResponseEnvelope(response: ResponseEnvelope, card: AgentCard, invocation: InvocationEnvelope): void {
  if (response.agentId !== card.agentId) throw new Error("Remote response agent identity does not match the invited agent");
  if (response.replyToInvocationId !== invocation.invocationId) throw new Error("Remote response does not match the invocation");
  if (response.agentVersion !== card.agentVersion) throw new Error("Remote response agent version does not match its card");
  if (response.agentCardDigest !== digestJson(card)) throw new Error("Remote response was produced under a different agent card");
  if (response.contentHash !== sha256(response.authoredMessage)) throw new Error("Remote response content hash is invalid");
  if (!verifyResponseEnvelopeSignature(response, card.publicKey)) throw new Error("Remote response signature is invalid");
  if (response.authoredMessage.length > invocation.responseConstraints.maxAuthoredMessageChars) throw new Error("Remote authored message exceeds the response limit");
  if (containsHiddenAdministrativeNarration(response.authoredMessage)) {
    throw new Error("Remote response narrates quotation administration or hidden runtime state");
  }
  const quotes = extractQuotedSegments(response.authoredMessage);
  if (hasUnmarkedExactQuotationSection(response.authoredMessage)) {
    throw new Error("Remote response contains an unmarked Exact quotation section");
  }
  if (quotes.length > invocation.responseConstraints.maxQuotes) throw new Error("Remote response contains too many quotations");
  if (quotes.some((quote) => quote.length > invocation.responseConstraints.maxQuoteChars)) throw new Error("Remote response contains an oversized quotation");
  if (quotes.reduce((sum, quote) => sum + quote.length, 0) > invocation.responseConstraints.maxTotalQuoteChars) {
    throw new Error("Remote response exceeds the total quotation budget");
  }
  if (invocation.responseConstraints.maxDirectQuoteWords !== undefined
      && quotes.reduce((sum, quote) => sum + countWords(quote), 0) > invocation.responseConstraints.maxDirectQuoteWords) {
    throw new Error("Remote response exceeds the host-supplied quotation word budget");
  }
}

export class HttpsAgentTransport implements AgentTransport {
  constructor(private readonly client: FederationClient) {}
  invoke(_agent: AgentRef, card: AgentCard, envelope: InvocationEnvelope): Promise<ResponseEnvelope> {
    return this.client.invoke(card, envelope);
  }
}

export class GatewayAgentTransport implements AgentTransport {
  async invoke(): Promise<ResponseEnvelope> {
    throw new Error("Gateway transport is reserved for a future Toolcog-style broker and is not configured");
  }
}
