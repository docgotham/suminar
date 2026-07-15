import { handleHostedOAuthRequest } from "../dist/src/hosted/oauth.js";

export default {
  async fetch(request) {
    return handleHostedOAuthRequest(request);
  },
};
