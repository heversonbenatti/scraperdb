import { supabaseClient } from '@/utils/supabase-admin';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    console.log('🔍 Buscando produtos ocultos...');
    const startTime = Date.now();

    // 1. Buscar produtos ocultos
    const { data: hiddenProducts, error } = await supabaseClient
      .from('products')
      .select('id, name, category, website, product_link, is_hidden, hidden_reason, hidden_at')
      .eq('is_hidden', true)
      .order('hidden_at', { ascending: false });

    if (error) {
      return res.status(500).json({ 
        error: 'Failed to fetch hidden products',
        details: error.message
      });
    }

    if (!hiddenProducts || hiddenProducts.length === 0) {
      return res.status(200).json({
        success: true,
        stats: { total: 0, manual: 0, priceLimit: 0, outdated: 0, other: 0, byCategory: {} },
        products: [],
        loadTime: Date.now() - startTime
      });
    }

    console.log(`📦 ${hiddenProducts.length} produtos ocultos encontrados`);

    // 2. Buscar preços em LOTE usando função RPC (se disponível)
    const productIds = hiddenProducts.map(p => p.id);
    let pricesMap = {};
    
    const { data: prices, error: pricesError } = await supabaseClient
      .rpc('get_latest_prices_by_products', { product_ids: productIds });

    if (!pricesError && prices) {
      console.log(`✅ ${prices.length} preços obtidos via RPC`);
      prices.forEach(price => {
        pricesMap[price.product_id] = {
          currentPrice: parseFloat(price.price) || 0,
          lastPriceUpdate: price.price_changed_at,
          lastChecked: price.last_checked_at
        };
      });
    } else {
      console.warn('⚠️ RPC não disponível, buscando preços individualmente...');
      // Fallback: buscar preços em lote usando IN
      const { data: batchPrices } = await supabaseClient
        .from('prices')
        .select('product_id, price, price_changed_at, last_checked_at')
        .in('product_id', productIds)
        .order('price_changed_at', { ascending: false });

      if (batchPrices) {
        const grouped = {};
        batchPrices.forEach(price => {
          if (!grouped[price.product_id]) {
            grouped[price.product_id] = price;
          }
        });
        
        Object.entries(grouped).forEach(([productId, price]) => {
          pricesMap[productId] = {
            currentPrice: parseFloat(price.price) || 0,
            lastPriceUpdate: price.price_changed_at,
            lastChecked: price.last_checked_at
          };
        });
        console.log(`✅ ${Object.keys(pricesMap).length} preços obtidos em lote`);
      }
    }

    // 3. Buscar limites de preço ativos
    const { data: priceLimits, error: limitsError } = await supabaseClient
      .from('category_price_limits')
      .select('category, max_price')
      .eq('is_active', true);

    if (limitsError) {
      console.warn('⚠️ Error fetching price limits:', limitsError.message);
    }

    const limitsMap = {};
    priceLimits?.forEach(limit => {
      limitsMap[limit.category] = parseFloat(limit.max_price);
    });

    // 4. Combinar produtos com preços
    const productsWithPrices = hiddenProducts.map(product => {
      const priceData = pricesMap[product.id] || {
        currentPrice: 0,
        lastPriceUpdate: null,
        lastChecked: null
      };

      return {
        id: product.id,
        name: product.name,
        category: product.category,
        website: product.website,
        product_link: product.product_link,
        is_hidden: product.is_hidden,
        hidden_reason: product.hidden_reason,
        hidden_at: product.hidden_at,
        ...priceData,
        categoryLimit: limitsMap[product.category] || null,
        isAboveLimit: limitsMap[product.category] && priceData.currentPrice > 0 
          ? priceData.currentPrice >= limitsMap[product.category]
          : false
      };
    });

    // 5. Agrupar por motivo
    const groupedByReason = {
      manual: productsWithPrices.filter(p => p.hidden_reason === 'manual'),
      price_limit_exceeded: productsWithPrices.filter(p => p.hidden_reason === 'price_limit_exceeded'),
      outdated: productsWithPrices.filter(p => p.hidden_reason === 'outdated'),
      other: productsWithPrices.filter(p => p.hidden_reason && !['manual', 'price_limit_exceeded', 'outdated'].includes(p.hidden_reason))
    };

    // 6. Estatísticas
    const stats = {
      total: productsWithPrices.length,
      manual: groupedByReason.manual.length,
      priceLimit: groupedByReason.price_limit_exceeded.length,
      outdated: groupedByReason.outdated.length,
      other: groupedByReason.other.length,
      byCategory: {}
    };

    // Contar por categoria
    stats.byCategory = productsWithPrices.reduce((acc, product) => {
      acc[product.category] = (acc[product.category] || 0) + 1;
      return acc;
    }, {});

    const loadTime = Date.now() - startTime;
    console.log(`✅ ${stats.total} produtos processados em ${loadTime}ms`);
    console.log(`📊 Distribuição: ${stats.manual} manual, ${stats.priceLimit} preço, ${stats.outdated} desatualizados, ${stats.other} outros`);

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      stats,
      products: productsWithPrices,
      groupedByReason,
      activePriceLimits: limitsMap,
      loadTime
    });

  } catch (error) {
    console.error('Hidden products API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}
