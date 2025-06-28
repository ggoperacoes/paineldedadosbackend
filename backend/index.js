const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { subDays, subHours, subMinutes, subSeconds, format } = require('date-fns');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Carregar variáveis de ambiente
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Configurar CORS
app.use(cors({
  origin: ['http://localhost:3000', 'https://*.netlify.app'],
  credentials: true
}));

app.use(express.json());

// Configurar Supabase (se as credenciais estiverem disponíveis)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// Middleware de autenticação simples
const authMiddleware = (req, res, next) => {
  const password = req.headers['x-auth-password'];
  if (password !== process.env.AUTH_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Armazenamento em memória para demonstração (quando Supabase não estiver configurado)
let salesHistory = [];

// Função para extrair dados da mensagem do bot
function extractSaleData(message) {
  const data = {};
  
  // Extrair ID do cliente
  const idMatch = message.match(/🆔 ID Cliente: (\d+)/);
  if (idMatch) {
    data.client_id = idMatch[1];
  }
  
  // Extrair plano
  const planoMatch = message.match(/Plano (\w+)/i);
  if (planoMatch) {
    data.plan = planoMatch[1];
  }
  
  // Extrair valor
  const valorMatch = message.match(/R\$\s*(\d+[,.]?\d*)/);
  if (valorMatch) {
    const valorStr = valorMatch[1].replace(',', '.');
    data.value = parseFloat(valorStr);
  }
  
  // Extrair tempo de conversão
  const tempoMatch = message.match(/⏳ Tempo Conversão: (\d+)d (\d+)h (\d+)m (\d+)s/);
  if (tempoMatch) {
    data.conversion_time = {
      days: parseInt(tempoMatch[1]),
      hours: parseInt(tempoMatch[2]),
      minutes: parseInt(tempoMatch[3]),
      seconds: parseInt(tempoMatch[4])
    };
  }
  
  // Extrair data e hora da compra
  const dataMatch = message.match(/🕓 Data e Hora da compra: (\d{2}\/\d{2}\/\d{4}) (\d{2}:\d{2})/);
  if (dataMatch) {
    data.purchase_datetime = `${dataMatch[1]} ${dataMatch[2]}`;
  }
  
  return data;
}

// Função para calcular o horário estimado do clique
function calculateClickTime(purchaseDateTime, conversionTime) {
  // Converter string para Date
  const [datePart, timePart] = purchaseDateTime.split(' ');
  const [day, month, year] = datePart.split('/');
  const [hour, minute] = timePart.split(':');
  
  let purchaseDate = new Date(year, month - 1, day, hour, minute);
  
  // Subtrair o tempo de conversão
  purchaseDate = subDays(purchaseDate, conversionTime.days);
  purchaseDate = subHours(purchaseDate, conversionTime.hours);
  purchaseDate = subMinutes(purchaseDate, conversionTime.minutes);
  purchaseDate = subSeconds(purchaseDate, conversionTime.seconds);
  
  return purchaseDate;
}

// Função para consultar eventos na UTMIFY
async function queryUtmifyEvents(clickTime, marginMinutes = 5) {
  if (!process.env.UTMIFY_API_TOKEN) {
    // Retornar dados simulados para demonstração
    return {
      data: [
        {
          utm_campaign: 'CJ2_VIDA_LTV',
          utm_content: 'CJ2_CRT1',
          utm_source: 'facebook',
          utm_medium: 'cpc',
          event_time: format(clickTime, 'yyyy-MM-dd HH:mm:ss'),
          ip: '192.168.1.1',
          fbp: 'fb.1.123456789.987654321',
          fbc: 'fb.1.123456789.987654321'
        },
        {
          utm_campaign: 'CJ2_VIDA_LTV',
          utm_content: 'CJ2_CRT2',
          utm_source: 'facebook',
          utm_medium: 'cpc',
          event_time: format(clickTime, 'yyyy-MM-dd HH:mm:ss'),
          ip: '192.168.1.2',
          fbp: 'fb.1.123456789.987654322',
          fbc: 'fb.1.123456789.987654322'
        }
      ]
    };
  }
  
  // Calcular intervalo de tempo
  const startTime = subMinutes(clickTime, marginMinutes);
  const endTime = subMinutes(clickTime, -marginMinutes);
  
  const startStr = format(startTime, 'yyyy-MM-dd HH:mm:ss');
  const endStr = format(endTime, 'yyyy-MM-dd HH:mm:ss');
  
  try {
    const response = await axios.get('https://api.utmify.com.br/api-credentials/events', {
      headers: {
        'x-api-token': process.env.UTMIFY_API_TOKEN,
        'Content-Type': 'application/json'
      },
      params: {
        start_date: startStr,
        end_date: endStr,
        event_types: 'PageView,ViewContent,Lead'
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('Erro ao consultar UTMIFY:', error.message);
    return { error: `Erro na API UTMIFY: ${error.message}` };
  }
}

// Função para analisar cliques e rankear por probabilidade
function analyzeClicks(events, clickTime) {
  if (!events || !events.data) {
    return [];
  }
  
  // Agrupar por campanha/criativo
  const campaigns = {};
  
  events.data.forEach(event => {
    const utmCampaign = event.utm_campaign || 'Desconhecida';
    const utmContent = event.utm_content || 'Desconhecido';
    
    const key = `${utmCampaign}_${utmContent}`;
    
    if (!campaigns[key]) {
      campaigns[key] = {
        campaign: utmCampaign,
        creative: utmContent,
        utm_source: event.utm_source || '',
        utm_medium: event.utm_medium || '',
        count: 0,
        events: []
      };
    }
    
    campaigns[key].count += 1;
    campaigns[key].events.push(event);
  });
  
  // Ordenar por número de cliques
  const sortedCampaigns = Object.values(campaigns)
    .sort((a, b) => b.count - a.count);
  
  // Determinar nível de confiança
  return sortedCampaigns.slice(0, 3).map(campaign => {
    let confidence = 'Baixa';
    if (campaign.count > 20) confidence = 'Alta';
    else if (campaign.count > 10) confidence = 'Média';
    
    return {
      campaign: campaign.campaign,
      creative: campaign.creative,
      utm_source: campaign.utm_source,
      utm_medium: campaign.utm_medium,
      confidence,
      click_count: campaign.count
    };
  });
}

// Função para salvar no Supabase ou memória
async function saveSaleAnalysis(saleData, analysisResult) {
  const data = {
    original_message: saleData.original_message || '',
    client_id: saleData.client_id,
    plan: saleData.plan,
    value: saleData.value,
    purchase_datetime: saleData.purchase_datetime,
    estimated_click_time: analysisResult.estimated_click_time,
    campaign: analysisResult.top_result?.campaign,
    creative: analysisResult.top_result?.creative,
    confidence: analysisResult.top_result?.confidence,
    analysis_data: analysisResult,
    created_at: new Date().toISOString()
  };
  
  if (supabase) {
    try {
      const { data: result, error } = await supabase
        .from('sales_analysis')
        .insert(data);
      
      if (error) throw error;
      return { success: true, id: result?.[0]?.id };
    } catch (error) {
      console.error('Erro ao salvar no Supabase:', error);
      return { error: `Erro ao salvar no Supabase: ${error.message}` };
    }
  } else {
    // Salvar em memória
    data.id = salesHistory.length + 1;
    salesHistory.push(data);
    return { success: true, id: data.id };
  }
}

// Função para registrar venda na UTMIFY (opcional)
async function registerSaleUtmify(saleData, utmData) {
  if (!process.env.UTMIFY_API_TOKEN) {
    return { error: 'Token UTMIFY não configurado' };
  }
  
  const valueCents = Math.round((saleData.value || 0) * 100);
  
  const payload = {
    orderId: `bot_${saleData.client_id || 'unknown'}_${Date.now()}`,
    platform: 'TelegramBot',
    paymentMethod: 'pix',
    status: 'paid',
    createdAt: saleData.purchase_datetime || '',
    approvedDate: saleData.purchase_datetime || '',
    customer: {
      name: `Cliente ${saleData.client_id || 'Desconhecido'}`,
      country: 'BR',
      ip: '0.0.0.0'
    },
    products: [{
      id: saleData.plan || 'plano_desconhecido',
      name: `Plano ${saleData.plan || 'Desconhecido'}`,
      quantity: 1,
      priceInCents: valueCents
    }],
    trackingParameters: {
      utm_source: utmData.utm_source || '',
      utm_campaign: utmData.campaign || '',
      utm_medium: utmData.utm_medium || '',
      utm_content: utmData.creative || ''
    },
    commission: {
      totalPriceInCents: valueCents,
      gatewayFeeInCents: Math.round(valueCents * 0.15),
      userCommissionInCents: Math.round(valueCents * 0.85)
    },
    isTest: false
  };
  
  try {
    const response = await axios.post(
      'https://api.utmify.com.br/api-credentials/orders',
      payload,
      {
        headers: {
          'x-api-token': process.env.UTMIFY_API_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return { success: true, data: response.data };
  } catch (error) {
    console.error('Erro ao registrar venda na UTMIFY:', error.message);
    return { error: `Erro ao registrar venda na UTMIFY: ${error.message}` };
  }
}

// Rotas da API

// Endpoint principal para análise de vendas
app.post('/api/analyze-sale', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Mensagem não fornecida' });
    }
    
    // Extrair dados da mensagem
    const saleData = extractSaleData(message);
    saleData.original_message = message;
    
    if (!saleData.purchase_datetime || !saleData.conversion_time) {
      return res.status(400).json({ 
        error: 'Não foi possível extrair dados necessários da mensagem' 
      });
    }
    
    // Calcular horário do clique
    const clickTime = calculateClickTime(
      saleData.purchase_datetime,
      saleData.conversion_time
    );
    
    // Consultar UTMIFY
    const events = await queryUtmifyEvents(clickTime);
    
    // Analisar cliques
    const analysis = analyzeClicks(events, clickTime);
    
    // Preparar resultado
    const result = {
      sale_data: saleData,
      estimated_click_time: format(clickTime, 'dd/MM/yyyy HH:mm'),
      analysis,
      top_result: analysis[0] || null,
      events_found: events.data ? events.data.length : 0
    };
    
    // Salvar análise
    const saveResult = await saveSaleAnalysis(saleData, result);
    result.saved = saveResult;
    
    // Registrar venda na UTMIFY se houver resultado
    if (analysis.length > 0) {
      const utmifyResult = await registerSaleUtmify(saleData, analysis[0]);
      result.utmify_registration = utmifyResult;
    }
    
    res.json(result);
  } catch (error) {
    console.error('Erro interno:', error);
    res.status(500).json({ error: `Erro interno: ${error.message}` });
  }
});

// Endpoint para buscar histórico
app.get('/api/history', async (req, res) => {
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from('sales_analysis')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json({ data });
    } else {
      res.json({ data: [...salesHistory].reverse() });
    }
  } catch (error) {
    console.error('Erro ao buscar histórico:', error);
    res.status(500).json({ error: `Erro ao buscar histórico: ${error.message}` });
  }
});

// Endpoint para busca
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q) {
      return res.json({ data: [] });
    }
    
    if (supabase) {
      const { data, error } = await supabase
        .from('sales_analysis')
        .select('*')
        .or(`campaign.ilike.%${q}%,creative.ilike.%${q}%,client_id.ilike.%${q}%`)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json({ data });
    } else {
      const filtered = salesHistory.filter(sale => 
        (sale.campaign && sale.campaign.toLowerCase().includes(q.toLowerCase())) ||
        (sale.creative && sale.creative.toLowerCase().includes(q.toLowerCase())) ||
        (sale.client_id && sale.client_id.includes(q))
      );
      res.json({ data: filtered.reverse() });
    }
  } catch (error) {
    console.error('Erro na busca:', error);
    res.status(500).json({ error: `Erro na busca: ${error.message}` });
  }
});

// Endpoint de health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    supabase_configured: !!supabase,
    utmify_configured: !!process.env.UTMIFY_API_TOKEN
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Supabase configurado: ${!!supabase}`);
  console.log(`UTMIFY configurado: ${!!process.env.UTMIFY_API_TOKEN}`);
});

