const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const TOKEN = process.env.MUELLER_TOKEN;

// Cache simples
const cache = new Map();

// ==================== FUNÇÕES UTILITÁRIAS ====================

// Função para extrair informações detalhadas da chave NF-e
function extrairInformacoesChaveNF(chaveAcesso) {
  if (!chaveAcesso || chaveAcesso.length !== 44) {
    return null;
  }
  
  try {
    // Extrair todas as informações da chave
    const uf = chaveAcesso.substring(0, 2);
    const ano = chaveAcesso.substring(2, 4);
    const mes = chaveAcesso.substring(4, 6);
    const cnpj = chaveAcesso.substring(6, 20);
    const modelo = chaveAcesso.substring(20, 22);
    const serie = chaveAcesso.substring(22, 25);
    const numeroNFcompleto = chaveAcesso.substring(25, 34);
    const tipoEmissao = chaveAcesso.substring(34, 35);
    const codigoNumerico = chaveAcesso.substring(35, 43);
    const dv = chaveAcesso.substring(43, 44);
    
    // Número da NF sem zeros à esquerda
    const numeroNF = parseInt(numeroNFcompleto).toString();
    
    // Formatar CNPJ
    const cnpjFormatado = cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    
    // Mapear UF
    const ufMap = {
      '42': 'SC - Santa Catarina',
      '35': 'SP - São Paulo',
      '33': 'RJ - Rio de Janeiro',
      '41': 'PR - Paraná',
      '43': 'RS - Rio Grande do Sul',
      '31': 'MG - Minas Gerais'
    };
    
    return {
      numero: numeroNF,
      numero_completo: numeroNFcompleto,
      numero_formatado: numeroNFcompleto.replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3'),
      serie: serie,
      formato: `${serie}/${numeroNF}`,
      chave_acesso: chaveAcesso,
      uf: uf,
      uf_completo: ufMap[uf] || `UF ${uf}`,
      ano: `20${ano}`,
      mes: mes,
      ano_mes: `20${ano}/${mes}`,
      cnpj: cnpj,
      cnpj_formatado: cnpjFormatado,
      modelo: modelo,
      modelo_descricao: modelo === '55' ? 'NF-e' : modelo === '65' ? 'NFC-e' : `Modelo ${modelo}`,
      tipo_emissao: tipoEmissao,
      codigo_numerico: codigoNumerico,
      dv: dv
    };
  } catch (error) {
    console.error("Erro ao extrair informações da chave:", error);
    return null;
  }
}

// Função simplificada para extrair apenas número da NF
function extrairNumeroNFdaChave(chaveAcesso) {
  const info = extrairInformacoesChaveNF(chaveAcesso);
  if (!info) return null;
  
  return {
    numero: info.numero,
    serie: info.serie,
    numero_completo: info.numero_completo,
    chave_acesso: info.chave_acesso,
    formato: info.formato,
    numero_formatado: info.numero_formatado
  };
}

// Função para formatar número da NF no padrão brasileiro
function formatarNumeroNF(numero) {
  if (!numero) return "";
  
  const numStr = numero.toString().padStart(9, '0');
  return numStr.replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3');
}

// ==================== FUNÇÕES API MAGENTO ====================

