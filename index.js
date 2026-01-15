const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const TOKEN = process.env.MUELLER_TOKEN;

app.get("/", (req, res) => {
  res.send("API consulta de pedidos ativa");
});

app.get("/pedidos", async (req, res) => {
  try {
    const { cpf, pedido } = req.query;

    if (!cpf && !pedido) {
      return res.status(400).json({ erro: "Informe CPF ou número do pedido" });
    }

    const field = cpf ? "customer_taxvat" : "increment_id";
    const value = cpf || pedido;

    const url = `https://loja.mueller.ind.br/rest/V1/orders?searchCriteria[filter_groups][0][filters][0][field]=${field}&searchCriteria[filter_groups][0][filters][0][value]=${value}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`
      }
    });

    const seisMesesAtras = new Date();
    seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);

    const pedidosFiltrados = response.data.items
      .filter(p => new Date(p.created_at) >= seisMesesAtras)
      .map(p => ({
        numero_pedido: p.increment_id,
        data_pedido: p.created_at,
        consumidor: `${p.customer_firstname} ${p.customer_lastname}`,
        endereco_entrega: p.billing_address
          ? {
              rua: p.billing_address.street?.join(", "),
              cidade: p.billing_address.city,
              estado: p.billing_address.region,
              cep: p.billing_address.postcode
            }
          : null,
        produtos: p.items.map(i => ({
          nome: i.name,
          quantidade: i.qty_ordered
        })),
        nf: null,
        rastreamento: null
      }));

    res.json(pedidosFiltrados);

  } catch (error) {
    console.error(error.message);
    res.status(500).json({ erro: "Erro ao consultar pedidos" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
