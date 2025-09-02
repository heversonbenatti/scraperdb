import { supabaseClient } from '@/utils/supabase-admin';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    console.log('🔍 Buscando produtos ocultos com OTIMIZAÇÃO ULTRA-RÁPIDA...');
    const startTime = Date.now();

    // ✅ OTIMIZAÇÃO: Uma única query RPC em vez de dezenas de queries individuais
    const { data: hiddenProducts, error } = await supabaseClient
      .rpc('get_hidden_products_with_prices');

    if (error) {
      console.error('Error fetching hidden products:', error);
      // Fallback para método antigo se RPC falhar
      return await fallbackHiddenProducts(res);
    }

    if (!hiddenProducts || hiddenProducts.length === 0) {
      console.log('📦 Nenhum produto oculto encontrado');
      return res.status(200).json({
        success: true,
        timestamp: new Date().toISOString(),
        stats: { total: 0, manual: 0, priceLimit: 0, other: 0, byCategory: {} },
        products: [],
        groupedByReason: { manual: [], price_limit_exceeded: [], other: [] },
        activePriceLimits: {},
        loadTime: Date.now() - startTime
      });
    }

    console.log(`📦 ULTRA-RÁPIDO: ${hiddenProducts.length} produtos ocultos obtidos em uma única query!`);

    // 2. Buscar limites de preço ativos para comparação
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

    // 3. Processar produtos em lote (muito mais rápido que loops)
    const productsWithPrices = hiddenProducts.map(item => {
      const product = {
        id: item.product_id,
        name: item.product_name,
        category: item.product_category,
        website: item.product_website,
        product_link: item.product_link,
        is_hidden: item.is_hidden,
        hidden_reason: item.hidden_reason,
        hidden_at: item.hidden_at,
        currentPrice: parseFloat(item.current_price) || 0,
        lastPriceUpdate: item.price_changed_at,
        lastChecked: item.last_checked_at,
        categoryLimit: limitsMap[item.product_category] || null
      };

      // Verificar se está acima do limite
      product.isAboveLimit = product.categoryLimit && product.currentPrice > 0 
        ? product.currentPrice >= product.categoryLimit 
        : false;

      return product;
    });

    // 4. Agrupar por motivo usando filter (mais rápido que loops)
    const groupedByReason = {
      manual: productsWithPrices.filter(p => p.hidden_reason === 'manual'),
      price_limit_exceeded: productsWithPrices.filter(p => p.hidden_reason === 'price_limit_exceeded'),
      other: productsWithPrices.filter(p => p.hidden_reason && p.hidden_reason !== 'manual' && p.hidden_reason !== 'price_limit_exceeded')
    };

    // 5. Estatísticas calculadas em lote
    const stats = {
      total: productsWithPrices.length,
      manual: groupedByReason.manual.length,
      priceLimit: groupedByReason.price_limit_exceeded.length,
      other: groupedByReason.other.length,
      byCategory: {}
    };

    // Contar por categoria usando reduce (mais eficiente)
    stats.byCategory = productsWithPrices.reduce((acc, product) => {
      acc[product.category] = (acc[product.category] || 0) + 1;
      return acc;
    }, {});

    const loadTime = Date.now() - startTime;
    console.log(`🎯 ULTRA-OTIMIZADO: ${stats.total} produtos processados em ${loadTime}ms!`);
    console.log(`📊 Distribuição: ${stats.manual} manual, ${stats.priceLimit} preço, ${stats.other} outros`);

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

// Função de fallback caso a RPC não funcione
async function fallbackHiddenProducts(res) {
  console.log('⚠️ Usando método fallback (mais lento)...');
  const startTime = Date.now();

  try {
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
        stats: { total: 0, manual: 0, priceLimit: 0, other: 0, byCategory: {} },
        products: [],
        loadTime: Date.now() - startTime
      });
    }

    // 2. Buscar preços em LOTE usando função RPC
    const productIds = hiddenProducts.map(p => p.id);
    const { data: prices, error: pricesError } = await supabaseClient
      .rpc('get_latest_prices_by_products', { product_ids: productIds });

    if (pricesError) {
      console.error('Error fetching prices in batch:', pricesError);
    }

    // 3. Criar mapa de preços para lookup rápido
    const pricesMap = {};
    prices?.forEach(price => {
      pricesMap[price.product_id] = {
        currentPrice: parseFloat(price.price) || 0,
        lastPriceUpdate: price.price_changed_at,
        lastChecked: price.last_checked_at
      };
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
        categoryLimit: null,
        isAboveLimit: false
      };
    });

    const loadTime = Date.now() - startTime;
    console.log(`✅ Fallback concluído em ${loadTime}ms para ${productsWithPrices.length} produtos`);

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      stats: { 
        total: productsWithPrices.length,
        manual: productsWithPrices.filter(p => p.hidden_reason === 'manual').length,
        priceLimit: productsWithPrices.filter(p => p.hidden_reason === 'price_limit_exceeded').length,
        other: productsWithPrices.filter(p => p.hidden_reason !== 'manual' && p.hidden_reason !== 'price_limit_exceeded').length,
        byCategory: {}
      },
      products: productsWithPrices,
      loadTime
    });

  } catch (error) {
    console.error('Fallback error:', error);
    return res.status(500).json({
      error: 'Fallback method failed',
      details: error.message
    });
  }
}
