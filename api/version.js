import { handleHostedVersionRequest } from "../dist/src/hosted/version.js";

export default {
  async fetch() {
    return handleHostedVersionRequest();
  },
};
