import { supabaseClient } from '@/utils/supabase-admin';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    console.log('🔍 Buscando produtos ocultos...');

    // 1. Buscar produtos ocultos (sem join complexo)
    const { data: hiddenProducts, error } = await supabaseClient
      .from('products')
      .select('id, name, category, website, product_link, is_hidden, hidden_reason, hidden_at')
      .eq('is_hidden', true)
      .order('hidden_at', { ascending: false });

    if (error) {
      console.error('Error fetching hidden products:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch hidden products',
        details: error.message
      });
    }

    if (!hiddenProducts || hiddenProducts.length === 0) {
      return res.status(200).json({
        success: true,
        timestamp: new Date().toISOString(),
        stats: { total: 0, manual: 0, priceLimit: 0, other: 0, byCategory: {} },
        products: [],
        groupedByReason: { manual: [], price_limit_exceeded: [], other: [] },
        activePriceLimits: {}
      });
    }

    console.log(`📦 Encontrados ${hiddenProducts.length} produtos ocultos`);

    // 2. Para cada produto oculto, buscar seu preço mais recente
    const productsWithPrices = [];
    
    for (const product of hiddenProducts) {
      console.log(`💰 Buscando preço para produto ${product.id}: ${product.name.substring(0, 50)}...`);
      
      const { data: latestPrice, error: priceError } = await supabaseClient
        .from('prices')
        .select('price, last_checked_at, price_changed_at, collected_at')
        .eq('product_id', product.id)
        .order('price_changed_at', { ascending: false })
        .limit(1)
        .single();

      let productWithPrice = {
        id: product.id,
        name: product.name,
        category: product.category,
        website: product.website,
        product_link: product.product_link,
        is_hidden: product.is_hidden,
        hidden_reason: product.hidden_reason,
        hidden_at: product.hidden_at,
        currentPrice: 0,
        lastPriceUpdate: null,
        lastChecked: null
      };

      if (priceError) {
        console.warn(`⚠️ Erro ao buscar preço do produto ${product.id}:`, priceError.message);
        // Produto sem preço válido - manter preço 0
      } else if (latestPrice) {
        productWithPrice.currentPrice = parseFloat(latestPrice.price) || 0;
        productWithPrice.lastPriceUpdate = latestPrice.price_changed_at;
        productWithPrice.lastChecked = latestPrice.last_checked_at || latestPrice.collected_at;
        console.log(`✅ Preço encontrado para ${product.name}: R$ ${productWithPrice.currentPrice}`);
      } else {
        console.warn(`⚠️ Nenhum preço encontrado para produto ${product.id}`);
      }

      productsWithPrices.push(productWithPrice);
    }

    // 3. Buscar limites de preço ativos para comparação
    const { data: priceLimits, error: limitsError } = await supabaseClient
      .from('category_price_limits')
      .select('category, max_price')
      .eq('is_active', true);

    if (limitsError) {
      console.error('Error fetching price limits:', limitsError);
      // Continuar sem os limites se houver erro
    }

    const limitsMap = {};
    priceLimits?.forEach(limit => {
      limitsMap[limit.category] = parseFloat(limit.max_price);
    });

    // 4. Adicionar informação sobre limite de preço
    productsWithPrices.forEach(product => {
      product.categoryLimit = limitsMap[product.category] || null;
      product.isAboveLimit = product.categoryLimit && product.currentPrice > 0 
        ? product.currentPrice >= product.categoryLimit 
        : false;
    });

    // 5. Agrupar por motivo de ocultação
    const groupedByReason = {
      manual: productsWithPrices.filter(p => p.hidden_reason === 'manual'),
      price_limit_exceeded: productsWithPrices.filter(p => p.hidden_reason === 'price_limit_exceeded'),
      other: productsWithPrices.filter(p => p.hidden_reason !== 'manual' && p.hidden_reason !== 'price_limit_exceeded')
    };

    // 6. Estatísticas
    const stats = {
      total: productsWithPrices.length,
      manual: groupedByReason.manual.length,
      priceLimit: groupedByReason.price_limit_exceeded.length,
      other: groupedByReason.other.length,
      byCategory: {}
    };

    // Contar por categoria
    productsWithPrices.forEach(product => {
      if (!stats.byCategory[product.category]) {
        stats.byCategory[product.category] = 0;
      }
      stats.byCategory[product.category]++;
    });

    console.log(`🎯 Processamento concluído: ${stats.total} produtos (${stats.manual} manual, ${stats.priceLimit} preço, ${stats.other} outros)`);

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      stats,
      products: productsWithPrices,
      groupedByReason,
      activePriceLimits: limitsMap
    });

  } catch (error) {
    console.error('Hidden products API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}
