const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

// CACHE NATIVO (Simples, para não precisar de biblioteca externa)
const cacheSimples = new Map();
const CACHE_DURACAO = 5 * 60 * 1000; // 5 minutos

app.use(cors());
app.use(express.json());

// ==================== CONFIGURAÇÕES E SEGURANÇA ====================
const TOKEN = process.env.MUELLER_TOKEN;
const USUARIOS = {
    [process.env.USUARIO_1]: process.env.SENHA_1,
    [process.env.USUARIO_2]: process.env.SENHA_2,
    [process.env.USUARIO_3]: process.env.SENHA_3
};

// Middleware de Autenticação
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/status') return next();
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Consulta Mueller"');
        return res.status(401).send('Autenticação necessária');
    }
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (USUARIOS[auth[0]] && USUARIOS[auth[0]] === auth[1]) {
        next();
    } else {
        res.status(401).send('Usuário ou senha inválidos');
    }
});

// ==================== FUNÇÕES DE TRATAMENTO ====================

async function buscarDadosExtras(orderId) {
    try {
        const header = { headers: { Authorization: `Bearer ${TOKEN}` } };
        // Busca NF e Rastreio em paralelo
        const [resNf, resShip] = await Promise.all([
            axios.get(`https://loja.mueller.ind.br/rest/V1/invoices?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}`, header),
            axios.get(`https://loja.mueller.ind.br/rest/V1/shipments?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}`, header)
        ]);

        const nfData = resNf.data.items?.[0];
        const shipData = resShip.data.items?.[0];

        return {
            chave_nfe: nfData?.extension_attributes?.nfe_key || nfData?.extension_attributes?.chave_acesso || null,
            rastreio: shipData?.tracks?.[0]?.track_number || null
        };
    } catch (e) { return { chave_nfe: null, rastreio: null }; }
}

// ==================== HTML INTERFACE (RESUMIDA PARA FUNCIONAR) ====================
const HTML_TEMPLATE = `
<!DOCTYPE html>
<html>
<head>
    <title>Consulta Mueller</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background: #f4f4f4; padding: 20px; }
        .pedido-card { background: white; padding: 15px; border-radius: 8px; margin-bottom: 10px; border-left: 5px solid #682247; }
    </style>
</head>
<body>
    <div class="container">
        <h2 class="mb-4">Buscador de Pedidos</h2>
        <div class="card p-3 mb-4">
            <div class="row g-2">
                <div class="col-8"><input type="text" id="busca" class="form-control" placeholder="CPF ou Pedido"></div>
                <div class="col-4"><button onclick="buscar()" class="btn btn-primary w-100">Buscar</button></div>
            </div>
        </div>
        <div id="resultado"></div>
    </div>
    <script>
        async function buscar() {
            const val = document.getElementById('busca').value;
            const resDiv = document.getElementById('resultado');
            resDiv.innerHTML = "Buscando...";
            try {
                const response = await fetch('/api/pedidos?valor=' + val);
                const data = await response.json();
                resDiv.innerHTML = data.map(p => \`
                    <div class="pedido-card">
                        <strong>Pedido: \${p.increment_id}</strong> - \${p.status}<br>
                        Cliente: \${p.cliente}<br>
                        Produtos: \${p.produtos.map(pr => \`<br>• \${pr.qty}x \${pr.name}\`).join('')}<br>
                        \${p.chave_nfe ? \`<div class="mt-2 small text-success">NF: \${p.chave_nfe}</div>\` : ''}
                    </div>
                \`).join('') || "Nenhum pedido encontrado.";
            } catch (e) { resDiv.innerHTML = "Erro na busca."; }
        }
    </script>
</body>
</html>`;

// ==================== ROTAS ====================

app.get("/", (req, res) => res.send(HTML_TEMPLATE));

app.get("/api/pedidos", async (req, res) => {
    try {
        let { valor } = req.query;
        if (!valor) return res.json([]);

        // Limpeza de segurança (Sanitização)
        valor = valor.replace(/\D/g, ''); 

        // Verificação de Cache Nativo
        const cached = cacheSimples.get(valor);
        if (cached && (Date.now() - cached.time < CACHE_DURACAO)) {
            return res.json(cached.data);
        }

        // Busca na Mueller
        const field = valor.length > 9 ? "customer_taxvat" : "increment_id";
        const url = `https://loja.mueller.ind.br/rest/V1/orders?searchCriteria[filter_groups][0][filters][0][field]=${field}&searchCriteria[filter_groups][0][filters][0][value]=${valor}`;
        
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const items = response.data.items || [];

        const resultados = await Promise.all(items.map(async p => {
            const extras = await buscarDadosExtras(p.entity_id);
            return {
                increment_id: p.increment_id,
                status: p.status,
                cliente: `\${p.customer_firstname} \${p.customer_lastname}`,
                // FILTRO: Remove produtos de valor zero (duplicados)
                produtos: p.items.filter(i => parseFloat(i.price) > 0).map(i => ({ name: i.name, qty: i.qty_ordered })),
                chave_nfe: extras.chave_nfe,
                rastreio: extras.rastreio
            };
        }));

        cacheSimples.set(valor, { data: resultados, time: Date.now() });
        res.json(resultados);

    } catch (error) {
        res.status(500).json({ erro: "Erro interno" });
    }
});

app.listen(process.env.PORT || 3000);
