const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache"); // Certifique-se de rodar: npm install node-cache

const app = express();
// Configuração do Cache (5 minutos)
const myCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

app.use(cors());
app.use(express.json());

// ==================== CONFIGURAÇÕES E SEGURANÇA ====================

const TOKEN = process.env.MUELLER_TOKEN;

// SEGURANÇA: Removido valores padrão. Devem ser configurados no Render.
const USUARIOS = {
    [process.env.USUARIO_1]: process.env.SENHA_1,
    [process.env.USUARIO_2]: process.env.SENHA_2,
    [process.env.USUARIO_3]: process.env.SENHA_3
};

// Middleware de autenticação
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/status' || req.path === '/login-info') return next();
    
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Consulta Mueller"');
        return res.status(401).send('Autenticação necessária');
    }
    
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const usuario = auth[0];
    const senha = auth[1];
    
    if (usuario && USUARIOS[usuario] && USUARIOS[usuario] === senha) {
        req.usuario = usuario;
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="Acesso Negado"');
        return res.status(401).send('Usuário ou senha inválidos');
    }
});

// ==================== FUNÇÕES AUXILIARES ====================

function extrairInformacoesChaveNF(chaveAcesso) {
    if (!chaveAcesso || chaveAcesso.length !== 44) return null;
    try {
        const serie = chaveAcesso.substring(22, 25);
        const numeroNFcompleto = chaveAcesso.substring(25, 34);
        const numeroNF = parseInt(numeroNFcompleto).toString();
        return {
            numero: numeroNF,
            numero_completo: numeroNFcompleto,
            numero_formatado: numeroNFcompleto.replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3'),
            serie: serie,
            formato: `${serie}/${numeroNF}`,
            chave_acesso: chaveAcesso
        };
    } catch (e) { return null; }
}

async function buscarNotaFiscal(orderId) {
    try {
        const url = `https://loja.mueller.ind.br/rest/V1/invoices?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}`;
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (response.data.items?.length > 0) {
            const invoice = response.data.items[0];
            let chaveAcesso = invoice.extension_attributes?.nfe_key || invoice.extension_attributes?.chave_acesso;
            return {
                numero_interno: invoice.increment_id,
                chave_acesso: chaveAcesso,
                emitida_em: invoice.created_at,
                detalhes_nfe: extrairInformacoesChaveNF(chaveAcesso)
            };
        }
        return null;
    } catch (e) { return null; }
}

async function buscarRastreamento(orderId) {
    try {
        const url = `https://loja.mueller.ind.br/rest/V1/shipments?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}`;
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (response.data.items?.length > 0) {
            const ship = response.data.items[0];
            return {
                numero_rastreamento: ship.tracks?.[0]?.track_number || null,
                transportadora: ship.tracks?.[0]?.title || ship.shipping_description,
                link_rastreamento: ship.tracks?.[0]?.url || null
            };
        }
        return null;
    } catch (e) { return null; }
}

async function processarPedidoCompleto(p) {
    const [nf, rastreio] = await Promise.all([
        buscarNotaFiscal(p.entity_id),
        buscarRastreamento(p.entity_id)
    ]);

    // CORREÇÃO: Filtro de produtos com preço > 0
    const produtosFiltrados = p.items
        .filter(item => parseFloat(item.price) > 0)
        .map(i => ({
            nome: i.name,
            sku: i.sku,
            quantidade: i.qty_ordered,
            preco_unitario: i.price,
            total: i.row_total
        }));

    return {
        numero_pedido: p.increment_id,
        data_pedido: p.created_at,
        status: p.status,
        consumidor: `${p.customer_firstname || ""} ${p.customer_lastname || ""}`.trim(),
        cpf: p.customer_taxvat || "",
        email: p.customer_email || "",
        valor_total: p.grand_total,
        forma_pagamento: p.payment?.method || "",
        produtos: produtosFiltrados,
        nf: nf,
        rastreamento: rastreio,
        link_pedido: `https://loja.mueller.ind.br/admin/sales/order/view/order_id/${p.entity_id}/`
    };
}

