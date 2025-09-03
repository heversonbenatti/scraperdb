import { supabaseClient } from '@/utils/supabase';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Data de 15 minutos atrás
    const fifteenMinutesAgo = new Date();
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);

    // Buscar TODOS os preços dos últimos 15 minutos primeiro
    const { data: recentPrices, error: pricesError } = await supabaseClient
      .from('prices')
      .select('product_id, last_checked_at')
      .gte('last_checked_at', fifteenMinutesAgo.toISOString());

    if (pricesError) {
      return res.status(500).json({
        error: 'Failed to fetch recent prices',
        details: pricesError.message
      });
    }

    // Buscar todos os produtos para fazer o mapeamento manualmente
    const { data: products, error: productsError } = await supabaseClient
      .from('products')
      .select('id, website, is_hidden');

    if (productsError) {
      return res.status(500).json({
        error: 'Failed to fetch products',
        details: productsError.message
      });
    }

    // Criar um mapa de produto_id -> website
    const productMap = {};
    products?.forEach(product => {
      productMap[product.id] = {
        website: product.website,
        is_hidden: product.is_hidden
      };
    });

    // Filtrar preços por website e produtos visíveis
    const websites = ['kabum', 'terabyte', 'pichau'];
    const scraperStats = [];

    for (const website of websites) {
      // Contar preços deste website que não são de produtos ocultos
      const count = recentPrices?.filter(price => {
        const product = productMap[price.product_id];
        return product && 
               product.website === website && 
               product.is_hidden === false;
      }).length || 0;

      // Status baseado na quantidade
      let status = 'normal';
      let statusColor = 'green';
      let statusIcon = '✅';

      if (count === 0) {
        status = 'offline';
        statusColor = 'red';
        statusIcon = '🔴';
      } else if (count < 10) {
        status = 'baixo';
        statusColor = 'yellow';
        statusIcon = '⚠️';
      } else if (count > 100) {
        status = 'alto';
        statusColor = 'blue';
        statusIcon = '🔥';
      }

      scraperStats.push({
        website,
        websiteName: website.charAt(0).toUpperCase() + website.slice(1),
        count,
        status,
        statusColor,
        statusIcon
      });
    }

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      timeframe: '15 minutos',
      stats: scraperStats,
      total: scraperStats.reduce((sum, s) => sum + s.count, 0),
      debug: {
        totalRecentPrices: recentPrices?.length || 0,
        totalProducts: products?.length || 0,
        websiteDistribution: websites.map(site => ({
          website: site,
          totalProducts: products?.filter(p => p.website === site).length || 0,
          visibleProducts: products?.filter(p => p.website === site && !p.is_hidden).length || 0
        }))
      }
    });

  } catch (error) {
    console.error('Scraper stats error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}
