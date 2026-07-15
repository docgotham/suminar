import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./suminar/config.js";
import { createSuminarMcpServer } from "./suminar/mcp.js";
import { createSuminarConversationService } from "./suminar/service.js";
import { LocalStore } from "./core/storage.js";

const config = loadConfig();
const store = new LocalStore(config.dataDir);
store.ensureLayout();
const service = createSuminarConversationService(config, store);
await createSuminarMcpServer(service).connect(new StdioServerTransport());
