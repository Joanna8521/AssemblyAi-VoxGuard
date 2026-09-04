#!/usr/bin/env bash
#
# Find the chat ids a Telegram bot can see.
#
#   ./tools/telegram-chats.sh <bot-token>
#
# A bot only learns a chat exists once somebody speaks in it while the bot is a
# member, so an empty list usually means the bot is not in the group yet, or
# nobody has spoken since it joined, or Group Privacy is still on. Those three
# look identical from here, and the script says so rather than guessing.
set -euo pipefail

TOKEN="${1:-${TELEGRAM_BOT_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  echo "Usage: $0 <bot-token>     (or set TELEGRAM_BOT_TOKEN)" >&2
  exit 1
fi

RESPONSE="$(curl -sS "https://api.telegram.org/bot${TOKEN}/getUpdates")"

python3 - "$RESPONSE" <<'PY'
import json, sys

try:
    data = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print("Telegram did not return JSON. Check the token.")
    raise SystemExit(1)

if not data.get("ok"):
    # The token being wrong and the bot being idle produce very different
    # fixes, so the two are never reported as one.
    print(f"Telegram refused the request: {data.get('description', 'no reason given')}")
    print("That is a token problem, not a group problem.")
    raise SystemExit(1)

chats = {}
for update in data.get("result", []):
    message = update.get("message") or update.get("channel_post")
    if message:
        chat = message["chat"]
        chats[chat["id"]] = chat.get("title") or chat.get("first_name") or "(direct message)"

if not chats:
    print("The token works, but this bot has not seen any chat yet.")
    print()
    print("  1. Add the bot to the group (Group settings, Add members, search its @username)")
    print("  2. In BotFather: /mybots, the bot, Bot Settings, Group Privacy, Turn off")
    print("  3. Say anything in the group, then run this again")
    raise SystemExit(0)

width = max(len(name) for name in chats.values())
for chat_id, name in sorted(chats.items(), key=lambda kv: kv[1]):
    print(f"  {name.ljust(width)}   {chat_id}")
print()
print("Put the numbers into .env as TELEGRAM_OPS_CHAT_ID and TELEGRAM_CUSTOMER_CHAT_ID.")
PY
