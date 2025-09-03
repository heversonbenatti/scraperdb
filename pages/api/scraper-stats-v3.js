import { supabaseClient } from '@/utils/supabase';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Data de 15 minutos atrás
    const fifteenMinutesAgo = new Date();
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);

    // Buscar diretamente os preços atualizados nos últimos 15 minutos usando last_checked_at
    // que é o campo que o scraper sempre atualiza (tanto para preços novos quanto para incrementar check_count)
    const { data: recentPrices, error } = await supabaseClient
      .from('prices')
      .select(`
        product_id,
        last_checked_at,
        products!inner(
          website,
          is_hidden
        )
      `)
      .gte('last_checked_at', fifteenMinutesAgo.toISOString())
      .eq('products.is_hidden', false);

    if (error) {
      return res.status(500).json({
        error: 'Failed to fetch recent prices',
        details: error.message
      });
    }

    // Contar por website
    const websites = ['kabum', 'terabyte', 'pichau'];
    const scraperStats = [];

    for (const website of websites) {
      // Ajustar nome do website para terabyte (no banco é "terabyteshop")
      const dbWebsiteName = website === 'terabyte' ? 'terabyteshop' : website;
      
      const count = recentPrices?.filter(price => 
        price.products.website === dbWebsiteName
      ).length || 0;

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
        websiteBreakdown: recentPrices?.reduce((acc, price) => {
          const website = price.products.website;
          acc[website] = (acc[website] || 0) + 1;
          return acc;
        }, {}) || {}
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