// Função ATUALIZADA para buscar notas fiscais - USA O RASTREAMENTO COMO CHAVE!
async function buscarNotaFiscal(orderId) {
  try {
    const url = `https://loja.mueller.ind.br/rest/V1/invoices?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${orderId}`;
    
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    if (response.data.items && response.data.items.length > 0) {
      const invoice = response.data.items[0];
      
      // NÚMERO INTERNO DO SISTEMA
      const numeroInterno = invoice.increment_id;
      
      // PRIMEIRO: Buscar o rastreamento para pegar a CHAVE
      const rastreamento = await buscarRastreamento(orderId);
      
      let chaveAcesso = null;
      let numeroNFReal = null;
      
      // SEÇÃO CRÍTICA: A chave está no código de rastreamento!
      if (rastreamento && rastreamento.numero_rastreamento && rastreamento.numero_rastreamento.length === 44) {
        // O "código de rastreamento" é na verdade a CHAVE DA NF!
        chaveAcesso = rastreamento.numero_rastreamento;
        numeroNFReal = extrairNumeroNFdaChave(chaveAcesso);
      }
      
      // Se não encontrou no rastreamento, tenta na invoice
      if (!chaveAcesso && invoice.extension_attributes) {
        const extAttrs = invoice.extension_attributes;
        if (extAttrs.nfe_key) chaveAcesso = extAttrs.nfe_key;
        else if (extAttrs.chave_acesso) chaveAcesso = extAttrs.chave_acesso;
        else if (extAttrs.nfeChave) chaveAcesso = extAttrs.nfeChave;
        
        if (chaveAcesso) {
          numeroNFReal = extrairNumeroNFdaChave(chaveAcesso);
        }
      }
      
      return {
        // Número interno do sistema (invoice)
        numero_interno: numeroInterno,
        // Número real da NF (extraído da chave no rastreamento)
        numero_real: numeroNFReal ? numeroNFReal.numero : null,
        serie: numeroNFReal ? numeroNFReal.serie : null,
        formato_completo: numeroNFReal ? numeroNFReal.formato : null,
        numero_formatado: numeroNFReal ? numeroNFReal.numero_formatado : null,
        chave_acesso: chaveAcesso,
        emitida_em: invoice.created_at,
        // Informações adicionais se tivermos a chave
        ...(chaveAcesso ? {
          modelo: chaveAcesso.substring(20, 22),
          cnpj_emitente: chaveAcesso.substring(6, 20),
          uf: chaveAcesso.substring(0, 2),
          ano_mes: chaveAcesso.substring(2, 6)
        } : {})
      };
    }
    return null;
  } catch (error) {
    console.error("Erro ao buscar nota fiscal:", error.message);
    return null;
  }
}

// Função para buscar rastreamento
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

// Função para buscar nota fiscal por número interno
async function buscarNotaFiscalPorNumero(numeroNF) {
  try {
    const url = `https://loja.mueller.ind.br/rest/V1/invoices?searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=${numeroNF}`;
    
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    if (response.data.items && response.data.items.length > 0) {
      const invoice = response.data.items[0];
      
      let chaveAcesso = null;
      let numeroNFReal = null;
      
      if (invoice.extension_attributes) {
        const extAttrs = invoice.extension_attributes;
        if (extAttrs.nfe_key) chaveAcesso = extAttrs.nfe_key;
        else if (extAttrs.chave_acesso) chaveAcesso = extAttrs.chave_acesso;
        else if (extAttrs.nfeChave) chaveAcesso = extAttrs.nfeChave;
      }
      
      if (chaveAcesso) {
        numeroNFReal = extrairNumeroNFdaChave(chaveAcesso);
      }
      
      return {
        numero_interno: invoice.increment_id,
        numero_real: numeroNFReal ? numeroNFReal.numero : null,
        serie: numeroNFReal ? numeroNFReal.serie : null,
        formato_completo: numeroNFReal ? numeroNFReal.formato : null,
        chave_acesso: chaveAcesso,
        order_id: invoice.order_id,
        emitida_em: invoice.created_at
      };
    }
    return null;
  } catch (error) {
    console.error("Erro ao buscar nota fiscal por número:", error.message);
    return null;
  }
}

