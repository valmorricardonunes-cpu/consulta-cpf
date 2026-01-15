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

    const field = cpf ? "customer_taxvat" : "increment_id";
    const value = cpf || pedido;

    const url = `https://loja.mueller.ind.br/rest/V1/orders?searchCriteria[filter_groups][0][filters][0][field]=${field}&searchCriteria[filter_groups][0][filters][0][value]=${value}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.MUELLER_TOKEN}`
      }
    });

    const seisMesesAtras = new Date();
    seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);

    const pedidosFiltrados = response.data.items
      .filter(p => new Date(p.created_at) >= seisMesesAtras)
      .map(pedido => ({
        numero_pedido: pedido.increment_id,
        data_pedido: pedido.created_at,
        consumidor: pedido.customer_firstname + " " + pedido.customer_lastname,
        endereco_entrega: pedido.extension_attributes?.shipping_assignments?.[0]?.shipping?.address || null,
        produtos: pedido.items.map(item => ({
          nome: item.name,
          quantidade: item.qty_ordered
        })),
        nf: pedido.extension_attributes?.invoice_id || null,
        rastreamento: pedido.extension_attributes?.shipping_assignments?.[0]?.shipping?.tracks?.[0]?.track_url || null
      }));

    res.json(pedidosFiltrados);

  } catch (error) {
    res.status(500).json({ erro: "Erro ao consultar pedidos" });
  }
});
