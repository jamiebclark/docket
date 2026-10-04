import { setWebhookLoopbackForTests } from "../../src/server/net/safe-fetch";

// Webhook tests deliver to a receiver on 127.0.0.1, which the production policy refuses. The destination
// tests switch this off to prove the refusal.
setWebhookLoopbackForTests(true);