// Função para processar um pedido completo
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
        body {
            background-color: #f8f9fa;
            padding: 20px;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem;
            border-radius: 10px;
            margin-bottom: 2rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .card {
            border: none;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.08);
            margin-bottom: 1.5rem;
            transition: transform 0.3s;
        }
        .card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
        }
        .status-badge {
            font-size: 0.8rem;
            padding: 5px 10px;
            border-radius: 20px;
        }
        .status-complete {
            background-color: #d4edda;
            color: #155724;
        }
        .status-pending {
            background-color: #fff3cd;
            color: #856404;
        }
        .status-processing {
            background-color: #cce5ff;
            color: #004085;
        }
        .product-badge {
            background-color: #e9ecef;
            padding: 3px 8px;
            border-radius: 5px;
            font-size: 0.9rem;
            margin-right: 5px;
            margin-bottom: 5px;
            display: inline-block;
        }
        .badge-pix {
            background-color: #32bbaf;
            color: white;
        }
        .badge-card {
            background-color: #f0ad4e;
            color: white;
        }
        .badge-boleto {
            background-color: #d9534f;
            color: white;
        }
        .search-form {
            background: white;
            padding: 1.5rem;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.08);
            margin-bottom: 2rem;
        }
        .table-responsive {
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 2px 10px rgba(0,0,0,0.08);
        }
        .table th {
            background-color: #667eea;
            color: white;
            border: none;
        }
        .table td {
            vertical-align: middle;
        }
        .accordion-button:not(.collapsed) {
            background-color: rgba(102, 126, 234, 0.1);
            color: #667eea;
        }
        .info-box {
            background: white;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #667eea;
            margin-bottom: 15px;
        }
        .copy-btn {
            cursor: pointer;
            transition: all 0.3s;
        }
        .copy-btn:hover {
            transform: scale(1.1);
        }
        .chave-nfe {
            font-family: monospace;
            font-size: 0.8rem;
            background: #f8f9fa;
            padding: 8px;
            border-radius: 4px;
            word-break: break-all;
            border: 1px solid #dee2e6;
        }
        .nf-real {
            background-color: #d4edda;
            border-left: 4px solid #28a745;
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 15px;
        }
        .nf-interna {
            background-color: #f8f9fa;
            border-left: 4px solid #6c757d;
            padding: 8px;
            border-radius: 4px;
            font-size: 0.9rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header text-center">
            <h1><i class="bi bi-search"></i> Consulta de Pedidos Mueller</h1>
            <p class="lead">Sistema de consulta de pedidos por CPF, número do pedido ou NF</p>
        </div>

        <div class="search-form">
            <h4><i class="bi bi-search"></i> Buscar Pedidos</h4>
            <form id="searchForm">
                <div class="row g-3">
                    <div class="col-md-4">
                        <label for="cpf" class="form-label">CPF (somente números)</label>
                        <div class="input-group">
                            <span class="input-group-text"><i class="bi bi-person-badge"></i></span>
                            <input type="text" class="form-control" id="cpf" placeholder="Digite o CPF">
                        </div>
                    </div>
                    <div class="col-md-4">
                        <label for="pedido" class="form-label">Número do Pedido</label>
                        <div class="input-group">
                            <span class="input-group-text"><i class="bi bi-receipt"></i></span>
                            <input type="text" class="form-control" id="pedido" placeholder="Ex: 1000662958">
                        </div>
                    </div>
                    <div class="col-md-4">
                        <label for="nf" class="form-label">Número da NF</label>
                        <div class="input-group">
                            <span class="input-group-text"><i class="bi bi-file-text"></i></span>
                            <input type="text" class="form-control" id="nf" placeholder="Ex: 1000566780">
                        </div>
                    </div>
                    <div class="col-12">
                        <div class="form-text mb-3">Informe APENAS UM: CPF OU número do pedido OU número da NF</div>
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
        // Função para extrair informações da chave NF-e (frontend)
        function extrairInformacoesChaveNF(chave) {
            if (!chave || chave.length !== 44) return null;
            
            try {
                const uf = chave.substring(0, 2);
                const ano = chave.substring(2, 4);
                const mes = chave.substring(4, 6);
                const modelo = chave.substring(20, 22);
                const serie = chave.substring(22, 25);
                const numeroNFcompleto = chave.substring(25, 34);
                const numeroNF = parseInt(numeroNFcompleto).toString();
                
                const ufMap = {
                    '42': 'SC - Santa Catarina',
                    '35': 'SP - São Paulo',
                    '33': 'RJ - Rio de Janeiro',
                    '41': 'PR - Paraná',
                    '43': 'RS - Rio Grande do Sul'
                };
                
                return {
                    numero: numeroNF,
                    numero_completo: numeroNFcompleto,
                    numero_formatado: numeroNFcompleto.replace(/(\\d{3})(\\d{3})(\\d{3})/, '$1.$2.$3'),
                    serie: serie,
                    formato: serie + '/' + numeroNF,
                    chave_acesso: chave,
                    uf_completo: ufMap[uf] || 'UF ' + uf,
                    ano_mes: '20' + ano + '/' + mes,
                    modelo_descricao: modelo === '55' ? 'NF-e' : 'Modelo ' + modelo
                };
            } catch (error) {
                return null;
            }
        }
        
        // Função para formatar chave de acesso
        function formatarChaveAcesso(chave) {
            if (!chave || chave.length !== 44) return chave;
            return chave.match(/.{1,4}/g).join(' ');
        }
        
        document.getElementById('searchForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const cpf = document.getElementById('cpf').value.trim();
            const pedido = document.getElementById('pedido').value.trim();
            const nf = document.getElementById('nf').value.trim();
            
            const camposPreenchidos = [cpf, pedido, nf].filter(Boolean).length;
            
            if (camposPreenchidos === 0) {
                showError('Informe o CPF, número do pedido ou número da NF');
                return;
            }
            
            if (camposPreenchidos > 1) {
                showError('Informe apenas UM critério de busca por vez');
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
                else if (pedido) queryParam = 'pedido=' + pedido;
                else if (nf) queryParam = 'nf=' + nf;
                
                const response = await fetch('/api/pedidos?' + queryParam);
                const data = await response.json();
                
                if (!response.ok) {
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
            document.getElementById('nf').value = '';
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
            
            // Cliente
            html += '<div class="info-box"><h6><i class="bi bi-person"></i> Cliente</h6>' +
                    '<p class="mb-1"><strong>' + pedido.consumidor + '</strong></p>' +
                    '<p class="mb-1">CPF: ' + pedido.cpf + '</p>' +
                    '<p class="mb-1">Email: ' + pedido.email + '</p>' +
                    '<p class="mb-0">Telefone: ' + pedido.telefone + '</p></div>';
            
            // Endereço
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
            
            // Produtos
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
            
            // NOTA FISCAL - VERSÃO SUPER MELHORADA
            if (pedido.nf) {
                const nfInfo = pedido.nf.chave_acesso ? extrairInformacoesChaveNF(pedido.nf.chave_acesso) : null;
                
                html += '<div class="info-box">' +
                        '<h6><i class="bi bi-receipt"></i> Nota Fiscal Eletrônica</h6>';
                
                // 1. NÚMERO REAL DA NF (extraído da chave) - DESTAQUE
                if (nfInfo) {
                    html += '<div class="nf-real">' +
                            '<h5 class="mb-1"><strong>NF-e Real: ' + nfInfo.formato + '</strong></h5>' +
                            '<p class="mb-0">Número: <strong>' + nfInfo.numero_formatado + '</strong> (' + nfInfo.numero + ')</p>' +
                            '</div>';
                    
                    // 2. INFORMAÇÕES DA CHAVE
                    html += '<div class="mb-3">' +
                            '<strong>Informações da Chave:</strong><br>' +
                            '<small>' + nfInfo.uf_completo + ' | Emissão: ' + nfInfo.ano_mes + ' | ' + nfInfo.modelo_descricao + '</small>' +
                            '</div>';
                    
                    // 3. CHAVE FORMATADA
                    html += '<div class="mb-3">' +
                            '<strong>Chave de Acesso (44 dígitos):</strong>' +
                            '<div class="chave-nfe mt-1">' + formatarChaveAcesso(nfInfo.chave_acesso) + '</div>' +
                            '<button class="btn btn-sm btn-outline-primary copy-btn mt-1 me-2" ' +
                            'onclick="copyToClipboard(\\'' + nfInfo.chave_acesso + '\\')" ' +
                            'title="Copiar chave completa">' +
                            '<i class="bi bi-clipboard"></i> Copiar Chave</button>' +
                            
                            '<button class="btn btn-sm btn-outline-success copy-btn mt-1" ' +
                            'onclick="copyToClipboard(\\'' + nfInfo.numero + '\\')" ' +
                            'title="Copiar apenas o número da NF">' +
                            '<i class="bi bi-clipboard-check"></i> Copiar Número NF</button>' +
                            '</div>';
                    
                    // 4. LINKS PARA CONSULTA
                    html += '<div class="d-grid gap-2">' +
                            '<a href="https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=resumo&tipoConteudo=Gb3PasosJ2k=" ' +
                            'target="_blank" class="btn btn-primary">' +
                            '<i class="bi bi-search"></i> Consultar NF-e no Portal da Fazenda</a>' +
                            
                            '<a href="https://www.sefaz.rs.gov.br/NFE/NFE-NFC.aspx?p=' + pedido.nf.chave_acesso + '&t=1" ' +
                            'target="_blank" class="btn btn-outline-primary">' +
                            '<i class="bi bi-qr-code"></i> Ver DANFE Online</a>' +
                            '</div>';
                }
                
                // 5. NÚMERO INTERNO DO SISTEMA (para referência)
                html += '<div class="nf-interna mt-3">' +
                        '<i class="bi bi-info-circle"></i> ' +
                        '<strong>Documento Interno do Sistema:</strong> ' + pedido.nf.numero_interno + ' | ' +
                        '<strong>Emitida em:</strong> ' + formatDate(pedido.nf.emitida_em) +
                        '</div>';
                
                html += '</div>';
            }
            
            // Rastreamento
            if (pedido.rastreamento) {
                html += '<div class="info-box">' +
                        '<h6><i class="bi bi-truck"></i> Rastreamento</h6>' +
                        '<p class="mb-1"><strong>Código:</strong> ' + 
                        '<span id="track-' + pedido.numero_pedido + '">' + pedido.rastreamento.numero_rastreamento + '</span>' +
                        '<button class="btn btn-sm btn-outline-secondary copy-btn ms-2" onclick="copyToClipboard(\\'' + pedido.rastreamento.numero_rastreamento + '\\')" title="Copiar código"><i class="bi bi-clipboard"></i></button></p>' +
                        '<p class="mb-1"><strong>Transportadora:</strong> ' + pedido.rastreamento.transportadora + '</p>';
                if (pedido.rastreamento.link_rastreamento) {
                    html += '<a href="' + pedido.rastreamento.link_rastreamento + '" target="_blank" class="btn btn-sm btn-primary"><i class="bi bi-box-arrow-up-right"></i> Acompanhar Entrega</a>';
                }
                html += '</div>';
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
        
        // Adicionar máscara ao CPF
        document.getElementById('cpf').addEventListener('input', function(e) {
            let value = e.target.value.replace(/\\D/g, '');
            if (value.length > 11) value = value.substring(0, 11);
            e.target.value = value;
        });
    </script>
</body>
</html>`;

// ==================== ROTAS DA API ====================

app.get("/", (req, res) => {
  res.send(HTML_TEMPLATE);
});

// Rota da API com suporte a CPF, Pedido e NF
app.get("/api/pedidos", async (req, res) => {
  try {
    const { cpf, pedido, nf } = req.query;

    if (!cpf && !pedido && !nf) {
      return res.status(400).json({ 
        erro: "Informe CPF, número do pedido ou número da NF" 
      });
    }

    let pedidosCompletos = [];

    // CASO 1: Busca por CPF ou Pedido
    if (cpf || pedido) {
      const field = cpf ? "customer_taxvat" : "increment_id";
      const value = cpf || pedido;

      const cacheKey = `${field}:${value}`;
      if (cache.has(cacheKey)) {
        const cachedData = cache.get(cacheKey);
        if (Date.now() - cachedData.timestamp < 300000) {
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

      pedidosCompletos = await Promise.all(
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
    }
    
    // CASO 2: Busca por Número da NF (número interno)
    else if (nf) {
      const notaFiscal = await buscarNotaFiscalPorNumero(nf);
      
      if (!notaFiscal) {
        return res.json([]);
      }
      
      const orderId = notaFiscal.order_id;
      
      const url = `https://loja.mueller.ind.br/rest/V1/orders/${orderId}`;
      
      try {
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${TOKEN}`
          }
        });
        
        const pedido = response.data;
        const pedidoProcessado = await processarPedidoCompleto(pedido);
        pedidosCompletos = [pedidoProcessado];
        
      } catch (error) {
        console.error("Erro ao buscar pedido por ID:", error.message);
        return res.json([]);
      }
    }

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

// Rota para manter compatibilidade com versão anterior
app.get("/pedidos", async (req, res) => {
  try {
    const { cpf, pedido } = req.query;

    if (!cpf && !pedido) {
      return res.status(400).json({ erro: "Informe CPF ou número do pedido" });
    }

    const field = cpf ? "customer_taxvat" : "increment_id";
    const value = cpf || pedido;

    const cacheKey = `${field}:${value}`;
    if (cache.has(cacheKey)) {
      const cachedData = cache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < 300000) {
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

// Rota de status
app.get("/status", (req, res) => {
  res.json({
    status: "online",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cache_size: cache.size
  });
});

// Endpoint para limpar cache
app.delete("/api/cache", (req, res) => {
  cache.clear();
  res.json({ mensagem: "Cache limpo", cache_size: cache.size });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
  console.log(`🔧 Ambiente: ${process.env.NODE_ENV || 'desenvolvimento'}`);
});
