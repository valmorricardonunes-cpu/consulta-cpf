const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const TOKEN = process.env.MUELLER_TOKEN;

app.get("/pedidos", async (req, res) => {
  try {
    const { cpf, pedido } = req.query;

    if (!cpf && !pedido) {
      return res.status(400).json({ erro: "Informe CPF ou número do pedido" });
    }

    let filtro = "";

    if (cpf) {
      filtro = `customer_taxvat=${cpf}`;
    }

    if (pedido) {
      filtro = `increment_id=${pedido}`;
    }

    const url = `https://loja.mueller.ind.br/rest/V1/orders?searchCriteria[filter_groups][0][filters][0][field]=${filtro.split("=")[0]}&searchCriteria[filter_groups][0][filters][0][value]=${filtro.split("=")[1]}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`
      }
    });

    res.json(response.data);

  } catch (error) {
    res.status(500).json({ erro: "Erro ao consultar pedidos" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
