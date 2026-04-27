"use strict";
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const prisma = require("./db/client");
const router = express.Router();

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS;
const sessions = new Map();

function authRequired(req, res, next) {
  const sid = (req.headers.cookie || "").match(/admin_sid=([^;]+)/)?.[1];
  if (sid && sessions.has(sid)) return next();
  if (req.path === "/login" && req.method === "POST") return next();
  if (req.path === "/login") return res.sendFile(path.join(__dirname, "../web/admin-login.html"));
  return res.redirect("/admin/login");
}
router.use(authRequired);

router.post("/login", express.json(), (req, res) => {
  const { user, pass } = req.body;
  if (!ADMIN_PASS) return res.status(500).json({ error: "ADMIN_PASS not set" });
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const sid = crypto.randomBytes(32).toString("hex");
    sessions.set(sid, { ts: Date.now() });
    for (const [k, v] of sessions) { if (Date.now() - v.ts > 86400000) sessions.delete(k); }
    res.setHeader("Set-Cookie", `admin_sid=${sid}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=86400`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Invalid credentials" });
});

router.post("/logout", (req, res) => {
  const sid = (req.headers.cookie || "").match(/admin_sid=([^;]+)/)?.[1];
  if (sid) sessions.delete(sid);
  res.setHeader("Set-Cookie", "admin_sid=; Path=/admin; Max-Age=0");
  res.json({ ok: true });
});

router.get("/", (req, res) => res.sendFile(path.join(__dirname, "../web/admin.html")));

router.get("/api/overview", async (req, res) => {
  try {
    const [tot, setup, txC, msgC] = await Promise.all([
      prisma.user.count(), prisma.user.count({ where: { setup: true } }),
      prisma.transaction.count(), prisma.message.count(),
    ]);
    const wk = new Date(Date.now() - 7 * 86400000), mo = new Date(Date.now() - 30 * 86400000);
    const [a7, a30] = await Promise.all([
      prisma.transaction.findMany({ where: { createdAt: { gte: wk } }, select: { userId: true }, distinct: ["userId"] }),
      prisma.transaction.findMany({ where: { createdAt: { gte: mo } }, select: { userId: true }, distinct: ["userId"] }),
    ]);
    const langs = await prisma.user.groupBy({ by: ["language"], _count: true, where: { setup: true } });
    res.json({
      totalUsers: tot, setupUsers: setup, setupRate: tot > 0 ? Math.round(setup / tot * 100) : 0,
      active7d: a7.length, active30d: a30.length,
      totalTransactions: txC, totalMessages: msgC,
      languages: langs.map(l => ({ lang: l.language, count: l._count })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/users", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id:true, telegramId:true, setup:true, language:true, balanceCents:true, incomeCents:true, savingsCents:true, savingRateBps:true, payday:true, createdAt:true, updatedAt:true,
        _count: { select: { transactions:true, messages:true, drains:true, pools:true } } },
      orderBy: { updatedAt: "desc" },
    });
    res.json(users.map(u => ({
      id:u.id, telegramId:u.telegramId||null, setup:u.setup, language:u.language,
      balanceUSD:(u.balanceCents/100).toFixed(2), incomeUSD:(u.incomeCents/100).toFixed(2),
      savingsUSD:(u.savingsCents/100).toFixed(2), savingRate:(u.savingRateBps/100).toFixed(1)+"%",
      payday:u.payday, createdAt:u.createdAt, lastActive:u.updatedAt,
      txCount:u._count.transactions, msgCount:u._count.messages,
      drainCount:u._count.drains, poolCount:u._count.pools,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/costs", async (req, res) => {
  try {
    const now = new Date();
    const td = new Date(now.toISOString().slice(0,10)+"T00:00:00Z");
    const wk = new Date(now - 7*86400000), mo = new Date(now - 30*86400000);
    const [today, week, month, total] = await Promise.all([
      prisma.apiLog.aggregate({ where:{createdAt:{gte:td}}, _sum:{costCents:true,promptTokens:true,outputTokens:true}, _count:true }),
      prisma.apiLog.aggregate({ where:{createdAt:{gte:wk}}, _sum:{costCents:true,promptTokens:true,outputTokens:true}, _count:true }),
      prisma.apiLog.aggregate({ where:{createdAt:{gte:mo}}, _sum:{costCents:true,promptTokens:true,outputTokens:true}, _count:true }),
      prisma.apiLog.aggregate({ _sum:{costCents:true,promptTokens:true,outputTokens:true}, _count:true }),
    ]);
    const byModel = await prisma.apiLog.groupBy({ by:["model"], where:{createdAt:{gte:mo}}, _sum:{costCents:true,totalTokens:true}, _count:true });
    const byEnd = await prisma.apiLog.groupBy({ by:["endpoint"], where:{createdAt:{gte:mo}}, _sum:{costCents:true}, _count:true });
    const f = a => ({ calls:a._count, costUSD:((a._sum.costCents||0)/10000).toFixed(4), promptTokens:a._sum.promptTokens||0, outputTokens:a._sum.outputTokens||0 });
    res.json({
      today:f(today), week:f(week), month:f(month), total:f(total),
      byModel: byModel.map(m=>({model:m.model,calls:m._count,costUSD:((m._sum.costCents||0)/10000).toFixed(4),tokens:m._sum.totalTokens||0})),
      byEndpoint: byEnd.map(e=>({endpoint:e.endpoint,calls:e._count,costUSD:((e._sum.costCents||0)/10000).toFixed(4)})),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/activity", async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 14;
    const since = new Date(Date.now() - days * 86400000);
    const txs = await prisma.transaction.findMany({ where:{createdAt:{gte:since}}, select:{date:true,type:true,amountCents:true}, orderBy:{createdAt:"asc"} });
    const daily = {};
    for (const tx of txs) {
      if (!daily[tx.date]) daily[tx.date] = { date:tx.date, txCount:0, spentCents:0, earnedCents:0 };
      daily[tx.date].txCount++;
      if (tx.type==="income") daily[tx.date].earnedCents += tx.amountCents;
      else if (tx.type==="transaction"||tx.type==="bill_payment") daily[tx.date].spentCents += tx.amountCents;
    }
    res.json(Object.values(daily));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/financial", async (req, res) => {
  try {
    const users = await prisma.user.findMany({ where:{setup:true}, select:{balanceCents:true,savingsCents:true,incomeCents:true,savingRateBps:true} });
    let tB=0,tS=0,tI=0,tR=0;
    for (const u of users) { tB+=u.balanceCents; tS+=u.savingsCents; tI+=u.incomeCents; tR+=u.savingRateBps; }
    const n = users.length||1;
    const topP = await prisma.pool.groupBy({ by:["name"], where:{active:true}, _sum:{spentCents:true}, _count:true, orderBy:{_sum:{spentCents:"desc"}}, take:10 });
    const topD = await prisma.drain.groupBy({ by:["name"], where:{active:true}, _sum:{amountCents:true}, _count:true, orderBy:{_count:{_all:"desc"}}, take:10 });
    res.json({
      totalBalanceUSD:(tB/100).toFixed(2), totalSavingsUSD:(tS/100).toFixed(2),
      avgIncomeUSD:(tI/n/100).toFixed(2), avgSavingRate:(tR/n/100).toFixed(1)+"%",
      userCount:users.length,
      topPools: topP.map(p=>({name:p.name,spentUSD:((p._sum.spentCents||0)/100).toFixed(2),users:p._count})),
      topDrains: topD.map(d=>({name:d.name,amountUSD:((d._sum.amountCents||0)/100).toFixed(2),users:d._count})),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const lastLog = await prisma.apiLog.findFirst({ orderBy:{createdAt:"desc"}, select:{createdAt:true,model:true} });
    const lastTx = await prisma.transaction.findFirst({ orderBy:{createdAt:"desc"}, select:{createdAt:true} });
    res.json({ db:"connected", lastApiCall:lastLog?.createdAt||null, lastApiModel:lastLog?.model||null, lastTransaction:lastTx?.createdAt||null, ts:new Date().toISOString() });
  } catch (e) { res.json({ db:"disconnected", error:e.message, ts:new Date().toISOString() }); }
});

// Cost per token in hundredths of a cent (divide by 100 for cents, by 10000 for dollars)
const COST_MAP = {
  "gpt-4o-mini": { prompt: 15, output: 60 },
  "claude-sonnet-4-20250514": { prompt: 300, output: 1500 },
  "claude-haiku-4-5-20251001": { prompt: 80, output: 400 },
};

async function logApiCall(userId, model, promptTokens, outputTokens, endpoint) {
  const rates = COST_MAP[model] || { prompt: 10, output: 40 };
  const costCents = Math.round(promptTokens * rates.prompt / 100 + outputTokens * rates.output / 100);
  try {
    await prisma.apiLog.create({
      data: { userId, model, promptTokens, outputTokens, totalTokens: promptTokens + outputTokens, costCents, endpoint },
    });
  } catch (e) { console.error("ApiLog err:", e.message); }
}

module.exports = { router, logApiCall };
