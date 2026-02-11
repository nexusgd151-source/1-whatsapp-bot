app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    if (!from) return res.sendStatus(200);

    let input =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id ||
      null;

    const rawText = msg.type === "text" ? msg.text?.body?.trim() : null;

    if (!sessions[from]) {
      resetSession(from);
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    const s = sessions[from];

    // ================================
    // 🔒 PROTECCIÓN TOTAL ANTI-ROTURA
    // ================================

    if (!input && !rawText) {
      return res.sendStatus(200);
    }

    // Si está esperando botones y llega texto
    if (s.expected?.length && !input) {
      await sendMessage(from, textMsg("⚠️ Usa los botones."));
      await sendMessage(from, resendStep(s));
      return res.sendStatus(200);
    }

    // Si el botón NO pertenece al paso actual
    if (
      input &&
      s.expected?.length &&
      !s.expected.includes(input)
    ) {
      console.log("Botón viejo detectado:", input);
      await sendMessage(from, textMsg("⚠️ Opción no válida."));
      await sendMessage(from, resendStep(s));
      return res.sendStatus(200);
    }

    // ================================
    // FLUJO NORMAL
    // ================================

    switch (s.step) {

      case "menu_option":
        if (input === "pedido") {
          s.currentPizza = { extras: [], crust: false };
          s.step = "pizza_type";
          s.expected = ["pepperoni","carnes_frias","hawaiana","mexicana"];
          await sendMessage(from, pizzaList());
        }
        return res.sendStatus(200);


      case "pizza_type":
        s.currentPizza.type = input;
        s.step = "size";
        s.expected = ["grande","extragrande"];
        await sendMessage(from, sizeButtons(input));
        return res.sendStatus(200);


      case "size":
        s.currentPizza.size = input;
        s.step = "ask_crust";
        s.expected = ["crust_si","crust_no"];
        await sendMessage(from, askCrust());
        return res.sendStatus(200);


      case "ask_crust":
        s.currentPizza.crust = input === "crust_si";
        s.step = "ask_extra";
        s.expected = ["extra_si","extra_no"];
        await sendMessage(from, askExtra());
        return res.sendStatus(200);
    }

    // ⚠️ NO HAY FALLBACK AL MENÚ
    return res.sendStatus(200);

  } catch (err) {
    console.error("ERROR:", err);
    return res.sendStatus(200);
  }
});
