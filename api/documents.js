import { handleHostedDocumentsRequest } from "../dist/src/hosted/documents.js";

export default {
  async fetch(request) {
    return handleHostedDocumentsRequest(request);
  },
};
