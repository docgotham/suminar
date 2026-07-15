import { ConversationService } from "../core/conversationService.js";
import type { LocalAgentInvoker } from "../core/conversationService.js";
import type { ConversationStore } from "../core/storage.js";
import { LocalSourceAgent, OpenAiAnswerGenerator } from "./localAgent.js";
import type { AnswerGenerator } from "./localAgent.js";
import { LocalArtifactReader } from "./artifacts.js";
import type { ArtifactReader } from "./artifacts.js";
import type { AppConfig } from "./config.js";

// Wires the Suminar product layer (scholarly representatives, retrieval,
// validation) into the framework's conversation runtime. wrapLocalInvoker lets
// a deployment interpose on invocations (the hosted layer meters quota there)
// without owning representative construction.
export function createSuminarConversationService(
  config: AppConfig,
  store: ConversationStore,
  options: {
    answerGenerator?: AnswerGenerator;
    artifactReader?: ArtifactReader;
    wrapLocalInvoker?: (invoker: LocalAgentInvoker) => LocalAgentInvoker;
  } = {},
): ConversationService {
  const invoker = new LocalSourceAgent(
    options.answerGenerator ?? new OpenAiAnswerGenerator(config.openAiModel),
    options.artifactReader ?? new LocalArtifactReader(),
  );
  return new ConversationService(store, {
    allowPrivateOrigins: config.allowPrivateOrigins,
    localInvoker: options.wrapLocalInvoker ? options.wrapLocalInvoker(invoker) : invoker,
  });
}
