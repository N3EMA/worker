export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    try {
      // ✅ CORRECT (Safe for numbers, strings, or missing values)
      const apiKey = String(env.GEMINI_API_KEY || "")
        .trim()
        .replace(/^["']|["']$/g, "");

      const botToken = String(env.TELEGRAM_BOT_TOKEN || "")
        .trim()
        .replace(/^["']|["']$/g, "");

      const adminId = String(env.ADMIN_USER_ID || "")
        .trim()
        .replace(/^["']|["']$/g, "");

      if (!apiKey || !botToken) {
        console.error("[ERROR] Missing required API keys.");
        return new Response("Internal Server Error", { status: 500 });
      }

      const update = await request.json();
      const message = update.message;

      if (!message || !message.text) {
        return new Response("OK", { status: 200 });
      }

      const chatId = message.chat.id;
      const userId = String(message.from?.id);
      const userText = message.text.trim();

      // ── Helper to send Telegram message ──
      const sendTg = async (text) => {
        return fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: text })
        });
      };

      // ── 1. Dynamic Allowed Users Check (Cloudflare KV) ──
      let allowedUsers = [];
      const storedUsers = await env.BOT_STORAGE.get("allowed_users", { type: "json" });
      if (Array.isArray(storedUsers)) {
        allowedUsers = storedUsers;
      }

      // If admin is set, always ensure admin is authorized
      const isAuthorized = (adminId && userId === adminId) || allowedUsers.includes(userId);

      if (!isAuthorized) {
        console.warn("[ACCESS DENIED] User " + userId + " attempted access.");
        await sendTg("⛔ Unauthorized. Your ID (" + userId + ") is not in the whitelist.");
        return new Response("OK", { status: 200 });
      }

      // ── 2. Command: /adduser <id> (Admin only) ──
      if (userText.startsWith("/adduser")) {
        if (adminId && userId !== adminId) {
          await sendTg("⛔ Only the admin can add users.");
          return new Response("OK", { status: 200 });
        }

        const parts = userText.split(/\s+/);
        const targetId = parts[1];

        if (!targetId || isNaN(targetId)) {
          await sendTg("Usage: /adduser <telegram_user_id>\nExample: /adduser 123456789");
          return new Response("OK", { status: 200 });
        }

        if (allowedUsers.includes(targetId)) {
          await sendTg("User " + targetId + " is already in the allowed list.");
          return new Response("OK", { status: 200 });
        }

        allowedUsers.push(targetId);
        await env.BOT_STORAGE.put("allowed_users", JSON.stringify(allowedUsers));
        await sendTg("✅ User " + targetId + " added successfully.\nTotal allowed: " + allowedUsers.length);
        return new Response("OK", { status: 200 });
      }

      // ── Current Gemini 3 & Production Models ──
      const availableModels = [
      "gemini-3.0-flash",
      "gemini-3.0-pro",
      "gemini-2.5-flash",
      "gemini-2.5-pro"
      ];

      
// Update the fallback default

      if (userText.startsWith("/switch")) {
        const parts = userText.split(/\s+/);
        const chosenModel = parts[1];

        if (!chosenModel) {
          const current = (await env.BOT_STORAGE.get("selected_model")) || "gemini-2.5-flash";
          const list = availableModels.map(m => (m === current ? "• " + m + " (active)" : "• " + m)).join("\n");
          await sendTg("Current model: " + current + "\n\nAvailable models:\n" + list + "\n\nUsage: /switch <model_name>");
          return new Response("OK", { status: 200 });
        }

        if (!availableModels.includes(chosenModel)) {
          await sendTg("❌ Unknown model: " + chosenModel + "\n\nOptions:\n" + availableModels.join("\n"));
          return new Response("OK", { status: 200 });
        }
        await env.BOT_STORAGE.put("selected_model", chosenModel);
        await sendTg("✅ Switched model to: " + chosenModel);
        return new Response("OK", { status: 200 });
      }

      // ── 4. Standard Message: Generate with Selected Gemini Model ──
      const activeModel = (await env.BOT_STORAGE.get("selected_model")) || "gemini-3.8-flash";
      const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + activeModel + ":generateContent";

      const geminiResponse = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: "You are a concise, helpful Telegram AI assistant." }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userText }]
            }
          ]
        })
      });

      const geminiData = await geminiResponse.json();

      if (!geminiResponse.ok) {
        console.error("[GEMINI ERROR]", geminiData.error?.message);
        await sendTg("⚠️ Gemini API Error (" + activeModel + "): " + (geminiData.error?.message || "Unknown error"));
        return new Response("OK", { status: 200 });
      }

      const replyText =
        geminiData.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Sorry, I couldn't generate a response.";

      await sendTg(replyText);

    } catch (err) {
      console.error("[WORKER ERROR]", err.message || err);
    }

    return new Response("OK", { status: 200 });
  }
};
