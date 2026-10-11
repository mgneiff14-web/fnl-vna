// POST /api/webhook?k=<token>&...   (chamado pela FlevoPay, uma URL por cobrança: ver postback_url em pix.js)
// Cobre a venda feita com a página fechada: quando o Pix é aprovado, dispara o Purchase do TikTok.
//
// A FlevoPay não assina o webhook, então nada do corpo é aceito só porque chegou:
//  1. o token `k` (HMAC da referência com a chave secreta) tem de bater com a referência do corpo;
//  2. o status e o valor são conferidos de novo direto na API da FlevoPay.
// Responde 200 para tudo que não precisa de nova tentativa e 500 só quando vale a pena reenviar.
const {
  STEPS, tokenValido, etapaDaReferencia, transacaoPorReferencia, enviarCompraTikTok,
} = require("./_lib");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });

  const corpo = req.body && typeof req.body === "object" ? req.body : {};
  const referencia = String(corpo.external_id || corpo.store_reference || "");
  const etapa = etapaDaReferencia(referencia);

  if (!referencia || !tokenValido(referencia, req.query.k)) {
    return res.status(403).json({ error: "Token inválido." });
  }
  if (!etapa) return res.status(200).json({ ok: true, ignorado: "referência desconhecida" });

  // Só a aprovação interessa; pending, refunded etc. são confirmados e ignorados.
  if (corpo.status !== "approved") return res.status(200).json({ ok: true, ignorado: corpo.status || "sem status" });

  try {
    const t = await transacaoPorReferencia(referencia);
    if (!t || t.status !== "approved" || Number(t.amount) !== STEPS[etapa].amount) {
      return res.status(200).json({ ok: true, ignorado: "não confirmado na FlevoPay" });
    }

    const cliente = corpo.customer || {};
    await enviarCompraTikTok({
      req,
      codigo: referencia,
      step: etapa,
      valorCentavos: STEPS[etapa].amount,
      email: cliente.email,
      telefone: cliente.phone,
      query: null,
      contexto: {
        ip: req.query.ip,
        userAgent: req.query.ua,
        ttp: req.query.ttp,
        ttclid: req.query.ttclid,
      },
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Erro no webhook:", e);
    return res.status(500).json({ error: "Falha ao confirmar a transação." });
  }
};
