/**
 * Telegram, the first adapter that actually reaches somebody.
 *
 * It was chosen because it is the cheapest thing to configure that is genuinely
 * irreversible. A sent message cannot be unsent, which is what makes it worth
 * governing and what makes the demo mean anything: when the policy allows, a
 * message appears in a real chat, and when it does not, the chat stays empty.
 * The absence is the evidence, and no animation of ours can stand in for it.
 */

const API = 'https://api.telegram.org';

const CHATS = {
  ops: () => process.env.TELEGRAM_OPS_CHAT_ID,
  customer: () => process.env.TELEGRAM_CUSTOMER_CHAT_ID,
};

export function telegramConfigured(channel) {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && CHATS[channel]?.());
}

/**
 * What is obviously wrong with the configuration, before anything is sent.
 *
 * Group chat ids are negative, and the minus is the easiest character in the
 * world to lose between a terminal and a text editor. Without it the id points
 * at a user who does not exist and Telegram says "chat not found", which sounds
 * like a permissions problem and sends you looking in the wrong place. It cost
 * an afternoon once; it should cost a startup warning from now on.
 */
export function telegramProblems() {
  const problems = [];
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (token && !/^\d+:[\w-]{30,}$/.test(token.trim())) {
    problems.push('TELEGRAM_BOT_TOKEN does not look like a bot token (digits, a colon, then a long key)');
  }

  for (const [channel, read] of Object.entries(CHATS)) {
    const raw = read();
    if (!raw) continue;
    const value = raw.trim();
    const name = `TELEGRAM_${channel.toUpperCase()}_CHAT_ID`;

    if (!/^-?\d+$/.test(value)) {
      problems.push(`${name} is "${value}", which is not a chat id. It is a number, not a group name.`);
    } else if (!value.startsWith('-') && value.length >= 8) {
      problems.push(`${name} is ${value} with no minus sign. Group ids are negative; this one is probably -${value}.`);
    }
  }

  return problems;
}

/**
 * @param {'ops'|'customer'} channel
 * @param {string} text
 * @returns {Promise<string>} what to show in the audit trail
 */
export async function sendTelegram(channel, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = CHATS[channel]?.();
  if (!token || !chatId) throw new Error(`the ${channel} chat is not configured`);

  const label = channel === 'customer'
    ? 'a Telegram chat standing in for the customer channel'
    : 'the operations chat';

  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      // Nothing here is authored by us, so it is sent as plain text. Handing
      // Telegram markup built from a policy someone dictated would be a way to
      // turn a transcription slip into a formatting bug at best.
      disable_web_page_preview: true,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(body.description ?? `Telegram returned ${res.status}`);
  }

  return `delivered to ${label}, message ${body.result?.message_id ?? '?'}`;
}
