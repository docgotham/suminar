import type { SupabaseClient } from "@supabase/supabase-js";
import type { LocalAgentInvoker } from "../core/conversationService.js";
import type { InvocationEnvelope, LocalAgentManifest, ResponseEnvelope } from "../core/types.js";
import { isPilotLimitMessage } from "./limits.js";

// Meters hosted source-agent invocations against the account's pilot quota.
// The usage row is inserted before the model call — reserve, then spend — and
// the database trigger on invocation_usage is the enforcement point, so every
// write path shares one gate. Metered inference is paid work: if the
// reservation cannot be recorded, the invocation does not run (fail closed).
export class MeteredLocalInvoker implements LocalAgentInvoker {
  constructor(
    private readonly inner: LocalAgentInvoker,
    private readonly client: SupabaseClient,
    private readonly owner: string,
  ) {}

  async invoke(manifest: LocalAgentManifest, envelope: InvocationEnvelope): Promise<ResponseEnvelope> {
    const { error } = await this.client.from("invocation_usage").insert({
      owner: this.owner,
      agent_id: envelope.targetAgentId,
      invocation_id: envelope.invocationId,
    });
    if (error) {
      if (isPilotLimitMessage(error.message)) throw new Error(error.message);
      throw new Error(`Suminar could not meter this invocation, so it was not run: ${error.message}`);
    }
    return this.inner.invoke(manifest, envelope);
  }
}
