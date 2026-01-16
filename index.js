const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ==================== CONFIGURAÇÕES ====================

const TOKEN = process.env.MUELLER_TOKEN; // TOKEN FICA SÓ AQUI!
const cache = new Map();

// ==================== SEGURANÇA ====================

// USUÁRIOS AUTORIZADOS (configure no Render)
const USUARIOS = {
    [process.env.USUARIO_1 || 'valmor']: process.env.SENHA_1 || 'SenhaProvisoria123',
    [process.env.USUARIO_2 || 'financeiro']: process.env.SENHA_2 || 'Financ@2024',
    [process.env.USUARIO_3 || 'vendas']: process.env.SENHA_3 || 'Vendas#2024'
};

// Middleware de autenticação
app.use((req, res, next) => {
    // Libera página inicial e status sem login
    if (req.path === '/' || req.path === '/status' || req.path === '/login-info') {
        return next();
    }
    
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Consulta Mueller - Acesso Restrito"');
        return res.status(401).send('Autenticação necessária');
    }
    
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const usuario = auth[0];
    const senha = auth[1];
    
    if (USUARIOS[usuario] && USUARIOS[usuario] === senha) {
        req.usuario = usuario;
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="Consulta Mueller - Acesso Restrito"');
        return res.status(401).send('Usuário ou senha inválidos');
    }
});

// ==================== FUNÇÕES UTILITÁRIAS ====================

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
    } catch (error) {
        return null;
    }
}

function formatarNumeroNF(numero) {
    if (!numero) return "";
    const numStr = numero.toString().padStart(9, '0');
    return numStr.replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3');
}

// ==================== FUNÇÕES API ====================

async function buscarNotaFiscal(orderId) {
    try {
        const url = `https://loja.mueller.ind.br/rest/V1/invoices?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}`;
        
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });

        if (response.data.items && response.data.items.length > 0) {
            const invoice = response.data.items[0];
            const rastreamento = await buscarRastreamento(orderId);
            
            let chaveAcesso = null;
            let numeroNFReal = null;
            
            if (rastreamento && rastreamento.numero_rastreamento && rastreamento.numero_rastreamento.length === 44) {
                chaveAcesso = rastreamento.numero_rastreamento;
                numeroNFReal = extrairInformacoesChaveNF(chaveAcesso);
            }
            
            if (!chaveAcesso && invoice.extension_attributes) {
                const extAttrs = invoice.extension_attributes;
                if (extAttrs.nfe_key) chaveAcesso = extAttrs.nfe_key;
                else if (extAttrs.chave_acesso) chaveAcesso = extAttrs.chave_acesso;
                
                if (chaveAcesso) {
                    numeroNFReal = extrairInformacoesChaveNF(chaveAcesso);
                }
            }
            
            return {
                numero_interno: invoice.increment_id,
                numero_real: numeroNFReal ? numeroNFReal.numero : null,
                serie: numeroNFReal ? numeroNFReal.serie : null,
                formato_completo: numeroNFReal ? numeroNFReal.formato : null,
                numero_formatado: numeroNFReal ? numeroNFReal.numero_formatado : null,
                chave_acesso: chaveAcesso,
                emitida_em: invoice.created_at
            };
        }
        return null;
    } catch (error) {
        console.error("Erro ao buscar nota fiscal:", error.message);
        return null;
    }
}

async function buscarRastreamento(orderId) {
    try {
        const url = `https://loja.mueller.ind.br/rest/V1/shipments?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}`;
        
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });

        if (response.data.items && response.data.items.length > 0) {
            const shipment = response.data.items[0];
            
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

async function processarPedidoCompleto(p) {
    const [notaFiscal, rastreamento] = await Promise.all([
        buscarNotaFiscal(p.entity_id),
        buscarRastreamento(p.entity_id)
    ]);

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
        cpf: p.customer_taxvat ? 
    `${p.customer_taxvat.substring(0, 3)}.${p.customer_taxvat.substring(3, 6)}.${p.customer_taxvat.substring(6, 9)}-${p.customer_taxvat.substring(9, 11)}` : "",
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
        numero_nf_formatado: notaFiscal && notaFiscal.numero_real 
            ? formatarNumeroNF(notaFiscal.numero_real)
            : (notaFiscal ? notaFiscal.numero_interno : null),
        link_pedido: `https://loja.mueller.ind.br/admin/sales/order/view/order_id/${p.entity_id}/`
    };
}

