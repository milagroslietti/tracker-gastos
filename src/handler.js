const { parseExpense, answerQuery } = require("./claude");
const { saveExpense, getExpensesThisMonth, getExpensesLastNMonths, getRecentExpenses, deleteLastExpense } = require("./db");
const { sendMessage } = require("./telegram");
//const { transcribeAudio } = require("./whisper");

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Handle voice messages
 // if (msg.voice || msg.audio) {
//   const fileId = msg.voice ? msg.voice.file_id : msg.audio.file_id;
//   try {
//     await sendMessage(chatId, "🎙 Transcribiendo audio...");
//     const transcribed = await transcribeAudio(fileId);
//     await sendMessage(chatId, `_Escuché: "${transcribed}"_`);
//     msg.text = transcribed;
//   } catch (err) {
//     console.error("Audio transcription error:", err);
//     return sendMessage(chatId, "❌ No pude transcribir el audio. Intentá de nuevo.");
//   }
// }

  const text = msg.text?.trim();
  if (!text) return;


  // --- Commands ---
  if (text === "/start") {
    return sendMessage(
      chatId,
      `👋 <b>Hola! Soy tu bot de gastos.</b>\n\nMandame tus gastos así:\n\n` +
        `• <code>uber 2500</code>\n` +
        `• <code>café 850 pesos</code>\n` +
        `• <code>netflix 15 usd</code>\n` +
        `• <code>supermercado 12000</code>\n\n` +
        `También podés preguntarme:\n` +
        `• <i>¿cuánto gasté este mes?</i>\n` +
        `• <i>¿en qué categoría gasté más?</i>\n\n` +
        `Comandos:\n` +
        `/resumen — ver resumen del mes\n` +
        `/ultimos — últimos 5 gastos\n` +
        `/borrar — borrar el último gasto`
    );
  }

  if (text === "/resumen") {
    return handleResumen(chatId, userId);
  }

  if (text === "/ultimos") {
    return handleUltimos(chatId, userId);
  }

  if (text === "/borrar") {
    return handleBorrar(chatId, userId);
  }

  // --- Parse with Claude ---
  try {
    const parsed = await parseExpense(text);

    if (parsed.type === "expense") {
      const saved = await saveExpense(userId, parsed);
      const emoji = categoryEmoji(saved.category);
      const amountStr = formatAmount(saved.amount, saved.currency);

      return sendMessage(
        chatId,
        `${emoji} <b>${saved.category}</b>\n` +
          `💰 ${amountStr}\n` +
          (saved.merchant ? `🏪 ${saved.merchant}\n` : "") +
          (saved.description ? `📝 ${saved.description}\n` : "") +
          `📅 ${saved.date}\n\n` +
          `<i>Guardado ✓ — mandá /borrar si fue un error</i>`
      );
    }

    if (parsed.type === "query") {
      const expenses = await getExpensesLastNMonths(userId, 3);
      const answer = await answerQuery(text, expenses);
      return sendMessage(chatId, answer);
    }

    return sendMessage(
      chatId,
      `🤔 No entendí ese gasto. Probá con algo como:\n<code>uber 2500</code> o <code>café 850 pesos</code>`
    );
  } catch (err) {
    console.error("handleMessage error:", err);
    return sendMessage(chatId, "❌ Algo salió mal. Intentá de nuevo en un momento.");
  }
}

async function handleResumen(chatId, userId) {
  try {
    const expenses = await getExpensesThisMonth(userId);
    if (!expenses || expenses.length === 0) {
      return sendMessage(chatId, "📭 No tenés gastos registrados este mes.");
    }

    const byCategory = expenses.reduce((acc, e) => {
      const key = e.category;
      if (!acc[key]) acc[key] = { ARS: 0, USD: 0 };
      acc[key][e.currency] = (acc[key][e.currency] || 0) + e.amount;
      return acc;
    }, {});

    const lines = Object.entries(byCategory)
      .sort((a, b) => (b[1].ARS || 0) - (a[1].ARS || 0))
      .map(([cat, totals]) => {
        const emoji = categoryEmoji(cat);
        const parts = [];
        if (totals.ARS) parts.push(`$${totals.ARS.toLocaleString("es-AR")}`);
        if (totals.USD) parts.push(`USD ${totals.USD}`);
        return `${emoji} <b>${cat}</b>: ${parts.join(" + ")}`;
      })
      .join("\n");

    const totalARS = expenses
      .filter((e) => e.currency === "ARS")
      .reduce((s, e) => s + e.amount, 0);
    const totalUSD = expenses
      .filter((e) => e.currency === "USD")
      .reduce((s, e) => s + e.amount, 0);

    const month = new Date().toLocaleString("es-AR", { month: "long" });

    return sendMessage(
      chatId,
      `📊 <b>Resumen de ${month}</b>\n\n${lines}\n\n` +
        `─────────────────\n` +
        (totalARS ? `💵 Total ARS: <b>$${totalARS.toLocaleString("es-AR")}</b>\n` : "") +
        (totalUSD ? `💵 Total USD: <b>$${totalUSD}</b>\n` : "") +
        `📦 Transacciones: ${expenses.length}`
    );
  } catch (err) {
    console.error("handleResumen error:", err);
    return sendMessage(chatId, "❌ No pude cargar el resumen.");
  }
}

async function handleUltimos(chatId, userId) {
  try {
    const expenses = await getRecentExpenses(userId, 5);
    if (!expenses || expenses.length === 0) {
      return sendMessage(chatId, "📭 No tenés gastos registrados todavía.");
    }

    const lines = expenses
      .map((e) => {
        const emoji = categoryEmoji(e.category);
        const amount = formatAmount(e.amount, e.currency);
        const merchant = e.merchant ? ` — ${e.merchant}` : "";
        return `${emoji} ${amount}${merchant} <i>(${e.date})</i>`;
      })
      .join("\n");

    return sendMessage(chatId, `🕐 <b>Últimos gastos</b>\n\n${lines}`);
  } catch (err) {
    console.error("handleUltimos error:", err);
    return sendMessage(chatId, "❌ No pude cargar los gastos.");
  }
}

async function handleBorrar(chatId, userId) {
  try {
    const deleted = await deleteLastExpense(userId);
    if (!deleted) {
      return sendMessage(chatId, "📭 No hay gastos para borrar.");
    }
    return sendMessage(chatId, "🗑️ Último gasto borrado.");
  } catch (err) {
    console.error("handleBorrar error:", err);
    return sendMessage(chatId, "❌ No pude borrar el gasto.");
  }
}

function formatAmount(amount, currency) {
  if (currency === "USD") return `USD ${amount}`;
  return `$${amount.toLocaleString("es-AR")}`;
}

function categoryEmoji(category) {
  const map = {
    "Food & Coffee": "☕",
    Transport: "🚗",
    Groceries: "🛒",
    Shopping: "🛍️",
    Health: "💊",
    Subscriptions: "📱",
    Entertainment: "🎬",
    "Developer Tools": "💻",
    Travel: "✈️",
    Utilities: "💡",
    Transfers: "💸",
    Fees: "🏦",
    Other: "📦",
  };
  return map[category] || "📦";
}

module.exports = { handleMessage };
