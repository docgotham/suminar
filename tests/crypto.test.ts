import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  digestJson,
  generateSigningKeyPair,
  sha256,
  signResponseEnvelope,
  verifyResponseEnvelopeSignature,
} from "../src/core/crypto.js";
import { PROTOCOL_VERSION } from "../src/core/types.js";

describe("canonical response signatures", () => {
  it("detects any alteration of the authored message", () => {
    const keys = generateSigningKeyPair();
    const authoredMessage = "Wang et al. qualify the broader claim.";
    const response = signResponseEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      messageId: randomUUID(),
      replyToInvocationId: randomUUID(),
      agentId: "agent_wang",
      agentVersion: "1.0.0",
      agentCardDigest: digestJson({ card: true }),
      authoredMessage,
      citations: [],
      contentHash: sha256(authoredMessage),
    }, keys.privateKey);
    expect(verifyResponseEnvelopeSignature(response, keys.publicKey)).toBe(true);
    expect(verifyResponseEnvelopeSignature({ ...response, authoredMessage: `${authoredMessage} altered` }, keys.publicKey)).toBe(false);
  });
});
