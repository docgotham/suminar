import { handleHostedAccountRequest } from "../dist/src/hosted/account.js";

export default {
  async fetch(request) {
    return handleHostedAccountRequest(request);
  },
};
