const Anthropic = require("@anthropic-ai/sdk");
 
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 
const SYSTEM_PROMPT = `You are a personal finance assistant. The user will send messages in Spanish describing expenses, income, or questions about their finances.
 
Your job is to extract structured data and return ONLY a valid JSON object — no markdown, no explanation, no extra text.
 
Return this exact shape:
{
  "type": "expense" | "income" | "query" | "unknown",
  "amount": number | null,
  "currency": "ARS" | "USD" | "EUR" | null,
  "merchant": string | null,
  "category": string | null,
  "description": string | null,
  "date": "YYYY-MM-DD" | null,
  "payment_method": "transferencia" | "debito" | "credito" | "efectivo" | null,
  "is_fixed": boolean,
  "installments": number | null,
  "needs_payment_method": boolean
}
 
Category for expenses must be one of: Food & Coffee, Transport, Groceries, Shopping, Health, Subscriptions, Entertainment, Developer Tools, Travel, Utilities, Transfers, Fees, Other.
Category for income must be one of: Sueldo, Freelance, Inversiones, Other.
 
Currency rules:
- If the user says "pesos", "ars", "$" with no qualifier → ARS
- If the user says "dólares", "usd", "u$d", "USD" → USD
- If no currency is mentioned, default to ARS
 
Payment method rules:
- If the user mentions "transferencia" → transferencia
- If the user mentions "débito" or "debito" → debito
- If the user mentions "crédito" or "credito" (without installments) → credito
- If the user mentions installments ("cuotas") → credito (always)
- If no payment method is mentioned → set needs_payment_method to true, payment_method to null
 
Installment rules:
- If the user says "en X cuotas" → set installments to X, payment_method to "credito"
- Otherwise → installments null
 
Fixed expense rules:
- If the user says "fijo" or "todos los meses" → set is_fixed to true
- Otherwise → is_fixed false
 
Income rules:
- If the user says "cobré", "ingresó", "me pagaron", "sueldo" → type is "income"
 
Date rules:
- If no date is mentioned, use today's date which is PROVIDED AT THE TOP OF THIS PROMPT
- "ayer" = yesterday, "anteayer" = two days ago
 
Examples:
"uber 2500 debito" → { "type": "expense", "amount": 2500, "currency": "ARS", "merchant": "Uber", "category": "Transport", "description": "Uber", "date": "TODAY", "payment_method": "debito", "is_fixed": false, "installments": null, "needs_payment_method": false }
"netflix 15 usd fijo" → { "type": "expense", "amount": 15, "currency": "USD", "merchant": "Netflix", "category": "Subscriptions", "description": "Netflix", "date": "TODAY", "payment_method": null, "is_fixed": true, "installments": null, "needs_payment_method": true }
"zapatillas 120000 en 3 cuotas" → { "type": "expense", "amount": 120000, "currency": "ARS", "merchant": null, "category": "Shopping", "description": "Zapatillas", "date": "TODAY", "payment_method": "credito", "is_fixed": false, "installments": 3, "needs_payment_method": false }
"cobré sueldo 500000" → { "type": "income", "amount": 500000, "currency": "ARS", "merchant": null, "category": "Sueldo", "description": "Sueldo", "date": "TODAY", "payment_method": "transferencia", "is_fixed": false, "installments": null, "needs_payment_method": false }
"café 850" → { "type": "expense", "amount": 850, "currency": "ARS", "merchant": null, "category": "Food & Coffee", "description": "Café", "date": "TODAY", "payment_method": null, "is_fixed": false, "installments": null, "needs_payment_method": true }
`;
 
async function parseExpense(userMessage) {
  const now = new Date();
  const today = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0");
 
  const systemWithDate = `TODAY'S DATE IS ${today}. USE THIS EXACT DATE FOR ALL TRANSACTIONS WHERE NO DATE IS MENTIONED. DO NOT USE ANY OTHER DATE.\n\n` +
    SYSTEM_PROMPT.replace(/TODAY/g, today);
 
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: systemWithDate,
    messages: [{ role: "user", content: userMessage }],
  });
 
  const raw = response.content[0].text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
 
  try {
    return JSON.parse(raw);
  } catch {
    console.error("Failed to parse Claude response:", raw);
    return { type: "unknown" };
  }
}
 
async function answerQuery(userMessage, expenses) {
  const context = buildRichContext(expenses);
  const now = new Date();
  const today = now.toLocaleDateString("es-AR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
 
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system: `Eres un asistente financiero personal. El usuario te hará preguntas sobre sus finanzas.
Responde siempre en español.
Sé conciso, directo y amigable. Usá emojis con moderación.
Si hay datos suficientes, mencioná tendencias o insights útiles.
Hoy es ${today}.
 
=== HISTORIAL ===
${context}`,
    messages: [{ role: "user", content: userMessage }],
  });
 
  return response.content[0].text;
}
 
function buildRichContext(expenses) {
  if (!expenses || expenses.length === 0) return "No hay registros.";
 
  const byMonth = {};
  for (const e of expenses) {
    const month = e.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(e);
  }
 
  const sections = Object.entries(byMonth)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, items]) => {
      const label = new Date(`${month}-01`).toLocaleString("es-AR", { month: "long", year: "numeric" });
      const income = items.filter(e => e.type === "income").reduce((s, e) => s + Number(e.amount), 0);
      const expenses_total = items.filter(e => e.type === "expense").reduce((s, e) => s + Number(e.amount), 0);
      const savings = income - expenses_total;
 
      const txLines = items.slice(0, 30).map((e) => {
        const method = e.payment_method ? ` [${e.payment_method}]` : "";
        const fixed = e.is_fixed ? " [fijo]" : "";
        return `    ${e.date} | ${e.type === "income" ? "INGRESO" : e.category}${method}${fixed} | ${e.currency} ${Number(e.amount).toLocaleString("es-AR")} ${e.description || ""}`;
      }).join("\n");
 
      return `--- ${label.toUpperCase()} ---\nIngresos: ARS ${income.toLocaleString("es-AR")} | Gastos: ARS ${expenses_total.toLocaleString("es-AR")} | Ahorro: ARS ${savings.toLocaleString("es-AR")}\n\n${txLines}`;
    });
 
  return sections.join("\n\n");
}
 
module.exports = { parseExpense, answerQuery };