// ==================== HTML TEMPLATE (MANTENDO SEU DESIGN ORIGINAL) ====================

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Consulta de Pedidos Mueller</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
    <style>
        body { background-color: #f8f9fa; padding: 20px; font-family: 'Segoe UI', sans-serif; }
        .header { background: linear-gradient(135deg, #682247 0%, #5a1d3d 100%); color: white; padding: 2rem; border-radius: 10px; margin-bottom: 2rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .card { border: none; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); margin-bottom: 1.5rem; transition: transform 0.3s; }
        .status-badge { font-size: 0.8rem; padding: 5px 10px; border-radius: 20px; }
        .status-complete { background-color: #d4edda; color: #155724; }
        .status-pending { background-color: #fff3cd; color: #856404; }
        .status-processing { background-color: #cce5ff; color: #004085; }
        .product-badge { background-color: #e9ecef; padding: 3px 8px; border-radius: 5px; font-size: 0.9rem; margin-right: 5px; }
        .info-box { background: white; padding: 15px; border-radius: 8px; border-left: 4px solid #682247; margin-bottom: 15px; }
        .chave-nfe { font-family: monospace; font-size: 0.8rem; background: #f8f9fa; padding: 8px; border-radius: 4px; word-break: break-all; border: 1px solid #dee2e6; }
        .nf-real { background-color: #d4edda; border-left: 4px solid #28a745; padding: 10px; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header text-center">
            <img src="https://loja.mueller.ind.br/media/wysiwyg/image_4.png" alt="Mueller" height="50" class="mb-2">
            <h1><i class="bi bi-search"></i> Consulta de Pedidos Mueller</h1>
        </div>

        <div class="card p-4 mb-4">
            <form id="searchForm" class="row g-3">
                <div class="col-md-5">
                    <label class="form-label">CPF (somente números)</label>
                    <input type="text" class="form-control" id="cpf" maxlength="11">
                </div>
                <div class="col-md-5">
                    <label class="form-label">Número do Pedido</label>
                    <input type="text" class="form-control" id="pedido">
                </div>
                <div class="col-md-2 d-flex align-items-end">
                    <button type="submit" class="btn btn-primary w-100">Buscar</button>
                </div>
            </form>
        </div>

        <div id="loading" class="text-center d-none"><div class="spinner-border text-primary"></div><p>Buscando...</p></div>
        <div id="results"></div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script>
        // Função de formatação (mantida do seu original)
        function formatCurrency(v) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v); }

        document.getElementById('searchForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const resultsDiv = document.getElementById('results');
            const loader = document.getElementById('loading');
            
            const cpf = document.getElementById('cpf').value.trim();
            const pedido = document.getElementById('pedido').value.trim();

            loader.classList.remove('d-none');
            resultsDiv.innerHTML = '';

            try {
                const query = cpf ? \`cpf=\${cpf}\` : \`pedido=\${pedido}\`;
                const response = await fetch('/api/pedidos?' + query);
                const data = await response.json();

                if (!response.ok) throw new Error(data.erro || 'Erro na busca');

                data.forEach(p => {
                    const pDiv = document.createElement('div');
                    pDiv.className = 'card p-3 mb-3';
                    pDiv.innerHTML = \`
                        <div class="d-flex justify-content-between align-items-center">
                            <h4>Pedido: \${p.numero_pedido}</h4>
                            <span class="status-badge \${p.status === 'complete' ? 'status-complete' : 'status-processing'}">\${p.status}</span>
                        </div>
                        <p><strong>Cliente:</strong> \${p.consumidor} | <strong>Total:</strong> \${formatCurrency(p.valor_total)}</p>
                        <div class="row">
                            <div class="col-md-6">
                                <div class="info-box">
                                    <h6>Produtos:</h6>
                                    \${p.produtos.map(prod => \`
                                        <div class="mb-2">
                                            <span class="product-badge">\${prod.quantidade}x</span>
                                            <strong>\${prod.nome}</strong><br>
                                            <small class="text-muted">SKU: \${prod.sku}</small>
                                        </div>
                                    \`).join('')}
                                </div>
                            </div>
                            <div class="col-md-6">
                                \${p.nf ? \`
                                    <div class="nf-real mb-2">
                                        <strong>Nota Fiscal: \${p.nf.detalhes_nfe?.formato || p.nf.numero_interno}</strong><br>
                                        <div class="chave-nfe mt-1">\${p.nf.chave_acesso || ''}</div>
                                    </div>
                                \` : '<p class="text-muted">Sem NF emitida</p>'}
                                
                                \${p.rastreamento?.numero_rastreamento ? \`
                                    <a href="http://www.transpofrete.com.br/default/rastreio/mercadoria/rastreio.xhtml?exibirDetalhes=true&chave=\${p.rastreamento.numero_rastreamento}" 
                                       target="_blank" class="btn btn-sm btn-outline-primary mt-2">Rastrear Entrega</a>
                                \` : ''}
                            </div>
                        </div>
                    \`;
                    resultsDiv.appendChild(pDiv);
                });
            } catch (err) {
                resultsDiv.innerHTML = \`<div class="alert alert-danger">\${err.message}</div>\`;
            } finally { loader.classList.add('d-none'); }
        });
    </script>
</body>
</html>`;

// ==================== ROTAS API ====================

app.get("/", (req, res) => res.send(HTML_TEMPLATE));

app.get("/api/pedidos", async (req, res) => {
    try {
        let { cpf, pedido } = req.query;
        if (!cpf && !pedido) return res.status(400).json({ erro: "Informe CPF ou Pedido" });

        // Sanitização (Segurança)
        if (cpf) cpf = cpf.replace(/\D/g, '');

        const field = cpf ? "customer_taxvat" : "increment_id";
        const value = cpf || pedido;
        const cacheKey = `req_${field}_${value}`;

        // Verificar Cache
        const cachedData = myCache.get(cacheKey);
        if (cachedData) return res.json(cachedData);

        const url = `https://loja.mueller.ind.br/rest/V1/orders?searchCriteria[filter_groups][0][filters][0][field]=${field}&searchCriteria[filter_groups][0][filters][0][value]=${value}`;
        
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
        
        if (!response.data.items?.length) return res.json([]);

        // Filtro de 6 meses
        const seisMeses = new Date();
        seisMeses.setMonth(seisMeses.getMonth() - 6);

        const resultados = await Promise.all(
            response.data.items
                .filter(p => new Date(p.created_at) >= seisMeses)
                .map(p => processarPedidoCompleto(p))
        );

        myCache.set(cacheKey, resultados);
        res.json(resultados);

    } catch (error) {
        res.status(500).json({ erro: "Erro na consulta Mueller" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));
