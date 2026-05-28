// v2 - payment method, income, installments
const { parseExpense, answerQuery } = require("./claude");
const { saveExpense, getExpensesThisMonth, getExpensesLastNMonths, getRecentExpenses, deleteLastExpense, saveFixedExpense } = require("./db");
const { sendMessage } = require("./telegram");
// const { transcribeAudio } = require("./whisper");

const pendingPaymentMethod = {};

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // // Handle voice messages
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

  if (pendingPaymentMethod[userId]) {
    const validMethods = ["transferencia", "debito", "credito", "efectivo"];
    const method = text.toLowerCase();
    if (validMethods.includes(method)) {
      const pending = pendingPaymentMethod[userId];
      delete pendingPaymentMethod[userId];
      pending.payment_method = method;
      return await processParsed(chatId, userId, pending);
    } else {
      return sendMessage(chatId, "❓ Por favor respondé con: transferencia, debito, credito o efectivo");
    }
  }

  if (text === "/start") {
    return sendMessage(
      chatId,
      `👋 <b>Hola! Soy tu asistente financiero.</b>\n\nPodés registrar:\n` +
      `• <code>uber 2500 debito</code>\n` +
      `• <code>netflix 15 usd fijo</code>\n` +
      `• <code>zapatillas 120000 en 3 cuotas</code>\n` +
      `• <code>cobré sueldo 500000</code>\n\n` +
      `Comandos:\n` +
      `/resumen — resumen del mes\n` +
      `/ultimos — últimos 5 movimientos\n` +
      `/borrar — borrar el último registro`
    );
  }

  if (text === "/resumen") return handleResumen(chatId, userId);
  if (text === "/ultimos") return handleUltimos(chatId, userId);
  if (text === "/borrar") return handleBorrar(chatId, userId);

  const parsed = await parseExpense(text);

  if (parsed.type === "query") {
    const expenses = await getExpensesLastNMonths(userId, 3);
    const answer = await answerQuery(text, expenses);
    return sendMessage(chatId, answer);
  }

  if (parsed.type === "unknown") {
    return sendMessage(chatId, "❓ No entendí ese mensaje. Probá con algo como: <code>café 850 efectivo</code>");
  }

  if (parsed.type === "expense" || parsed.type === "income") {
    if (parsed.needs_payment_method) {
      pendingPaymentMethod[userId] = parsed;
      return sendMessage(chatId, `💳 ¿Cómo pagaste?\n\n• transferencia\n• debito\n• credito\n• efectivo`);
    }
    return await processParsed(chatId, userId, parsed);
  }
}

async function processParsed(chatId, userId, parsed) {
  try {
    if (parsed.installments && parsed.installments > 1) {
      const installmentAmount = parsed.amount / parsed.installments;
      const baseDate = new Date(parsed.date);
      for (let i = 0; i < parsed.installments; i++) {
        const date = new Date(baseDate);
        date.setMonth(date.getMonth() + i);
        await saveExpense(userId, {
          ...parsed,
          amount: installmentAmount,
          date: date.toISOString().split("T")[0],
          installment_number: i + 1,
          installment_total: parsed.installments,
          description: `${parsed.description} (cuota ${i + 1}/${parsed.installments})`,
        });
      }
      return sendMessage(chatId,
        `💳 <b>${parsed.description}</b>\n` +
        `💰 ${parsed.installments} cuotas de ${formatAmount(parsed.amount / parsed.installments, parsed.currency)}\n` +
        `📅 Desde ${parsed.date}\n\n` +
        `_Guardado ✓ — mandá /borrar si fue un error_`
      );
    }

    await saveExpense(userId, parsed);

    if (parsed.is_fixed) {
      await saveFixedExpense(userId, parsed);
    }

    const emoji = parsed.type === "income" ? "💵" : "💸";
    const typeLabel = parsed.type === "income" ? "Ingreso" : parsed.category;

    return sendMessage(chatId,
      `${emoji} <b>${typeLabel}</b>\n` +
      `💰 ${formatAmount(parsed.amount, parsed.currency)}\n` +
      (parsed.merchant ? `🏪 ${parsed.merchant}\n` : "") +
      (parsed.payment_method ? `💳 ${parsed.payment_method}\n` : "") +
      (parsed.is_fixed ? `🔁 Gasto fijo registrado\n` : "") +
      `📅 ${parsed.date}\n\n` +
      `_Guardado ✓ — mandá /borrar si fue un error_`
    );
  } catch (err) {
    console.error("processParsed error:", err);
    return sendMessage(chatId, "❌ Algo salió mal. Intentá de nuevo en un momento.");
  }
}

