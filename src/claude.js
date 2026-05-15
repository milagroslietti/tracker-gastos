const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an expense parsing assistant. The user will send messages in Spanish or English describing a purchase or expense.

Your job is to extract structured data and return ONLY a valid JSON object — no markdown, no explanation, no extra text.

Return this exact shape:
{
  "type": "expense" | "query" | "unknown",
  "amount": number | null,
  "currency": "ARS" | "USD" | "EUR" | null,
  "merchant": string | null,
  "category": string | null,
  "description": string | null,
  "date": "YYYY-MM-DD" | null
}

Category must be one of: Food & Coffee, Transport, Groceries, Shopping, Health, Subscriptions, Entertainment, Developer Tools, Travel, Utilities, Transfers, Fees, Other.

Currency rules:
- If the user says "pesos", "ars", "$" with no qualifier → ARS
- If the user says "dólares", "usd", "u$d", "USD" → USD
- If no currency is mentioned, default to ARS

Date rules:
- If no date is mentioned, use today's date
- "ayer" = yesterday, "anteayer" = two days ago

If the message is a question about spending (e.g. "cuánto gasté?", "how much on food?"), set type to "query" and all other fields to null.
If you cannot parse it as an expense or query, set type to "unknown".

Examples:
"uber 2500" → { "type": "expense", "amount": 2500, "currency": "ARS", "merchant": "Uber", "category": "Transport", "description": "Uber ride", "date": "TODAY" }
"netflix 15 usd" → { "type": "expense", "amount": 15, "currency": "USD", "merchant": "Netflix", "category": "Subscriptions", "description": "Netflix subscription", "date": "TODAY" }
"café con medialunas 850" → { "type": "expense", "amount": 850, "currency": "ARS", "merchant": null, "category": "Food & Coffee", "description": "Café con medialunas", "date": "TODAY" }
"cuánto gasté este mes?" → { "type": "query", "amount": null, "currency": null, "merchant": null, "category": null, "description": null, "date": null }
`;

async function parseExpense(userMessage) {
  const today = new Date().toISOString().split("T")[0];

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: SYSTEM_PROMPT.replace(/TODAY/g, today),
    messages: [{ role: "user", content: userMessage }],
  });

const raw = response.content[0].text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');

  try {
    return JSON.parse(raw);
  } catch {
    console.error("Failed to parse Claude response:", raw);
    return { type: "unknown" };
  }
}

async function answerQuery(userMessage, expenses) {
  const context = buildRichContext(expenses);
  const today = new Date().toLocaleDateString("es-AR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system: `Eres un asistente financiero personal. El usuario te hará preguntas sobre sus gastos del historial que se provee abajo.
Responde siempre en el mismo idioma que el usuario (español o inglés).
Sé conciso, directo y amigable. Usá emojis con moderación.
Si hay datos suficientes, mencioná tendencias o insights útiles (ej: "gastaste 20% más en comida que el mes pasado").
Si te preguntan algo que no podés responder con los datos disponibles, decilo claramente.
Hoy es ${today}.

=== HISTORIAL DE GASTOS ===
${context}`,
    messages: [{ role: "user", content: userMessage }],
  });

  return response.content[0].text;
}

function buildRichContext(expenses) {
  if (!expenses || expenses.length === 0) return "No hay gastos registrados.";

  const byMonth = {};
  for (const e of expenses) {
    const month = e.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(e);
  }

  const sections = Object.entries(byMonth)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, exps]) => {
      const label = new Date(`${month}-01`).toLocaleString("es-AR", {
        month: "long",
        year: "numeric",
      });

      const catTotals = {};
      for (const e of exps) {
        const key = `${e.category} (${e.currency})`;
        catTotals[key] = (catTotals[key] || 0) + Number(e.amount);
      }
      const catLines = Object.entries(catTotals)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, total]) => `    ${cat}: ${total.toLocaleString("es-AR")}`)
        .join("\n");

      const txLines = exps
        .slice(0, 30)
        .map((e) => {
          const merchant = e.merchant ? ` @ ${e.merchant}` : "";
          const desc = e.description ? ` (${e.description})` : "";
          return `    ${e.date} | ${e.category}${merchant}${desc} | ${e.currency} ${Number(e.amount).toLocaleString("es-AR")}`;
        })
        .join("\n");

      const totalARS = exps.filter((e) => e.currency === "ARS").reduce((s, e) => s + Number(e.amount), 0);
      const totalUSD = exps.filter((e) => e.currency === "USD").reduce((s, e) => s + Number(e.amount), 0);
      const totalsLine = [
        totalARS ? `ARS ${totalARS.toLocaleString("es-AR")}` : null,
        totalUSD ? `USD ${totalUSD}` : null,
      ].filter(Boolean).join(" + ");

      return `--- ${label.toUpperCase()} (total: ${totalsLine}) ---\nPor categoría:\n${catLines}\n\nTransacciones:\n${txLines}`;
    });

  return sections.join("\n\n");
}

module.exports = { parseExpense, answerQuery };