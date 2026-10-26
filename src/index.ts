export default {
  async fetch(): Promise<Response> {
    return new Response("Manifest0-Ai is live (auto-deployed from GitHub).", { headers: { "content-type": "text/plain" } });
  },
};
