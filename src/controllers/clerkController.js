import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

export const getUserIdByEmail = async (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email em falta" });

  try {
    const url = `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const rawText = await response.text();

    try {
      const data = JSON.parse(rawText);

      if (!Array.isArray(data) || data.length === 0) {
        return res.status(404).json({ error: "Utilizador não encontrado" });
      }

      const user = data[0];
      return res.json({ user_id: user.id });
    } catch (jsonError) {
      console.error("Resposta inválida da Clerk API:", rawText);
      return res.status(500).json({ error: "Resposta inesperada da Clerk API" });
    }

  } catch (error) {
    console.error("Erro ao obter user ID:", error);
    return res.status(500).json({ error: "Erro ao buscar utilizador" });
  }
};
