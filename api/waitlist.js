import { handleHostedWaitlistRequest } from "../dist/src/hosted/waitlist.js";

export default {
  async fetch(request) {
    return handleHostedWaitlistRequest(request);
  },
};
