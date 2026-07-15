import { handleHostedAdminRequest } from "../dist/src/hosted/admin.js";

export default {
  async fetch(request) {
    return handleHostedAdminRequest(request);
  },
};
