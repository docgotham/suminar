import { handleHostedMcpRequest } from "../dist/src/hosted/mcp.js";

export default {
  async fetch(request) {
    return handleHostedMcpRequest(request);
  },
};
