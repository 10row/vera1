"use strict";
require("dotenv").config({ override: true });
const { runScenario } = require("./driver");
const bot = require("../bot");
const orig = bot.processCallbackData;
bot.processCallbackData = async function(prisma, ctx, telegramId, data) {
  console.log("[probe] callback data=" + data + " telegramId=" + telegramId);
  return orig.call(this, prisma, ctx, telegramId, data);
};
const scen = require("./scenarios/06-cancel-confirm");
(async () => {
  const r = await runScenario(scen);
  console.log(r.rendered);
})();
