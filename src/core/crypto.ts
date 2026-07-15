import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import type { ResponseEnvelope } from "./types.js";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestJson(value: unknown): string {
  return sha256(stableStringify(value));
}

export interface SigningKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

function signingPayload(envelope: Omit<ResponseEnvelope, "signature">): string {
  return stableStringify(envelope);
}

export function signResponseEnvelope(
  envelope: Omit<ResponseEnvelope, "signature">,
  privateKeyPem: string,
): ResponseEnvelope {
  const signature = sign(null, Buffer.from(signingPayload(envelope)), createPrivateKey(privateKeyPem)).toString("base64");
  return { ...envelope, signature };
}

export function verifyResponseEnvelopeSignature(envelope: ResponseEnvelope, publicKeyPem: string): boolean {
  const { signature, ...unsigned } = envelope;
  try {
    return verify(
      null,
      Buffer.from(signingPayload(unsigned)),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function extractQuotedSegments(markdown: string): string[] {
  const segments: string[] = [];
  const patterns = [/“([^”]+)”/gs, /\"([^\"\n]+)\"/g];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const text = match[1]?.trim();
      if (text && !segments.includes(text)) segments.push(text);
    }
  }
  return segments;
}

export function hasUnmarkedExactQuotationSection(markdown: string): boolean {
  const sections = markdown.matchAll(
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?Exact quotations?\b[^\n]*(?:\*\*)?\s*\n([\s\S]*?)(?=\n\s*\n|$)/gi,
  );
  for (const section of sections) {
    if (section[1]?.trim() && extractQuotedSegments(section[1]).length === 0) return true;
  }
  return false;
}

export function removeExactQuotationSections(markdown: string): string {
  return markdown.replace(
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?Exact quotations?\b[^\n]*(?:\*\*)?\s*\n[\s\S]*?(?=\n\s*\n|$)/gi,
    "",
  ).replace(/\n{3,}/g, "\n\n").trim();
}

export function countWords(value: string): number {
  return value.trim().match(/\S+/gu)?.length ?? 0;
}

export function containsHiddenAdministrativeNarration(markdown: string): boolean {
  const normalized = markdown.replace(/\s+/g, " ");
  const quotationAccounting = /\b(?:quotation|quote)\s+(?:word\s+)?(?:budget|allowance|quota)\b/i.test(normalized)
    || /\b(?:budget|allowance|quota)\s+(?:for\s+)?(?:an?\s+)?(?:direct\s+)?quotation\b/i.test(normalized);
  const selfReferentialQuotationRule = /\b(?:the|this|your|my)\s+(?:instruction|constraint|limit|runtime|system|host|validator|policy)\w*\b.{0,100}\b(?:direct\s+)?quot(?:e|ation)s?\b/i.test(normalized)
    || /\b(?:direct\s+)?quot(?:e|ation)s?\b.{0,100}\b(?:the|this|your|my)\s+(?:instruction|constraint|limit|runtime|system|host|validator|policy)\w*\b/i.test(normalized);
  const explicitRuntimeNarration = /\b(?:system|runtime|validator|host)\b.{0,60}\b(?:requires?|allows?|forbids?|rejects?|limits?|prevents?|retries?|routes?)\b/i.test(normalized);
  const evidencePacketNarration = /\b(?:available|provided|supplied|bounded|private)\s+(?:source\s+)?evidence\b/i.test(normalized)
    || /\b(?:requested|current|supplied)\s+constraints?\b/i.test(normalized);
  return quotationAccounting || selfReferentialQuotationRule || explicitRuntimeNarration || evidencePacketNarration;
}