// ==================== HTML TEMPLATE ====================
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Consulta de Pedidos Mueller</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css">
    <style>
        body { background-color: #f8f9fa; padding: 20px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .header { background: linear-gradient(135deg, #682247 0%, #5a1d3d 100%); color: white; padding: 2rem; border-radius: 10px; margin-bottom: 2rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .card { border: none; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); margin-bottom: 1.5rem; transition: transform 0.3s; }
        .card:hover { transform: translateY(-2px); box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        .status-badge { font-size: 0.8rem; padding: 5px 10px; border-radius: 20px; }
        .status-complete { background-color: #d4edda; color: #155724; }
        .status-pending { background-color: #fff3cd; color: #856404; }
        .status-processing { background-color: #cce5ff; color: #004085; }
        .product-badge { background-color: #e9ecef; padding: 3px 8px; border-radius: 5px; font-size: 0.9rem; margin-right: 5px; margin-bottom: 5px; display: inline-block; }
        .badge-pix { background-color: #32bbaf; color: white; }
        .badge-card { background-color: #f0ad4e; color: white; }
        .badge-boleto { background-color: #d9534f; color: white; }
        .search-form { background: white; padding: 1.5rem; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); margin-bottom: 2rem; }
        .table-responsive { border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
        .table th { background-color: #682247; color: white; border: none; }
        .table td { vertical-align: middle; }
        .accordion-button:not(.collapsed) { background-color: rgba(104, 34, 71, 0.1); color: #682247; }
        .info-box { background: white; padding: 15px; border-radius: 8px; border-left: 4px solid #682247; margin-bottom: 15px; }
        .copy-btn { cursor: pointer; transition: all 0.3s; }
        .copy-btn:hover { transform: scale(1.1); }
        .chave-nfe { font-family: monospace; font-size: 0.8rem; background: #f8f9fa; padding: 8px; border-radius: 4px; word-break: break-all; border: 1px solid #dee2e6; }
        .nf-real { background-color: #d4edda; border-left: 4px solid #28a745; padding: 10px; border-radius: 4px; margin-bottom: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header text-center">
    <!-- LOGO MUELLER -->
    <img src="https://loja.mueller.ind.br/static/version1705596758/frontend/Mueller/pt_Br/images/logo.svg" 
         alt="Mueller" 
         height="50" 
         class="mb-2">
    
    <h1><i class="bi bi-search"></i> Consulta de Pedidos Mueller</h1>
        </div>

        <div class="search-form">
            <h4><i class="bi bi-search"></i> Buscar Pedidos</h4>
            <form id="searchForm">
                <div class="row g-3">
                    <div class="col-md-6">
                        <label for="cpf" class="form-label">CPF (somente números)</label>
                        <div class="input-group">
                            <span class="input-group-text"><i class="bi bi-person-badge"></i></span>
                            <input type="text" class="form-control" id="cpf" placeholder="Digite o CPF">
                        </div>
                    </div>
                    <div class="col-md-6">
                        <label for="pedido" class="form-label">Número do Pedido</label>
                        <div class="input-group">
                            <span class="input-group-text"><i class="bi bi-receipt"></i></span>
                            <input type="text" class="form-control" id="pedido" placeholder="Ex: 1000662958">
                        </div>
                    </div>
                    <div class="col-12">
                        <div class="form-text mb-3">Informe o CPF OU o número do pedido</div>
                        <button type="submit" class="btn btn-primary">
                            <i class="bi bi-search"></i> Buscar Pedidos
                        </button>
                        <button type="button" id="clearBtn" class="btn btn-outline-secondary">
                            <i class="bi bi-x-circle"></i> Limpar
                        </button>
                    </div>
                </div>
            </form>
        </div>

        <div id="loading" class="text-center d-none">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Carregando...</span>
            </div>
            <p class="mt-2">Buscando informações...</p>
        </div>

        <div id="results"></div>
        
        <div id="errorAlert" class="alert alert-danger d-none" role="alert">
            <i class="bi bi-exclamation-triangle"></i> <span id="errorMessage"></span>
        </div>

        <div class="mt-4 text-center text-muted">
            <small>
                <i class="bi bi-info-circle"></i> 
                Sistema desenvolvido para consulta de pedidos - Última atualização: ${new Date().toLocaleDateString()}
            </small>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script>
        function extrairInformacoesChaveNF(chave) {
            if (!chave || chave.length !== 44) return null;
            try {
                const serie = chave.substring(22, 25);
                const numeroNFcompleto = chave.substring(25, 34);
                const numeroNF = parseInt(numeroNFcompleto).toString();
                return {
                    numero: numeroNF,
                    numero_completo: numeroNFcompleto,
                    numero_formatado: numeroNFcompleto.replace(/(\\d{3})(\\d{3})(\\d{3})/, '$1.$2.$3'),
                    serie: serie,
                    formato: serie + '/' + numeroNF,
                    chave_acesso: chave
                };
            } catch (error) {
                return null;
            }
        }
        
        function formatarChaveAcesso(chave) {
            if (!chave || chave.length !== 44) return chave;
            return chave.match(/.{1,4}/g).join(' ');
        }
        
        document.getElementById('searchForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const cpf = document.getElementById('cpf').value.trim();
            const pedido = document.getElementById('pedido').value.trim();
            
            if (!cpf && !pedido) {
                showError('Informe o CPF ou o número do pedido');
                return;
            }
            
            if (cpf && !/^\\d{11}$/.test(cpf)) {
                showError('CPF deve conter exatamente 11 números');
                return;
            }
            
            showLoading(true);
            hideError();
            document.getElementById('results').innerHTML = '';
            
            try {
                let queryParam = '';
                if (cpf) queryParam = 'cpf=' + cpf;
                else queryParam = 'pedido=' + pedido;
                
                const response = await fetch('/api/pedidos?' + queryParam, {
                    credentials: 'include' // IMPORTANTE para autenticação!
                });
                const data = await response.json();
                
                if (!response.ok) {
                    if (response.status === 401) {
                        // Recarrega a página para pedir login
                        location.reload();
                        return;
                    }
                    throw new Error(data.erro || 'Erro ao buscar dados');
                }
                
                if (data.length === 0) {
                    showError('Nenhum pedido encontrado para os critérios informados');
                    return;
                }
                
                displayResults(data);
            } catch (error) {
                showError(error.message);
            } finally {
                showLoading(false);
            }
        });
        
        document.getElementById('clearBtn').addEventListener('click', function() {
            document.getElementById('cpf').value = '';
            document.getElementById('pedido').value = '';
            document.getElementById('results').innerHTML = '';
            hideError();
        });
        
        function showLoading(show) {
            document.getElementById('loading').classList.toggle('d-none', !show);
        }
        
        function showError(message) {
            document.getElementById('errorMessage').textContent = message;
            document.getElementById('errorAlert').classList.remove('d-none');
        }
        
        function hideError() {
            document.getElementById('errorAlert').classList.add('d-none');
        }
        
        function formatCurrency(value) {
            return new Intl.NumberFormat('pt-BR', {
                style: 'currency',
                currency: 'BRL'
            }).format(value);
        }
        
        function formatDate(dateString) {
            const date = new Date(dateString);
            return date.toLocaleDateString('pt-BR') + ' ' + date.toLocaleTimeString('pt-BR');
        }
        
        function getStatusBadge(status) {
            const statusMap = {
                'complete': { class: 'status-complete', text: 'Concluído' },
                'complete_delivered': { class: 'status-complete', text: 'Entregue' },
                'processing': { class: 'status-processing', text: 'Processando' },
                'pending': { class: 'status-pending', text: 'Pendente' },
                'pending_payment': { class: 'status-pending', text: 'Aguardando Pagamento' },
                'canceled': { class: 'badge bg-danger', text: 'Cancelado' }
            };
            
            const statusInfo = statusMap[status] || { class: 'badge bg-secondary', text: status };
            return '<span class="badge status-badge ' + statusInfo.class + '">' + statusInfo.text + '</span>';
        }
        
        function getPaymentBadge(paymentMethod) {
            const paymentMap = {
                'pix': { class: 'badge-pix', text: 'PIX' },
                'creditcard': { class: 'badge-card', text: 'Cartão' },
                'boleto': { class: 'badge-boleto', text: 'Boleto' }
            };
            
            const paymentInfo = paymentMap[paymentMethod] || { class: 'badge bg-secondary', text: paymentMethod };
            return '<span class="badge ' + paymentInfo.class + '">' + paymentInfo.text + '</span>';
        }
        
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert('Copiado para área de transferência!');
            });
        }
        
        function displayResults(pedidos) {
            let html = '<div class="mb-4"><h4><i class="bi bi-list-check"></i> Resultados Encontrados: ' + pedidos.length + ' pedido(s)</h4></div>';
            
            html += '<div class="table-responsive mb-4"><table class="table table-hover"><thead><tr><th>Pedido</th><th>Data</th><th>Status</th><th>Valor Total</th><th>Pagamento</th><th>NF</th><th>Ações</th></tr></thead><tbody>';
            
            pedidos.forEach(pedido => {
                const nfDisplay = pedido.nf && pedido.nf.formato_completo 
                    ? pedido.nf.formato_completo 
                    : (pedido.nf ? pedido.nf.numero_interno : '—');
                
                html += '<tr>' +
                    '<td><strong>' + pedido.numero_pedido + '</strong></td>' +
                    '<td>' + formatDate(pedido.data_pedido) + '</td>' +
                    '<td>' + getStatusBadge(pedido.status) + '</td>' +
                    '<td><strong>' + formatCurrency(pedido.valor_total) + '</strong></td>' +
                    '<td>' + getPaymentBadge(pedido.forma_pagamento) + '</td>' +
                    '<td>' + nfDisplay + '</td>' +
                    '<td><button class="btn btn-sm btn-outline-primary" onclick="toggleDetails(\\'' + pedido.numero_pedido + '\\')" data-bs-toggle="collapse" data-bs-target="#details-' + pedido.numero_pedido + '"><i class="bi bi-chevron-down"></i> Detalhes</button></td>' +
                '</tr>' +
                '<tr>' +
                    '<td colspan="7" class="p-0">' +
                        '<div class="collapse" id="details-' + pedido.numero_pedido + '">' +
                            '<div class="card border-0">' +
                                '<div class="card-body">' + getPedidoDetailsHtml(pedido) + '</div>' +
                            '</div>' +
                        '</div>' +
                    '</td>' +
                '</tr>';
            });
            
            html += '</tbody></table></div>';
            
            document.getElementById('results').innerHTML = html;
        }
        
        function getPedidoDetailsHtml(pedido) {
            let html = '<div class="row"><div class="col-md-6">';
            
            html += '<div class="info-box"><h6><i class="bi bi-person"></i> Cliente</h6>' +
                    '<p class="mb-1"><strong>' + pedido.consumidor + '</strong></p>' +
                    '<p class="mb-1">CPF: ' + pedido.cpf + '</p>' +
                    '<p class="mb-1">Email: ' + pedido.email + '</p>' +
                    '<p class="mb-0">Telefone: ' + pedido.telefone + '</p></div>';
            
            html += '<div class="info-box"><h6><i class="bi bi-truck"></i> Endereço de Entrega</h6>';
            if (pedido.endereco_entrega) {
                html += '<p class="mb-1">' + pedido.endereco_entrega.rua + '</p>' +
                        '<p class="mb-1">' + pedido.endereco_entrega.cidade + ' - ' + pedido.endereco_entrega.estado + '</p>' +
                        '<p class="mb-1">CEP: ' + pedido.endereco_entrega.cep + '</p>' +
                        '<p class="mb-0">Tel: ' + (pedido.endereco_entrega.telefone || pedido.telefone) + '</p>';
            } else {
                html += '<p class="text-muted">Nenhum endereço cadastrado</p>';
            }
            html += '</div></div><div class="col-md-6">';
            
            html += '<div class="info-box"><h6><i class="bi bi-box-seam"></i> Produtos (' + pedido.produtos.length + ')</h6>';
            pedido.produtos.forEach(prod => {
                html += '<div class="mb-2">' +
                        '<span class="product-badge">' + prod.quantidade + 'x</span>' +
                        '<strong>' + prod.nome + '</strong><br>' +
                        '<small class="text-muted">SKU: ' + prod.sku + '</small><br>' +
                        '<small>Valor: ' + formatCurrency(prod.total) + '</small>' +
                        '</div>';
            });
            html += '</div>';
            
            if (pedido.nf) {
                const nfInfo = pedido.nf.chave_acesso ? extrairInformacoesChaveNF(pedido.nf.chave_acesso) : null;
                
                html += '<div class="info-box"><h6><i class="bi bi-receipt"></i> Nota Fiscal</h6>';
                
                if (nfInfo) {
                    html += '<div class="nf-real">' +
                            '<h5 class="mb-1"><strong>NF-e: ' + nfInfo.formato + '</strong></h5>' +
                            '<p class="mb-0">Número: <strong>' + nfInfo.numero_formatado + '</strong> (' + nfInfo.numero + ')</p>' +
                            '</div>';
                    
                    html += '<p class="mb-1"><strong>Chave de Acesso:</strong></p>' +
                            '<div class="chave-nfe mb-2">' + formatarChaveAcesso(nfInfo.chave_acesso) + '</div>' +
                            '<button class="btn btn-sm btn-outline-primary copy-btn" ' +
                            'onclick="copyToClipboard(\\'' + nfInfo.chave_acesso + '\\')">' +
                            '<i class="bi bi-clipboard"></i> Copiar Chave</button>';
                } else {
                    html += '<p class="mb-0"><strong>Documento:</strong> ' + pedido.nf.numero_interno + '</p>';
                }
                
                html += '<p class="mb-0 mt-2"><small><strong>Emitida em:</strong> ' + formatDate(pedido.nf.emitida_em) + '</small></p>';
                html += '</div>';
            }
            
            if (pedido.rastreamento && pedido.rastreamento.numero_rastreamento) {
                const chaveRastreamento = pedido.rastreamento.numero_rastreamento;
                const linkRastreamento = 'http://www.transpofrete.com.br/default/rastreio/mercadoria/rastreio.xhtml?exibirDetalhes=true&chave=' + chaveRastreamento;
                
                html += '<div class="info-box">' +
                        '<h6><i class="bi bi-truck"></i> Rastreamento</h6>' +
                        '<p class="mb-1"><strong>Código:</strong> ' + chaveRastreamento + '</p>' +
                        '<p class="mb-2"><strong>Transportadora:</strong> ' + pedido.rastreamento.transportadora + '</p>' +
                        
                        '<a href="' + linkRastreamento + '" target="_blank" class="btn btn-primary">' +
                        '<i class="bi bi-box-arrow-up-right"></i> Acompanhar Entrega</a>' +
                        
                        '<button class="btn btn-outline-secondary ms-2 copy-btn" ' +
                        'onclick="copyToClipboard(\\'' + chaveRastreamento + '\\')" ' +
                        'title="Copiar código">' +
                        '<i class="bi bi-clipboard"></i></button>' +
                        '</div>';
            }
            
            html += '<div class="mt-3">' +
                    '<a href="' + pedido.link_pedido + '" target="_blank" class="btn btn-outline-primary btn-sm">' +
                    '<i class="bi bi-link"></i> Ver no Sistema</a></div></div></div>';
            
            return html;
        }
        
        function toggleDetails(pedidoId) {
            const btn = document.querySelector('button[onclick*="' + pedidoId + '"]');
            const icon = btn.querySelector('i');
            icon.classList.toggle('bi-chevron-down');
            icon.classList.toggle('bi-chevron-up');
        }
        
        document.getElementById('cpf').addEventListener('input', function(e) {
            let value = e.target.value.replace(/\\D/g, '');
            if (value.length > 11) value = value.substring(0, 11);
            e.target.value = value;
        });
    </script>
</body>
</html>`;

// ==================== ROTAS ====================

app.get("/", (req, res) => {
    res.send(HTML_TEMPLATE);
});

// Página com instruções de login
app.get("/login-info", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Instruções de Acesso</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        </head>
        <body class="container mt-5">
            <div class="card">
                <div class="card-header bg-primary text-white">
                    <h4>Instruções de Acesso - Sistema Mueller</h4>
                </div>
                <div class="card-body">
                    <h5>Como acessar:</h5>
                    <p>1. Ao acessar o sistema, seu navegador solicitará usuário e senha</p>
                    <p>2. Utilize as credenciais fornecidas pelo administrador</p>
                    
                    <h5 class="mt-4">Usuários autorizados:</h5>
                    <ul>
                        <li><strong>valmor</strong> - Acesso completo</li>
                        <li><strong>financeiro</strong> - Departamento Financeiro</li>
                        <li><strong>vendas</strong> - Equipe de Vendas</li>
                    </ul>
                    
                    <div class="alert alert-info mt-4">
                        <strong>Problemas de acesso?</strong><br>
                        Contate o administrador do sistema para obter suas credenciais.
                    </div>
                    
                    <a href="/" class="btn btn-primary">Voltar ao Sistema</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

// API SEGURA - TOKEN PROTEGIDO
app.get("/api/pedidos", async (req, res) => {
    try {
        const { cpf, pedido } = req.query;

        if (!cpf && !pedido) {
            return res.status(400).json({ erro: "Informe CPF ou número do pedido" });
        }

        const field = cpf ? "customer_taxvat" : "increment_id";
        const value = cpf || pedido;

        const cacheKey = `${field}:${value}:${req.usuario}`;
        if (cache.has(cacheKey)) {
            const cachedData = cache.get(cacheKey);
            if (Date.now() - cachedData.timestamp < 300000) {
                return res.json(cachedData.data);
            }
        }

        const url = `https://loja.mueller.ind.br/rest/V1/orders?searchCriteria[filter_groups][0][filters][0][field]=${field}&searchCriteria[filter_groups][0][filters][0][value]=${value}&searchCriteria[pageSize]=50`;

        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });

        if (!response.data.items || response.data.items.length === 0) {
            return res.json([]);
        }

        const seisMesesAtras = new Date();
        seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);

        const pedidosCompletos = await Promise.all(
            response.data.items
                .filter(p => new Date(p.created_at) >= seisMesesAtras)
                .map(async (p) => {
                    return await processarPedidoCompleto(p);
                })
        );

        cache.set(cacheKey, {
            timestamp: Date.now(),
            data: pedidosCompletos
        });

        res.json(pedidosCompletos);

    } catch (error) {
        console.error("Erro na API:", error.message);
        
        if (error.response?.status === 401) {
            return res.status(500).json({ erro: "Erro de autenticação com o sistema Mueller" });
        }
        
        res.status(500).json({ 
            erro: "Erro ao consultar pedidos",
            detalhes: "Entre em contato com o suporte técnico"
        });
    }
});

// Rota compatível (também segura)
app.get("/pedidos", async (req, res) => {
    try {
        const { cpf, pedido } = req.query;

        if (!cpf && !pedido) {
            return res.status(400).json({ erro: "Informe CPF ou número do pedido" });
        }

        const field = cpf ? "customer_taxvat" : "increment_id";
        const value = cpf || pedido;

        const cacheKey = `${field}:${value}:${req.usuario}`;
        if (cache.has(cacheKey)) {
            const cachedData = cache.get(cacheKey);
            if (Date.now() - cachedData.timestamp < 300000) {
                return res.json(cachedData.data);
            }
        }

        const url = `https://loja.mueller.ind.br/rest/V1/orders?searchCriteria[filter_groups][0][filters][0][field]=${field}&searchCriteria[filter_groups][0][filters][0][value]=${value}&searchCriteria[pageSize]=50`;

        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });

        if (!response.data.items || response.data.items.length === 0) {
            return res.json([]);
        }

        const seisMesesAtras = new Date();
        seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);

        const pedidosCompletos = await Promise.all(
            response.data.items
                .filter(p => new Date(p.created_at) >= seisMesesAtras)
                .map(async (p) => {
                    return await processarPedidoCompleto(p);
                })
        );

        cache.set(cacheKey, {
            timestamp: Date.now(),
            data: pedidosCompletos
        });

        res.json(pedidosCompletos);

    } catch (error) {
        console.error("Erro:", error.message);
        res.status(500).json({ erro: "Erro ao consultar pedidos" });
    }
});

app.get("/status", (req, res) => {
    res.json({
        status: "online",
        timestamp: new Date().toISOString(),
        usuario: req.usuario || "não autenticado",
        cache_size: cache.size,
        ambiente: process.env.NODE_ENV || "desenvolvimento"
    });
});

app.delete("/api/cache", (req, res) => {
    cache.clear();
    res.json({ mensagem: "Cache limpo", cache_size: cache.size });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`✅ Servidor SEGURO rodando na porta ${PORT}`);
    console.log(`🔐 Login obrigatório ativado`);
    console.log(`🌐 Acesse: http://localhost:${PORT}`);
});
