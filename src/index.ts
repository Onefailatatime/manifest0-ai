export default {
  async fetch(): Promise<Response> {
    return new Response("Manifest0-Ai is live.", { headers: { "content-type": "text/plain" } });
  },
};
