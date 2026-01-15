const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const TOKEN = process.env.MUELLER_TOKEN;

// Cache simples para evitar múltiplas requisições
const cache = new Map();

app.get("/", (req, res) => {
  res.send("API consulta de pedidos ativa");
});

// Função para buscar notas fiscais de um pedido
async function buscarNotaFiscal(orderId) {
  try {
    const url = `https://loja.mueller.ind.br/rest/V1/invoices?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}`;
    
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    if (response.data.items && response.data.items.length > 0) {
      return {
        numero: response.data.items[0].increment_id,
        emitida_em: response.data.items[0].created_at
      };
    }
    return null;
  } catch (error) {
    console.error("Erro ao buscar nota fiscal:", error.message);
    return null;
  }
}

// Função para buscar informações de envio/rastreamento
async function buscarRastreamento(orderId) {
  try {
    const url = `https://loja.mueller.ind.br/rest/V1/shipments?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}`;
    
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    if (response.data.items && response.data.items.length > 0) {
      const shipment = response.data.items[0];
      
      // Buscar tracks (rastreamento)
      if (shipment.tracks && shipment.tracks.length > 0) {
        return {
          numero_rastreamento: shipment.tracks[0].track_number,
          transportadora: shipment.tracks[0].title || shipment.tracks[0].carrier_code,
          link_rastreamento: shipment.tracks[0].url || null
        };
      }
      
      return {
        numero_envio: shipment.increment_id,
        transportadora: shipment.shipping_description
      };
    }
    return null;
  } catch (error) {
    console.error("Erro ao buscar rastreamento:", error.message);
    return null;
  }
}

app.get("/pedidos", async (req, res) => {
  try {
    const { cpf, pedido } = req.query;

    if (!cpf && !pedido) {
      return res.status(400).json({ erro: "Informe CPF ou número do pedido" });
    }

    const field = cpf ? "customer_taxvat" : "increment_id";
    const value = cpf || pedido;

    // Verificar cache
    const cacheKey = `${field}:${value}`;
    if (cache.has(cacheKey)) {
      const cachedData = cache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < 300000) { // 5 minutos de cache
        return res.json(cachedData.data);
      }
    }

    const url = `https://loja.mueller.ind.br/rest/V1/orders?searchCriteria[filter_groups][0][filters][0][field]=${field}&searchCriteria[filter_groups][0][filters][0][value]=${value}&searchCriteria[pageSize]=50`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`
      }
    });

    if (!response.data.items || response.data.items.length === 0) {
      return res.json([]);
    }

    const seisMesesAtras = new Date();
    seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);

    // Processar pedidos em paralelo para melhor performance
    const pedidosCompletos = await Promise.all(
      response.data.items
        .filter(p => new Date(p.created_at) >= seisMesesAtras)
        .map(async (p) => {
          // Buscar informações adicionais em paralelo
          const [notaFiscal, rastreamento] = await Promise.all([
            buscarNotaFiscal(p.entity_id),
            buscarRastreamento(p.entity_id)
          ]);

          // Formatar endereço de entrega
          let enderecoFormatado = null;
          if (p.extension_attributes && p.extension_attributes.shipping_assignments) {
            const shipping = p.extension_attributes.shipping_assignments[0]?.shipping?.address;
            if (shipping) {
              enderecoFormatado = {
                rua: shipping.street ? (Array.isArray(shipping.street) ? shipping.street.join(", ") : shipping.street) : "",
                numero: shipping.street_number || "",
                complemento: shipping.complement || "",
                bairro: shipping.neighborhood || "",
                cidade: shipping.city || "",
                estado: shipping.region || "",
                cep: shipping.postcode || "",
                telefone: shipping.telephone || ""
              };
            }
          }

          // Se não encontrou shipping, tenta billing
          if (!enderecoFormatado && p.billing_address) {
            enderecoFormatado = {
              rua: p.billing_address.street ? (Array.isArray(p.billing_address.street) ? p.billing_address.street.join(", ") : p.billing_address.street) : "",
              cidade: p.billing_address.city || "",
              estado: p.billing_address.region || "",
              cep: p.billing_address.postcode || "",
              telefone: p.billing_address.telephone || ""
            };
          }

          return {
            numero_pedido: p.increment_id,
            data_pedido: p.created_at,
            status: p.status,
            consumidor: `${p.customer_firstname || ""} ${p.customer_lastname || ""}`.trim(),
            cpf: p.customer_taxvat || "",
            email: p.customer_email || "",
            telefone: p.billing_address?.telephone || "",
            endereco_entrega: enderecoFormatado,
            produtos: p.items.map(i => ({
              nome: i.name,
              sku: i.sku,
              quantidade: i.qty_ordered,
              preco_unitario: i.price,
              total: i.row_total
            })),
            valor_total: p.grand_total,
            forma_pagamento: p.payment?.method || "",
            nf: notaFiscal,
            rastreamento: rastreamento,
            link_pedido: `https://loja.mueller.ind.br/admin/sales/order/view/order_id/${p.entity_id}/`
          };
        })
    );

    // Salvar no cache
    cache.set(cacheKey, {
      timestamp: Date.now(),
      data: pedidosCompletos
    });

    res.json(pedidosCompletos);

  } catch (error) {
    console.error("Erro detalhado:", error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      return res.status(401).json({ erro: "Token de autenticação inválido" });
    }
    
    if (error.response?.status === 404) {
      return res.json([]);
    }
    
    res.status(500).json({ 
      erro: "Erro ao consultar pedidos",
      detalhes: error.message 
    });
  }
});

// Endpoint para limpar cache
app.delete("/cache", (req, res) => {
  cache.clear();
  res.json({ mensagem: "Cache limpo" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'desenvolvimento'}`);
});
