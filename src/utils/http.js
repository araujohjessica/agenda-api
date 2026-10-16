export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === "function") out.catch(next);
  } catch (e) {
    next(e);
  }
};

const LABELS = {
  email: "e-mail", name: "nome", phone: "celular", password: "senha", new_password: "nova senha", current_password: "senha atual",
  code: "código", slot_id: "horário", consent: "aceite da política de privacidade", notes: "observações", reason: "motivo",
  start_date: "data inicial", end_date: "data final", start_time: "horário inicial", end_time: "horário final", date: "data",
  weekdays: "dias da semana", interval_minutes: "intervalo", duration_minutes: "duração", location_id: "local", kind: "tipo",
  detail: "detalhe", min_notice_hours: "antecedência mínima", cancel_limit_hours: "prazo de cancelamento",
  session_minutes: "duração da consulta", slug: "endereço da agenda", headline: "título", bio: "apresentação",
  status: "status", amount: "valor", description: "descrição", category: "categoria", method: "forma de pagamento", paid_at: "data do pagamento", price: "valor da consulta", payment: "pagamento", office_address: "endereço do consultório", office_city: "cidade", session_price: "valor da consulta", month: "mês", from: "data inicial", to: "data final",
};

// Converte os erros do Joi (em inglês) para mensagens claras em português.
function translate(d) {
  const key = String(d.path[d.path.length - 1] ?? "");
  const field = LABELS[key] ?? "informado";
  const label = LABELS[key] ? `O campo ${LABELS[key]}` : "Um dos campos";
  const { limit } = d.context;
  switch (d.type) {
    case "any.required":
    case "string.empty":
      return `Preencha o campo ${field}.`;
    case "string.email":
      return "Informe um e-mail válido.";
    case "string.min":
      return `${label} precisa ter pelo menos ${limit} caracteres.`;
    case "string.max":
      return `${label} pode ter no máximo ${limit} caracteres.`;
    case "string.pattern.base":
      if (key === "code") return "O código deve ter 6 dígitos.";
      if (key === "slug") return "O endereço deve ter de 3 a 60 caracteres, usando letras minúsculas, números e hífen.";
      if (/time/.test(key)) return `Informe um ${field} válido no formato HH:MM.`;
      if (/date|from|to|month/.test(key)) return `Informe uma ${field} válida.`;
      return `${label} está em um formato inválido.`;
    case "number.base":
    case "number.integer":
    case "number.unsafe":
      return `${label} deve ser um número válido.`;
    case "number.min":
      return `${label} deve ser no mínimo ${limit}.`;
    case "number.max":
      return `${label} deve ser no máximo ${limit}.`;
    case "any.only":
      return key === "consent" ? "É necessário aceitar a política de privacidade para continuar." : `${label} tem um valor não permitido.`;
    case "object.min":
      return "Informe pelo menos um campo para atualizar.";
    case "array.min":
      return key === "weekdays" ? "Selecione pelo menos um dia da semana." : `${label} precisa ter ao menos um item.`;
    default:
      return `${label} é inválido.`;
  }
}

// Valida req.body/req.query com um schema Joi e devolve o valor normalizado.
export function validate(schema, data) {
  const { value, error } = schema.validate(data, { abortEarly: false, stripUnknown: true, convert: true });
  if (error) {
    const details = [...new Set(error.details.map(translate))];
    const err = new HttpError(400, details.length === 1 ? details[0] : "Confira os dados informados.");
    err.details = details.length === 1 ? undefined : details;
    throw err;
  }
  return value;
}

export function errorHandler(err, _req, res, _next) {
  if (err.status) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "Este registro já existe." });
  console.error(err);
  res.status(500).json({ error: "Algo deu errado do nosso lado. Tente novamente em instantes." });
}
