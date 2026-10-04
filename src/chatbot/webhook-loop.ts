import type { DiscordMessage } from "./chatbot-context";

const MAX_WEBHOOK_RESPONSES = 4;

export class WebhookLoopTracker {
  private channels = new Map<string, Map<string, number>>();

  observe(message: DiscordMessage, botUserId: string) {
    if (
      message.author?.id &&
      message.author.id !== botUserId &&
      !message.author.bot &&
      !message.webhook_id
    ) {
      this.channels.delete(message.channel_id);
    }
  }

  allowResponse(message: DiscordMessage) {
    if (!message.webhook_id) return true;

    let webhooks = this.channels.get(message.channel_id);
    if (!webhooks) {
      webhooks = new Map();
      this.channels.set(message.channel_id, webhooks);
    }
    const count = webhooks.get(message.webhook_id) ?? 0;
    if (count >= MAX_WEBHOOK_RESPONSES) return false;
    webhooks.set(message.webhook_id, count + 1);
    return true;
  }
}
