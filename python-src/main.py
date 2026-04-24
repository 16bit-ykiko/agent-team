"""Discord Agent Team — entrypoint."""

import asyncio
import atexit
import logging
import os
import signal
import tomllib
from datetime import datetime

import discord
from discord import app_commands

from src.bot import AgentTeamBot
from src.commands import register_commands

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
os.makedirs(".logs", exist_ok=True)
_log_file = f".logs/bot_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
logging.basicConfig(
    level=logging.INFO,
    format=LOG_FORMAT,
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(_log_file, encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)


def load_config() -> dict:
    with open("config.toml", "rb") as f:
        return tomllib.load(f)


def load_env():
    try:
        with open(".env") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())
    except FileNotFoundError:
        pass


async def main():
    load_env()
    config = load_config()

    # Use the planner token as the single bot token
    token = os.environ.get("PLANNER_TOKEN", "")
    if not token:
        log.error("Missing PLANNER_TOKEN in .env")
        return

    guild_id = config.get("discord", {}).get("guild_id", "")
    if not guild_id:
        log.error("Missing guild_id in config.toml")
        return

    guild_obj = discord.Object(id=int(guild_id))
    bot = AgentTeamBot(token, config)

    # Save state on exit
    def save_all():
        try:
            bot.save_state()
        except Exception as e:
            log.error("Failed to save state on exit: %s", e)
        log.info("State saved on exit.")

    atexit.register(save_all)

    def signal_handler(sig, _frame):
        log.info("Received signal %s, saving state...", sig)
        save_all()
        signal.signal(sig, signal.SIG_DFL)
        os.kill(os.getpid(), sig)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    # Setup commands after bot is ready
    @bot.client.event
    async def on_ready():
        log.info("Bot ready as %s", bot.client.user)

        tree = app_commands.CommandTree(bot.client)
        register_commands(tree, guild_obj, bot, config)
        bot.client._tree = tree
        await tree.sync(guild=guild_obj)
        log.info("Commands synced for guild %s", guild_id)

        bot.load_state()

    try:
        await bot.start()
    except KeyboardInterrupt:
        log.info("Shutting down...")
    finally:
        await bot.close()


def run():
    asyncio.run(main())


if __name__ == "__main__":
    run()
