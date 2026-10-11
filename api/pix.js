// POST /api/pix?f=<etapa>   (etapa: front, back, up1 ... up10)
// Cria a cobrança Pix na FlevoPay. O valor vem da tabela STEPS (_lib.js), nunca do navegador.
const crypto = require("crypto");
const {
  STEPS, soDigitos, cpfValido, telefoneValido, reais, queryDaPagina, lerCorpo, flevo,
  tokenDoWebhook, urlBase, lerCookie,
} = require("./_lib");

// Mesma etapa + mesmo CPF dentro da validade do Pix devolve o Pix que ja existe, em vez de abrir outra
// cobranca na FlevoPay (cliques repetidos, "tentar de novo", varias abas). Fica na memoria da instancia:
// protege as chamadas em sequencia; o front tambem reaproveita o Pix (api-pix.js).
const VALIDADE_MS = 15 * 60 * 1000;
const recentes = new Map();   // "etapa:cpf" -> { inicio, resultado } | { inicio, promessa }

function limparVencidos() {
  const agora = Date.now();
  for (const [k, v] of recentes) if (agora - v.inicio > VALIDADE_MS) recentes.delete(k);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });

  const step = String(req.query.f || "");
  const cfg = STEPS[step];
  if (!cfg) return res.status(400).json({ error: "Etapa inválida." });

  const body = await lerCorpo(req);
  const nome = String(body.nome || "").trim();
  const email = String(body.email || "").trim();
  const cpf = soDigitos(body.cpf);
  const telefone = soDigitos(body.telefone);
  if (!nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Informe nome e e-mail válidos." });
  }
  if (!cpfValido(cpf)) return res.status(400).json({ error: "CPF inválido." });
  if (!telefoneValido(telefone)) return res.status(400).json({ error: "Telefone inválido (DDD + número)." });

  const q = queryDaPagina(req, body.utm);
  const tracking = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "src", "sck"]) {
    if (q.get(k)) tracking[k] = q.get(k);
  }

  // O prefixo da referência é a etapa: o /api/status confere isso antes de aceitar uma consulta.
  const reference = `${step}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

  // Webhook desta cobrança. O token prova que a URL saiu daqui; o resto é o contexto do cliente
  // (a FlevoPay chama o webhook sozinha, sem cookie nem IP do navegador) para o Purchase do TikTok.
  const base = urlBase(req);
  let postbackUrl;
  if (base) {
    const p = new URLSearchParams({ k: tokenDoWebhook(reference) });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ua = String(req.headers["user-agent"] || "").slice(0, 300);
    const ttp = lerCookie(req, "_ttp");
    if (ip) p.set("ip", ip);
    if (ua) p.set("ua", ua);
    if (ttp) p.set("ttp", ttp);
    if (q.get("ttclid")) p.set("ttclid", q.get("ttclid"));
    postbackUrl = `${base}/api/webhook?${p}`;
  }

  async function criarCobranca() {
    const t0 = Date.now();
    const r = await flevo("/transaction", {
      method: "POST",
      body: JSON.stringify({
        amount: cfg.amount,
        description: cfg.name,
        reference,
        ...(postbackUrl ? { postback_url: postbackUrl } : {}),
        source: "api_externa",
        customer: { name: nome, email, document: cpf, phone: telefone },
        tracking,
      }),
    });

    const d = r.dados || {};
    console.log("[pix] FlevoPay respondeu", JSON.stringify({ reference, http: r.status, ms: Date.now() - t0, id: d.transaction_id }));
    if (!r.ok || d.status !== "success" || !d.qr_code || !d.transaction_id) {
      console.error("FlevoPay recusou a criação:", r.status, JSON.stringify(d));
      return null;
    }
    return { pix_code: d.qr_code, payment_code: String(d.transaction_id), price_label: reais(cfg.amount) };
  }

  const chave = `${step}:${cpf}`;
  // Diagnostico: cada linha e uma chamada a /api/pix (aparece nos Logs da Vercel).
  console.log("[pix] chamada", JSON.stringify({
    step, reference, repetida: recentes.has(chave),
    referer: String(req.headers.referer || "").slice(0, 120),
    ua: String(req.headers["user-agent"] || "").slice(0, 80),
  }));
  try {
    limparVencidos();
    let existente = recentes.get(chave);
    if (!existente) {
      existente = { inicio: Date.now() };
      existente.promessa = criarCobranca();
      recentes.set(chave, existente);
    }
    // Chamadas simultaneas esperam a mesma criacao; se falhar, libera a chave para tentar de novo.
    const resultado = await existente.promessa;
    if (!resultado) {
      if (recentes.get(chave) === existente) recentes.delete(chave);
      return res.status(502).json({ error: "Não foi possível gerar o Pix. Tente novamente." });
    }
    return res.status(200).json(resultado);
  } catch (e) {
    if (recentes.get(chave)?.promessa) recentes.delete(chave);
    console.error("Erro ao criar Pix:", e);
    return res.status(500).json({ error: "Erro interno ao gerar o Pix." });
  }
};