async function handleResumen(chatId, userId) {
  try {
    const expenses = await getExpensesThisMonth(userId);
    if (!expenses || expenses.length === 0) {
      return sendMessage(chatId, "📭 No hay registros este mes.");
    }

    const ingresos = expenses.filter(e => e.type === "income").reduce((s, e) => s + Number(e.amount), 0);
    const egresos = expenses.filter(e => e.type === "expense").reduce((s, e) => s + Number(e.amount), 0);
    const ahorro = ingresos - egresos;

    const catMap = {};
    for (const e of expenses.filter(e => e.type === "expense")) {
      if (!catMap[e.category]) catMap[e.category] = 0;
      catMap[e.category] += Number(e.amount);
    }
    const catLines = Object.entries(catMap)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, total]) => `  ${categoryEmoji(cat)} ${cat}: ${formatAmount(total, "ARS")}`)
      .join("\n");

    const methodMap = {};
    for (const e of expenses.filter(e => e.type === "expense" && e.payment_method)) {
      if (!methodMap[e.payment_method]) methodMap[e.payment_method] = 0;
      methodMap[e.payment_method] += Number(e.amount);
    }
    const totalWithMethod = Object.values(methodMap).reduce((s, v) => s + v, 0);
    const methodLines = Object.entries(methodMap)
      .sort((a, b) => b[1] - a[1])
      .map(([method, total]) => `  ${method}: ${Math.round(total / totalWithMethod * 100)}%`)
      .join("\n");

    return sendMessage(chatId,
      `📊 <b>Resumen del mes</b>\n\n` +
      `💵 Ingresos: ${formatAmount(ingresos, "ARS")}\n` +
      `💸 Egresos: ${formatAmount(egresos, "ARS")}\n` +
      `${ahorro >= 0 ? "✅" : "⚠️"} Ahorro: ${formatAmount(ahorro, "ARS")}\n\n` +
      `<b>Por categoría:</b>\n${catLines}\n\n` +
      `<b>Por método de pago:</b>\n${methodLines}`
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
      return sendMessage(chatId, "📭 No hay registros recientes.");
    }
    const lines = expenses.map((e) => {
      const emoji = e.type === "income" ? "💵" : categoryEmoji(e.category);
      const amount = formatAmount(e.amount, e.currency);
      const method = e.payment_method ? ` · ${e.payment_method}` : "";
      return `${emoji} ${amount}${method} <i>(${e.date})</i>\n   ${e.description || e.category}`;
    }).join("\n\n");

    return sendMessage(chatId, `🕐 <b>Últimos movimientos</b>\n\n${lines}`);
  } catch (err) {
    console.error("handleUltimos error:", err);
    return sendMessage(chatId, "❌ No pude cargar los gastos.");
  }
}

async function handleBorrar(chatId, userId) {
  try {
    const deleted = await deleteLastExpense(userId);
    if (!deleted) {
      return sendMessage(chatId, "🗑 No hay gastos para borrar.");
    }
    return sendMessage(chatId, "🗑 Último registro borrado.");
  } catch (err) {
    console.error("handleBorrar error:", err);
    return sendMessage(chatId, "❌ No pude borrar el gasto.");
  }
}

function formatAmount(amount, currency) {
  if (currency === "USD") return `USD ${amount}`;
  return `$${Number(amount).toLocaleString("es-AR")}`;
}

function categoryEmoji(category) {
  const map = {
    "Food & Coffee": "☕",
    "Transport": "🚗",
    "Groceries": "🛒",
    "Shopping": "🛍",
    "Health": "💊",
    "Subscriptions": "📱",
    "Entertainment": "🎬",
    "Developer Tools": "💻",
    "Travel": "✈️",
    "Utilities": "💡",
    "Transfers": "🔄",
    "Fees": "🏦",
    "Other": "📦",
    "Sueldo": "💼",
    "Freelance": "🖥",
    "Inversiones": "📈",
  };
  return map[category] || "📦";
}

module.exports = { handleMessage };
