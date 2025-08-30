import { supabaseClient } from '@/utils/supabase';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Buscar produtos ocultos com seus preços atuais
    const { data: hiddenProducts, error } = await supabaseClient
      .from('products')
      .select(`
        id, name, category, website, product_link, 
        is_hidden, hidden_reason, hidden_at,
        prices!inner(price, last_checked_at, price_changed_at)
      `)
      .eq('is_hidden', true)
      .order('hidden_at', { ascending: false });

    if (error) {
      console.error('Error fetching hidden products:', error);
      return res.status(500).json({ error: 'Failed to fetch hidden products' });
    }

    // Processar produtos para obter apenas o preço mais recente de cada produto
    const productsWithLatestPrice = {};
    
    hiddenProducts?.forEach(product => {
      const productId = product.id;
      
      if (!productsWithLatestPrice[productId] || 
          new Date(product.prices.price_changed_at) > new Date(productsWithLatestPrice[productId].lastPriceUpdate)) {
        
        productsWithLatestPrice[productId] = {
          id: product.id,
          name: product.name,
          category: product.category,
          website: product.website,
          product_link: product.product_link,
          is_hidden: product.is_hidden,
          hidden_reason: product.hidden_reason,
          hidden_at: product.hidden_at,
          currentPrice: parseFloat(product.prices.price),
          lastPriceUpdate: product.prices.price_changed_at,
          lastChecked: product.prices.last_checked_at
        };
      }
    });

    const processedProducts = Object.values(productsWithLatestPrice);

    // Buscar limites de preço ativos para comparação
    const { data: priceLimits, error: limitsError } = await supabaseClient
      .from('category_price_limits')
      .select('category, max_price')
      .eq('is_active', true);

    if (limitsError) {
      console.error('Error fetching price limits:', limitsError);
    }

    const limitsMap = {};
    priceLimits?.forEach(limit => {
      limitsMap[limit.category] = limit.max_price;
    });

    // Adicionar informação sobre limite de preço
    processedProducts.forEach(product => {
      product.categoryLimit = limitsMap[product.category] || null;
      product.isAboveLimit = product.categoryLimit ? product.currentPrice >= product.categoryLimit : false;
    });

    // Agrupar por motivo de ocultação
    const groupedByReason = {
      manual: processedProducts.filter(p => p.hidden_reason === 'manual'),
      price_limit_exceeded: processedProducts.filter(p => p.hidden_reason === 'price_limit_exceeded'),
      other: processedProducts.filter(p => p.hidden_reason !== 'manual' && p.hidden_reason !== 'price_limit_exceeded')
    };

    // Estatísticas
    const stats = {
      total: processedProducts.length,
      manual: groupedByReason.manual.length,
      priceLimit: groupedByReason.price_limit_exceeded.length,
      other: groupedByReason.other.length,
      byCategory: {}
    };

    // Contar por categoria
    processedProducts.forEach(product => {
      if (!stats.byCategory[product.category]) {
        stats.byCategory[product.category] = 0;
      }
      stats.byCategory[product.category]++;
    });

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      stats,
      products: processedProducts,
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