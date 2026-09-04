#!/usr/bin/env bash
#
# Find the chat ids a Telegram bot can see, and say why it cannot see any.
#
#   ./tools/telegram-chats.sh <bot-token>
#
# Four different situations produce an empty list and they need four different
# fixes: a wrong token, a webhook swallowing the updates, a bot nobody has
# spoken to, and Group Privacy hiding the messages that were sent. They are
# indistinguishable from the empty list alone, so each is checked by name.
set -euo pipefail

TOKEN="${1:-${TELEGRAM_BOT_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  echo "Usage: $0 <bot-token>     (or set TELEGRAM_BOT_TOKEN)" >&2
  exit 1
fi

ME="$(curl -sS "https://api.telegram.org/bot${TOKEN}/getMe")"
HOOK="$(curl -sS "https://api.telegram.org/bot${TOKEN}/getWebhookInfo")"
UPDATES="$(curl -sS "https://api.telegram.org/bot${TOKEN}/getUpdates")"

python3 - "$ME" "$HOOK" "$UPDATES" <<'PY'
import json, sys

def load(raw, what):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        print(f"Telegram did not return JSON for {what}. Check the token.")
        raise SystemExit(1)

me, hook, updates = (load(a, n) for a, n in
                     zip(sys.argv[1:4], ("getMe", "getWebhookInfo", "getUpdates")))

if not me.get("ok"):
    print(f"Telegram refused the token: {me.get('description', 'no reason given')}")
    print("That is a token problem, not a group problem.")
    raise SystemExit(1)

bot = me["result"]
print(f"Bot: {bot.get('first_name')}  @{bot.get('username')}")
print(f"  can read all group messages: {'yes' if bot.get('can_read_all_group_messages') else 'no, Group Privacy is on'}")

webhook = (hook.get("result") or {}).get("url") or ""
if webhook:
    # A webhook takes the updates instead, so getUpdates is empty no matter how
    # much anyone says. Nothing else here can be diagnosed until it is gone.
    print()
    print(f"A webhook is set: {webhook}")
    print("Telegram delivers updates there instead, so getUpdates will always be empty.")
    print(f"  Clear it:  curl -s 'https://api.telegram.org/bot<token>/deleteWebhook'")
    raise SystemExit(0)

chats = {}
for update in updates.get("result", []):
    message = update.get("message") or update.get("channel_post")
    if message:
        chat = message["chat"]
        chats[chat["id"]] = chat.get("title") or chat.get("first_name") or "(direct message)"

print()
if chats:
    width = max(len(name) for name in chats.values())
    for chat_id, name in sorted(chats.items(), key=lambda kv: kv[1]):
        print(f"  {name.ljust(width)}   {chat_id}")
    print()
    print("Put the numbers into .env as TELEGRAM_OPS_CHAT_ID and TELEGRAM_CUSTOMER_CHAT_ID.")
    raise SystemExit(0)

print("The token works and no webhook is in the way, but no chat has spoken to it.")
print()
print(f"  Fastest: open Telegram, search @{bot.get('username')}, press Start, run this again.")
print("  A direct message always arrives, whatever Group Privacy is set to.")
if not bot.get("can_read_all_group_messages"):
    print()
    print("  For groups you will also need Group Privacy off:")
    print("  BotFather, /mybots, this bot, Bot Settings, Group Privacy, Turn off.")
PY
